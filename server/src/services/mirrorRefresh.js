/**
 * mirrorRefresh.js — cross-board mirror engine (Phase 1, F2).
 *
 * Three responsibilities:
 *   1. computeMirrorValue / getMirrorValue / embedMirrorValues
 *      — read-time evaluation of a `mirror` column over the rows its sibling
 *        `connect_boards` column points at, with a TTL/stale cache stored on
 *        `Task.columnValues`.
 *   2. wouldCreateMirrorCycle
 *      — graph walk used at column-save time (columnController) to reject a
 *        mirror whose new edge would close a dependency cycle.
 *   3. mountMirrorRefresh / invalidateMirrorsForTask
 *      — eventBus subscriber that invalidates cached mirror values when a
 *        linked (target) task is updated or deleted.
 *
 * Mirror values are computed lazily: the cache is a best-effort optimisation,
 * and the TTL is the backstop that keeps multi-target mirrors eventually
 * consistent even when an invalidation keys off a non-primary target board.
 */

const Board = require('../models/Board');
const Task = require('../models/Task');
const BoardConnection = require('../models/BoardConnection');
const eventBus = require('./eventBus');
const { MIRROR_AGGREGATIONS } = require('../utils/columnTypes');

// How long a cached mirror value is trusted before recompute. Short enough
// that a missed invalidation self-heals quickly; long enough that a board
// list render doesn't recompute every row on every poll.
const CACHE_TTL_MS = 60 * 1000;
const MAX_GRAPH_DEPTH = 64;

const toIdString = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function') return value.toString();
  return String(value);
};

/**
 * Read a single column value off a task, tolerating both a hydrated Mongoose
 * doc (columnValues is a Map) and a `.lean()` POJO (columnValues is a plain
 * object).
 */
const readColumnValue = (task, columnId) => {
  if (!task || !task.columnValues || columnId == null) return undefined;
  const cv = task.columnValues;
  const key = columnId.toString();
  if (typeof cv.get === 'function') return cv.get(key);
  return cv[key];
};

/**
 * Normalised `[{ boardId, taskId }]` links from a connect_boards column value.
 */
const readLinks = (task, connectColumnId) => {
  const raw = readColumnValue(task, connectColumnId);
  if (!raw || typeof raw !== 'object') return [];
  const links = Array.isArray(raw.links) ? raw.links : [];
  return links
    .map((l) => ({ boardId: toIdString(l && l.boardId), taskId: toIdString(l && l.taskId) }))
    .filter((l) => l.taskId);
};

/**
 * Empty / identity value for an aggregation when there are no linked rows.
 */
const aggregationDefault = (aggregation) => {
  switch (aggregation) {
    case 'sum':
    case 'count':
      return 0;
    case 'concat':
      return '';
    default:
      return null; // first / min / max
  }
};

/**
 * Collapse a list of per-link display values into a single mirror value.
 */
const aggregate = (aggregation, values) => {
  if (aggregation === 'count') return values.length;
  if (!Array.isArray(values) || values.length === 0) return aggregationDefault(aggregation);
  switch (aggregation) {
    case 'concat':
      return values.map((v) => (v == null ? '' : String(v))).filter((s) => s !== '').join(', ');
    case 'sum':
    case 'min':
    case 'max': {
      const nums = values
        .map((v) => (typeof v === 'string' ? Number(v) : v))
        .filter((n) => typeof n === 'number' && Number.isFinite(n));
      if (nums.length === 0) return aggregationDefault(aggregation);
      if (aggregation === 'sum') return nums.reduce((a, b) => a + b, 0);
      if (aggregation === 'min') return Math.min(...nums);
      return Math.max(...nums);
    }
    case 'first':
    default:
      return values[0];
  }
};

/**
 * Turn a raw stored value from the target task into a human-facing display
 * value, resolving option ids to labels for status/dropdown/tags columns.
 */
const resolveDisplay = (raw, targetBoard, sourceColumnId) => {
  if (raw == null) return raw;
  const col =
    targetBoard && Array.isArray(targetBoard.columns)
      ? targetBoard.columns.find((c) => c._id.toString() === sourceColumnId)
      : null;
  if (!col) return typeof raw === 'object' ? null : raw;
  const opts = Array.isArray(col.settings && col.settings.options) ? col.settings.options : [];
  const labelOf = (id) => {
    const o = opts.find((op) => op.id != null && op.id.toString() === String(id));
    return o ? o.label : String(id);
  };
  switch (col.type) {
    case 'status':
    case 'dropdown':
      return labelOf(raw);
    case 'tags':
      return Array.isArray(raw) ? raw.map(labelOf).join(', ') : '';
    case 'link':
      return typeof raw === 'object' ? raw.label || raw.url || '' : raw;
    case 'location':
      return typeof raw === 'object' ? raw.label || '' : raw;
    case 'client':
      // `{ boardId, name }` — who the row is for. `name` is the server-kept
      // snapshot of the client board's display name (or a typed name), which
      // is exactly what a mirror should show; the default branch below turned
      // the object into null, so mirroring a Client column showed nothing.
      return typeof raw === 'object' ? (raw && raw.name) || '' : raw;
    case 'mirror':
      // A nested mirror: unwrap the cache shape if present.
      return raw && typeof raw === 'object' && raw.__mirror === true ? raw.value : raw;
    case 'payments': {
      // A payments cell is a LIST of receipts, and the default branch below
      // turns every object into null — so mirroring "Paid" from a billing board
      // showed nothing, and a `sum` of it was always 0. The number a payments
      // column stands for is what the receipts add up to, the same figure the
      // client's `paymentsTotal` and a formula referencing the column use: 0
      // for an empty list (nothing paid yet is a real zero), null for a value
      // that is not a list at all.
      if (!Array.isArray(raw)) return null;
      return raw.reduce((sum, p) => {
        const n = p && typeof p === 'object'
          ? (typeof p.amount === 'string' ? Number(p.amount) : p.amount)
          : NaN;
        return typeof n === 'number' && Number.isFinite(n) ? sum + n : sum;
      }, 0);
    }
    default:
      return typeof raw === 'object' ? null : raw;
  }
};

/**
 * Compute a mirror column's value for `task`. `board` must be the board that
 * OWNS the mirror column (so its sibling connect column is resolvable).
 *
 * Returns the bare aggregated value (never the cache wrapper).
 */
const computeMirrorValue = async (task, board, mirrorColumn) => {
  const settings = (mirrorColumn && mirrorColumn.settings) || {};
  const aggregation = MIRROR_AGGREGATIONS.includes(settings.aggregation)
    ? settings.aggregation
    : 'first';

  const cols = Array.isArray(board && board.columns) ? board.columns : [];
  const connectCol = cols.find(
    (c) => c._id.toString() === toIdString(settings.sourceConnectColumnId)
  );
  if (!connectCol || connectCol.type !== 'connect_boards') {
    return aggregationDefault(aggregation);
  }

  const links = readLinks(task, connectCol._id);
  if (aggregation === 'count') return links.length;
  if (links.length === 0) return aggregationDefault(aggregation);

  const sourceColumnId = toIdString(settings.sourceColumnId);
  if (!sourceColumnId) return aggregationDefault(aggregation);

  const taskIds = links.map((l) => l.taskId).filter(Boolean);
  const targets = await Task.find({ _id: { $in: taskIds } }).lean();
  if (targets.length === 0) return aggregationDefault(aggregation);

  const boardIds = [
    ...new Set(targets.map((t) => (t.board ? t.board.toString() : null)).filter(Boolean)),
  ];
  const targetBoards = boardIds.length
    ? await Board.find({ _id: { $in: boardIds } }).select('columns').lean()
    : [];
  const boardById = new Map(targetBoards.map((b) => [b._id.toString(), b]));
  const taskById = new Map(targets.map((t) => [t._id.toString(), t]));

  // Iterate in link order so `first` / `concat` are deterministic.
  const values = [];
  for (const link of links) {
    const tt = taskById.get(link.taskId);
    if (!tt) continue;
    const raw = readColumnValue(tt, sourceColumnId);
    const display = resolveDisplay(raw, boardById.get(tt.board ? tt.board.toString() : ''), sourceColumnId);
    if (display == null || display === '') continue;
    values.push(display);
  }
  return aggregate(aggregation, values);
};

const isFreshCache = (wrapper) =>
  wrapper &&
  typeof wrapper === 'object' &&
  wrapper.__mirror === true &&
  wrapper.stale !== true &&
  typeof wrapper.computedAt === 'number' &&
  Date.now() - wrapper.computedAt < CACHE_TTL_MS;

/**
 * Cache-aware single-value read. Returns the cached value when fresh; otherwise
 * recomputes and (optionally) write-throughs the cache onto the task doc.
 */
const getMirrorValue = async (task, board, mirrorColumn, { persist = false } = {}) => {
  const cid = mirrorColumn._id.toString();
  const cached = readColumnValue(task, cid);
  if (isFreshCache(cached)) return cached.value;

  const value = await computeMirrorValue(task, board, mirrorColumn);
  if (persist && task && task._id) {
    try {
      await Task.updateOne(
        { _id: task._id },
        {
          $set: {
            [`columnValues.${cid}`]: {
              __mirror: true,
              value,
              computedAt: Date.now(),
              stale: false,
            },
          },
        }
      );
    } catch (err) {
      console.error('[mirrorRefresh] cache write-through failed:', err.message);
    }
  }
  return value;
};

/**
 * Replace every mirror column's stored cache wrapper with its bare computed
 * value on a list of `.lean()` tasks, so the client renders a plain value.
 * Used to embed mirror values in the standard task-list response.
 */
const embedMirrorValues = async (tasks, board) => {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks;
  const mirrorCols = (board && Array.isArray(board.columns) ? board.columns : []).filter(
    (c) => c.type === 'mirror'
  );
  if (mirrorCols.length === 0) return tasks;

  for (const task of tasks) {
    if (!task.columnValues || typeof task.columnValues !== 'object') task.columnValues = {};
    for (const mc of mirrorCols) {
      const cid = mc._id.toString();
      const cached = task.columnValues[cid];
      let value;
      if (isFreshCache(cached)) {
        value = cached.value;
      } else {
        // eslint-disable-next-line no-await-in-loop
        value = await computeMirrorValue(task, board, mc);
      }
      task.columnValues[cid] = value;
    }
  }
  return tasks;
};

/**
 * Walk the mirror dependency graph from a PROPOSED mirror edge on `board` and
 * report whether the edge would close a cycle.
 *
 * A mirror M on board F depends on `(targetBoard, sourceColumnId)` for each
 * target board of its source connect column. If that source column is itself a
 * mirror, the dependency continues. The edge is a cycle if the walk returns to
 * the starting node (identified by `selfColumnId` on an edit, or a sentinel on
 * a create — though a brand-new mirror has no inbound references and so can
 * only be part of a cycle once another column points at it).
 *
 * `board` may be a hydrated doc or a lean object; only `_id` and `columns` are
 * read. `proposedSettings` is the mirror's new `{ sourceConnectColumnId,
 * sourceColumnId }`.
 */
const wouldCreateMirrorCycle = async (board, proposedSettings, selfColumnId = null) => {
  const startKey = `${board._id.toString()}:${selfColumnId ? selfColumnId.toString() : '__new__'}`;

  const boardCache = new Map([[board._id.toString(), board]]);
  const loadBoard = async (id) => {
    const key = id.toString();
    if (boardCache.has(key)) return boardCache.get(key);
    const b = await Board.findById(key).select('columns').lean();
    boardCache.set(key, b);
    return b;
  };

  // Expand a mirror column's settings into the `[boardId, columnId]` nodes it
  // depends on (one per target board of its source connect column).
  const dependenciesOf = (bd, mirrorSettings) => {
    const deps = [];
    if (!bd || !mirrorSettings) return deps;
    const cols = Array.isArray(bd.columns) ? bd.columns : [];
    const connectCol = cols.find(
      (c) => c._id.toString() === toIdString(mirrorSettings.sourceConnectColumnId)
    );
    if (!connectCol || connectCol.type !== 'connect_boards') return deps;
    const targets = Array.isArray(connectCol.settings && connectCol.settings.targetBoardIds)
      ? connectCol.settings.targetBoardIds
      : [];
    const sourceColumnId = toIdString(mirrorSettings.sourceColumnId);
    for (const tb of targets) {
      const depBoard = toIdString(tb);
      if (depBoard && sourceColumnId) deps.push([depBoard, sourceColumnId]);
    }
    return deps;
  };

  const visit = async (boardId, columnId, stack, depth) => {
    if (depth > MAX_GRAPH_DEPTH) return true; // pathological depth — treat as a cycle
    const key = `${boardId}:${columnId}`;
    if (stack.has(key)) return true;
    const bd = await loadBoard(boardId);
    if (!bd) return false;
    const col = (bd.columns || []).find((c) => c._id.toString() === columnId);
    if (!col || col.type !== 'mirror') return false; // concrete value column — a leaf
    stack.add(key);
    for (const [depBoard, depCol] of dependenciesOf(bd, col.settings)) {
      // eslint-disable-next-line no-await-in-loop
      if (await visit(depBoard, depCol, stack, depth + 1)) return true;
    }
    stack.delete(key);
    return false;
  };

  const stack = new Set([startKey]);
  for (const [depBoard, depCol] of dependenciesOf(board, proposedSettings)) {
    // eslint-disable-next-line no-await-in-loop
    if (await visit(depBoard, depCol, stack, 1)) return true;
  }
  return false;
};

/**
 * Invalidate cached mirror values that read from a changed (or deleted) task.
 *
 * Keyed off `BoardConnection.toBoardId`: when a task on board B changes, every
 * connect column that targets B may have referencing rows whose mirrors are now
 * stale. On delete we also pull the dead link so the mirror falls back to its
 * aggregation default (Acceptance #3).
 */
const invalidateMirrorsForTask = async ({ taskId, boardId, deleted = false }) => {
  if (!taskId || !boardId) return;
  const tid = taskId.toString();

  const connections = await BoardConnection.find({ toBoardId: boardId }).lean();
  if (connections.length === 0) return;

  for (const conn of connections) {
    const fromColId = conn.fromColumnId.toString();
    const linkPath = `columnValues.${fromColId}.links.taskId`;

    // eslint-disable-next-line no-await-in-loop
    const referencing = await Task.find({
      board: conn.fromBoardId,
      [linkPath]: tid,
    }).select('_id');
    if (referencing.length === 0) continue;
    const referencingIds = referencing.map((t) => t._id);

    if (deleted) {
      // eslint-disable-next-line no-await-in-loop
      await Task.updateMany(
        { _id: { $in: referencingIds } },
        { $pull: { [`columnValues.${fromColId}.links`]: { taskId: tid } } }
      );
    }

    // eslint-disable-next-line no-await-in-loop
    const fromBoard = await Board.findById(conn.fromBoardId).select('columns').lean();
    const mirrorCols = (fromBoard && fromBoard.columns ? fromBoard.columns : []).filter(
      (c) => c.type === 'mirror' && toIdString(c.settings && c.settings.sourceConnectColumnId) === fromColId
    );
    if (mirrorCols.length === 0) continue;

    // $unset the cache so the next read recomputes (the simplest stale marker).
    const unset = {};
    for (const mc of mirrorCols) unset[`columnValues.${mc._id.toString()}`] = '';
    // eslint-disable-next-line no-await-in-loop
    await Task.updateMany({ _id: { $in: referencingIds } }, { $unset: unset });
  }
};

/**
 * The same invalidation for MANY tasks on one board at once.
 *
 * ---- WHY A SECOND FUNCTION AND NOT A LOOP --------------------------------
 *
 * `invalidateMirrorsForTask` is written for the everyday case: one task
 * changed, so one `BoardConnection.find` and a handful of follow-up writes. A
 * GROUP DELETE is not that case. It removes every task in the group in one
 * request, and driving that through the per-task path means one
 * `BoardConnection.find` plus, per connection, one `Task.find` and up to two
 * `updateMany` — PER DELETED ROW. A group holding a few thousand tasks becomes
 * tens of thousands of round-trips, and because the caller emits rather than
 * awaits, every one of them is launched in the same tick, after the HTTP
 * response has already gone out, with nothing bounding the concurrency.
 *
 * This version pays the connection lookup ONCE and then works in `$in` batches,
 * so the cost is proportional to the number of CONNECTIONS (a handful, always)
 * rather than to the number of deleted rows. The writes it performs are
 * literally the same two.
 *
 * It is also AWAITABLE, which is the other half of the point: a group delete can
 * finish its cascade knowing the dead links are gone, instead of racing a
 * fire-and-forget listener against its own `TaskGroup.deleteOne`.
 *
 * `deleted` is not a parameter here. The only caller is a delete — an update
 * path that touched thousands of rows at once does not exist — and a flag with
 * one possible value is a flag that will eventually be passed wrong.
 */
const invalidateMirrorsForDeletedTasks = async ({ taskIds, boardId }) => {
  const ids = (Array.isArray(taskIds) ? taskIds : [taskIds])
    .filter(Boolean)
    .map((t) => t.toString());
  if (ids.length === 0 || !boardId) return;

  // TWO SOURCES, unioned — because the registry alone is not complete.
  //
  // `BoardConnection` records only the PRIMARY target of a connect column
  // (models/BoardConnection.js says so outright), so a column whose SECOND or
  // third `targetBoardIds` entry is this board produces no edge and its links
  // would never be pulled. `boardController.purgeLinksToDeletedBoard` refuses
  // the registry for exactly this reason and walks the column settings instead;
  // driving a group delete off the edges alone would inherit the hole that
  // comment rejects — and a stale entry in `links` has no TTL to heal it, unlike
  // a cached mirror value.
  //
  // So the edges are kept (they are indexed and they cover the common case) and
  // the settings scan is added beside them. The scan is ONE query for the whole
  // call, not one per deleted task.
  const pairs = new Map();
  const addPair = (fromBoardId, fromColumnId) => {
    if (!fromBoardId || !fromColumnId) return;
    pairs.set(`${fromBoardId}:${fromColumnId}`, {
      fromBoardId,
      fromColumnId: fromColumnId.toString(),
    });
  };

  const connections = await BoardConnection.find({ toBoardId: boardId }).lean();
  connections.forEach((c) => addPair(c.fromBoardId, c.fromColumnId));

  const self = await Board.findById(boardId).select('organisation').lean();
  if (self && self.organisation) {
    const targeting = await Board.find({
      organisation: self.organisation,
      'columns.settings.targetBoardIds': boardId,
    })
      .select('columns')
      .lean();
    for (const b of targeting) {
      for (const col of b.columns || []) {
        if (col.type !== 'connect_boards') continue;
        const targets = (col.settings && col.settings.targetBoardIds) || [];
        if (!targets.some((t) => toIdString(t) === toIdString(boardId))) continue;
        addPair(b._id, col._id);
      }
    }
  }
  if (pairs.size === 0) return;

  for (const conn of pairs.values()) {
    const fromColId = conn.fromColumnId;
    const linkPath = `columnValues.${fromColId}.links.taskId`;

    const referencing = await Task.find({
      board: conn.fromBoardId,
      [linkPath]: { $in: ids },
    }).select('_id');
    if (referencing.length === 0) continue;
    const referencingIds = referencing.map((t) => t._id);

    await Task.updateMany(
      { _id: { $in: referencingIds } },
      { $pull: { [`columnValues.${fromColId}.links`]: { taskId: { $in: ids } } } }
    );

    const fromBoard = await Board.findById(conn.fromBoardId).select('columns').lean();
    const mirrorCols = (fromBoard && fromBoard.columns ? fromBoard.columns : []).filter(
      (c) => c.type === 'mirror' && toIdString(c.settings && c.settings.sourceConnectColumnId) === fromColId
    );
    if (mirrorCols.length === 0) continue;

    // $unset the cache so the next read recomputes — the same stale marker the
    // single-task path writes, on the same rows it would have written it to.
    const unset = {};
    for (const mc of mirrorCols) unset[`columnValues.${mc._id.toString()}`] = '';
    await Task.updateMany({ _id: { $in: referencingIds } }, { $unset: unset });
  }
};

/**
 * Invalidate a single task's OWN mirror caches — used after its connect column
 * changes (link added/removed) so its mirrors recompute on next read.
 */
const invalidateOwnMirrors = async (taskId, board) => {
  if (!taskId || !board || !Array.isArray(board.columns)) return;
  const mirrorCols = board.columns.filter((c) => c.type === 'mirror');
  if (mirrorCols.length === 0) return;
  const unset = {};
  for (const mc of mirrorCols) unset[`columnValues.${mc._id.toString()}`] = '';
  try {
    await Task.updateOne({ _id: taskId }, { $unset: unset });
  } catch (err) {
    console.error('[mirrorRefresh] own-mirror invalidation failed:', err.message);
  }
};

let mounted = false;

/**
 * Subscribe the refresh service to `task.updated` / `task.deleted`. Idempotent
 * — safe to call on every boot (mirrors automationEventDispatcher).
 */
const mountMirrorRefresh = () => {
  if (mounted) return;
  mounted = true;
  eventBus.on('task.updated', (payload) => {
    invalidateMirrorsForTask({
      taskId: payload && payload.taskId,
      boardId: payload && payload.boardId,
      deleted: false,
    }).catch((err) => console.error('[mirrorRefresh] task.updated handler error:', err));
  });
  eventBus.on('task.deleted', (payload) => {
    invalidateMirrorsForTask({
      taskId: payload && payload.taskId,
      boardId: payload && payload.boardId,
      deleted: true,
    }).catch((err) => console.error('[mirrorRefresh] task.deleted handler error:', err));
  });
  console.log('mirror refresh service mounted');
};

module.exports = {
  computeMirrorValue,
  getMirrorValue,
  embedMirrorValues,
  wouldCreateMirrorCycle,
  invalidateMirrorsForTask,
  invalidateMirrorsForDeletedTasks,
  invalidateOwnMirrors,
  mountMirrorRefresh,
  // exported for tests
  aggregate,
  aggregationDefault,
  resolveDisplay,
  readLinks,
};

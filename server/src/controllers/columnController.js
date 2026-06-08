/**
 * columnController.js — CRUD for the flexible-columns engine (Phase 1, F1).
 *
 * Routes (wired in routes/boards.js under `:id`):
 *   GET    /api/boards/:id/columns
 *   POST   /api/boards/:id/columns
 *   PATCH  /api/boards/:id/columns/reorder
 *   PATCH  /api/boards/:id/columns/:cid
 *   DELETE /api/boards/:id/columns/:cid
 *
 * Member auth for `GET`; admin auth for write routes. Validation hits
 * `columnTypes.js` before persistence.
 */

const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const Organisation = require('../models/Organisation');
const BoardConnection = require('../models/BoardConnection');
const { getColumnType, MIRROR_AGGREGATIONS } = require('../utils/columnTypes');
const { wouldCreateMirrorCycle } = require('../services/mirrorRefresh');
const { resolveBoardAccess } = require('../utils/boardAccess');

/**
 * Load board + org and confirm the calling user is a member.
 *
 * `isAdmin` means "may edit board content" — true org admins and members
 * granted edit access on a private board both qualify. Returns
 * { board, org, isAdmin } on success, or { status, error } on failure.
 */
const loadBoardContext = async (boardId, userId) => {
  if (!boardId || !mongoose.Types.ObjectId.isValid(boardId)) {
    return { status: 400, error: 'Invalid board id' };
  }
  const board = await Board.findById(boardId);
  if (!board) return { status: 404, error: 'Board not found' };

  const org = await Organisation.findById(board.organisation);
  if (!org) return { status: 404, error: 'Organisation not found' };

  const isMember = org.members.some((m) => m.toString() === userId);
  if (!isMember) {
    return { status: 403, error: 'Not a member of this organisation' };
  }
  const access = resolveBoardAccess(board, org, userId);
  if (!access.canRead) {
    return { status: 403, error: 'Access denied' };
  }
  return { board, org, isAdmin: access.canEdit };
};

const serializeColumns = (board) =>
  (board.columns || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));

/**
 * Generate a stable slug from a name, then suffix it with `-2`, `-3`, ...
 * until it's unique within the board. Slugs only contain [a-z0-9_].
 */
const slugify = (name) => {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base || 'column';
};

const uniqueSlug = (board, baseName) => {
  const existing = new Set((board.columns || []).map((c) => c.key));
  const base = slugify(baseName);
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
};

const nextOrder = (board) => {
  const cols = board.columns || [];
  if (cols.length === 0) return 0;
  return Math.max(...cols.map((c) => c.order || 0)) + 1;
};

// ---------------------------------------------------------------------------
// F2 — cross-board column settings validation + BoardConnection sync
// ---------------------------------------------------------------------------

/**
 * Validate `connect_boards` settings. `targetBoardIds` must be a non-empty
 * list of board ids in the SAME organisation as the source board (a board
 * can't connect to itself; cross-workspace targets arrive with F3 grants).
 * The synchronous registry validator only checks value shape, so the
 * DB-aware checks live here.
 */
const validateConnectSettings = async (board, settings) => {
  const targetBoardIds = Array.isArray(settings && settings.targetBoardIds)
    ? settings.targetBoardIds
    : [];
  if (targetBoardIds.length === 0) {
    return { error: 'connect_boards requires at least one target board' };
  }
  const ids = [];
  for (const raw of targetBoardIds) {
    const id = raw == null ? '' : raw.toString();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return { error: 'targetBoardIds contains an invalid board id' };
    }
    if (id === board._id.toString()) {
      return { error: 'A board cannot connect to itself' };
    }
    ids.push(id);
  }
  const uniqueIds = [...new Set(ids)];
  const targets = await Board.find({ _id: { $in: uniqueIds } }).select('organisation');
  if (targets.length !== uniqueIds.length) {
    return { error: 'One or more target boards do not exist' };
  }
  for (const tb of targets) {
    if (!tb.organisation || tb.organisation.toString() !== board.organisation.toString()) {
      return {
        error:
          'Target boards must be in the same workspace (cross-workspace links require a grant — F3)',
      };
    }
  }
  return { ok: true };
};

/**
 * Validate `mirror` settings. The source connect column must be a
 * `connect_boards` column on THIS board; `sourceColumnId` is required; the
 * aggregation must be a supported mode.
 */
const validateMirrorSettings = (board, settings) => {
  const connectId =
    settings && settings.sourceConnectColumnId ? settings.sourceConnectColumnId.toString() : '';
  if (!connectId) return { error: 'mirror requires a sourceConnectColumnId' };
  const connectCol = (board.columns || []).find((c) => c._id.toString() === connectId);
  if (!connectCol || connectCol.type !== 'connect_boards') {
    return {
      error: 'sourceConnectColumnId must reference a connect_boards column on this board',
    };
  }
  if (!settings.sourceColumnId) {
    return { error: 'mirror requires a sourceColumnId' };
  }
  if (settings.aggregation && !MIRROR_AGGREGATIONS.includes(settings.aggregation)) {
    return { error: `aggregation must be one of: ${MIRROR_AGGREGATIONS.join(', ')}` };
  }
  return { ok: true };
};

/**
 * Upsert the BoardConnection edge for a connect_boards column. The primary
 * (first) target board is recorded as `toBoardId` — see BoardConnection.js.
 * Idempotent against the `{ fromBoardId, fromColumnId }` unique index.
 */
const syncBoardConnection = async (board, column) => {
  const targetBoardIds = Array.isArray(column.settings && column.settings.targetBoardIds)
    ? column.settings.targetBoardIds
    : [];
  if (targetBoardIds.length === 0) return;
  await BoardConnection.findOneAndUpdate(
    { fromBoardId: board._id, fromColumnId: column._id },
    {
      $set: { toBoardId: targetBoardIds[0] },
      $setOnInsert: {
        fromBoardId: board._id,
        fromColumnId: column._id,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
};

const removeBoardConnection = async (boardId, columnId) => {
  await BoardConnection.deleteOne({ fromBoardId: boardId, fromColumnId: columnId });
};

/**
 * GET /api/boards/:id/columns
 */
const listColumns = async (req, res) => {
  try {
    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ columns: serializeColumns(ctx.board) });
  } catch (err) {
    console.error('listColumns error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:id/columns
 * Body: { name, type, settings?, width?, after?, key?, isPrimary? }
 *
 * `after` is the column id to insert the new column after; appends if absent.
 * Admin-only. Validates `settings` through the type registry.
 */
const addColumn = async (req, res) => {
  try {
    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const { board } = ctx;
    const { name, type, settings = {}, width, after, key, isPrimary } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Column name is required' });
    }
    if (!type || typeof type !== 'string') {
      return res.status(400).json({ error: 'Column type is required' });
    }
    const entry = getColumnType(type);
    if (!entry) {
      return res.status(400).json({ error: `Unknown column type: ${type}` });
    }

    // Validate the default value against the new column's settings — this
    // catches malformed `settings` payloads early (e.g. dropdown with no
    // `options`). Registry validators are permissive about null, so we
    // synthesize an option-id when the type needs one.
    try {
      const probe = entry.defaultValue ? entry.defaultValue(settings) : null;
      entry.validate(probe, settings);
    } catch (err) {
      return res.status(400).json({ error: `Invalid settings: ${err.message}` });
    }

    // F2: cross-board column types carry DB-aware invariants the synchronous
    // registry validator can't check (target-board membership, cycle-free
    // mirror graph). Reject bad settings before the column lands.
    if (type === 'connect_boards') {
      const r = await validateConnectSettings(board, settings);
      if (r.error) return res.status(400).json({ error: r.error });
    } else if (type === 'mirror') {
      const r = validateMirrorSettings(board, settings);
      if (r.error) return res.status(400).json({ error: r.error });
      if (await wouldCreateMirrorCycle(board, settings, null)) {
        return res.status(400).json({
          error: 'This mirror would create a circular reference. Pick a different source column.',
        });
      }
    }

    // Build the column subdoc. `key` is optional in the request; if absent,
    // we derive one from the name and de-dupe.
    const desiredKey = typeof key === 'string' && key.trim() ? slugify(key) : null;
    let finalKey = desiredKey || uniqueSlug(board, name);
    if ((board.columns || []).some((c) => c.key === finalKey)) {
      finalKey = uniqueSlug(board, name);
    }

    // Insertion: after-id semantics if provided.
    const cols = board.columns || [];
    const insertIndex = after
      ? cols.findIndex((c) => c._id.toString() === after.toString())
      : -1;
    const order = nextOrder(board);

    const column = {
      key: finalKey,
      name: name.trim(),
      type,
      settings: settings || {},
      order,
      width: typeof width === 'number' && width > 40 ? width : 160,
      isPrimary:
        isPrimary === true && cols.every((c) => c.isPrimary !== true),
    };

    if (insertIndex >= 0 && insertIndex < cols.length - 1) {
      // Renumber order so the new column sits right after the anchor.
      const anchorOrder = cols[insertIndex].order || 0;
      column.order = anchorOrder + 0.5;
      board.columns.push(column);
      // Normalise orders to integers after the splice.
      const sorted = board.columns
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      sorted.forEach((c, i) => {
        c.order = i;
      });
    } else {
      board.columns.push(column);
    }

    // First column on the board is automatically primary.
    if (!board.columns.some((c) => c.isPrimary)) {
      board.columns[0].isPrimary = true;
    }

    await board.save();

    const created = board.columns.find((c) => c.key === finalKey);

    // F2: register the connect edge so mirror invalidation can find it.
    if (type === 'connect_boards' && created) {
      await syncBoardConnection(board, created);
    }

    return res.status(201).json({ column: created, columns: serializeColumns(board) });
  } catch (err) {
    console.error('addColumn error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/boards/:id/columns/:cid
 * Body: { name?, settings?, width? } — type changes are out of scope for v1.
 */
const updateColumn = async (req, res) => {
  try {
    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const { board } = ctx;
    const { cid } = req.params;
    const column = board.columns.id(cid);
    if (!column) return res.status(404).json({ error: 'Column not found' });

    const { name, settings, width } = req.body || {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Column name cannot be empty' });
      }
      column.name = name.trim();
    }
    if (settings !== undefined) {
      const entry = getColumnType(column.type);
      if (!entry) {
        return res.status(400).json({ error: `Unknown column type: ${column.type}` });
      }
      try {
        const probe = entry.defaultValue ? entry.defaultValue(settings) : null;
        entry.validate(probe, settings);
      } catch (err) {
        return res.status(400).json({ error: `Invalid settings: ${err.message}` });
      }
      // F2: re-validate cross-board invariants before persisting the new
      // settings (re-targeting a connect column, or re-pointing a mirror).
      if (column.type === 'connect_boards') {
        const r = await validateConnectSettings(board, settings);
        if (r.error) return res.status(400).json({ error: r.error });
      } else if (column.type === 'mirror') {
        const r = validateMirrorSettings(board, settings);
        if (r.error) return res.status(400).json({ error: r.error });
        if (await wouldCreateMirrorCycle(board, settings, column._id)) {
          return res.status(400).json({
            error: 'This mirror would create a circular reference. Pick a different source column.',
          });
        }
      }
      column.settings = settings;
      // mongoose doesn't track Mixed mutations — flag manually.
      column.markModified('settings');
    }
    if (width !== undefined) {
      if (typeof width !== 'number' || width < 40 || width > 1000) {
        return res.status(400).json({ error: 'width must be between 40 and 1000' });
      }
      column.width = width;
    }

    await board.save();

    // F2: keep the connect edge in sync when its target board(s) change.
    if (column.type === 'connect_boards' && req.body && req.body.settings !== undefined) {
      await syncBoardConnection(board, column);
    }

    return res.json({ column, columns: serializeColumns(board) });
  } catch (err) {
    console.error('updateColumn error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/boards/:id/columns/reorder
 * Body: { order: [cid, ...] } — must list every column id exactly once.
 */
const reorderColumns = async (req, res) => {
  try {
    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const { board } = ctx;
    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!order) return res.status(400).json({ error: 'order[] is required' });

    const currentIds = board.columns.map((c) => c._id.toString());
    const requestedIds = order.map((id) => id.toString());
    if (
      requestedIds.length !== currentIds.length ||
      !requestedIds.every((id) => currentIds.includes(id)) ||
      new Set(requestedIds).size !== requestedIds.length
    ) {
      return res
        .status(400)
        .json({ error: 'order must list every column id exactly once' });
    }

    const indexById = new Map(requestedIds.map((id, i) => [id, i]));
    for (const col of board.columns) {
      col.order = indexById.get(col._id.toString());
    }
    await board.save();

    return res.json({ columns: serializeColumns(board) });
  } catch (err) {
    console.error('reorderColumns error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/boards/:id/columns/:cid
 *
 * - 400 if the column is the primary.
 * - Otherwise `$unset` `columnValues.<cid>` on every Task in the board.
 */
const deleteColumn = async (req, res) => {
  try {
    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const { board } = ctx;
    const { cid } = req.params;
    const column = board.columns.id(cid);
    if (!column) return res.status(404).json({ error: 'Column not found' });
    if (column.isPrimary) {
      return res.status(400).json({ error: 'Cannot delete the primary column' });
    }

    const wasConnect = column.type === 'connect_boards';

    board.columns.pull({ _id: cid });
    await board.save();

    await Task.updateMany(
      { board: board._id },
      { $unset: { [`columnValues.${cid}`]: '' } }
    );

    // F2: drop the connect edge so mirror invalidation no longer fans out to a
    // column that no longer exists. Mirror columns that read this connect
    // column are left in place — they compute to their aggregation default.
    if (wasConnect) {
      await removeBoardConnection(board._id, cid);
    }

    return res.json({ columns: serializeColumns(board) });
  } catch (err) {
    console.error('deleteColumn error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  listColumns,
  addColumn,
  updateColumn,
  reorderColumns,
  deleteColumn,
};

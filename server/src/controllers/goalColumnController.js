/**
 * The shared goal COLUMN schema on a tracker board.
 *
 * Every group's goals table on a board renders the same columns, so an agency
 * comparing two clients is comparing like with like.
 *
 * Writes gate on `goal.manage` — the same capability that already lets someone
 * create a goal and decide its target. These USED to gate on the org-wide
 * `org.manage_settings`, on the theory that the column list was the
 * organisation's reporting vocabulary rather than one board owner's preference.
 * The theory was tidy and the consequence was not: it meant a board's own
 * creator could define every goal on it and still be unable to add a column to
 * hold them. Deciding what a goal promises and deciding what is recorded
 * alongside it are the same job, done by the same person, and they now need the
 * same permission.
 *
 * `goal.manage` IS in BOARD_SCOPED, so it resolves through the full two-layer
 * AND: the org role is the floor and the board's `edit` rung is the ceiling.
 * That makes this gate strictly per-board, which is the point.
 *
 * IMPORTANT: do not reach for `middleware/requireCapability.js` here. It
 * resolves the organisation from `req.params.id`, which on these routes is a
 * BOARD id. Use `ctx.can(...)` from the loaded board context, which applies the
 * AND for board-scoped capabilities and passes org-scoped ones straight through.
 */

const mongoose = require('mongoose');
const Goal = require('../models/Goal');
const { loadBoardContext } = require('../utils/boardContext');

const COLUMN_TYPES = ['text', 'number', 'date', 'dropdown', 'link', 'person'];
const MAX_COLUMNS = 20;
const MAX_OPTIONS = 40;

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const slugify = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'column';

const uniqueSlug = (board, base, excludeId = null) => {
  const taken = new Set(
    (board.goalColumns || [])
      .filter((c) => String(c._id) !== String(excludeId))
      .map((c) => c.key)
  );
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
};

/** Board read + `goal.manage`. Returns the context, or null having answered. */
const gateColumns = async (req, res, { write = true } = {}) => {
  const boardId = req.params.boardId || req.params.id;
  if (!isValidId(boardId)) {
    res.status(400).json({ error: 'Invalid board id' });
    return null;
  }
  const ctx = await loadBoardContext(boardId, req.user.userId);
  if (ctx.error) {
    res.status(ctx.status).json({ error: ctx.error });
    return null;
  }
  if (ctx.board?.boardType !== 'tracker') {
    res.status(404).json({ error: 'This board is not a tracker board.' });
    return null;
  }
  if (write && !ctx.can('goal.manage')) {
    res.status(403).json({
      error: 'Goal columns are shared by every group on this board, so changing '
        + 'them needs permission to manage this board\u2019s goals.',
    });
    return null;
  }
  return ctx;
};

const sanitizeOptions = (settings) => {
  const options = Array.isArray(settings?.options) ? settings.options : [];
  return options
    .map((o, i) => ({
      id: String(o?.id || o?.label || i).slice(0, 60),
      label: String(o?.label || '').trim().slice(0, 60),
      color: typeof o?.color === 'string' ? o.color : '#6B7280',
      order: Number.isFinite(o?.order) ? o.order : i,
    }))
    .filter((o) => o.label)
    .slice(0, MAX_OPTIONS);
};

/** GET /api/boards/:boardId/goal-columns */
const listGoalColumns = async (req, res) => {
  try {
    const ctx = await gateColumns(req, res, { write: false });
    if (!ctx) return undefined;
    return res.json({
      columns: (ctx.board.goalColumns || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      canManage: ctx.can('goal.manage'),
    });
  } catch (err) {
    console.error('listGoalColumns error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** POST /api/boards/:boardId/goal-columns */
const addGoalColumn = async (req, res) => {
  try {
    const ctx = await gateColumns(req, res);
    if (!ctx) return undefined;
    const { board } = ctx;
    const { name, type, settings, required } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Give the column a name.' });
    }
    if (!COLUMN_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Pick a column type.' });
    }
    if ((board.goalColumns || []).length >= MAX_COLUMNS) {
      return res.status(400).json({ error: `A board can have ${MAX_COLUMNS} goal columns.` });
    }

    const isRequired = required === true;
    board.goalColumns.push({
      key: uniqueSlug(board, slugify(name)),
      name: String(name).trim().slice(0, 60),
      type,
      settings: type === 'dropdown' ? { options: sanitizeOptions(settings) } : {},
      required: isRequired,
      // Stamped now, so goals created BEFORE this moment are never retroactively
      // blocked for a value the rule did not exist to ask for.
      requiredSince: isRequired ? new Date() : null,
      archived: false,
      order: (board.goalColumns || []).length,
      width: 160,
    });
    await board.save();

    return res.status(201).json({ columns: board.goalColumns });
  } catch (err) {
    console.error('addGoalColumn error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** PATCH /api/boards/:boardId/goal-columns/reorder — must precede /:cid */
const reorderGoalColumns = async (req, res) => {
  try {
    const ctx = await gateColumns(req, res);
    if (!ctx) return undefined;
    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds must be an array' });
    }
    const index = new Map(orderedIds.map((id, i) => [String(id), i]));
    for (const col of ctx.board.goalColumns) {
      const next = index.get(String(col._id));
      if (next !== undefined) col.order = next;
    }
    await ctx.board.save();
    return res.json({ columns: ctx.board.goalColumns });
  } catch (err) {
    console.error('reorderGoalColumns error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** PATCH /api/boards/:boardId/goal-columns/:cid */
const updateGoalColumn = async (req, res) => {
  try {
    const ctx = await gateColumns(req, res);
    if (!ctx) return undefined;
    const { board } = ctx;
    const col = board.goalColumns.id(req.params.cid);
    if (!col) return res.status(404).json({ error: 'Column not found' });

    const { name, settings, required, width, archived } = req.body || {};

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'Give the column a name.' });
      col.name = trimmed.slice(0, 60);
      // The key is NOT re-slugged on rename: goal values are keyed by `_id`, and
      // a stable key is what lets a rename be free.
    }
    if (settings !== undefined && col.type === 'dropdown') {
      col.settings = { options: sanitizeOptions(settings) };
    }
    if (required !== undefined) {
      const next = required === true;
      // Stamp only on the false → true transition, so toggling it off and back
      // on does not silently forgive rows written in between.
      if (next && !col.required) col.requiredSince = new Date();
      if (!next) col.requiredSince = null;
      col.required = next;
    }
    if (width !== undefined) {
      const w = Number(width);
      if (Number.isFinite(w)) col.width = Math.max(60, Math.min(600, w));
    }
    if (archived !== undefined) col.archived = archived === true;

    await board.save();
    return res.json({ columns: board.goalColumns });
  } catch (err) {
    console.error('updateGoalColumn error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/boards/:boardId/goal-columns/:cid[?purge=true]
 *
 * ARCHIVES by default rather than deleting. Labels and statuses hard-delete and
 * `$pull`, and that is right for them — losing a chip is a nuisance. Losing a
 * number somebody already reported to a client is not. The response reports how
 * many goals actually hold a value so the client can warn before purging.
 */
const deleteGoalColumn = async (req, res) => {
  try {
    const ctx = await gateColumns(req, res);
    if (!ctx) return undefined;
    const { board } = ctx;
    const col = board.goalColumns.id(req.params.cid);
    if (!col) return res.status(404).json({ error: 'Column not found' });

    const valuedRowCount = await Goal.countDocuments({
      board: board._id,
      [`columnValues.${col._id}`]: { $exists: true, $nin: [null, ''] },
    });

    if (req.query.purge === 'true') {
      board.goalColumns.pull({ _id: col._id });
      await board.save();
      await Goal.updateMany(
        { board: board._id },
        { $unset: { [`columnValues.${req.params.cid}`]: '' } }
      );
      return res.json({ columns: board.goalColumns, purged: true, valuedRowCount });
    }

    col.archived = true;
    col.required = false;
    await board.save();
    return res.json({ columns: board.goalColumns, archived: true, valuedRowCount });
  } catch (err) {
    console.error('deleteGoalColumn error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  COLUMN_TYPES,
  listGoalColumns,
  addGoalColumn,
  updateGoalColumn,
  reorderGoalColumns,
  deleteGoalColumn,
};

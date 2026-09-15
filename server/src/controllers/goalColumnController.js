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

const crypto = require('crypto');
const mongoose = require('mongoose');
const Goal = require('../models/Goal');
const ConnectorFieldMapping = require('../models/ConnectorFieldMapping');
const { loadBoardContext } = require('../utils/boardContext');
const { snapshotGoal, logGoalChanges } = require('../services/goalActivity');

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

/* ===========================================================================
 * The CHOICES inside one `dropdown` column — the board's own tag vocabulary.
 *
 * A dropdown column used to be write-once: you named its choices when you
 * created it and that was the last word. These handlers make the list editable,
 * and the whole design turns on one fact — A GOAL STORES THE OPTION'S `id`, NOT
 * ITS LABEL. That is what makes a rename or a recolour free, and it is also
 * what makes a removal dangerous, because a value pointing at an id that no
 * longer exists renders as an empty cell and says nothing about what it lost.
 *
 * So removal is THREE outcomes, not one, mirroring how a whole column is
 * removed further down this file:
 *
 *   nobody uses it           → gone, no questions asked
 *   somebody uses it, RETIRE → `archived: true`. Out of every picker so it can
 *                              never be chosen again; still rendered on the rows
 *                              that already hold it. Nothing is lost.
 *   somebody uses it, PURGE  → gone, and the value is cleared from every goal
 *                              holding it, each clear written to that goal's own
 *                              history so a number that vanished from a client
 *                              report is still attributable.
 *
 * Retire is the default the UI offers, for the reason the column delete gives:
 * losing a chip is a nuisance, losing something already reported is not.
 *
 * Two guards that are easy to miss:
 *   - A REQUIRED column must always keep at least one choosable option, or it
 *     becomes a permanent block on closing the month — nobody can satisfy a
 *     rule that has nothing to pick. Retiring or deleting the last live option
 *     is refused while `required` is on.
 *   - Ids are minted with a RANDOM suffix and never reused. A counter would
 *     eventually hand a new option the id of a deleted one, and any goal still
 *     holding that dead value would silently light up with a tag nobody gave it.
 *
 * Connector field mappings are deliberately NOT considered here: a mapping can
 * never target a dropdown column in the first place (see `fieldMapping.js` —
 * "a value from the connector would not match one"), so there is no binding to
 * this vocabulary anywhere for an option change to break.
 * ========================================================================= */

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_OPTION_COLOR = '#6B7280';

/**
 * How many goals a purge writes a history row for.
 *
 * The CLEAR itself is a single `updateMany` and is never capped — leaving dead
 * ids behind to keep a log tidy would be the wrong way round. This caps only
 * the per-goal history rows, so purging a tag used by a thousand goals cannot
 * turn into a thousand-row activity feed nobody can read.
 */
const MAX_LOGGED_CLEARS = 200;

const normaliseColor = (c) =>
  (typeof c === 'string' && HEX_RE.test(c.trim()) ? c.trim() : DEFAULT_OPTION_COLOR);

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

const optionsOf = (col) => (Array.isArray(col?.settings?.options) ? col.settings.options : []);

/** Options somebody may still CHOOSE. Retired ones stay renderable, not pickable. */
const liveOptions = (col) => optionsOf(col).filter((o) => !o.archived);

/**
 * `settings` is a Mixed path, so an array mutated in place inside it is
 * invisible to mongoose. Every write goes through here: fresh array, explicit
 * markModified.
 */
const writeOptions = (col, options) => {
  col.settings = { ...(col.settings || {}), options };
  col.markModified('settings');
};

const sameLabel = (a, b) =>
  String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** A stable id that is never handed out twice on this column — see the note above. */
const mintOptionId = (col, label) => {
  const base = slugify(label).slice(0, 24);
  const taken = new Set(optionsOf(col).map((o) => String(o.id)));
  for (let i = 0; i < 12; i += 1) {
    const id = `${base}_${crypto.randomBytes(3).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
  return `${base}_${Date.now().toString(36)}`;
};

/**
 * How many goals hold each option of this column, in ONE query.
 *
 * Counted per option rather than per row because that is the number the editor
 * has to show beside a delete button, and asking it forty times would be forty
 * round trips. The array branch is defensive: a goal dropdown is single-valued
 * today, but a multi-select column would group by the whole array and the
 * counts would then be silently wrong rather than absent.
 */
const optionUsage = async (boardId, colId) => {
  const key = `columnValues.${colId}`;
  const rows = await Goal.aggregate([
    {
      $match: {
        board: new mongoose.Types.ObjectId(String(boardId)),
        [key]: { $exists: true, $nin: [null, ''] },
      },
    },
    { $group: { _id: `$${key}`, count: { $sum: 1 } } },
  ]);
  const usage = {};
  for (const row of rows) {
    const ids = Array.isArray(row._id) ? row._id : [row._id];
    for (const id of ids) {
      if (id === null || id === undefined || typeof id === 'object') continue;
      const k = String(id);
      usage[k] = (usage[k] || 0) + row.count;
    }
  }
  return usage;
};

/** Board read + `goal.manage` + "this column actually has choices". */
const gateOptions = async (req, res, { write = true } = {}) => {
  const ctx = await gateColumns(req, res, { write });
  if (!ctx) return null;
  const col = ctx.board.goalColumns.id(req.params.cid);
  if (!col) {
    res.status(404).json({ error: 'Column not found' });
    return null;
  }
  if (col.type !== 'dropdown') {
    res.status(400).json({
      error: `“${col.name}” does not hold a list of choices, so there are none to edit.`,
    });
    return null;
  }
  return { ctx, col };
};

/** Every options response has the same shape, so one repaint path covers all of them. */
const optionsResponse = async (board, col, extra = {}) => ({
  columns: board.goalColumns,
  columnId: String(col._id),
  options: optionsOf(col).slice().sort(byOrder),
  usage: await optionUsage(board._id, col._id),
  ...extra,
});

/**
 * Drop one option's value from every goal that holds it, and say so in each
 * goal's history.
 *
 * ORDER MATTERS. `{ field: id }` in mongo matches an array CONTAINING the id as
 * well as a scalar equal to it, so `$unset` first would blow away a whole
 * multi-value cell to remove one tag from it. Pulling from arrays first leaves
 * only scalars for the unset to find.
 */
const clearOptionValues = async ({ board, col, optionId, actor, columns }) => {
  const key = `columnValues.${col._id}`;
  const filter = { board: board._id, [key]: optionId };

  // Read BEFORE the write — afterwards there is nothing left to diff against.
  const affected = await Goal.find(filter)
    .select('name type weight owner note unit unitLabel actual actualDayKey config columnValues monthKey group board')
    .limit(MAX_LOGGED_CLEARS)
    .lean();

  await Goal.updateMany(
    { board: board._id, [key]: { $elemMatch: { $eq: optionId } } },
    { $pull: { [key]: optionId } }
  );
  const result = await Goal.updateMany(filter, { $unset: { [key]: '' } });

  const cid = String(col._id);
  await Promise.all(affected.map((goal) => {
    const before = snapshotGoal(goal);
    const values = { ...before.columnValues };
    const current = values[cid];
    if (Array.isArray(current)) {
      const next = current.filter((v) => String(v) !== optionId);
      if (next.length) values[cid] = next;
      else delete values[cid];
    } else {
      delete values[cid];
    }
    return logGoalChanges({
      goal,
      before,
      after: { ...before, columnValues: values },
      columns,
      actor,
    });
  }));

  return result.modifiedCount ?? result.nModified ?? 0;
};

/** GET /api/boards/:boardId/goal-columns/:cid/options */
const listGoalColumnOptions = async (req, res) => {
  try {
    const gated = await gateOptions(req, res, { write: false });
    if (!gated) return undefined;
    return res.json({
      ...(await optionsResponse(gated.ctx.board, gated.col)),
      canManage: gated.ctx.can('goal.manage'),
    });
  } catch (err) {
    console.error('listGoalColumnOptions error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** POST /api/boards/:boardId/goal-columns/:cid/options — one new choice. */
const addGoalColumnOption = async (req, res) => {
  try {
    const gated = await gateOptions(req, res);
    if (!gated) return undefined;
    const { board } = gated.ctx;
    const { col } = gated;
    const label = String(req.body?.label || '').trim();

    if (!label) return res.status(400).json({ error: 'Give the choice a name.' });

    const options = optionsOf(col);
    if (options.length >= MAX_OPTIONS) {
      return res.status(400).json({ error: `A column can hold ${MAX_OPTIONS} choices.` });
    }

    const clash = options.find((o) => sameLabel(o.label, label));
    if (clash) {
      // A retired twin is offered back rather than duplicated: two chips
      // reading the same word, one of them unpickable, is unreadable on a row.
      return res.status(400).json({
        error: clash.archived
          ? `“${clash.label}” is retired on this column. Restore it instead of adding a second one.`
          : `“${clash.label}” is already a choice here.`,
        restorableId: clash.archived ? String(clash.id) : undefined,
      });
    }

    const next = [...options, {
      id: mintOptionId(col, label),
      label: label.slice(0, 60),
      color: normaliseColor(req.body?.color),
      archived: false,
      order: options.length,
    }];
    writeOptions(col, next);
    await board.save();

    return res.status(201).json(await optionsResponse(board, col));
  } catch (err) {
    console.error('addGoalColumnOption error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/boards/:boardId/goal-columns/:cid/options/reorder — must precede /:oid
 *
 * Reordering is free for the same reason renaming is: the stored value is the
 * id, and `order` only decides what the picker looks like.
 */
const reorderGoalColumnOptions = async (req, res) => {
  try {
    const gated = await gateOptions(req, res);
    if (!gated) return undefined;
    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds must be an array' });
    }
    const index = new Map(orderedIds.map((id, i) => [String(id), i]));
    const next = optionsOf(gated.col).map((o) => {
      const at = index.get(String(o.id));
      return at === undefined ? o : { ...o, order: at };
    });
    writeOptions(gated.col, next);
    await gated.ctx.board.save();
    return res.json(await optionsResponse(gated.ctx.board, gated.col));
  } catch (err) {
    console.error('reorderGoalColumnOptions error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/boards/:boardId/goal-columns/:cid/options/:oid
 *
 * Rename, recolour, retire and restore. The first two touch no goal at all —
 * every row holding this option is keyed by its id and simply renders the new
 * word in the new colour, which is the whole reason the id is what gets stored.
 */
const updateGoalColumnOption = async (req, res) => {
  try {
    const gated = await gateOptions(req, res);
    if (!gated) return undefined;
    const { board } = gated.ctx;
    const { col } = gated;
    const oid = String(req.params.oid);

    const options = optionsOf(col);
    const target = options.find((o) => String(o.id) === oid);
    if (!target) return res.status(404).json({ error: 'That choice is not on this column.' });

    const { label, color, archived } = req.body || {};
    const patch = {};

    if (label !== undefined) {
      const trimmed = String(label).trim();
      if (!trimmed) return res.status(400).json({ error: 'Give the choice a name.' });
      const clash = options.find((o) => String(o.id) !== oid && sameLabel(o.label, trimmed));
      if (clash) {
        return res.status(400).json({
          error: clash.archived
            ? `A retired choice is already called “${clash.label}”.`
            : `“${clash.label}” is already a choice here.`,
        });
      }
      patch.label = trimmed.slice(0, 60);
    }

    if (color !== undefined) patch.color = normaliseColor(color);

    if (archived !== undefined) {
      const next = archived === true;
      // The guard that keeps a required column satisfiable — see the header.
      if (next && col.required && liveOptions(col).filter((o) => String(o.id) !== oid).length === 0) {
        return res.status(400).json({
          error: `“${col.name}” is required, so it has to keep at least one choice. `
            + 'Add another choice first, or turn Required off.',
        });
      }
      if (!next) {
        const clash = options.find(
          (o) => String(o.id) !== oid && !o.archived && sameLabel(o.label, target.label)
        );
        if (clash) {
          return res.status(400).json({
            error: `There is already a live choice called “${clash.label}”. `
              + 'Rename one of them first.',
          });
        }
      }
      patch.archived = next;
    }

    if (Object.keys(patch).length === 0) {
      return res.json(await optionsResponse(board, col));
    }

    writeOptions(col, options.map((o) => (String(o.id) === oid ? { ...o, ...patch } : o)));
    await board.save();

    return res.json(await optionsResponse(board, col));
  } catch (err) {
    console.error('updateGoalColumnOption error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/boards/:boardId/goal-columns/:cid/options/:oid[?purge=true]
 *
 * Three outcomes, described in full in the header of this section. An option
 * nobody uses just goes; one somebody uses comes back with `confirmRequired`
 * and a count, and changes NOTHING until the caller says which of retire or
 * purge it meant.
 */
const deleteGoalColumnOption = async (req, res) => {
  try {
    const gated = await gateOptions(req, res);
    if (!gated) return undefined;
    const { board } = gated.ctx;
    const { col } = gated;
    const oid = String(req.params.oid);

    const options = optionsOf(col);
    const target = options.find((o) => String(o.id) === oid);
    if (!target) return res.status(404).json({ error: 'That choice is not on this column.' });

    // Same guard as retiring, and it applies even to an unused option: a
    // required column with nothing to pick can never be filled in.
    if (col.required && !target.archived
      && liveOptions(col).filter((o) => String(o.id) !== oid).length === 0) {
      return res.status(400).json({
        error: `“${col.name}” is required, so it has to keep at least one choice. `
          + 'Add another choice first, or turn Required off.',
      });
    }

    const usage = await optionUsage(board._id, col._id);
    const usedByCount = usage[oid] || 0;

    if (usedByCount > 0 && req.query.purge !== 'true') {
      return res.json(await optionsResponse(board, col, {
        confirmRequired: true,
        usedByCount,
        columnRequired: col.required === true,
      }));
    }

    // The column list handed to the history, pinned to the vocabulary as it is
    // RIGHT NOW. `goalActivity` resolves the choice's word from this list, and
    // by the time the clear runs the word has been taken off the column — so
    // passing the live subdoc would log the bare id and the one row that
    // explains what a goal lost would be the one row nobody can read.
    const columnsForLog = (board.goalColumns || [])
      .filter((c) => !c.archived)
      .map((c) => (String(c._id) === String(col._id)
        ? { _id: c._id, name: col.name, type: col.type, settings: { options } }
        : c));

    writeOptions(col, options.filter((o) => String(o.id) !== oid));
    await board.save();

    const clearedCount = usedByCount > 0
      ? await clearOptionValues({
        board,
        col,
        optionId: oid,
        actor: req.user.userId,
        columns: columnsForLog,
      })
      : 0;

    return res.json(await optionsResponse(board, col, {
      removed: true,
      clearedCount,
      // What the caller has to warn about next: those goals are now empty in a
      // column the month is waiting on.
      columnRequired: col.required === true,
    }));
  } catch (err) {
    console.error('deleteGoalColumnOption error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const sanitizeOptions = (settings) => {
  const options = Array.isArray(settings?.options) ? settings.options : [];
  return options
    .map((o, i) => ({
      id: String(o?.id || o?.label || i).slice(0, 60),
      label: String(o?.label || '').trim().slice(0, 60),
      color: normaliseColor(o?.color),
      // Carried through rather than dropped: a retired choice that came back as
      // a live one would reappear in every picker on the board the first time
      // anybody renamed the column.
      archived: o?.archived === true,
      order: Number.isFinite(o?.order) ? o.order : i,
    }))
    .filter((o) => o.label)
    .slice(0, MAX_OPTIONS);
};

/**
 * The choices on a BRAND NEW column.
 *
 * Ids are minted HERE rather than accepted from the caller, so every option id
 * on the board has one shape and no caller can hand us two the same. Duplicate
 * labels are dropped for the reason the add-a-choice handler refuses them: a
 * comma list with the same word twice is a typo, and two identical chips on a
 * row cannot be told apart.
 */
const initialOptions = (settings) => {
  const out = [];
  for (const o of sanitizeOptions(settings)) {
    if (out.some((x) => sameLabel(x.label, o.label))) continue;
    out.push({
      ...o,
      id: mintOptionId({ settings: { options: out } }, o.label),
      order: out.length,
    });
  }
  return out;
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
      settings: type === 'dropdown' ? { options: initialOptions(settings) } : {},
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
      // Only reachable for a column that has no choices yet. Editing an
      // existing vocabulary goes through the per-option routes instead, because
      // a whole-list write cannot say which incoming entry is which existing
      // one — and getting that wrong silently orphans every goal pointing at
      // the id it re-minted. Refused rather than accepted-and-hoped-for.
      if (optionsOf(col).length > 0) {
        return res.status(400).json({
          error: 'Edit this column’s choices one at a time — adding, renaming or '
            + 'removing them individually is what keeps the goals already using '
            + 'them attached.',
        });
      }
      writeOptions(col, initialOptions(settings));
    }
    if (required !== undefined) {
      const next = required === true;
      // The same unsatisfiable state the option handlers guard against, reached
      // from the other side: a list column with nothing to pick, marked
      // required, is a permanent block on closing the month that nobody can
      // clear from the goals table.
      if (next && col.type === 'dropdown' && liveOptions(col).length === 0) {
        return res.status(400).json({
          error: `“${col.name}” has no choices to pick from yet, so nobody could `
            + 'fill it in. Add a choice first.',
        });
      }
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
      // A connector field mapped to this column now names an `_id` that no
      // longer exists. Deleted rather than left dangling: the unique partial
      // index on `(board, target.columnId)` would otherwise reserve the dead id
      // forever, and the mapping panel would show a binding to a column nobody
      // can find. ARCHIVING deliberately does NOT do this — an archived column
      // keeps its values and can be restored, so its mapping is worth keeping
      // and the panel flags it instead.
      await ConnectorFieldMapping.deleteMany({
        board: board._id,
        'target.columnId': col._id,
      });
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
  MAX_OPTIONS,
  listGoalColumns,
  addGoalColumn,
  updateGoalColumn,
  reorderGoalColumns,
  deleteGoalColumn,
  // The choices inside one dropdown column — see the section header above.
  listGoalColumnOptions,
  addGoalColumnOption,
  updateGoalColumnOption,
  reorderGoalColumnOptions,
  deleteGoalColumnOption,
};

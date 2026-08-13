/**
 * Monthly goals — the per-group tables on a tracker board's Goals tab.
 *
 * The scoring lives in the pure [utils/goalTypes.js](../utils/goalTypes.js);
 * this file only queries and gates. Every handler runs the same three gates, in
 * this order:
 *
 *   1. loadBoardContext    — can you reach this board at all?
 *   2. requireCapability   — does your role permit it?
 *   3. requireMonthlyBoard — is this a board type that HAS goals?
 *
 * Order matters, exactly as it does in trackerController: someone who cannot
 * reach the board never learns what is on it.
 *
 * THE ONE EXCEPTION to "capability = board capability" is the goal COLUMN
 * schema, which gates on the org-wide `org.manage_settings`. The columns are the
 * organisation's reporting vocabulary — shared by every group on the board and
 * meant to be comparable across clients — not one board owner's preference.
 * A consequence worth knowing before it becomes a support ticket: a board's own
 * creator who is not an org admin cannot edit their own board's goal columns.
 */

const mongoose = require('mongoose');
const Board = require('../models/Board');
const Goal = require('../models/Goal');
const TaskGroup = require('../models/TaskGroup');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const {
  getGoalType, isGoalType, scoreGoal, scoreGroup, scoreBoard,
  missingFinalValues, monthIsUnclosed, describeGoalTypes, UNITS,
} = require('../utils/goalTypes');
const { isMonthKey, monthKeyOf, addMonths, monthKeysBetween } = require('../utils/monthKey');

const NOT_TRACKER = 'This board is not a tracker board.';
const MAX_GOALS_PER_GROUP = 100;
const MAX_TREND_MONTHS = 24;
const MAX_TREND_ROWS = 4000;
const HISTORY_MONTHS = 6;

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/** The three gates, in order. Returns the context, or null having answered. */
const gate = async (req, res, capability) => {
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
  const denied = requireCapability(ctx, capability);
  if (denied) {
    res.status(denied.status).json({ error: denied.error });
    return null;
  }
  // 404, not 403: on a standard board goals do not exist, so there is nothing
  // here to be refused access to.
  if (ctx.board?.boardType !== 'tracker') {
    res.status(404).json({ error: NOT_TRACKER, code: 'NOT_TRACKER_BOARD' });
    return null;
  }
  return ctx;
};

/** Resolve a goal id to its board, then run the normal gates. */
const gateByGoal = async (req, res, capability) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'Invalid goal id' });
    return null;
  }
  const goal = await Goal.findById(id);
  if (!goal) {
    res.status(404).json({ error: 'Goal not found' });
    return null;
  }
  req.params.boardId = String(goal.board);
  const ctx = await gate(req, res, capability);
  if (!ctx) return null;
  return { ctx, goal };
};

/** Non-archived columns, in order. The shape the client renders. */
const liveColumns = (board) =>
  (board.goalColumns || [])
    .filter((c) => !c.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

/** Attach the computed score + any missing-value flags to a lean goal row. */
const decorate = (goal, columns) => ({
  ...goal,
  columnValues: goal.columnValues instanceof Map
    ? Object.fromEntries(goal.columnValues)
    : (goal.columnValues || {}),
  computed: scoreGoal(goal),
  missing: missingFinalValues(goal, columns),
});

/**
 * GET /api/goal-types — the type catalog, for generating the add-a-goal form.
 *
 * Served rather than duplicated on the client so a new goal type arrives in the
 * UI with the right inputs and labels without a second table to keep in sync.
 * Static; safe to cache.
 */
const getGoalTypes = async (req, res) => {
  res.json({ types: describeGoalTypes(), units: UNITS });
};

/**
 * GET /api/boards/:boardId/goals?month=YYYY-MM
 *
 * Everything the tab and three of its four visuals need, in one round trip:
 * the columns, each group's rows with their scores, the group and board
 * roll-ups, and each goal's own recent history for its sparkline.
 */
const getGoals = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'goal.view');
    if (!ctx) return undefined;

    const { board } = ctx;
    const month = req.query.month;
    if (!isMonthKey(month)) {
      return res.status(400).json({ error: 'A month (YYYY-MM) is required' });
    }

    const columns = liveColumns(board);
    const [groups, goals] = await Promise.all([
      TaskGroup.find({ board: board._id }).sort({ order: 1 }).lean(),
      Goal.find({ board: board._id, monthKey: month })
        .sort({ order: 1, createdAt: 1 })
        .populate('owner', 'name profilePic email')
        .lean(),
    ]);

    // Each goal's last few months, for the sparkline. One query for the whole
    // board rather than one per row.
    const since = addMonths(month, -(HISTORY_MONTHS - 1));
    const historyRows = await Goal.find({
      board: board._id,
      monthKey: { $gte: since, $lte: month },
    })
      .select('group nameKey monthKey actual type config unit unitLabel weight actualDayKey')
      .lean();

    const historyBySeries = new Map();
    for (const row of historyRows) {
      const key = `${row.group}:${row.nameKey}`;
      if (!historyBySeries.has(key)) historyBySeries.set(key, []);
      historyBySeries.get(key).push({
        monthKey: row.monthKey,
        actual: row.actual,
        pct: scoreGoal(row).pct,
      });
    }
    for (const series of historyBySeries.values()) {
      series.sort((a, b) => (a.monthKey < b.monthKey ? -1 : 1));
    }

    const byGroup = new Map(groups.map((g) => [String(g._id), []]));
    for (const goal of goals) {
      const list = byGroup.get(String(goal.group));
      if (list) list.push(goal);
    }

    const groupPayloads = groups.map((g) => {
      const rows = (byGroup.get(String(g._id)) || []).map((goal) => {
        const decorated = decorate(goal, columns);
        const series = historyBySeries.get(`${goal.group}:${goal.nameKey}`) || [];
        // A one-point line is a lie; it takes two months to have a trend.
        decorated.history = series.length >= 2 ? series : [];
        return decorated;
      });
      return {
        _id: String(g._id),
        name: g.name,
        order: g.order,
        goals: rows,
        summary: scoreGroup(rows),
      };
    });

    const summary = scoreBoard(groupPayloads.map((g) => g.summary));
    const currentKey = monthKeyOf(new Date(), board.monthTimezone || 'UTC');
    const allRows = groupPayloads.flatMap((g) => g.goals);

    return res.json({
      goals: {
        boardId: String(board._id),
        monthKey: month,
        columns,
        groups: groupPayloads,
        summary,
        unclosed: monthIsUnclosed(month, currentKey, allRows, columns),
        missingCount: allRows.filter((g) => g.missing.length > 0).length,
        canManageColumns: ctx.can('org.manage_settings'),
      },
    });
  } catch (err) {
    console.error('getGoals error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** Validate and normalise the writable parts of a goal payload. */
const buildGoalPatch = (body, board, { partial = false } = {}) => {
  const patch = {};
  const errors = [];

  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) errors.push({ field: 'name', message: 'Give this goal a name.' });
    else patch.name = name.slice(0, 200);
  } else if (!partial) {
    errors.push({ field: 'name', message: 'Give this goal a name.' });
  }

  if (body.type !== undefined) {
    if (!isGoalType(body.type)) {
      errors.push({ field: 'type', message: 'Pick a kind of goal.' });
    } else {
      patch.type = body.type;
    }
  } else if (!partial) {
    errors.push({ field: 'type', message: 'Pick a kind of goal.' });
  }

  if (body.config !== undefined) {
    patch.config = body.config && typeof body.config === 'object' ? body.config : {};
  }

  if (body.unit !== undefined) {
    if (!UNITS.includes(body.unit)) errors.push({ field: 'unit', message: 'Unknown unit.' });
    else patch.unit = body.unit;
  }
  if (body.unitLabel !== undefined) {
    patch.unitLabel = String(body.unitLabel || '').trim().slice(0, 12);
  }
  // Money is USD — the symbol is not the caller's to choose.
  if (patch.unit === 'currency') patch.unitLabel = '$';

  if (body.weight !== undefined) {
    const w = Number(body.weight);
    if (!Number.isFinite(w) || w < 0 || w > 100) {
      errors.push({ field: 'weight', message: 'Importance must be between 0 and 100.' });
    } else {
      patch.weight = w;
    }
  }

  if (body.owner !== undefined) {
    patch.owner = body.owner && isValidId(body.owner) ? body.owner : null;
  }
  if (body.note !== undefined) {
    patch.note = String(body.note || '').slice(0, 2000);
  }

  return { patch, errors };
};

/** Validate the result fields, which `goal.track` may write on their own. */
const buildResultPatch = (body, type) => {
  const patch = {};
  const errors = [];
  const spec = getGoalType(type);

  if (spec.actualField.key === 'actualDayKey') {
    if (body.actualDayKey !== undefined) {
      const v = body.actualDayKey;
      patch.actualDayKey = v === null || v === '' ? null : String(v);
    }
    // A `deadline` goal has no numeric result; ignore a stray `actual`.
  } else if (body.actual !== undefined) {
    const v = body.actual;
    if (v === null || v === '') {
      patch.actual = null;
    } else {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
      if (!Number.isFinite(n)) {
        errors.push({ field: 'actual', message: 'That needs to be a number.' });
      } else {
        patch.actual = n;
      }
    }
  }
  return { patch, errors };
};

/**
 * Mandatory columns. A required column that is empty blocks the save —
 * EXCEPT on a row written before the column became required, which is flagged
 * by `missingFinalValues` instead. `requiredSince` is what makes that
 * distinction storable rather than guessed.
 */
const checkRequiredColumns = (values, board, createdAt) => {
  const errors = [];
  for (const col of board.goalColumns || []) {
    if (!col.required || col.archived) continue;
    if (col.requiredSince && createdAt && new Date(createdAt) < new Date(col.requiredSince)) {
      continue;
    }
    const v = values[String(col._id)];
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
      errors.push({
        field: String(col._id),
        columnId: String(col._id),
        message: `${col.name} is required.`,
      });
    }
  }
  return errors;
};

/** Merge a columnValues patch onto what the goal already has. */
const mergedColumnValues = (existing, incoming) => {
  const base = existing instanceof Map
    ? Object.fromEntries(existing)
    : ({ ...(existing || {}) });
  if (incoming && typeof incoming === 'object') {
    for (const [k, v] of Object.entries(incoming)) base[k] = v;
  }
  return base;
};

/** POST /api/boards/:boardId/goals */
const createGoal = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'goal.manage');
    if (!ctx) return undefined;
    const { board } = ctx;
    const body = req.body || {};

    if (!isMonthKey(body.monthKey)) {
      return res.status(400).json({ error: 'A month (YYYY-MM) is required' });
    }
    if (!isValidId(body.group)) {
      return res.status(400).json({ error: 'A group is required' });
    }
    const group = await TaskGroup.findOne({ _id: body.group, board: board._id }).lean();
    if (!group) return res.status(400).json({ error: 'That group is not on this board' });

    const count = await Goal.countDocuments({
      board: board._id, group: body.group, monthKey: body.monthKey,
    });
    if (count >= MAX_GOALS_PER_GROUP) {
      return res.status(400).json({
        error: `A group can hold ${MAX_GOALS_PER_GROUP} goals in one month.`,
      });
    }

    const { patch, errors } = buildGoalPatch(body, board);
    if (patch.type) {
      const configError = getGoalType(patch.type).validateConfig(patch.config || {});
      if (configError) errors.push({ field: 'config', message: configError });
    }

    const columnValues = mergedColumnValues({}, body.columnValues);
    errors.push(...checkRequiredColumns(columnValues, board, new Date()));
    if (errors.length > 0) return res.status(422).json({ error: errors[0].message, errors });

    const last = await Goal.findOne({ board: board._id, group: body.group, monthKey: body.monthKey })
      .sort({ order: -1 }).select('order').lean();

    const result = buildResultPatch(body, patch.type);
    if (result.errors.length > 0) {
      return res.status(422).json({ error: result.errors[0].message, errors: result.errors });
    }

    const goal = await Goal.create({
      ...patch,
      ...result.patch,
      board: board._id,
      organisation: board.organisation,
      group: body.group,
      monthKey: body.monthKey,
      columnValues,
      order: (last?.order ?? -1) + 1,
      createdBy: req.user.userId,
    });

    const lean = goal.toObject();
    return res.status(201).json({ goal: decorate(lean, liveColumns(board)) });
  } catch (err) {
    console.error('createGoal error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/goals/:id
 *
 * Gated on WHAT is being changed, not just who is asking: a payload touching
 * only the result fields needs `goal.track`, anything that redefines the goal
 * needs `goal.manage`. That split is the whole reason `goal.track` exists.
 */
const RESULT_ONLY_FIELDS = new Set(['actual', 'actualDayKey', 'columnValues']);

const updateGoal = async (req, res) => {
  try {
    const body = req.body || {};
    const touched = Object.keys(body);
    const resultOnly = touched.length > 0 && touched.every((k) => RESULT_ONLY_FIELDS.has(k));

    const loaded = await gateByGoal(req, res, resultOnly ? 'goal.track' : 'goal.manage');
    if (!loaded) return undefined;
    const { ctx, goal } = loaded;
    const { board } = ctx;

    const { patch, errors } = buildGoalPatch(body, board, { partial: true });
    const effectiveType = patch.type || goal.type;

    if (patch.config !== undefined || patch.type !== undefined) {
      const config = patch.config !== undefined ? patch.config : goal.config;
      const configError = getGoalType(effectiveType).validateConfig(config || {});
      if (configError) errors.push({ field: 'config', message: configError });
    }

    const result = buildResultPatch(body, effectiveType);
    errors.push(...result.errors);

    let columnValues;
    if (body.columnValues !== undefined) {
      columnValues = mergedColumnValues(goal.columnValues, body.columnValues);
      errors.push(...checkRequiredColumns(columnValues, board, goal.createdAt));
    }

    if (errors.length > 0) return res.status(422).json({ error: errors[0].message, errors });

    Object.assign(goal, patch, result.patch);
    if (columnValues) goal.columnValues = columnValues;
    goal.updatedBy = req.user.userId;
    await goal.save();

    const columns = liveColumns(board);
    // Return the whole group's recomputed summary too, so the score ring and the
    // roll-up strip update from this response rather than a second fetch.
    const siblings = await Goal.find({
      board: board._id, group: goal.group, monthKey: goal.monthKey,
    }).lean();

    return res.json({
      goal: decorate(goal.toObject(), columns),
      groupSummary: scoreGroup(siblings.map((s) => decorate(s, columns))),
    });
  } catch (err) {
    console.error('updateGoal error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** DELETE /api/goals/:id */
const deleteGoal = async (req, res) => {
  try {
    const loaded = await gateByGoal(req, res, 'goal.manage');
    if (!loaded) return undefined;
    await Goal.deleteOne({ _id: loaded.goal._id });
    return res.json({ deleted: true });
  } catch (err) {
    console.error('deleteGoal error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** PUT /api/boards/:boardId/goals/reorder — body { orderedIds } */
const reorderGoals = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'goal.manage');
    if (!ctx) return undefined;
    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds must be an array' });
    }
    const goals = await Goal.find({ _id: { $in: orderedIds }, board: ctx.board._id })
      .select('_id').lean();
    if (goals.length !== orderedIds.length) {
      return res.status(400).json({ error: 'One or more goals are not on this board' });
    }
    await Goal.bulkWrite(
      orderedIds.map((id, idx) => ({
        updateOne: { filter: { _id: id }, update: { $set: { order: idx } } },
      }))
    );
    return res.json({ reordered: orderedIds.length });
  } catch (err) {
    console.error('reorderGoals error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/boards/:boardId/goals/trend?months=12&through=YYYY-MM
 *
 * Each group's score month by month, for the trend chart. Computed on demand
 * rather than materialised, for the same reason the Delivery grid is: a stored
 * score goes stale the instant a weight or a target changes.
 */
const getGoalTrend = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'goal.view');
    if (!ctx) return undefined;
    const { board } = ctx;

    const through = isMonthKey(req.query.through)
      ? req.query.through
      : monthKeyOf(new Date(), board.monthTimezone || 'UTC');
    const requested = parseInt(req.query.months, 10);
    const months = Math.max(1, Math.min(MAX_TREND_MONTHS, Number.isFinite(requested) ? requested : 12));
    const from = addMonths(through, -(months - 1));

    const count = await Goal.countDocuments({
      board: board._id, monthKey: { $gte: from, $lte: through },
    });
    if (count > MAX_TREND_ROWS) {
      return res.status(400).json({
        error: 'That range covers too many goals to chart. Try fewer months.',
      });
    }

    const [groups, rows] = await Promise.all([
      TaskGroup.find({ board: board._id }).sort({ order: 1 }).select('name order').lean(),
      Goal.find({ board: board._id, monthKey: { $gte: from, $lte: through } })
        .select('group monthKey type config actual actualDayKey weight')
        .lean(),
    ]);

    const keys = monthKeysBetween(from, through);
    const bucket = new Map(); // `${group}:${month}` -> goals[]
    for (const row of rows) {
      const k = `${row.group}:${row.monthKey}`;
      if (!bucket.has(k)) bucket.set(k, []);
      bucket.get(k).push(row);
    }

    const series = groups.map((g) => ({
      _id: String(g._id),
      name: g.name,
      points: keys.map((monthKey) => {
        const goals = bucket.get(`${g._id}:${monthKey}`) || [];
        const s = scoreGroup(goals);
        return { monthKey, score: s.pct, scoredCount: s.scoredCount, totalCount: s.totalCount };
      }),
    }));

    const boardPoints = keys.map((monthKey) => {
      const summaries = groups.map((g) => scoreGroup(bucket.get(`${g._id}:${monthKey}`) || []));
      const s = scoreBoard(summaries);
      return { monthKey, score: s.pct, groupsScored: s.groupsScored };
    });

    return res.json({ trend: { months: keys, groups: series, board: boardPoints } });
  } catch (err) {
    console.error('getGoalTrend error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  gate,
  getGoalTypes,
  getGoals,
  createGoal,
  updateGoal,
  deleteGoal,
  reorderGoals,
  getGoalTrend,
  liveColumns,
  decorate,
};

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
 * The goal COLUMN schema (see goalColumnController) gates on `goal.manage`, the
 * same rung that sets a goal's target. It used to gate on the org-wide
 * `org.manage_settings`, which meant a board's own creator could define every
 * goal on it and still not add a column to hold them. That was the support
 * ticket the old comment here predicted, so the gate moved rather than the
 * explanation.
 */

const mongoose = require('mongoose');
const ActivityLog = require('../models/ActivityLog');
const Board = require('../models/Board');
const Goal = require('../models/Goal');
const GoalConnectorLink = require('../models/GoalConnectorLink');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const { isResolvedStatus } = require('../utils/doneStatus');
const {
  linkedGoalIds,
  isDismissed,
  isAttachable,
  staleReasonsFor,
  foldEvidenceByGroup,
} = require('../utils/goalEvidence');

const User = require('../models/User');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const {
  snapshotGoal, logGoalCreated, logGoalDeleted, logGoalChanges,
} = require('../services/goalActivity');
// Value resolution is shared with the task feed and the board activity export,
// so one goal edit cannot be described three different ways.
const { resolveFieldValue, collectUserIds } = require('../services/activityFormat');
const {
  getGoalType, isGoalType, scoreGoal, scoreGroup, scoreBoard,
  missingFinalValues, monthIsUnclosed, describeGoalTypes,
  normaliseGoalVocabulary, UNITS,
} = require('../utils/goalTypes');
const {
  isMonthKey, monthKeyOf, addMonths, monthKeysBetween, monthsBetween, formatMonth,
} = require('../utils/monthKey');
const { planCarryForward } = require('../services/goalCarryForward');
const { mergeGoalOrder, isOneTable } = require('../utils/goalOrdering');
const { resolveOwnerDisplay, EMPTY_OWNER_DISPLAY } = require('../services/groupOwnerDisplay');

const NOT_TRACKER = 'This board is not a tracker board.';
const MAX_GOALS_PER_GROUP = 100;
const MAX_TREND_MONTHS = 24;
const MAX_TREND_ROWS = 4000;
const HISTORY_MONTHS = 6;
/** Page size for the per-goal history panel, mirroring the task activity feed. */
const MAX_ACTIVITY_PAGE = 100;
const DEFAULT_ACTIVITY_PAGE = 50;

/**
 * The three people a goal row names, populated the same way in every response.
 *
 * `createdBy` was already being STORED and never returned, which made "who set
 * this target?" a question only the database could answer. The Goals tab shows
 * it, and the history panel leads with it.
 */
const PEOPLE_FIELDS = 'name profilePic email';
const POPULATE_PEOPLE = [
  { path: 'owner', select: PEOPLE_FIELDS },
  { path: 'createdBy', select: PEOPLE_FIELDS },
  { path: 'updatedBy', select: PEOPLE_FIELDS },
];
/** Queries take the array as-is; a saved document takes the same array. */
const populatePeople = (query) => query.populate(POPULATE_PEOPLE);

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

/**
 * Reshaping a goal: `goal.manage` for anyone's, or `goal.create` for your own.
 *
 * The two-tier rule mirrors `task.edit_assigned` vs `task.edit_any`, and it is
 * what makes `goal.create` usable rather than a trap. Create-only would let an
 * executive write a goal and then be unable to fix a typo in it — so the rung
 * that can add a goal can also correct and remove the goals it added, and
 * nothing else.
 *
 * BOTH CAPABILITIES ARE TESTED IN MEMORY, against one loaded context, rather
 * than by calling `gate` twice. `gate` ANSWERS on refusal — it writes the 403
 * itself — so a first failed check would both send a response and make the
 * second check unreachable. Asking `ctx.can` twice has neither problem and costs
 * one board load instead of two.
 *
 * `goal.manage` is checked FIRST and, when held, skips the ownership test
 * entirely: a board editor must never be refused a goal because somebody else
 * wrote it. Only then does ownership decide, and that refusal gets a sentence of
 * its own rather than the generic capability message, because "you may add
 * goals, just not change THIS one" is the genuinely confusing case.
 */
const gateGoalWrite = async (req, res) => {
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
  const ctx = await loadBoardContext(String(goal.board), req.user.userId);
  if (ctx.error) {
    res.status(ctx.status).json({ error: ctx.error });
    return null;
  }
  if (ctx.board?.boardType !== 'tracker') {
    res.status(404).json({ error: NOT_TRACKER, code: 'NOT_TRACKER_BOARD' });
    return null;
  }

  if (ctx.can('goal.manage')) return { ctx, goal };

  if (!ctx.can('goal.create')) {
    const denied = requireCapability(ctx, 'goal.manage');
    res.status(denied?.status || 403).json({
      error: denied?.error || 'You do not have permission to change goals.',
    });
    return null;
  }
  if (String(goal.createdBy || '') !== String(req.user.userId)) {
    res.status(403).json({
      error: 'You can change goals you added yourself. This one was added by '
        + 'someone else — ask a board editor to change it.',
    });
    return null;
  }
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
 * GET /api/goal-types[?vocabulary=ads] — the type catalog, for generating the
 * add-a-goal form.
 *
 * Served rather than duplicated on the client so a new goal type arrives in the
 * UI with the right inputs and labels without a second table to keep in sync.
 *
 * `vocabulary` is WORDING ONLY — it renames types and swaps their examples, and
 * cannot change what any type is scored by (`goalTypes.test.js` asserts that).
 * That is why it is taken from the query string rather than resolved from a
 * board id: there is nothing here to authorise. A board id would buy a lookup,
 * an access check and a 403 path on a catalog endpoint, in exchange for
 * protecting a set of English sentences the client is about to render anyway.
 *
 * An unrecognised value falls back to the default wording rather than 400ing,
 * so a client left open across a deploy that removed a vocabulary still gets a
 * usable form instead of a broken tab. Still cacheable — but per vocabulary,
 * which is why it is echoed back in the response.
 */
const getGoalTypes = async (req, res) => {
  const vocabulary = normaliseGoalVocabulary(req.query.vocabulary);
  res.json({ types: describeGoalTypes(vocabulary), units: UNITS, vocabulary });
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
      populatePeople(
        Goal.find({ board: board._id, monthKey: month }).sort({ order: 1, createdAt: 1 })
      ).lean(),
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

    // Who owns each group in THIS month — the same fact the Board tab shows on
    // the same group, resolved through the same service so the two tabs cannot
    // disagree about it. Resolved against the requested month, not today's, so
    // looking back at March credits whoever held the group in March.
    const ownerDisplay = await resolveOwnerDisplay(groups, month, ctx.org);

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
        ...(ownerDisplay.get(String(g._id)) || EMPTY_OWNER_DISPLAY),
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
        canManageColumns: ctx.can('goal.manage'),
      },
    });
  } catch (err) {
    console.error('getGoals error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * A config with its blanks REMOVED rather than stored as empty strings.
 *
 * The add-a-goal form sends `''` for a number field the user cleared, and the
 * inline cells send `null`. Both mean "not set", and both must land as an ABSENT
 * key — `isNum('')` is false, so an empty string scores as a missing baseline
 * anyway, and letting it persist leaves the row's own config disagreeing with
 * every check that asks whether the field is there. A real 0 is a value and
 * survives; only genuinely empty entries are dropped.
 */
const cleanConfig = (config) => {
  if (!config || typeof config !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined || value === '') continue;
    out[key] = value;
  }
  return out;
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
    patch.config = cleanConfig(body.config);
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

/**
 * A unit belongs to the goal's TYPE, not to whoever last touched the form.
 *
 * "Did we do it?", a checklist, a deadline and a rating have nothing to put a
 * unit on, so switching a currency goal to one of them must drop the unit with
 * it — otherwise a list of eight blog posts starts reporting itself as $8.
 */
const applyUnitRules = (patch, type) => {
  if (!isGoalType(type) || getGoalType(type).supportsUnit) return;
  patch.unit = 'none';
  patch.unitLabel = '';
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
    // `goal.create`, not `goal.manage` — writing down what you are aiming for on
    // the client you run is your own work. `contribute` confers it, so an
    // executive on a board left at the default rung can finally add a goal
    // instead of only reporting against one somebody else wrote.
    const ctx = await gate(req, res, 'goal.create');
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
      applyUnitRules(patch, patch.type);
    }

    const columnValues = mergedColumnValues({}, body.columnValues);
    errors.push(...checkRequiredColumns(columnValues, board, new Date()));
    if (errors.length > 0) return res.status(422).json({ error: errors[0].message, errors });

    const last = await Goal.findOne({ board: board._id, group: body.group, monthKey: body.monthKey })
      .sort({ order: -1 }).select('order').lean();

    // A brand-new goal is a PROMISE, never a result: `actual` / `actualDayKey`
    // stay null until somebody reports the month, which is what makes the row
    // read "Not yet" and keeps it out of the reported count. A result sent at
    // creation time is dropped rather than honoured — reporting is `goal.track`
    // work and goes through PUT /api/goals/:id.
    const goal = await Goal.create({
      ...patch,
      actual: null,
      actualDayKey: null,
      board: board._id,
      organisation: board.organisation,
      group: body.group,
      monthKey: body.monthKey,
      columnValues,
      order: (last?.order ?? -1) + 1,
      createdBy: req.user.userId,
    });

    // Who promised this, and what they promised. Awaited rather than left to
    // settle on its own, so opening the history panel on a goal added seconds
    // ago cannot show an empty timeline. `logActivity` swallows its own
    // failures, so waiting for it can never fail the create.
    await logGoalCreated({
      goal,
      actor: req.user.userId,
      groupName: group.name,
    });

    await goal.populate(POPULATE_PEOPLE);
    const lean = goal.toObject();
    return res.status(201).json({ goal: decorate(lean, liveColumns(board)) });
  } catch (err) {
    console.error('createGoal error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** Ceilings on one carry: how many rows, and how far across the calendar. */
const CARRY_MAX_GOALS = 500;
const CARRY_MAX_MONTHS = 24;

/**
 * POST /api/boards/:boardId/goals/carry-forward
 *
 * Body: { fromMonth, toMonth, goalIds?, rollBaseline?, carryLinks?, dryRun? }
 *
 * Copy a month's PROMISES into another month — by default this month's into
 * next month's, which is the only reason anybody opens it. Deliberately a
 * request somebody makes rather than a job that runs: see the header of
 * [services/goalCarryForward.js](../services/goalCarryForward.js) for why a
 * self-renewing goal is not a goal.
 *
 * `goal.manage`, because every row it writes is a new promise — the same rung
 * as typing one in by hand, and emphatically not the `goal.track` rung that only
 * fills in what a month ended on.
 *
 * `dryRun` runs the identical plan and writes nothing, which is what the modal
 * previews. One planner, so the sentence the user reads before confirming is
 * produced by the code that will actually do the work — a preview computed
 * separately on the client is a second implementation of the duplicate rule,
 * and the two would disagree the first time a goal was renamed.
 */
const carryForwardGoals = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'goal.manage');
    if (!ctx) return undefined;
    const { board } = ctx;
    const body = req.body || {};

    const fromMonth = body.fromMonth;
    const toMonth = body.toMonth;
    if (!isMonthKey(fromMonth) || !isMonthKey(toMonth)) {
      return res.status(400).json({ error: 'Both months (YYYY-MM) are required' });
    }
    if (fromMonth === toMonth) {
      return res.status(400).json({ error: 'Pick a different month to copy into.' });
    }

    // Bounded so a stray payload cannot ask for a hundred years of copies. The
    // window is generous in both directions on purpose: copying backwards to
    // fill in a month somebody forgot is a real thing people do.
    const monthDelta = monthsBetween(fromMonth, toMonth);
    if (!Number.isInteger(monthDelta) || Math.abs(monthDelta) > CARRY_MAX_MONTHS) {
      return res.status(400).json({
        error: `Goals can only be carried up to ${CARRY_MAX_MONTHS} months away.`,
      });
    }

    // An explicit selection, or the whole month. Validated as ids before it
    // reaches a query, and scoped to this board and this month by the filter —
    // an id from another board simply finds nothing.
    let selection = null;
    if (body.goalIds !== undefined) {
      if (!Array.isArray(body.goalIds) || !body.goalIds.every(isValidId)) {
        return res.status(400).json({ error: 'goalIds must be an array of goal ids' });
      }
      if (body.goalIds.length === 0) {
        return res.status(400).json({ error: 'Pick at least one goal to carry forward.' });
      }
      selection = body.goalIds;
    }

    const sourceFilter = { board: board._id, monthKey: fromMonth };
    if (selection) sourceFilter._id = { $in: selection };

    const [sourceGoals, targetGoals, groups] = await Promise.all([
      Goal.find(sourceFilter).sort({ order: 1, createdAt: 1 }).lean(),
      Goal.find({ board: board._id, monthKey: toMonth })
        .select('group nameKey name order').lean(),
      TaskGroup.find({ board: board._id }).sort({ order: 1 }).select('name order').lean(),
    ]);

    if (sourceGoals.length === 0) {
      return res.status(400).json({
        error: `There are no goals in ${formatMonth(fromMonth, { long: true })} to carry forward.`,
      });
    }
    if (sourceGoals.length > CARRY_MAX_GOALS) {
      return res.status(400).json({
        error: `That is more than ${CARRY_MAX_GOALS} goals. Carry them a few groups at a time.`,
      });
    }

    const columns = liveColumns(board);
    const { copies, skipped } = planCarryForward({
      sourceGoals,
      targetGoals,
      groups,
      columns,
      toMonth,
      monthDelta,
      rollBaseline: body.rollBaseline === true,
      maxPerGroup: MAX_GOALS_PER_GROUP,
    });

    // Whether the keyword wiring travels too, and whether this person is
    // allowed to move it. Pointing a goal at a tracked keyword is
    // `connector.manage` — the same rung `setGoalLink` is on — so somebody who
    // can define goals but not touch connectors carries the goals and is TOLD
    // the links stayed behind, rather than silently getting half a board.
    const wantsLinks = body.carryLinks !== false;
    const canLink = !!ctx.can('connector.manage');
    const linksTravel = wantsLinks && canLink;
    const sourceIds = copies.map((c) => c.sourceId);
    // Looked up even when they cannot travel, so "the links stayed behind" is
    // said only where there were links to leave behind. A tracker board with no
    // connector at all must not be warned about connector wiring.
    const sourceLinks = wantsLinks && sourceIds.length
      ? await GoalConnectorLink.find({ goal: { $in: sourceIds } }).lean()
      : [];
    const linksBySource = new Map(sourceLinks.map((l) => [String(l.goal), l]));

    const plan = copies.map((c) => ({
      sourceId: c.sourceId,
      name: c.name,
      group: String(c.group),
      groupName: c.groupName,
      type: c.type,
      hasLink: linksBySource.has(c.sourceId),
    }));

    const linkReport = {
      carried: linksTravel ? linksBySource.size : 0,
      // Named so the modal can say WHY none travelled rather than leaving a
      // connector board's owner wondering where their wiring went.
      blocked: wantsLinks && !canLink && linksBySource.size > 0,
    };

    if (body.dryRun === true) {
      return res.json({
        fromMonth,
        toMonth,
        dryRun: true,
        copied: 0,
        plan,
        skipped,
        links: linkReport,
      });
    }

    if (copies.length === 0) {
      return res.json({
        fromMonth, toMonth, copied: 0, plan, skipped, links: { carried: 0, blocked: false },
      });
    }

    // Ordered, so a row that somehow fails schema validation stops the batch
    // rather than scattering half a month. Partial is survivable here in a way
    // it is not elsewhere: the carry is idempotent by name, so running it again
    // finishes the job and copies nothing twice.
    const created = await Goal.insertMany(
      copies.map((c) => ({
        board: board._id,
        organisation: board.organisation,
        group: c.group,
        monthKey: c.monthKey,
        name: c.name,
        type: c.type,
        config: c.config,
        unit: c.unit,
        unitLabel: c.unitLabel,
        weight: c.weight,
        owner: c.owner,
        note: c.note,
        columnValues: c.columnValues,
        order: c.order,
        actual: null,
        actualDayKey: null,
        createdBy: req.user.userId,
      }))
    );

    // The links, pointed at the NEW rows. `applied` / `suggested` / `claimedAt`
    // are deliberately not copied: provenance is a fact about what a connector
    // did to ONE month's row, and inheriting August's claim would let the next
    // run overwrite a September cell it has never written. A fresh link with no
    // claim is exactly the day-one case `claimedAt` was designed for.
    let linksCarried = 0;
    if (linksTravel && linksBySource.size > 0) {
      const rows = [];
      created.forEach((doc, i) => {
        const src = linksBySource.get(copies[i].sourceId);
        if (!src) return;
        rows.push({
          goal: doc._id,
          board: board._id,
          organisation: board.organisation,
          group: doc.group,
          monthKey: doc.monthKey,
          provider: src.provider,
          project: src.project || null,
          keyword: src.keyword ?? null,
          variant: src.variant ?? null,
          autoFill: src.autoFill !== false,
          linkedBy: req.user.userId,
          updatedBy: req.user.userId,
        });
      });
      if (rows.length) {
        // `ordered: false` so one link that cannot be written — a project
        // unmapped since, most likely — does not strand the rest. The goals are
        // already saved either way, and a missing link is re-makeable in the
        // modal; a half-written month is not.
        const inserted = await GoalConnectorLink.insertMany(rows, { ordered: false })
          .catch((err) => {
            console.error('carryForwardGoals: some links did not carry', err?.message);
            // Report what DID land rather than zero. `ordered: false` keeps
            // going past a bad row, and telling somebody nothing carried when
            // twenty-five links did is how they redo work that is already done.
            return err?.insertedDocs || [];
          });
        linksCarried = inserted.length;
      }
    }

    // One `goal.created` row per copy, carrying the same promise the goal does —
    // so the new month's history opens with what was committed to and who
    // committed to it, exactly as a hand-typed goal's does. Awaited for the
    // same reason `createGoal` awaits its own: a history panel opened seconds
    // later must not be empty. `logActivity` swallows its own failures.
    await Promise.all(created.map((doc, i) => logGoalCreated({
      goal: doc,
      actor: req.user.userId,
      groupName: copies[i].groupName,
    })));

    return res.json({
      fromMonth,
      toMonth,
      copied: created.length,
      plan,
      skipped,
      links: { carried: linksCarried, blocked: linkReport.blocked },
    });
  } catch (err) {
    console.error('carryForwardGoals error:', err);
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

    // Reporting a result is `goal.track` on ANY goal — that is the whole point
    // of the rung, and it is unchanged. Reshaping one (its name, target, weight,
    // columns) is `goal.manage` for anyone's, or `goal.create` for your own.
    const loaded = resultOnly
      ? await gateByGoal(req, res, 'goal.track')
      : await gateGoalWrite(req, res);
    if (!loaded) return undefined;
    const { ctx, goal } = loaded;
    const { board } = ctx;

    const { patch, errors } = buildGoalPatch(body, board, { partial: true });
    const effectiveType = patch.type || goal.type;
    // The form re-sends `type` on every edit, so "was it touched" is not the
    // question — "did it actually change" is.
    const typeChanged = patch.type !== undefined && patch.type !== goal.type;

    if (patch.config !== undefined || patch.type !== undefined) {
      const config = patch.config !== undefined ? patch.config : goal.config;
      const configError = getGoalType(effectiveType).validateConfig(config || {});
      if (configError) errors.push({ field: 'config', message: configError });
    }
    applyUnitRules(patch, effectiveType);

    const result = buildResultPatch(body, effectiveType);
    errors.push(...result.errors);

    let columnValues;
    if (body.columnValues !== undefined) {
      columnValues = mergedColumnValues(goal.columnValues, body.columnValues);
      errors.push(...checkRequiredColumns(columnValues, board, goal.createdAt));
    }

    if (errors.length > 0) return res.status(422).json({ error: errors[0].message, errors });

    // The before-image, taken while the document still holds the old values.
    // Everything after this line mutates `goal` in place, so there is no second
    // chance to read what it used to say.
    const before = snapshotGoal(goal);

    Object.assign(goal, patch);
    // A result belongs to the goal it was recorded against. Change the KIND of
    // goal and the old number stops meaning anything: 4,200 recorded against
    // "move a number" is not a Yes/No answer, and the boolean scorer would read
    // it as a silent "No" rather than as the unanswered question it now is. The
    // same request may supply a fresh result, which wins.
    if (typeChanged) {
      goal.actual = null;
      goal.actualDayKey = null;
    }
    Object.assign(goal, result.patch);
    if (columnValues) goal.columnValues = columnValues;
    goal.updatedBy = req.user.userId;
    await goal.save();

    const columns = liveColumns(board);
    // One row per field that actually MOVED — the edit form re-sends every
    // field on every save, so "was it sent" is not the question.
    await logGoalChanges({
      goal,
      before,
      columns,
      actor: req.user.userId,
    });
    // Return the whole group's recomputed summary too, so the score ring and the
    // roll-up strip update from this response rather than a second fetch.
    const siblings = await Goal.find({
      board: board._id, group: goal.group, monthKey: goal.monthKey,
    }).lean();

    // Hydrated the same way the tab's own read is, so patching a cell cannot
    // replace a named creator on the row with a bare id.
    await goal.populate(POPULATE_PEOPLE);

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
    const loaded = await gateGoalWrite(req, res);
    if (!loaded) return undefined;

    // Logged BEFORE the delete, while there is still a goal to describe. The
    // row outlives the goal deliberately — "who removed the target we were
    // being measured against" is the single most useful thing in this log, and
    // it is the one event with no document left to ask afterwards.
    await logGoalDeleted({ goal: loaded.goal, actor: req.user.userId });

    await Goal.deleteOne({ _id: loaded.goal._id });
    // The connector link goes with it. Unlike a mirrored project — which is
    // unbound and kept, because it parents a rank history worth more than the
    // mapping — a link is nothing but a reference to this row plus the record of
    // which of its cells the connector owned. With the row gone there is nothing
    // for either half to be about.
    await GoalConnectorLink.deleteOne({ goal: loaded.goal._id });
    // Evidence links go too. A task keeps its link when it is reopened or
    // refiled — that drift is flagged, not corrected — but a link to a goal
    // that no longer exists is not drift, it is a dangling reference, and the
    // chip that counts it would be counting nothing.
    await Task.updateMany(
      { board: loaded.goal.board, 'goalLinks.goal': loaded.goal._id },
      { $pull: { goalLinks: { goal: loaded.goal._id } } }
    );
    return res.json({ deleted: true });
  } catch (err) {
    console.error('deleteGoal error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/goals/:id/activity?cursor=<isoDate>&limit=50
 *
 * One goal's history: who set the target, who moved it, and who typed in the
 * number at the end of the month. `goal.view` — the same rung that lets you see
 * the row at all, because there is nothing here that is not already on it.
 *
 * The response leads with `createdBy` / `updatedBy` rather than making the
 * panel infer them from the oldest row. Goals created before this log existed
 * have no `goal.created` row to find, and the stamp on the document is the only
 * honest answer for them.
 */
const getGoalActivity = async (req, res) => {
  try {
    const loaded = await gateByGoal(req, res, 'goal.view');
    if (!loaded) return undefined;
    const { ctx, goal } = loaded;

    const requested = parseInt(req.query.limit, 10);
    const limit = Math.min(
      Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_ACTIVITY_PAGE,
      MAX_ACTIVITY_PAGE
    );

    const filter = { goal: goal._id };
    if (req.query.cursor) {
      const cursorDate = new Date(req.query.cursor);
      if (!isNaN(cursorDate.getTime())) filter.createdAt = { $lt: cursorDate };
    }

    // +1 to detect another page without a second count query.
    const raw = await ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = raw.length > limit;
    const slice = hasMore ? raw.slice(0, limit) : raw;

    await goal.populate(POPULATE_PEOPLE);

    // The log's own actors, plus the two people stamped on the document — who
    // are frequently nobody who appears in this page of events.
    const userIds = new Set(collectUserIds(slice));
    const users = userIds.size
      ? await User.find({ _id: { $in: [...userIds] } })
        .select(PEOPLE_FIELDS)
        .lean()
      : [];
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const items = slice.map((e) => {
      const actorDoc = e.actor ? userMap.get(e.actor.toString()) : null;
      let actor;
      if (actorDoc) {
        actor = { _id: actorDoc._id, name: actorDoc.name, profilePic: actorDoc.profilePic };
      } else if (e.actorType === 'system') {
        // Nobody was behind it. Named rather than blanked: "Ubersuggest filled
        // this in" is the whole answer to why a number moved overnight.
        actor = { _id: null, name: e.actorLabel || 'Automatic', profilePic: null, isSystem: true };
      } else if (e.actorType === 'client') {
        actor = { _id: null, name: e.actorLabel || 'Client', profilePic: null, isClient: true };
      } else {
        actor = { _id: e.actor, name: 'Unknown', profilePic: null };
      }
      return {
        _id: e._id,
        type: e.type,
        field: e.field,
        oldValue: resolveFieldValue(e.field, e.oldValue, ctx.board, userMap, e),
        newValue: resolveFieldValue(e.field, e.newValue, ctx.board, userMap, e),
        metadata: e.metadata,
        actor,
        createdAt: e.createdAt,
      };
    });

    return res.json({
      goal: {
        _id: String(goal._id),
        name: goal.name,
        monthKey: goal.monthKey,
        type: goal.type,
        createdBy: goal.createdBy || null,
        updatedBy: goal.updatedBy || null,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
      },
      items,
      nextCursor: hasMore ? slice[slice.length - 1].createdAt.toISOString() : null,
    });
  } catch (err) {
    console.error('getGoalActivity error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:boardId/goals/reorder — body { orderedIds }
 *
 * The order one group's goals sit in, for EVERYONE. Stored on the rows rather
 * than in the mover's browser, because "put the keyword we actually care about
 * at the top" is a statement about the client's month, not about one person's
 * screen — the whole reason this is a write and not a localStorage key.
 *
 * `goal.manage`, alongside creating and redefining a goal: someone who can only
 * fill in this month's numbers is not rewriting the table those numbers sit in.
 *
 * ONE TABLE PER CALL. The read buckets goals by group, so `order` only ever
 * means anything within a single (group, month) — a list spanning two of them
 * has no single ordering to write, and quietly writing one would shuffle a
 * table the user was not even looking at.
 */
const reorderGoals = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'goal.manage');
    if (!ctx) return undefined;

    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: 'orderedIds must be a non-empty array' });
    }
    if (!orderedIds.every(isValidId)) {
      return res.status(400).json({ error: 'orderedIds must all be goal ids' });
    }

    const requested = await Goal.find({ _id: { $in: orderedIds }, board: ctx.board._id })
      .select('_id group monthKey').lean();
    if (requested.length !== new Set(orderedIds.map(String)).size) {
      return res.status(400).json({ error: 'One or more goals are not on this board' });
    }
    if (!isOneTable(requested)) {
      return res.status(400).json({
        error: 'Goals can only be reordered within one group and one month.',
      });
    }

    const { group, monthKey } = requested[0];
    // The table as it stands RIGHT NOW, in its current order — so a goal added
    // while the mover's tab sat open lands at the end instead of colliding on
    // order 0 with every other row. See utils/goalOrdering.js.
    const live = await Goal.find({ board: ctx.board._id, group, monthKey })
      .select('_id').sort({ order: 1, createdAt: 1 }).lean();

    const finalIds = mergeGoalOrder(orderedIds, live.map((g) => g._id));

    await Goal.bulkWrite(
      finalIds.map((id, idx) => ({
        updateOne: { filter: { _id: id }, update: { $set: { order: idx } } },
      }))
    );

    return res.json({
      reordered: finalIds.length,
      group: String(group),
      monthKey,
      orderedIds: finalIds,
    });
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


/**
 * The month's tasks, in the shape every evidence read needs: enough to test
 * done-ness and to derive staleness, and nothing else. `parent: null` because
 * subitems carry no evidence; personal tasks are never on a board anyway but
 * the filter is cheap and says so out loud.
 */
const evidenceTasksFor = (boardId, monthKey) =>
  Task.find({
    board: boardId,
    monthKey,
    parent: null,
    isPersonal: { $ne: true },
  })
    .select('_id name group status monthKey goalLinks goalLinkDismissedAt assignedTo')
    .lean();

/**
 * GET /api/boards/:boardId/goals/evidence?month=YYYY-MM
 *
 * How much work was attached to each goal this month, and how well each group
 * is keeping up. `goal.view` — it is a fact about the board, same as the scores.
 *
 * DELIBERATELY NOT FOLDED INTO getGoals. That handler is what makes the tab
 * render at all, and the reasoning GoalsTab.jsx already writes down for
 * connector links applies unchanged here: a secondary feature failing must
 * never be able to blank the goals table. Separate request, separate state,
 * swallowed failure.
 */
const getGoalEvidence = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'goal.view');
    if (!ctx) return undefined;

    const month = String(req.query.month || '');
    if (!isMonthKey(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }

    const [goals, tasks] = await Promise.all([
      Goal.find({ board: ctx.board._id, monthKey: month }).select('_id group').lean(),
      evidenceTasksFor(ctx.board._id, month),
    ]);

    // The "does this group have goals this month" rule, in bulk. Without it the
    // orphan count is a nag at every group that never set a goal.
    const goalGroupIds = new Set(goals.map((g) => String(g.group)));
    const liveGoalIds = new Set(goals.map((g) => String(g._id)));

    const byGoal = {};
    for (const id of liveGoalIds) byGoal[id] = { count: 0, stale: 0 };

    for (const task of tasks) {
      for (const link of task.goalLinks || []) {
        const goalId = String(link.goal);
        // Counts only goals that still exist. A missed cascade then shows up as
        // an undercount rather than a chip promising tasks the popover cannot
        // produce — a phantom count is worse than no count.
        const row = byGoal[goalId];
        if (!row) continue;
        row.count += 1;
        if (staleReasonsFor(task, link, ctx.board).length > 0) row.stale += 1;
      }
    }

    const byGroup = {};
    for (const [groupId, counts] of foldEvidenceByGroup(tasks, ctx.board, goalGroupIds)) {
      byGroup[groupId] = counts;
    }

    return res.json({
      evidence: {
        monthKey: month,
        canAttach: ctx.can('task.change_status') && ctx.can('goal.view'),
        byGoal,
        byGroup,
      },
    });
  } catch (err) {
    console.error('getGoalEvidence error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/goals/:id/tasks
 *
 * The work behind one goal — what the count chip opens. `goal.view`.
 *
 * Sorted stale-first, because the only reason to open this list rather than
 * trust the number is to find what needs reconciling.
 */
const getGoalTasks = async (req, res) => {
  try {
    const loaded = await gateByGoal(req, res, 'goal.view');
    if (!loaded) return undefined;
    const { ctx, goal } = loaded;

    const tasks = await Task.find({
      board: goal.board,
      'goalLinks.goal': goal._id,
    })
      .select('_id name group status monthKey parent goalLinks assignedTo')
      .populate('assignedTo', 'name profilePic email')
      .lean();

    const rows = [];
    for (const task of tasks) {
      const link = (task.goalLinks || []).find(
        (l) => String(l.goal) === String(goal._id)
      );
      if (!link) continue;
      rows.push({
        _id: task._id,
        name: task.name,
        // `board` and `monthKey` are here so the client can hand the row
        // straight to buildTaskLink, which carries the month — a task that
        // drifted to September must open on September's board.
        board: goal.board,
        monthKey: task.monthKey,
        parent: task.parent || null,
        group: task.group,
        assignedTo: task.assignedTo || [],
        linkedBy: link.linkedBy,
        linkedAt: link.createdAt || null,
        stale: staleReasonsFor(task, link, ctx.board),
      });
    }

    rows.sort((a, b) => {
      if (a.stale.length !== b.stale.length) return b.stale.length - a.stale.length;
      return a.name.localeCompare(b.name);
    });

    return res.json({ tasks: rows });
  } catch (err) {
    console.error('getGoalTasks error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/tasks/:id/goal-options
 *
 * What this task may be attached to, and what it is attached to now. Feeds BOTH
 * the on-done prompt and the panel picker, so the two can never offer different
 * choices.
 *
 * Lives in goalController because it reads Goals and already owns `gate`; it is
 * mounted from routes/goals.js, which already carries two prefixes.
 */
const getTaskGoalOptions = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ error: 'Invalid task id' });

    const task = await Task.findById(id).select(
      '_id board group monthKey status parent isPersonal goalLinks goalLinkDismissedAt'
    );
    if (!task) return res.status(404).json({ error: 'Task not found' });
    // A personal task lives on no board, so there is no board to gate against
    // and no goals to offer. Said plainly here rather than letting the empty
    // board id fall through to gate()'s 'Invalid board id'.
    if (!task.board) {
      return res.status(400).json({ error: 'This task is not on a board' });
    }

    req.params.boardId = String(task.board);
    const ctx = await gate(req, res, 'goal.view');
    if (!ctx) return undefined;

    const attachable = isAttachable(task);
    const goals = attachable
      ? await Goal.find({
          board: task.board,
          group: task.group,
          monthKey: task.monthKey,
        })
          .select('_id name type order')
          .sort({ order: 1 })
          .lean()
      : [];

    const linked = new Set(linkedGoalIds(task));

    return res.json({
      options: {
        taskId: task._id,
        monthKey: task.monthKey,
        // False for a subitem or a task with no month — the client uses this to
        // hide the field rather than render an empty picker.
        attachable,
        canAttach:
          attachable && ctx.can('task.change_status') && ctx.can('goal.view'),
        done: isResolvedStatus(ctx.board, task.status),
        dismissed: isDismissed(task),
        goals: goals.map((g) => ({
          _id: g._id,
          name: g.name,
          type: g.type,
          linked: linked.has(String(g._id)),
        })),
      },
    });
  } catch (err) {
    console.error('getTaskGoalOptions error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
module.exports = {
  gate,
  getGoalTypes,
  getGoals,
  createGoal,
  carryForwardGoals,
  updateGoal,
  deleteGoal,
  getGoalActivity,
  reorderGoals,
  getGoalTrend,
  getGoalEvidence,
  getGoalTasks,
  getTaskGoalOptions,
  liveColumns,
  decorate,
};

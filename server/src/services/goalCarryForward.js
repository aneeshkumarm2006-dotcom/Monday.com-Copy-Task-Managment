/**
 * goalCarryForward.js — copying a month's goals into another month.
 *
 * WHY THIS EXISTS. A tracker board's goals are per (group x month), which is
 * what makes "how did we do in March?" answerable at all — but it also means
 * every month starts with an empty table. A board with twelve clients and eight
 * goals each is ninety-six rows to retype on the first of the month, and the
 * rows are nearly always the same rows: the same keyword, the same target, the
 * same owner. So the promise gets copied forward by hand, or it does not get
 * made at all.
 *
 * MANUAL, NEVER AUTOMATIC — the point of the whole feature. There is no cron
 * here and there must not be one. A goal is a promise somebody makes, and a
 * promise that renews itself while nobody is looking is not a promise, it is a
 * default. The team decides that last month's targets still stand, and says so.
 * That is also what makes this safe to run twice: nothing here writes on a
 * schedule, so nothing here can surprise a board.
 *
 * WHAT TRAVELS AND WHAT DOES NOT. The `config` half of a goal is the promise —
 * name, kind, target, importance, owner — and it travels. `actual` and
 * `actualDayKey` are the RESULT, and they never travel: a copied row is born
 * unanswered, exactly as `createGoal` insists a brand-new one is. Copying a
 * result forward would report last month's number as this month's, which is the
 * worst thing this feature could possibly do.
 *
 * IDEMPOTENT BY NAME. A goal already present in the target month, in the same
 * group, under the same `nameKey` is SKIPPED rather than duplicated. Running the
 * carry-forward twice therefore copies nothing the second time, and a carry made
 * after somebody already typed three rows by hand fills in the other five. That
 * matters more than it sounds: the alternative is a table with two "Grow organic
 * traffic" rows, both half-filled, and no way to tell which one counts.
 *
 * Everything in this file is PURE — no mongoose, no dates, no io. It is handed
 * two months' worth of lean rows and returns a plan; the controller does the
 * writing. That split is what makes the interesting rules (what a deadline's due
 * date becomes, when a baseline rolls, what counts as a duplicate) testable
 * without a database.
 */

const { toNameKey } = require('../models/Goal');
const { shiftDayKeyByMonths } = require('../utils/monthKey');
const { getGoalType, isGoalType } = require('../utils/goalTypes');

/** Why a row did not travel. The client turns these into sentences. */
const SKIP_REASONS = {
  EXISTS: 'exists',
  GROUP_GONE: 'group-gone',
  FULL: 'full',
  REQUIRED: 'required',
  BAD_TYPE: 'bad-type',
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const asPlainObject = (value) => {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value && typeof value === 'object') return { ...value };
  return {};
};

/**
 * The promise, moved forward in the calendar.
 *
 * Only `deadline` has anything to move: its `dueDayKey` is a real date, and
 * copying "due 2026-09-05" into October produces a goal that is born a month
 * late and scores zero before anyone has touched it. Shifted by the same number
 * of months as the copy itself, so "the report is due on the 5th" stays true —
 * see `shiftDayKeyByMonths` for the end-of-month clamping.
 *
 * Every other type's config is a number or a choice, and numbers do not have a
 * month. They travel verbatim.
 */
const shiftConfigMonths = (type, config, monthDelta) => {
  const out = asPlainObject(config);
  if (type !== 'deadline' || !monthDelta) return out;
  const shifted = shiftDayKeyByMonths(out.dueDayKey, monthDelta);
  // A due date we cannot shift is left exactly as it was rather than dropped:
  // `validateConfig` would reject the copy outright, and a visibly stale date
  // somebody can correct beats a goal that refused to exist.
  if (shifted) out.dueDayKey = shifted;
  return out;
};

/**
 * Optionally start the new month from where the old one finished.
 *
 * "Grow organic traffic: 4,200 → 6,000" is a promise about a starting point,
 * and next month the starting point is not 4,200 any more — it is whatever the
 * month actually ended on. Rolling it is what most people mean by carrying that
 * goal forward; keeping it is what the others mean. Neither is universally
 * right, so it is a choice the person makes in the modal rather than a rule
 * this file invents.
 *
 * Off unless asked, because it is the one transformation here that changes what
 * the goal MEANS rather than where it sits in the calendar.
 *
 * Only `numeric` has a baseline at all. A threshold ("stay under 40") and a band
 * ("land between 3 and 5") are absolute lines, not journeys, and there is
 * nothing in them to roll. A month with no reported result cannot roll either —
 * the honest answer there is to keep the old starting point and let somebody
 * look at it.
 */
const rollBaselineForward = (type, config, sourceActual) => {
  if (type !== 'numeric' || !isNum(sourceActual)) return config;
  return { ...config, baseline: sourceActual };
};

/**
 * Does this row already exist in the target month?
 *
 * Group + `nameKey`, which is the same join key the per-goal sparkline uses to
 * follow one goal across months — so "the same goal, next month" means exactly
 * the same thing here as it does on the chart. `nameKey` is lowercased and
 * whitespace-collapsed, so "Grow  Organic Traffic" does not become a second row
 * beside "Grow organic traffic".
 */
const existingKeys = (targetGoals = []) => {
  const set = new Set();
  for (const g of targetGoals) {
    set.add(`${String(g.group)}:${g.nameKey || toNameKey(g.name)}`);
  }
  return set;
};

/**
 * A required column with nothing in it, on the row we are about to write.
 *
 * The same rule `createGoal` enforces, applied ahead of the write so the batch
 * reports a skip instead of dying on row nineteen. It bites in exactly one
 * situation: a column that became required AFTER the source row was written, so
 * the source has no value to copy. `requiredSince` is deliberately NOT consulted
 * here — the copy is being created now, so it is a new row and the rule applies
 * to it in full.
 */
const missingRequiredColumns = (values, columns = []) => {
  const missing = [];
  for (const col of columns) {
    if (!col.required || col.archived) continue;
    const v = values[String(col._id)];
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
      missing.push(col.name);
    }
  }
  return missing;
};

/**
 * What a carry-forward would do, without doing any of it.
 *
 * Returns `{ copies, skipped }`, both in the source's own order so the modal can
 * show the plan as the table the user is looking at. The controller writes
 * `copies` and reports `skipped` verbatim.
 *
 * @param {Object}   args
 * @param {Array}    args.sourceGoals  - lean goals in the source month, ordered
 * @param {Array}    args.targetGoals  - lean goals already in the target month
 * @param {Array}    args.groups       - the board's live groups (lean)
 * @param {Array}    args.columns      - the board's live goalColumns
 * @param {string}   args.toMonth      - target month key
 * @param {number}   args.monthDelta   - whole months from source to target
 * @param {boolean}  [args.rollBaseline=false]
 * @param {number}   [args.maxPerGroup=Infinity]
 */
const planCarryForward = ({
  sourceGoals = [],
  targetGoals = [],
  groups = [],
  columns = [],
  toMonth,
  monthDelta,
  rollBaseline = false,
  maxPerGroup = Infinity,
}) => {
  const groupById = new Map(groups.map((g) => [String(g._id), g]));
  const taken = existingKeys(targetGoals);

  // Where the copied rows land in each target group's table: after everything
  // already there, in the source's own order. Seeded from the target month so a
  // carry into a group that already holds three rows appends rather than
  // colliding with them — `order` is what the tab sorts on.
  const nextOrder = new Map();
  const heldNow = new Map();
  for (const g of targetGoals) {
    const key = String(g.group);
    nextOrder.set(key, Math.max(nextOrder.get(key) ?? -1, g.order ?? 0));
    heldNow.set(key, (heldNow.get(key) || 0) + 1);
  }

  const copies = [];
  const skipped = [];

  const skip = (goal, reason, detail) => {
    skipped.push({
      goalId: String(goal._id),
      name: goal.name,
      group: String(goal.group),
      groupName: groupById.get(String(goal.group))?.name || '',
      reason,
      ...(detail ? { detail } : {}),
    });
  };

  for (const goal of sourceGoals) {
    const groupId = String(goal.group);
    const group = groupById.get(groupId);
    if (!group) {
      skip(goal, SKIP_REASONS.GROUP_GONE);
      continue;
    }
    // A type retired between the two months. Nothing sane to copy — the config
    // would not validate and the row could not be scored.
    if (!isGoalType(goal.type)) {
      skip(goal, SKIP_REASONS.BAD_TYPE);
      continue;
    }

    const nameKey = goal.nameKey || toNameKey(goal.name);
    if (taken.has(`${groupId}:${nameKey}`)) {
      skip(goal, SKIP_REASONS.EXISTS);
      continue;
    }

    if ((heldNow.get(groupId) || 0) >= maxPerGroup) {
      skip(goal, SKIP_REASONS.FULL);
      continue;
    }

    let config = shiftConfigMonths(goal.type, goal.config, monthDelta);
    if (rollBaseline) config = rollBaselineForward(goal.type, config, goal.actual);

    // The copy must be a goal the board would have accepted if it had been
    // typed by hand — same validator, same required columns. A source row that
    // predates a rule does not get to smuggle a copy past it.
    const configError = getGoalType(goal.type).validateConfig(config);
    if (configError) {
      skip(goal, SKIP_REASONS.BAD_TYPE, configError);
      continue;
    }

    const columnValues = asPlainObject(goal.columnValues);
    const missing = missingRequiredColumns(columnValues, columns);
    if (missing.length > 0) {
      skip(goal, SKIP_REASONS.REQUIRED, missing[0]);
      continue;
    }

    const order = (nextOrder.get(groupId) ?? -1) + 1;
    nextOrder.set(groupId, order);
    heldNow.set(groupId, (heldNow.get(groupId) || 0) + 1);
    // Claim the name so two identically-named source rows in one group cannot
    // both travel and recreate the duplicate this whole check exists to prevent.
    taken.add(`${groupId}:${nameKey}`);

    copies.push({
      sourceId: String(goal._id),
      group: goal.group,
      groupName: group.name,
      monthKey: toMonth,
      order,
      name: goal.name,
      type: goal.type,
      config,
      unit: goal.unit || 'none',
      unitLabel: goal.unitLabel || '',
      weight: typeof goal.weight === 'number' ? goal.weight : 1,
      owner: goal.owner || null,
      note: goal.note || '',
      columnValues,
      // The result never travels. See the header.
      actual: null,
      actualDayKey: null,
    });
  }

  return { copies, skipped };
};

module.exports = {
  SKIP_REASONS,
  shiftConfigMonths,
  rollBaselineForward,
  missingRequiredColumns,
  planCarryForward,
};

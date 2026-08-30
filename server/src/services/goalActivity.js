/**
 * goalActivity.js — what happened to a monthly goal, and who did it.
 *
 * Goals are the one thing on a tracker board that carries a promise AND a
 * result: `config` is what a team said at the start of the month they would do,
 * `actual` is what they report at the end. Both are editable, by different
 * people, at different times, on different capability rungs — which is exactly
 * the shape of thing that needs a history. "The target was 6,000, wasn't it?"
 * is not a question a table showing today's numbers can answer.
 *
 * Rows land in the SAME `ActivityLog` collection as task events, keyed on
 * `goal` rather than `task`. One collection, deliberately: the board activity
 * export reads a board's whole history by board id, and a second collection
 * would mean a second query, a second merge, and a report that could quietly
 * disagree with itself about what happened that afternoon.
 *
 * FIRE AND FORGET, like `activityService` itself — a broken log never blocks
 * the save that triggered it. It also never runs INSIDE the save: every logger
 * here takes a before-image captured by the caller, so a failure to describe a
 * change cannot roll one back.
 *
 * THE DIFF IS THE POINT. `logGoalChanges` compares two snapshots and writes one
 * row per field that actually moved, which is what makes the edit form
 * re-sending every field on every save harmless — a save that changed nothing
 * logs nothing.
 */

const { logActivity } = require('./activityService');

/** No single edit should ever be able to write more rows than this. */
const MAX_ROWS_PER_CHANGE = 30;

/** `Goal.config` and `Goal.columnValues` are Maps on a doc, objects when lean. */
const asPlainObject = (value) => {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value && typeof value === 'object') return { ...value };
  return {};
};

/**
 * The comparable image of a goal.
 *
 * Taken BEFORE the patch is applied and again after the save, so the diff is
 * between two plain objects rather than between a mongoose document and its own
 * mutated self — which would compare a thing to itself and find nothing.
 */
const snapshotGoal = (goal) => ({
  name: goal.name || '',
  type: goal.type,
  weight: typeof goal.weight === 'number' ? goal.weight : 1,
  owner: goal.owner ? String(goal.owner) : null,
  note: goal.note || '',
  unit: goal.unit || 'none',
  unitLabel: goal.unitLabel || '',
  actual: goal.actual === undefined ? null : goal.actual,
  actualDayKey: goal.actualDayKey || null,
  config: asPlainObject(goal.config),
  columnValues: asPlainObject(goal.columnValues),
});

/** Blank in every shape it arrives in. `0` and `false` are values, not blanks. */
const isBlank = (v) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Two field values, compared the way a person would read them. */
const same = (a, b) => {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
};

/** Blank of any flavour is stored as null, so the log has one shape for it. */
const orNull = (v) => (isBlank(v) ? null : v);

/**
 * Short names for the per-type `config` keys.
 *
 * NOT the labels from `goalTypes.js` — those are the QUESTIONS the add-a-goal
 * form asks ("Where do you want to get to?"), which read as nonsense inside a
 * sentence about what somebody changed. A key with no entry falls back to
 * itself, so a new goal type logs something readable before anyone touches this
 * map.
 */
const CONFIG_LABELS = {
  baseline: 'starting point',
  target: 'target',
  total: 'how many',
  limit: 'the line',
  low: 'the bottom of the range',
  high: 'the top of the range',
  direction: 'which side of the line',
  dueDayKey: 'due date',
  penaltyPerDay: 'points lost per day late',
};

const configLabel = (key) => CONFIG_LABELS[key] || key;

/**
 * The context every goal row carries, whatever the field.
 *
 * `goalName` and `group` are here so a row still reads after the goal itself is
 * gone — a deleted goal has no document left to join to, and the board activity
 * export is where that matters most. `goalTypeKey` is what lets the reader turn
 * a stored `1` into "Yes" rather than into the number one.
 */
const baseMetadata = (goal) => ({
  goalName: goal.name || '',
  monthKey: goal.monthKey || null,
  group: goal.group ? String(goal.group) : null,
  goalTypeKey: goal.type || null,
});

/** The actor half, shared by every logger here. */
const actorOf = ({ actor, actorType = 'user', actorLabel = '' }) => ({
  actor,
  actorType,
  actorLabel,
});

/** A new goal — the promise, as it was first written down. */
const logGoalCreated = ({ goal, actor, actorType, actorLabel, groupName }) =>
  logActivity({
    goal,
    board: goal.board,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'goal.created',
    // The whole promise in one row, so "what did we originally commit to" is
    // answerable without replaying every edit made since.
    newValue: {
      name: goal.name,
      type: goal.type,
      config: asPlainObject(goal.config),
      weight: goal.weight,
      unit: goal.unit,
      unitLabel: goal.unitLabel,
    },
    metadata: { ...baseMetadata(goal), groupName: groupName || '' },
  });

const logGoalDeleted = ({ goal, actor, actorType, actorLabel, groupName }) =>
  logActivity({
    goal,
    board: goal.board,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'goal.deleted',
    metadata: { ...baseMetadata(goal), groupName: groupName || '' },
  });

/**
 * Every field that actually moved between two snapshots, as log rows.
 *
 * Pure — no writes, no mongoose — so the rules about what counts as a change
 * can be read and tested without a database. `logGoalChanges` is the thin shell
 * that persists what this returns.
 *
 * @param {Object} before  - snapshotGoal(), taken before the patch
 * @param {Object} after   - snapshotGoal(), taken after the save
 * @param {Array}  columns - the board's live goalColumns, for their names
 * @returns {Array<{field: string, oldValue: *, newValue: *, metadata: Object}>}
 */
const diffGoal = (before, after, columns = []) => {
  const rows = [];
  const push = (field, oldValue, newValue, metadata) => {
    rows.push({ field, oldValue: orNull(oldValue), newValue: orNull(newValue), metadata });
  };

  // ---- The goal itself ------------------------------------------------------
  if (!same(before.name, after.name)) push('name', before.name, after.name);
  if (!same(before.type, after.type)) push('goalType', before.type, after.type);
  if (!same(before.weight, after.weight)) push('weight', before.weight, after.weight);
  if (!same(before.owner, after.owner)) push('owner', before.owner, after.owner);
  if (!same(before.note, after.note)) push('note', before.note, after.note);

  // Unit and its label are one fact wearing two fields: 'currency' with a '$'
  // is not a change from 'currency' with nothing, and logging them separately
  // would say so twice or not at all.
  const unitOf = (s) => (s.unit === 'none' ? '' : (s.unitLabel || s.unit));
  if (!same(unitOf(before), unitOf(after))) push('unit', unitOf(before), unitOf(after));

  // ---- The promise ----------------------------------------------------------
  const configKeys = [...new Set([
    ...Object.keys(before.config || {}),
    ...Object.keys(after.config || {}),
  ])];
  for (const key of configKeys) {
    if (same(before.config[key], after.config[key])) continue;
    push(`config:${key}`, before.config[key], after.config[key], {
      configKey: key,
      configLabel: configLabel(key),
    });
  }

  // ---- The result -----------------------------------------------------------
  if (!same(before.actual, after.actual)) push('actual', before.actual, after.actual);
  if (!same(before.actualDayKey, after.actualDayKey)) {
    push('actualDayKey', before.actualDayKey, after.actualDayKey);
  }

  // ---- The board's own extra columns ---------------------------------------
  // Keyed by column `_id`, not by a slug: goal columns are identified by id
  // everywhere else (see the note on `Goal.columnValues`), and a renamed column
  // must not orphan its own history. The NAME goes in metadata, which is what
  // the timeline actually shows.
  const columnKeys = [...new Set([
    ...Object.keys(before.columnValues || {}),
    ...Object.keys(after.columnValues || {}),
  ])];
  const columnById = new Map((columns || []).map((c) => [String(c._id), c]));
  for (const key of columnKeys) {
    if (same(before.columnValues[key], after.columnValues[key])) continue;
    const col = columnById.get(String(key));
    push(`column:${key}`, before.columnValues[key], after.columnValues[key], {
      columnId: String(key),
      columnLabel: col?.name || 'a column',
      columnType: col?.type || null,
    });
  }

  return rows;
};

/**
 * Persist the diff between two snapshots. One row per field that moved.
 *
 * @param {Object} args
 * @param {Object} args.goal    - the saved goal doc (supplies ids and context)
 * @param {Object} args.before  - snapshotGoal() from before the patch
 * @param {Object} [args.after] - snapshotGoal() from after the save; defaults to `goal`
 * @param {Array}  [args.columns]
 * @returns {Promise<number>} how many rows were written
 */
const logGoalChanges = async ({
  goal,
  before,
  after,
  columns = [],
  actor,
  actorType,
  actorLabel,
  groupName,
}) => {
  if (!goal || !before) return 0;
  const changes = diffGoal(before, after || snapshotGoal(goal), columns)
    .slice(0, MAX_ROWS_PER_CHANGE);
  if (!changes.length) return 0;

  const context = { ...baseMetadata(goal), groupName: groupName || '' };
  await Promise.all(changes.map((c) => logActivity({
    goal,
    board: goal.board,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'goal.field_changed',
    field: c.field,
    oldValue: c.oldValue,
    newValue: c.newValue,
    metadata: { ...context, ...(c.metadata || {}) },
  })));
  return changes.length;
};

module.exports = {
  snapshotGoal,
  diffGoal,
  logGoalCreated,
  logGoalDeleted,
  logGoalChanges,
  CONFIG_LABELS,
  MAX_ROWS_PER_CHANGE,
};

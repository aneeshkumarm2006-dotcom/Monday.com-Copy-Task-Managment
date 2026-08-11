/**
 * Tracker evaluation — turning tasks, updates and manual entries into grid cells.
 *
 * This module takes ARRAYS, never queries. Everything it needs is passed in
 * already loaded, which is what lets the whole state machine be unit-tested with
 * plain objects and no database. The controller owns the querying; this owns the
 * meaning.
 *
 * ---------------------------------------------------------------------------
 * THE OCCURRENCE RULE
 *
 * `targetCount` is meaningless without saying count of what. An OCCURRENCE is
 * one task that:
 *   (a) was created inside the period (in the tracker's timezone),
 *   (b) passes `match`, and
 *   (c) satisfies every TASK-LEVEL requirement —
 *         UPDATE_POSTED : that same task received a human update inside the
 *                         period (or, with requireSameTask off, some matched
 *                         task in the period did),
 *         TASK_DONE     : it is currently in a done status.
 *
 * MANUAL_CONFIRM is PERIOD-LEVEL, not task-level. It is checked once per period
 * and is never itself an occurrence.
 *
 * The user's rule — "a task plus an update is equal to completely done" — is
 * therefore `requirements: ['TASK_EXISTS','UPDATE_POSTED']`, `targetCount: 1`,
 * `requireSameTask: true`. A task with no update yields zero occurrences but a
 * non-empty match, which is exactly the `partial` state.
 *
 * ---------------------------------------------------------------------------
 * TASK_DONE means "is it done NOW", not "was it done that day".
 *
 * There is no `completedAt` anywhere in this codebase and status history is only
 * reconstructible from ActivityLog, which misses automation and portal
 * transitions entirely. Rather than ship a subtly-wrong timestamp, this reads
 * current status and the UI labels it honestly. Revisit if `completedAt` ever
 * lands.
 */

const { isResolvedStatus } = require('./doneStatus');
const { dayKeyOf, compareDayKeys, isDayKey, addDays } = require('./tzDay');

const REQUIREMENT_TYPES = ['TASK_EXISTS', 'UPDATE_POSTED', 'TASK_DONE', 'MANUAL_CONFIRM'];

/** Requirements answered by a single task, versus by the period as a whole. */
const TASK_LEVEL_REQUIREMENTS = ['TASK_EXISTS', 'UPDATE_POSTED', 'TASK_DONE'];
const PERIOD_LEVEL_REQUIREMENTS = ['MANUAL_CONFIRM'];

const CELL_STATES = ['met', 'partial', 'missed', 'pending', 'excused', 'off', 'na'];

/** States that count toward the kept/required ratio. */
const SCORED_STATES = ['met', 'partial', 'missed'];

// Keeps the response bounded: cells carry enough task detail for the drill-down
// to explain itself, not the whole group.
const MAX_TASKS_PER_CELL = 3;

const idOf = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  return String(value);
};

const normaliseText = (value) => String(value || '').trim().toLowerCase();

/**
 * Does this task pass the tracker's `match` filter?
 * Returns { ok, excludedByName } so a red cell can say WHY nothing matched —
 * "1 task excluded by rule 'Report'" is the difference between a tracker people
 * trust and one they quietly stop believing.
 */
const matchesTask = (task, match) => {
  const m = match || {};
  const name = normaliseText(task.name);

  const include = normaliseText(m.nameContains);
  if (include && !name.includes(include)) return { ok: false, excludedByName: false };

  const exclude = normaliseText(m.excludeNameContains);
  if (exclude && name.includes(exclude)) return { ok: false, excludedByName: true };

  const wanted = Array.isArray(m.labels) ? m.labels.map(idOf).filter(Boolean) : [];
  if (wanted.length > 0) {
    const has = new Set((task.labels || []).map(idOf).filter(Boolean));
    if (!wanted.some((l) => has.has(l))) return { ok: false, excludedByName: false };
  }

  return { ok: true, excludedByName: false };
};

/**
 * Build the per-(group, period) buckets of matched tasks.
 * Tasks whose creation day falls in no period are simply dropped.
 */
const bucketTasks = ({ tasks, periods, tracker, timezone }) => {
  // startDayKey -> period, so a task's day maps to its column in one lookup
  // instead of a scan per task.
  const dayToPeriod = new Map();
  for (const p of periods) {
    let cursor = p.startDayKey;
    // Periods are short (1 day, 7 days, ~31 days) so this is cheap, and it
    // handles grace windows overlapping the next period correctly by letting
    // the earlier period claim the day first.
    while (cursor && compareDayKeys(cursor, p.endDayKey) <= 0) {
      if (!dayToPeriod.has(cursor)) dayToPeriod.set(cursor, p);
      cursor = addDays(cursor, 1);
    }
  }

  const buckets = new Map(); // `${groupId}|${periodKey}` -> { matched: [], excluded: 0 }
  const bucketFor = (groupId, periodKey) => {
    const k = `${groupId}|${periodKey}`;
    let b = buckets.get(k);
    if (!b) {
      b = { matched: [], excluded: 0 };
      buckets.set(k, b);
    }
    return b;
  };

  for (const task of tasks) {
    const groupId = idOf(task.group);
    if (!groupId) continue;
    const dayKey = dayKeyOf(task.createdAt, timezone);
    if (!dayKey) continue;
    const period = dayToPeriod.get(dayKey);
    if (!period) continue;

    const verdict = matchesTask(task, tracker.match);
    const bucket = bucketFor(groupId, period.key);
    if (verdict.ok) bucket.matched.push({ task, dayKey });
    else if (verdict.excludedByName) bucket.excluded += 1;
  }

  return buckets;
};

/**
 * Did this task receive a human update within [start, due] of the period?
 * `updateDayKeys` is Map<taskId, Set<dayKey>> built by the controller.
 */
const taskHasUpdateInPeriod = (taskId, period, updateDayKeys) => {
  const days = updateDayKeys.get(taskId);
  if (!days || days.size === 0) return false;
  for (const d of days) {
    if (compareDayKeys(d, period.startDayKey) >= 0 && compareDayKeys(d, period.dueDayKey) <= 0) {
      return true;
    }
  }
  return false;
};

/**
 * Evaluate one tracker into grid rows.
 *
 * @param {object}   args.tracker         plain tracker object
 * @param {object[]} args.periods         from trackerPeriods.periodsBetween
 * @param {object[]} args.groups          [{ _id, name, createdAt? }] in scope, in display order
 * @param {object[]} args.tasks           [{ _id, group, name, createdAt, status, labels }]
 * @param {Map}      args.updateDayKeys   Map<taskId, Set<'YYYY-MM-DD'>>
 * @param {object[]} args.entries         [{ group, periodKey, state, by, at, link, note }]
 * @param {object}   args.board           for done-status resolution
 * @param {string}   args.timezone
 * @param {Date}     args.now
 * @returns {{ rows, summary }}
 */
const evaluateTracker = ({
  tracker,
  periods = [],
  groups = [],
  tasks = [],
  updateDayKeys = new Map(),
  entries = [],
  board = null,
  timezone = 'UTC',
  now = new Date(),
}) => {
  const requirements = Array.isArray(tracker.requirements) && tracker.requirements.length > 0
    ? tracker.requirements.filter((r) => REQUIREMENT_TYPES.includes(r))
    : ['TASK_EXISTS'];
  const taskLevel = requirements.filter((r) => TASK_LEVEL_REQUIREMENTS.includes(r));
  const periodLevel = requirements.filter((r) => PERIOD_LEVEL_REQUIREMENTS.includes(r));

  const targetCount = Number.isInteger(tracker.targetCount) && tracker.targetCount > 0
    ? tracker.targetCount
    : 1;
  const requireSameTask = tracker.requireSameTask !== false;

  const todayKey = dayKeyOf(now, timezone);
  const startDate = isDayKey(tracker.startDate) ? tracker.startDate : null;
  const endDate = isDayKey(tracker.endDate) ? tracker.endDate : null;

  const buckets = bucketTasks({ tasks, periods, tracker, timezone });

  const entryByCell = new Map();
  for (const e of entries) {
    entryByCell.set(`${idOf(e.group)}|${e.periodKey}`, e);
  }

  const rows = groups.map((group) => {
    const groupId = idOf(group._id);
    // TaskGroup has `default: Date.now` but no timestamps, and a doc read
    // WITHOUT .lean() would hydrate a legacy row as "created just now" and blank
    // its own history. Missing means unknown, so we decline to clamp.
    const groupBornKey = group.createdAt ? dayKeyOf(group.createdAt, timezone) : null;

    const counts = { met: 0, partial: 0, missed: 0, pending: 0, excused: 0, off: 0, na: 0 };

    const cells = periods.map((period) => {
      const cellKey = `${groupId}|${period.key}`;
      const entry = entryByCell.get(cellKey) || null;
      const bucket = buckets.get(cellKey) || { matched: [], excluded: 0 };

      const base = {
        p: period.key,
        n: 0,
        N: targetCount,
        matched: bucket.matched.length,
        excluded: bucket.excluded,
        met: [],
        missing: [],
        tasks: [],
      };

      const finish = (state, extra = {}) => {
        counts[state] += 1;
        return { ...base, ...extra, s: state };
      };

      // --- Out of scope entirely -------------------------------------------
      if (startDate && compareDayKeys(period.endDayKey, startDate) < 0) return finish('na');
      if (endDate && compareDayKeys(period.startDayKey, endDate) > 0) return finish('na');
      if (groupBornKey && compareDayKeys(groupBornKey, period.endDayKey) > 0) return finish('na');

      // --- Human overrides beat everything ---------------------------------
      if (entry && entry.state === 'excused') {
        return finish('excused', { entry: describeEntry(entry) });
      }

      if (period.isOff) return finish('off');

      // --- Which requirements did anything at all satisfy? ------------------
      const confirmed = !!(entry && entry.state === 'confirmed');

      const groupHasUpdate = !requireSameTask
        && bucket.matched.some((m) => taskHasUpdateInPeriod(idOf(m.task._id), period, updateDayKeys));

      const evaluated = bucket.matched.map(({ task }) => {
        const taskId = idOf(task._id);
        const missing = [];
        for (const req of taskLevel) {
          if (req === 'TASK_EXISTS') continue; // being here IS the task
          if (req === 'UPDATE_POSTED') {
            const ok = requireSameTask
              ? taskHasUpdateInPeriod(taskId, period, updateDayKeys)
              : groupHasUpdate;
            if (!ok) missing.push('UPDATE_POSTED');
          }
          if (req === 'TASK_DONE' && !isResolvedStatus(board, task.status)) {
            missing.push('TASK_DONE');
          }
        }
        return { id: taskId, name: task.name, ok: missing.length === 0, missing };
      });

      const occurrences = evaluated.filter((t) => t.ok);

      const metReqs = [];
      const missingReqs = [];
      for (const req of requirements) {
        let satisfied;
        if (req === 'TASK_EXISTS') satisfied = bucket.matched.length > 0;
        else if (req === 'MANUAL_CONFIRM') satisfied = confirmed;
        else satisfied = evaluated.some((t) => !t.missing.includes(req));
        (satisfied ? metReqs : missingReqs).push(req);
      }

      base.n = occurrences.length;
      base.met = metReqs;
      base.missing = missingReqs;
      base.tasks = evaluated.slice(0, MAX_TASKS_PER_CELL);

      const periodLevelOk = periodLevel.every((req) => req === 'MANUAL_CONFIRM' && confirmed);
      const isMet = occurrences.length >= targetCount && periodLevelOk;

      // A bare `confirmed` entry on a tracker that does not require
      // MANUAL_CONFIRM is a human saying "this did happen" — it wins outright.
      if (confirmed && !periodLevel.includes('MANUAL_CONFIRM')) {
        return finish('met', { entry: describeEntry(entry) });
      }
      if (isMet) {
        return finish('met', entry ? { entry: describeEntry(entry) } : {});
      }

      // Evidence beats the clock: a task logged today with no update yet is
      // `partial`, not `pending`. That is the state the user actually asked to
      // see, and calling it "pending" would hide it.
      if (bucket.matched.length > 0 || confirmed) {
        return finish('partial', entry ? { entry: describeEntry(entry) } : {});
      }

      const stillOpen = todayKey && compareDayKeys(todayKey, period.dueDayKey) <= 0;
      if (stillOpen) return finish('pending');

      return finish('missed');
    });

    const required = SCORED_STATES.reduce((sum, s) => sum + counts[s], 0);

    return {
      groupId,
      groupName: group.name,
      cells,
      summary: {
        ...counts,
        required,
        keptPct: required > 0 ? Math.round((counts.met / required) * 100) : null,
      },
    };
  });

  return { rows, summary: summariseRows(rows) };
};

const describeEntry = (entry) => ({
  state: entry.state,
  by: entry.by || null,
  at: entry.at || null,
  link: entry.link || '',
  note: entry.note || '',
});

/**
 * Roll rows up into the tiles. "At risk" is 3+ misses rather than a percentage
 * because a client with 3 missed days is a conversation regardless of how many
 * days the window happens to cover.
 */
const summariseRows = (rows) => {
  let onTrack = 0;
  let slipping = 0;
  let atRisk = 0;
  let totalMet = 0;
  let totalRequired = 0;

  for (const row of rows) {
    const missed = row.summary.missed;
    if (missed === 0) onTrack += 1;
    else if (missed <= 2) slipping += 1;
    else atRisk += 1;
    totalMet += row.summary.met;
    totalRequired += row.summary.required;
  }

  return {
    groupCount: rows.length,
    onTrack,
    slipping,
    atRisk,
    met: totalMet,
    required: totalRequired,
    keptPct: totalRequired > 0 ? Math.round((totalMet / totalRequired) * 100) : null,
  };
};

module.exports = {
  REQUIREMENT_TYPES,
  TASK_LEVEL_REQUIREMENTS,
  PERIOD_LEVEL_REQUIREMENTS,
  CELL_STATES,
  SCORED_STATES,
  MAX_TASKS_PER_CELL,
  matchesTask,
  bucketTasks,
  taskHasUpdateInPeriod,
  evaluateTracker,
  summariseRows,
};

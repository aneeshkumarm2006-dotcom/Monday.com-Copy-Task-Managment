/**
 * The Delivery pipeline: trackers + a date range in, scored rows out.
 *
 * Extracted from trackerController.getDelivery when a SECOND caller appeared —
 * the People scoreboard, which needs the same numbers for exactly one calendar
 * month rather than for the grid's '4w'/'12m' window. Two copies of this would
 * have been a mistake twice over:
 *
 *   - It is 140 lines of subtle correctness, not boilerplate. Per-tracker
 *     timezones; a `todayKey` per timezone; clamping to `startDate`/`endDate`;
 *     the `from > to` guard that keeps an unstarted tracker rendering its empty
 *     columns; and a scan upper bound taken from the last period's `dueDayKey`
 *     rather than from `to`, BECAUSE GRACE EXTENDS PAST THE WINDOW. A second
 *     copy gets one of those wrong, and gets it wrong silently.
 *   - The scoreboard's whole value is that it reconciles with the Delivery grid.
 *     "The grid says Ali missed 4, People says 3" is not a bug anyone can debug.
 *
 * The one thing the two callers genuinely disagree about — WHICH WINDOW — is the
 * `resolveRange` seam. Everything tracker-invariant stays in here, so a new
 * caller cannot accidentally scan before a tracker existed or past the day it
 * ended.
 *
 * Split three ways so the two interesting halves are pure and unit-testable,
 * which is a net gain: there was no controller-level test for this code before.
 *
 *   planDelivery       PURE — which periods, which groups, what to scan
 *   fetchDeliveryInputs      the only half that queries
 *   evaluatePlans      PURE — plans + inputs -> scored rows
 */

const Task = require('../models/Task');
const TrackerEntry = require('../models/TrackerEntry');
const ActivityLog = require('../models/ActivityLog');

const { periodsBetween } = require('../utils/trackerPeriods');
const { evaluateTracker } = require('../utils/trackerEvaluate');
const { skipDayKeysOf, annotateDaysOff } = require('../utils/trackerDaysOff');
const {
  dayKeyOf,
  dayKeyToUtcRange,
  compareDayKeys,
  minDayKey,
  maxDayKey,
} = require('../utils/tzDay');

/**
 * Work out each tracker's periods and groups, and the union range the queries
 * must cover. Pure: no models, no queries, no clock beyond the `now` you pass.
 *
 * @param {Object}   args
 * @param {Object[]} args.trackers   lean Tracker docs
 * @param {Object[]} args.allGroups  lean TaskGroup docs, in display order
 * @param {Function} args.resolveRange  ({tracker, todayKey}) => {from, to} — THE
 *   seam. It answers only "what window did the caller ask for"; the clamps below
 *   are applied to whatever it returns.
 * @param {Date}     args.now
 * @param {number}   args.maxCells   guard; see the callers for why they differ
 * @returns {{plans: Object[], scanFrom: string|null, scanTo: string|null,
 *            overCap: {tracker: Object, cells: number}|null}}
 *   plan = { tracker, tz, todayKey, from, to, periods, groups }
 */
const planDelivery = ({ trackers, allGroups, resolveRange, now, maxCells }) => {
  const groupById = new Map(allGroups.map((g) => [String(g._id), g]));
  const plans = [];

  for (const tracker of trackers) {
    const tz = tracker.timezone;
    const todayKey = dayKeyOf(now, tz);
    if (!todayKey) continue;

    const requested = resolveRange({ tracker, todayKey }) || {};

    // Never scan before the tracker existed, and never past its end.
    const from = maxDayKey(requested.from, tracker.startDate);
    let to = tracker.endDate ? minDayKey(requested.to, tracker.endDate) : requested.to;
    // A tracker that has not started yet still renders its (empty) columns.
    if (compareDayKeys(from, to) > 0) to = from;

    // Days off go in HERE rather than at either call site, so the Delivery grid
    // and the People scoreboard cannot disagree about which days were owed. See
    // utils/trackerDaysOff.js for why there are two sources of dates.
    //
    // A PERIOD BELONGS TO THE WINDOW CONTAINING ITS FIRST DAY. periodsBetween
    // returns every period that INTERSECTS the range — it has to, because
    // periodKeyFor is pure in (cadence, day) and cannot know where a caller's
    // window happens to fall (INVARIANT 1 in trackerPeriods.js). So asking a
    // Monday-start weekly cadence for August hands back the week of Mon 27 July
    // as its first column, labelled and banded JUL. Two things go wrong if it
    // stays: a foreign month appears in a grid the board's month picker says is
    // August, and that week is scored twice over — once in July's totals and
    // once in August's — so a year of ratios does not add up to the year.
    //
    // The threshold is the REQUESTED start, not the startDate-clamped `from`
    // below it. A tracker that begins on Wednesday 5 August still owns the week
    // of Monday the 3rd: no earlier window will ever render it, so dropping it
    // would lose the first week of tracking entirely.
    const windowStart = requested.from;
    const periods = annotateDaysOff(
      periodsBetween(tracker.cadence, from, to, { skipDates: skipDayKeysOf(tracker) }),
      tracker
    ).filter((p) => compareDayKeys(p.startDayKey, windowStart) >= 0);

    // An empty `tracker.groups` means EVERY group — see models/Tracker.js.
    const scoped = (tracker.groups || []).length > 0
      ? (tracker.groups || []).map((g) => groupById.get(String(g))).filter(Boolean)
      : allGroups;

    plans.push({ tracker, tz, todayKey, from, to, periods, groups: scoped });
  }

  const over = plans.find((p) => p.groups.length * p.periods.length > maxCells);
  if (over) {
    return {
      plans,
      scanFrom: null,
      scanTo: null,
      overCap: { tracker: over.tracker, cells: over.groups.length * over.periods.length },
    };
  }

  // One task read and one update read across the UNION of every window. The last
  // period may extend past `to` via graceDays, so the upper bound comes from the
  // periods rather than from `to`.
  let scanFrom = null;
  let scanTo = null;
  for (const p of plans) {
    scanFrom = minDayKey(scanFrom, p.periods[0]?.startDayKey || p.from);
    const last = p.periods[p.periods.length - 1];
    scanTo = maxDayKey(scanTo, last?.dueDayKey || p.to);
  }

  return { plans, scanFrom, scanTo, overCap: null };
};

/**
 * Every remaining read, issued together. Server-side these queries are ~1ms;
 * what actually costs is the round trip to a hosted cluster, so this is shaped
 * as one parallel batch rather than three sequential awaits.
 */
const fetchDeliveryInputs = async ({ board, plans, scanFrom, scanTo }) => {
  const scanTz = plans[0]?.tz;
  const startRange = scanFrom && scanTz ? dayKeyToUtcRange(scanFrom, scanTz) : null;
  const endRange = scanTo && scanTz ? dayKeyToUtcRange(scanTo, scanTz) : null;
  const range = startRange && endRange
    ? { $gte: startRange.start, $lt: endRange.end }
    : null;

  const [tasks, updateRows, entryRows] = await Promise.all([
    // Task.createdAt is the signal, not ActivityLog: automation-created tasks
    // never write an activity row, and a board that auto-creates its daily item
    // would otherwise read as entirely missed.
    // Rides { board: 1, createdAt: -1 } — an IXSCAN returning only the window.
    range
      ? Task.find({
        board: board._id,
        parent: null,
        isPersonal: { $ne: true },
        createdAt: range,
      })
        // Never select columnValues / attachments / checklist / note — the last
        // three are unbounded arrays and this is thousands of rows.
        .select('_id group name createdAt status labels')
        .lean()
      : [],
    // Updates come from ActivityLog rather than the Update collection: it is the
    // only board-and-day query with an index behind it ({ board: 1,
    // createdAt: -1 }), it needs no $in over every task id, and it excludes
    // authorType 'system' auto-posts by construction — "Status changed to Done"
    // is not somebody writing an update.
    range
      ? ActivityLog.find({
        board: board._id,
        createdAt: range,
        type: { $in: ['update.added', 'client.update_added'] },
      })
        .select('task createdAt')
        .lean()
      : [],
    // Manual confirmations and waivers. Bounded by what humans have actually
    // clicked, so this stays small — no period filter needed.
    TrackerEntry.find({
      board: board._id,
      tracker: { $in: plans.map((p) => p.tracker._id) },
    })
      .populate('by', 'name email profilePic')
      .lean(),
  ]);

  const entriesByTracker = new Map();
  for (const entry of entryRows) {
    const key = String(entry.tracker);
    if (!entriesByTracker.has(key)) entriesByTracker.set(key, []);
    entriesByTracker.get(key).push(entry);
  }

  return { tasks, updateRows, entriesByTracker };
};

/**
 * Score every plan. Pure — the scoring itself lives in utils/trackerEvaluate.js.
 * A disabled tracker yields no rows, exactly as before.
 *
 * @returns {Array<{tracker, tz, periods, groups, rows, summary}>}
 */
const evaluatePlans = ({ board, plans, tasks, updateRows, entriesByTracker, now }) =>
  plans.map(({ tracker, tz, periods, groups }) => {
    // Day keys are timezone-dependent, so the update index is rebuilt per
    // tracker. In practice every tracker on a board shares a timezone and this
    // is a few thousand cheap string ops.
    const updateDayKeys = new Map();
    for (const row of updateRows) {
      const taskId = String(row.task);
      const dayKey = dayKeyOf(row.createdAt, tz);
      if (!dayKey) continue;
      let set = updateDayKeys.get(taskId);
      if (!set) {
        set = new Set();
        updateDayKeys.set(taskId, set);
      }
      set.add(dayKey);
    }

    const entries = entriesByTracker.get(String(tracker._id)) || [];

    const { rows, summary } = tracker.enabled
      ? evaluateTracker({
        tracker,
        periods,
        groups,
        tasks,
        updateDayKeys,
        entries,
        board,
        timezone: tz,
        now,
      })
      : { rows: [], summary: null };

    return { tracker, tz, periods, groups, rows, summary };
  });

module.exports = { planDelivery, fetchDeliveryInputs, evaluatePlans };

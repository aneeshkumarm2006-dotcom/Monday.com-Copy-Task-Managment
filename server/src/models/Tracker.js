const mongoose = require('mongoose');

/**
 * A recurring commitment a board makes, evaluated per group.
 *
 * THE POINT OF THIS MODEL: there is no code concept named "daily activity" or
 * "monthly report" anywhere in this feature. Those are two rows in this
 * collection. Concretely —
 *
 *   Daily activity   { cadence: { type: 'everyNDays', n: 1, weekdays: [1,2,3,4,5,6] },
 *                      requirements: ['TASK_EXISTS', 'UPDATE_POSTED'], targetCount: 1 }
 *   Monthly report   { cadence: { type: 'monthly', graceDays: 5 },
 *                      requirements: ['TASK_EXISTS', 'MANUAL_CONFIRM'],
 *                      match: { nameContains: 'Report' } }
 *   Twice a week     { cadence: { type: 'weekly' }, targetCount: 2 }
 *   Every two days   { cadence: { type: 'everyNDays', n: 2, anchorDate: '2026-08-01' } }
 *
 * A new rhythm for a new kind of project is a row, not a deploy. If you ever
 * find yourself adding an `if (tracker.name === ...)` anywhere, the model has
 * failed and the fix belongs here rather than at the call site.
 *
 * Board-scoped, and modelled deliberately on Automation: same board/organisation
 * indexing, same permissive-schema-plus-controller-sanitizer discipline.
 * The period math lives in utils/trackerPeriods.js, the scoring in
 * utils/trackerEvaluate.js; both are pure and unit-tested.
 */

// 'YYYY-MM-DD'. Dates here are CALENDAR DATES, stored as strings on purpose —
// "the day this tracker started" has no time and no zone, and a Date would
// silently attach both. The tracker's own `timezone` is what turns a task's UTC
// createdAt into one of these.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayKeyField = (extra = {}) => ({
  type: String,
  match: DAY_KEY_RE,
  ...extra,
});

/**
 * How the calendar is sliced into columns.
 *   everyNDays — n=1 is "every day"; n>1 needs `anchorDate` to fix the phase,
 *                because "every 2 days" is meaningless without saying from when.
 *   weekly     — `weekStartsOn` 0 (Sun) or 1 (Mon).
 *   monthly    — whole calendar months.
 *
 * `weekdays` marks which days are working days at all, for every cadence type. A
 * period with no working day in it renders `off` and stays out of the ratio —
 * that is how "Sundays are off" is expressed.
 *
 * `graceDays` extends how long evidence may land after the period ends. The
 * August report going out on 3 September is on time with graceDays: 5.
 */
const cadenceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['everyNDays', 'weekly', 'monthly'],
      required: true,
    },
    n: { type: Number, min: 1, max: 365, default: 1 },
    anchorDate: dayKeyField({ default: null }),
    weekStartsOn: { type: Number, enum: [0, 1], default: 1 },
    weekdays: [{ type: Number, min: 0, max: 6 }],
    graceDays: { type: Number, min: 0, max: 90, default: 0 },
  },
  { _id: false }
);

/**
 * Which tasks this tracker is even looking at. Kept narrow on purpose: a regex
 * field was considered and cut, because ordinary users cannot write one and it
 * would be a ReDoS surface evaluated over every task name on every page load.
 *
 * `excludeNameContains` is what keeps a "daily activity" tracker from counting
 * the monthly report task. It is a heuristic, which is exactly why every cell
 * reports its `excluded` count — a red square that cannot explain itself is one
 * people stop believing.
 */
const matchSchema = new mongoose.Schema(
  {
    nameContains: { type: String, default: '', trim: true },
    excludeNameContains: { type: String, default: '', trim: true },
    // ids into Board.labels — ids rather than names so a relabel or recolour
    // propagates without touching a tracker.
    labels: [{ type: mongoose.Schema.Types.ObjectId }],
  },
  { _id: false }
);

const trackerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
      index: true,
    },
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    // IANA zone. NOT defaulted to 'UTC' the way Automation.schedule is: a
    // tracker silently on UTC while the team is on IST is a 5.5-hour lie that
    // looks exactly like data. The client sends its resolved browser zone and
    // the controller rejects anything Intl cannot parse.
    timezone: {
      type: String,
      required: true,
    },
    // Nothing before this is ever scored. Without it every new tracker paints
    // red backwards to the epoch, over months when the commitment did not exist.
    startDate: dayKeyField({ required: true }),
    endDate: dayKeyField({ default: null }),
    cadence: { type: cadenceSchema, required: true },
    // Holidays and one-off closures. Deliberately NOT consulted when computing
    // period boundaries — see INVARIANT 1 in utils/trackerPeriods.js. They only
    // mark days as non-working, which affects rendering and scoring.
    skipDates: [dayKeyField()],
    // EMPTY MEANS ALL GROUPS, including ones added later. That default is the
    // one an agency wants: a client onboarded next month is covered without
    // anyone remembering to edit this.
    groups: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TaskGroup',
      },
    ],
    match: { type: matchSchema, default: () => ({}) },
    // ANDed: every one must hold. See the occurrence rule in
    // utils/trackerEvaluate.js for how task-level and period-level requirements
    // differ — MANUAL_CONFIRM is checked once per period, the rest per task.
    requirements: [
      {
        type: String,
        enum: ['TASK_EXISTS', 'UPDATE_POSTED', 'TASK_DONE', 'MANUAL_CONFIRM'],
      },
    ],
    // Must one task satisfy every task-level requirement, or may they be spread
    // across the period's tasks? True is stricter and is what makes the grid
    // trustworthy; false is the forgiving reading for teams who comment on
    // yesterday's item.
    requireSameTask: {
      type: Boolean,
      default: true,
    },
    // How many qualifying occurrences the period needs. 1 for a daily activity,
    // 2 for "twice a week".
    targetCount: {
      type: Number,
      min: 1,
      max: 100,
      default: 1,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Tracker', trackerSchema);

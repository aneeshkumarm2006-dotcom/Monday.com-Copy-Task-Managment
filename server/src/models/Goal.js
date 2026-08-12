const mongoose = require('mongoose');
const { GOAL_TYPE_KEYS, UNITS } = require('../utils/goalTypes');
const { MONTH_KEY_RE } = require('../utils/monthKey');

/**
 * One monthly goal, belonging to one group of one monthly board.
 *
 * Its own collection rather than an array on `TaskGroup`: rows are per
 * (group x month) and unbounded over time — twelve clients x eight goals x
 * three years is three thousand documents on a single board. Embedding would
 * grow `TaskGroup` without limit and turn "the last twelve months" into a full
 * document read.
 *
 * `config` and `actual` are deliberately SEPARATE fields rather than one blob,
 * because they are filled in at different times by (often) different people:
 * `config` is the promise made at the start of the month — baseline, target,
 * the deadline — and `actual` is the result typed in at the end. That split is
 * also what lets `goal.track` (fill in the number) be a lower rung than
 * `goal.manage` (change what we promised).
 *
 * NO STORED SCORE. It is computed on read by `utils/goalTypes.js`, for the same
 * reason the Delivery grid computes rather than materialises: a stored score is
 * stale the instant someone edits a weight, a target, or the goal above it.
 *
 * NO unique index on (board, group, monthKey, name). Two goals sharing a name is
 * a user error, not a data-integrity violation, and a duplicate-key 500 landing
 * mid-rename is worse than two rows. The controller reports it politely instead.
 */
const goalSchema = new mongoose.Schema(
  {
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
      index: true,
    },
    // Denormalised so the org cascade can clean up without joining through Board.
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
      required: true,
    },
    // 'YYYY-MM' in the BOARD's timezone — see utils/monthKey.js.
    monthKey: {
      type: String,
      required: true,
      match: MONTH_KEY_RE,
    },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    // Lowercased, whitespace-collapsed name. The join key for "the same goal,
    // last month" — which is what the per-goal history sparkline plots. Derived
    // in the pre-save hook so it can never drift from `name`.
    nameKey: { type: String, required: true, index: true },

    type: { type: String, required: true, enum: GOAL_TYPE_KEYS },
    // The promise: per-type, e.g. { baseline, target } or { dueDayKey }.
    // Validated against the type's own `validateConfig`, not by mongoose.
    config: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    // Display only — the maths is unit-blind.
    unit: { type: String, enum: UNITS, default: 'none' },
    unitLabel: { type: String, default: '', trim: true, maxlength: 12 },

    // The result. Numeric for every type except `deadline`, which needs a
    // calendar date and therefore its own field rather than a number pretending
    // to be one.
    actual: { type: Number, default: null },
    actualDayKey: { type: String, default: null },

    // Relative importance within its group. Surfaced to users as
    // Low / Normal / High / Critical rather than a raw number — leave every goal
    // on 1 and the group score is a plain average, which is what most people
    // expect. 0 means "track this, but do not count it".
    weight: { type: Number, default: 1, min: 0, max: 100 },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '', maxlength: 2000 },

    // Values for the board's shared extra columns, keyed by goalColumn._id.
    // Same shape and the same sharp edges as `Task.columnValues`: it is a Map,
    // so `.get(id)` not `obj[id]`, and `.lean()` hands back a plain object.
    columnValues: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },

    order: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

/** The tab's read: one board, one month, grouped and ordered. */
goalSchema.index({ board: 1, monthKey: 1, group: 1, order: 1 });
/** The sparkline: this goal's own history, by name, within its group. */
goalSchema.index({ board: 1, group: 1, nameKey: 1, monthKey: 1 });

const toNameKey = (name) =>
  String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

goalSchema.pre('validate', function deriveNameKey() {
  if (this.isModified('name') || !this.nameKey) {
    this.nameKey = toNameKey(this.name);
  }
});

module.exports = mongoose.model('Goal', goalSchema);
module.exports.toNameKey = toNameKey;

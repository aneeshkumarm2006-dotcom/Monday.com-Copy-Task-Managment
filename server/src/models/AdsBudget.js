const mongoose = require('mongoose');
const { MONTH_KEY_RE } = require('../utils/monthKey');

/** What a row's lifecycle can be. `active` is the only one that gets paced. */
const LIFECYCLES = ['active', 'draft', 'paused'];

/**
 * One advertising budget line — a platform, or a campaign inside one — for one
 * group of one tracker board, in one month.
 *
 * ---- Why platforms and campaigns are ONE collection ------------------------
 *
 * `parent` is null on a platform row and points at a platform row on a campaign
 * row. That is the same shape `Task.parent` already uses for subitems, and it
 * is what keeps "add a column to both levels" a one-line change instead of two.
 *
 * WHAT IT IS NOT is a rollup. A platform's `allocated` is NOT the sum of its
 * campaigns' — the brief has Meta Ads at $8,000 carrying one $2,500 campaign,
 * because a platform budget is what was committed to the channel and campaigns
 * are the part of it that has been broken out so far. Every total on both
 * screens therefore sums `parent: null` rows ONLY. Summing both levels
 * double-counts the campaigns, and does it silently, in the direction that
 * makes a client look better funded than they are.
 *
 * ---- `platform` is a free string, permanently ------------------------------
 *
 * Meta, Google, Pinterest, OpenAI Ads, LinkedIn, TikTok, Amazon and whatever
 * launches next are DATA. There is no enum here and there must never be one:
 * the tracker engine's rule is that trade vocabulary lives in board content,
 * not in code, and a new advertising channel must never be a schema change.
 * `ConnectorSnapshot.kind` is a free string for the same reason.
 *
 * ---- No stored status, no stored percentage --------------------------------
 *
 * `lifecycle` is the part a person sets — this budget is a draft, or paused.
 * Everything else the tab shows as a status (On Track, Low Spend, Needs
 * Attention, Over Budget) is PACING, computed on read by
 * `utils/adsBudgetPacing.js` from spend against elapsed days. Storing it would
 * make it wrong on the first of the next month without anybody touching a row.
 * Same reasoning as `Goal` storing no score.
 *
 * ---- No currency field -----------------------------------------------------
 *
 * Deliberately absent, though the brief's data model lists it. Currency lives
 * once, on the board (`Board.adsBudget.currency`), because every figure the two
 * screens show is a SUM across rows — and rows in mixed currencies cannot be
 * added. One board, one currency is a real limitation; adding numbers that do
 * not share a unit is a bug.
 */
const adsBudgetSchema = new mongoose.Schema(
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
    // The client. On a tracker board a group is one client, which is why the
    // tab's first screen is a roster of these rather than one flat table.
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

    // Null on a platform row; the platform row's id on a campaign row.
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdsBudget',
      default: null,
    },

    // Carried on BOTH levels, not just the platform row, so a campaign table
    // can be read on its own and a campaign can be re-parented without losing
    // which channel it ran on.
    platform: { type: String, required: true, trim: true, maxlength: 80 },
    account: { type: String, default: '', trim: true, maxlength: 120 },

    // The campaign's name. Blank on a platform row, where `platform` IS the
    // name — rather than duplicating it into both fields, which would then
    // need keeping in step on every rename.
    name: { type: String, default: '', trim: true, maxlength: 200 },
    // 'Conversion', 'Search', 'Traffic', 'Awareness', … Free text for the same
    // reason `platform` is: every network names its objectives differently and
    // renames them between seasons.
    objective: { type: String, default: '', trim: true, maxlength: 80 },

    // The two numbers the whole tab is about. Both default to 0 rather than
    // null: a budget row that exists has been committed to, and "no money
    // allocated yet" is honestly zero. The `unset` pacing state is what
    // distinguishes an untouched row, and it reads both together.
    allocated: { type: Number, default: 0, min: 0 },
    spent: { type: Number, default: 0, min: 0 },

    // What the channel is set to spend per day, as configured AT the platform.
    // Null, not 0 — "no daily cap set" and "a cap of nothing" are opposite
    // facts. Never confuse it with the tab's Daily Average Spend, which is
    // derived from `spent` and elapsed days and is never stored.
    dailyBudget: { type: Number, default: null, min: 0 },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lifecycle: { type: String, enum: LIFECYCLES, default: 'active' },
    notes: { type: String, default: '', maxlength: 2000 },

    order: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

/** The detail screen: one client, one month, platforms then their campaigns. */
adsBudgetSchema.index({ board: 1, monthKey: 1, group: 1, parent: 1, order: 1 });
/** The roster: every client on the board for one month, aggregated. */
adsBudgetSchema.index({ board: 1, monthKey: 1 });

module.exports = mongoose.model('AdsBudget', adsBudgetSchema);
module.exports.LIFECYCLES = LIFECYCLES;

const mongoose = require('mongoose');
const { MONTH_KEY_RE } = require('../utils/monthKey');

/**
 * A record that the month-end goal reminder has already gone out.
 *
 * This exists ONLY for its unique index. "Fire once per board per month" has to
 * survive a server restart, two app instances, a clock that steps backwards, and
 * a cron that ticks every fifteen minutes — and a boolean on `Board` survives
 * none of those, while querying `Notification` for an existing row both scans
 * and breaks the moment one recipient deletes theirs.
 *
 * The runner INSERTS BEFORE FANNING OUT and treats a duplicate-key error as
 * "someone else already did this". That ordering is deliberate: a crash midway
 * through the fan-out then under-notifies rather than notifying twice, and for a
 * monthly nag that is very much the better failure.
 *
 * Mirrors the `(tracker, group, periodKey)` trick TrackerEntry already uses.
 */
const goalReminderSchema = new mongoose.Schema(
  {
    board: { type: mongoose.Schema.Types.ObjectId, ref: 'Board', required: true },
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    monthKey: { type: String, required: true, match: MONTH_KEY_RE },
    // 'monthEnd' on the last day of the month, 'monthStart' on the 1st after.
    kind: { type: String, required: true, enum: ['monthEnd', 'monthStart'] },
    sentAt: { type: Date, default: Date.now },
    recipientCount: { type: Number, default: 0 },
    missingCount: { type: Number, default: 0 },
  },
  { timestamps: false }
);

goalReminderSchema.index({ board: 1, monthKey: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model('GoalReminder', goalReminderSchema);

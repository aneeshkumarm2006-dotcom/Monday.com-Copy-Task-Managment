const mongoose = require('mongoose');

/**
 * A record that one user's morning digest has already gone out today.
 *
 * Exists ONLY for its unique index, exactly like [GoalReminder](./GoalReminder.js):
 * "once per user per morning" has to survive a restart, two app instances and a
 * clock stepping backwards, and a boolean anywhere else survives none of those.
 * The runner INSERTS BEFORE SENDING and treats a duplicate key as "someone else
 * already did this" — so a crash mid-send under-notifies rather than sending the
 * same morning twice, which is the right direction for a reminder to fail.
 *
 * `dayKey` is the user's OWN local day (see utils/dueDigest.js for how the zone
 * is resolved), and `timezone` records which zone that key was computed in — so
 * a user who flies between zones can be reasoned about after the fact instead
 * of guessed at.
 */
const dueDigestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // 'YYYY-MM-DD' in the user's resolved timezone.
    dayKey: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    timezone: { type: String, default: 'UTC' },
    sentAt: { type: Date, default: Date.now },
    overdueCount: { type: Number, default: 0 },
    todayCount: { type: Number, default: 0 },
    emailed: { type: Boolean, default: false },
  },
  { timestamps: false }
);

dueDigestSchema.index({ user: 1, dayKey: 1 }, { unique: true });

module.exports = mongoose.model('DueDigest', dueDigestSchema);

const mongoose = require('mongoose');

/**
 * A record that one client contact's daily portal digest has already gone out.
 *
 * Exists ONLY for its unique index, exactly like [DueDigest](./DueDigest.js) and
 * [GoalReminder](./GoalReminder.js): "once per contact per day" has to survive a
 * restart, two app instances and a clock stepping backwards, and a boolean
 * anywhere else survives none of those.
 *
 * The runner INSERTS BEFORE SENDING and treats a duplicate key as "someone else
 * already did this" — so a crash mid-send UNDER-notifies rather than sending the
 * same digest twice, which is the right direction for a reminder to fail. A
 * client who gets two identical summaries an hour apart stops reading them.
 */
const portalDigestSchema = new mongoose.Schema(
  {
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientContact',
      required: true,
    },
    // 'YYYY-MM-DD', UTC. Unlike DueDigest this is NOT resolved into a personal
    // timezone: a ClientContact has no timezone field and no settings screen to
    // set one on, so inventing a per-contact zone here would be a guess dressed
    // up as a preference. One send a day, at whatever hour the runner reaches
    // them, is the honest version of that.
    dayKey: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    sentAt: { type: Date, default: Date.now },
    serviceCount: { type: Number, default: 0 },
    emailed: { type: Boolean, default: false },
  },
  { timestamps: false }
);

portalDigestSchema.index({ contact: 1, dayKey: 1 }, { unique: true });

module.exports = mongoose.model('PortalDigest', portalDigestSchema);

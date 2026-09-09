const mongoose = require('mongoose');

/**
 * One person's bookmark on one message.
 *
 * A SEPARATE COLLECTION rather than a `savedBy: [User]` array on Message, and
 * the reason is whose data it is. A reaction is public — the whole room sees
 * who picked 👍, so it belongs on the message everybody reads. A bookmark is
 * private: nobody else may learn what you set aside. Keeping it on Message
 * would mean every conversation read carries every reader's private list and
 * relies on a projection to strip it, and a projection that is forgotten once
 * leaks the lot.
 *
 * It also gets the ordering right for free. "My saved messages, newest first"
 * is an index on (user, createdAt) here; on Message it would be a scan of
 * every message in the workspace filtered by array membership.
 *
 * Access is re-checked on READ, never trusted from this row. A bookmark
 * outlives the access that created it — someone loses a board grant, a private
 * board's membership changes — so the saved list resolves channel access at
 * read time exactly as the channel list does, and silently drops what the
 * person may no longer see.
 */
const savedMessageSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    message: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      required: true,
    },
    // Denormalised so the saved list can resolve access without loading every
    // message first: the read needs the channel to check it, and the channel
    // of a message never changes.
    channel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      required: true,
    },
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// Saving twice is the same as saving once.
savedMessageSchema.index({ user: 1, message: 1 }, { unique: true });
// The list read: my saved messages, newest first.
savedMessageSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('SavedMessage', savedMessageSchema);

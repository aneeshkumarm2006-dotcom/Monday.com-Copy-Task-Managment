const mongoose = require('mongoose');

/**
 * ChannelRead — where one user has read up to in one channel.
 *
 * One row per (channel, user), upserted whenever the client reports the
 * channel was opened. Unread = messages with createdAt > lastReadAt (or all
 * of them when no row exists yet). This is the whole read model: no per-
 * message receipts, no "seen by" — a task manager's chat needs "is there
 * something new for me here", not delivery forensics.
 */
const channelReadSchema = new mongoose.Schema(
  {
    channel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lastReadAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

channelReadSchema.index({ channel: 1, user: 1 }, { unique: true });
// The sidebar computes unread for every visible channel for one user.
channelReadSchema.index({ user: 1 });

module.exports = mongoose.model('ChannelRead', channelReadSchema);

const mongoose = require('mongoose');

/**
 * ItemFollow — an opt-in subscription to a task's activity.
 *
 * A user who follows a task receives notifications for its activity (updates,
 * status changes, moves, due-date changes) even when they aren't assigned to it
 * or mentioned. This is the "watch" tier that sits between assigned/mentioned
 * (automatic) and board-subscription (passive, no per-change pings).
 */
const itemFollowSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
      index: true,
    },
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      default: null,
    },
  },
  { timestamps: true }
);

// One follow record per (user, task).
itemFollowSchema.index({ user: 1, task: 1 }, { unique: true });

module.exports = mongoose.model('ItemFollow', itemFollowSchema);

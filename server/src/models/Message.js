const mongoose = require('mongoose');

/**
 * Message — one post in a Channel. Deliberately the same shape as Update
 * (TipTap JSON body, plain-text mirror, attachments, mentions, one-level
 * replies) so the client renders both with the same components and people
 * write in one editor everywhere.
 *
 * What it does NOT share with Update: visibility. Chat has no client-facing
 * side in Phase 1 — every author is a team member (a required User), and
 * ClientContacts never see a channel. If client rooms ever happen they arrive
 * as their own channel kind, not as a visibility flag threaded through every
 * read like Update's — that flag exists there because one task thread serves
 * two audiences, which is exactly the situation chat doesn't have.
 *
 * `task` / `goal` are SHARE CHIPS: a message may point at a task or a goal on
 * the channel's board so the room can talk about it. Evidence and reference
 * only — a chip never moves a score, never marks anything done, never counts
 * toward a goal. That rule is load-bearing across the product (Task.goalLinks
 * says the same) and chat inherits it whole.
 */
const attachmentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    name: { type: String, default: '' },
    mime: { type: String, default: '' },
    size: { type: Number, default: 0 },
    publicId: { type: String, default: '' },
  },
  { _id: true }
);

const messageSchema = new mongoose.Schema(
  {
    channel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      required: true,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // TipTap JSON document, stored as-is (same contract as Update.body).
    body: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Plain-text mirror for previews, unread toasts and notifications.
    bodyText: {
      type: String,
      default: '',
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
    mentions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    // One-level thread, same as Update.replyTo.
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    // Share chips — see the header comment. At most one of each per message.
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      default: null,
    },
    goal: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Goal',
      default: null,
    },
    editedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// The conversation read: one channel, newest first, paginated by createdAt.
messageSchema.index({ channel: 1, createdAt: -1 });
// The thread read: replies to one message, oldest first.
messageSchema.index({ replyTo: 1, createdAt: 1 });

module.exports = mongoose.model('Message', messageSchema);

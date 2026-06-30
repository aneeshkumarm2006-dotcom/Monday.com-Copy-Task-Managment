const mongoose = require('mongoose');

/**
 * Update — a rich-text "post" on a task; the task's discussion feed. Renders
 * the full TipTap document (bold, lists, task lists, headings, mentions,
 * attachments) with threaded one-level replies, @mentions, file attachments,
 * and per-user mention read state.
 *
 * `body` stores the TipTap JSON document as-is. `bodyText` is an optional
 * plain-text mirror used for read-only contexts (notifications, digests,
 * previews) that don't have the editor on hand.
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

const updateSchema = new mongoose.Schema(
  {
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // TipTap JSON document (rich content). Stored as Mixed so structure can
    // evolve without schema migrations.
    body: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Optional plain-text fallback for previews/notifications.
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
    // Threaded reply — references the parent Update this one replies to.
    // null for top-level updates. One level deep.
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Update',
      default: null,
    },
    // Mentioned users who have marked this update as read. Per-user read state —
    // the "Mark as read" affordance is only shown to users in `mentions`.
    mentionReads: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    editedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Update', updateSchema);

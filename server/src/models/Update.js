const mongoose = require('mongoose');

/**
 * Update — a rich-text "post" on a task. Distinct from a Comment in that
 * Updates render the full TipTap document (bold, lists, task lists, headings,
 * mentions, attachments), while Comments are short plain-text chat-like
 * messages.
 *
 * `body` stores the TipTap JSON document as-is. `bodyHtml` is an optional
 * pre-rendered HTML mirror used for read-only contexts (notifications,
 * digests) that don't have the editor on hand.
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
    editedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Update', updateSchema);

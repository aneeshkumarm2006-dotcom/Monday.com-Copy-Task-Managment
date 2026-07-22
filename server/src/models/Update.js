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
    // Who posted this update. For 'user' updates this is the required author
    // User (the normal case). For 'client' updates — posts made by an external
    // ClientContact through the Client Portal — `author` is null and
    // `portalAuthor` carries the identity instead. The two sides share one
    // thread per task, so the board's UpdatesTab and the portal both render
    // this feed; each must tolerate a null `author`.
    authorType: {
      type: String,
      enum: ['user', 'client'],
      default: 'user',
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      // Required only for team (user) updates. Client updates have no User.
      required: function requireAuthorForUserUpdates() {
        return this.authorType !== 'client';
      },
    },
    // The external ClientContact who posted this update (client updates only).
    portalAuthor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientContact',
      default: null,
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

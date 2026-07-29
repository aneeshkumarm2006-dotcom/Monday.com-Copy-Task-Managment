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
    // 'user'   — a team member posted (author required)
    // 'client' — an external ClientContact posted via the portal (portalAuthor)
    // 'system' — an automated timeline event (e.g. "Status changed to Done");
    //            no author, shown only in the portal thread (filtered out of the
    //            team UpdatesTab so it stays a pure discussion feed).
    authorType: {
      type: String,
      enum: ['user', 'client', 'system'],
      default: 'user',
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      // Required only for team (user) updates. Client/system updates have no User.
      required: function requireAuthorForUserUpdates() {
        return this.authorType === 'user';
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
    // Who may READ this post. This is the only thing separating the client-facing
    // thread from the team's private one, so it is enforced on the PORTAL side
    // (portalController never selects 'internal') rather than trusted anywhere.
    //
    // The values describe CLIENT VISIBILITY, not which tab the post shows up in.
    // On a Client Portal board the panel's tabs invert the intuition: **Updates**
    // is the team thread ('internal') and **Client** is the client-facing one
    // ('shared'). On a standard board there is one thread and it is 'shared'.
    //
    // 'shared'   — the client can read this. On a client board it is their portal
    //              thread and they are emailed each post; on a standard board it
    //              just means "no client restriction". The default, and what every
    //              pre-existing row means: legacy docs carry no `visibility` field
    //              at all, so a shared-only read must be written
    //              `{ visibility: { $ne: 'internal' } }`, never
    //              `{ visibility: 'shared' }`.
    // 'internal' — team only. Never rendered in the portal, never emailed to a
    //              ClientContact, and never counted in the client's "last
    //              activity" signal. Only `authorType: 'user'` posts may be
    //              internal — a client cannot author one by definition, and
    //              'system' events exist for the portal timeline.
    visibility: {
      type: String,
      enum: ['shared', 'internal'],
      default: 'shared',
    },
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

// Every read of this collection is "one task's thread, filtered by visibility,
// newest first" — the team feed, the internal feed and the portal thread all take
// that shape.
updateSchema.index({ task: 1, visibility: 1, createdAt: -1 });

module.exports = mongoose.model('Update', updateSchema);

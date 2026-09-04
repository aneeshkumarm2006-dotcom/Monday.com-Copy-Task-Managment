const mongoose = require('mongoose');

/**
 * Message — one post in a Channel. Deliberately the same shape as Update
 * (TipTap JSON body, plain-text mirror, attachments, mentions, one-level
 * replies) so the client renders both with the same components and people
 * write in one editor everywhere.
 *
 * What it still does NOT share with Update: visibility. That flag exists there
 * because ONE task thread serves two audiences at once. A channel never does —
 * who can read it is `Channel.audience`, decided once for the whole surface. So
 * client rooms arrived exactly as this file predicted: as a structural
 * discriminator on the Channel, not as a per-message flag threaded through
 * every read. Do not add `visibility` here; a test asserts its absence.
 *
 * ---- A mail thread is a Message ------------------------------------------
 *
 * On a `mode:'mail'` channel there is no separate thread model. A THREAD is a
 * top-level message carrying a `subject`, and the thread body is that message's
 * ordinary one-level `replyTo` children. That is not a stretch: in a mailbox
 * everyone replies to the CONVERSATION, not to an individual message, which is
 * exactly one level — the shape `replyTo` already has.
 *
 * The payoff is that the existing reads already do the work.
 * `GET .../messages?thread=<id>` returns parent + replies, and the default
 * listing already filters `replyTo: null` and counts replies per message, which
 * is a mailbox thread list once `subject` exists.
 *
 * `authorType: 'system'` (Phase 2) is the ONLY authorless message: what an
 * automation or an alert posts. It is not a person and is never rendered as
 * one — the client shows the Macan mark. Everything a system message may do,
 * a user message may do; the split exists so nobody can impersonate the
 * product and the product never impersonates a person.
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
    // 'user'   — a team member posted (author required).
    // 'client' — an external ClientContact posted from the portal
    //            (portalAuthor required, author null).
    // 'system' — an automation or alert posted (neither). Never a person.
    authorType: {
      type: String,
      enum: ['user', 'client', 'system'],
      default: 'user',
      /**
       * The cross-field rule neither `required` above can see on its own:
       * `{ authorType: 'client', author: <someone> }` satisfies both and stores
       * a message that is a team member and a client at once.
       *
       * A PATH validator, not a `pre('validate')` hook — hooks are async
       * middleware and `validateSync()` skips them, so the rule would silently
       * not apply on half the validation paths.
       */
      validate: {
        validator: function enforceSingleAuthor(value) {
          if (value === 'user') return !this.portalAuthor;
          if (value === 'client') return !this.author;
          return !this.author && !this.portalAuthor;
        },
        message:
          'A message is authored by exactly one principal: a User (user), a ClientContact (client), or neither (system)',
      },
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: function requireAuthorForUserMessages() {
        return this.authorType === 'user';
      },
      default: null,
    },
    /**
     * The external client who posted, for `authorType: 'client'`. A
     * ClientContact is deliberately NOT a User and never enters the org
     * permission graph — same split `Update.portalAuthor` already makes.
     *
     * Conditionally required, unlike Update's, because a client message with no
     * contact is unattributable: it would render as a blank author on both
     * planes. Making it a schema fact costs nothing and removes the case.
     */
    portalAuthor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientContact',
      required: function requirePortalAuthorForClientMessages() {
        return this.authorType === 'client';
      },
      default: null,
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
    // Team members this message calls out. Stays a bare [User] on purpose: it
    // is populated in three places and feeds createNotificationsForUsers, which
    // takes User ids. A polymorphic array would change the wire shape of every
    // existing message and need splitting at every consumer.
    mentions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    /**
     * Client contacts this message calls out — a RENDERING signal only.
     *
     * A contact has no Notification row and gets no email (client alerts are
     * in-portal only), so this exists to highlight the mention in the thread
     * and for nothing else. Kept parallel to `mentions` rather than merged so
     * the existing array's shape, populate and notification path are untouched.
     */
    mentionsContacts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ClientContact',
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
    /**
     * The thread subject — MAIL ONLY, and only on a top-level message.
     *
     * A thread begins with a top-level message in a `mode:'mail'` channel, and
     * that message carries the subject. A reply INHERITS it and must not carry
     * one of its own; a chat message has none at all.
     *
     * ---- WHERE EACH HALF OF THAT RULE IS ACTUALLY ENFORCED ------------------
     *
     * Only half of it can live here, and it is worth being exact about which,
     * because a comment claiming more than the code does is worse than no
     * comment:
     *
     *   "a reply has no subject"  — HERE, in the validator below. It reads
     *       `this.replyTo`, which is on the document, so it costs nothing and
     *       holds on every path including `validateSync()`.
     *
     *   "a mail thread MUST have one, a chat message must NOT" — NOT here. It
     *       depends on `channel.mode`, which is on a different document. A
     *       validator that loaded the channel would put a query on the write
     *       path of every message in the product, chat included, to check a
     *       rule that concerns a small minority of them. So the mail compose
     *       endpoints enforce it — they hold the channel already, having just
     *       resolved access against it.
     *
     * `default: undefined` rather than `null` or `''`: absent means "this is
     * not a thread root", and an empty string would be a value that looks like
     * a subject to anything scanning for one.
     */
    subject: {
      type: String,
      trim: true,
      maxlength: 200,
      default: undefined,
      validate: {
        validator: function refuseSubjectOnReply(value) {
          if (value === undefined || value === null || value === '') return true;
          return !this.replyTo;
        },
        message:
          'Only the first message in a mail thread carries a subject; replies inherit it',
      },
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

const mongoose = require('mongoose');

/**
 * MailThreadRead — where one principal has read up to in one MAIL THREAD.
 *
 * ---- Why mail gets its own read model ---------------------------------------
 *
 * Chat and mail read different UNITS. Opening a chat channel means you have
 * seen the conversation, so `ChannelRead` keeps one marker per (channel, user)
 * and that is the whole story. A mailbox does not work that way: reading the
 * budget thread must not mark the content-plan thread read, or the unread count
 * is a lie the first time someone opens the mailbox.
 *
 * ---- Why NOT a `thread` field on ChannelRead --------------------------------
 *
 * That is the tidier-looking option and it is the one to avoid.
 * `ChannelRead`'s `{channel, user}` index is unique and NOT partial, so adding
 * a nullable discriminator means dropping and recreating a unique index on the
 * hottest small collection in chat. Two racing `markRead` upserts during that
 * window insert duplicate rows, and then `createIndex(unique)` FAILS on those
 * duplicates — leaving the collection permanently unguarded, which is a worse
 * end state than the problem. A new collection has no such window.
 *
 * ---- What a "thread" is here ------------------------------------------------
 *
 * `thread` points at the TOP-LEVEL Message that carries the subject. Its
 * replies are that message's ordinary one-level children, so there is no
 * separate thread entity to reference — see Message.js.
 *
 * ---- One principal per row --------------------------------------------------
 *
 * Exactly one of `user` (a team member) or `contact` (an external
 * ClientContact) is set. They are separate fields rather than one polymorphic
 * id because a ClientContact is deliberately not a User and never enters the
 * permission graph — the same split `Update.author` / `Update.portalAuthor`
 * already makes.
 *
 * Both marker collections advance through `services/chatRead.js`, so the
 * "$max, never backwards" rule has one implementation rather than two. Writing
 * `$set` instead of `$max` here would resurrect read threads as unread every
 * time a stale tab reported an older timestamp.
 */
const mailThreadReadSchema = new mongoose.Schema(
  {
    thread: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      required: true,
    },
    // Kept so a thread's markers die with their channel without having to walk
    // back through every root message to find them.
    channel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      required: true,
    },
    /**
     * Exactly one of `user` / `contact` is set — never both, never neither.
     *
     * Declared as a PATH validator rather than a `pre('validate')` hook because
     * hooks are async middleware and `validateSync()` skips them entirely. A
     * rule that silently does not apply on one of the two validation paths is
     * worse than no rule, since it reads as enforced.
     *
     * `default: null` is what makes this fire: Mongoose skips validators for
     * `undefined`, so an absent field would slip past.
     */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      validate: {
        validator: function enforceSinglePrincipal() {
          return !!this.user !== !!this.contact;
        },
        message:
          'A read marker belongs to exactly one principal — set either user or contact, not both and not neither',
      },
    },
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientContact',
      default: null,
    },
    lastReadAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

/**
 * One marker per (thread, principal).
 *
 * TWO partial indexes rather than one on `{thread, user, contact}`, because a
 * compound unique index treats null as a value: with one index, every contact's
 * row on a thread would key as `(thread, null, <contact>)` and every user's as
 * `(thread, <user>, null)` — which happens to work, but only by accident, and
 * it stops working the moment anything writes a row with neither set. Partial
 * indexes say what is actually meant: uniqueness applies to rows that HAVE that
 * principal.
 */
mailThreadReadSchema.index(
  { thread: 1, user: 1 },
  { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } }
);
mailThreadReadSchema.index(
  { thread: 1, contact: 1 },
  { unique: true, partialFilterExpression: { contact: { $type: 'objectId' } } }
);
// The mailbox read: unread state for every thread in one channel, for one
// principal, in a single query.
mailThreadReadSchema.index({ channel: 1, user: 1 });
mailThreadReadSchema.index({ channel: 1, contact: 1 });

module.exports = mongoose.model('MailThreadRead', mailThreadReadSchema);

const mongoose = require('mongoose');

/**
 * Channel — one conversation SURFACE.
 *
 * A surface is a `(mode, audience)` pair, and that pairing is the whole model:
 *
 *                  audience:'team'          audience:'client'
 *   mode:'chat'    the private team room    a room the client is in
 *   mode:'mail'    (possible, unused)       a mailbox the client is in
 *
 * Two orthogonal axes rather than one overloaded one. `kind` already answers
 * "room or DM"; piling "who is in it" onto the same field would have left
 * nowhere to put "how it renders" when Mail arrived. Each field answers one
 * question, so adding a third mode later is a new enum value and nothing else.
 *
 * Channels are scoped to the WORKSPACE, sectioned by board:
 *
 *   - A board channel (`board` set) belongs to one board. On a TRACKER board
 *     the auto-created rooms are one per (board, group), because a "client"
 *     there IS a group. On a CLIENT board the board itself is the client and a
 *     group is one of its workstreams, so a workstream may carry up to four
 *     surfaces — though the team picks which ones exist rather than getting
 *     them all automatically.
 *
 *   - A workspace channel (`board` null) belongs to the org as a whole —
 *     "General" and anything an admin creates beside it.
 *
 * MEMBERSHIP IS NOT STORED. Who can see a channel is derived on every read:
 * board channels follow board read access (the same resolveAccess the board
 * itself uses), workspace channels follow org membership — both AND'd with
 * the chat.* capabilities. A stored member list would be a second copy of
 * board access that drifts the first time someone's role changes.
 *
 * Chat never writes a score. A message may POINT at a task or goal (see
 * Message), but nothing posted in a channel moves a number anywhere.
 */
const channelSchema = new mongoose.Schema(
  {
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    // 'channel' — a room (board or workspace scoped, derived membership).
    // 'dm' — a private line between exactly the two users in `members`.
    //
    // Deliberately NOT extended with a 'client' value. Who can see a surface is
    // `audience`; how it renders is `mode`. Conflating either into `kind` is
    // what makes the third one impossible to add.
    kind: {
      type: String,
      enum: ['channel', 'dm'],
      default: 'channel',
    },
    /**
     * How this surface reads and writes.
     *
     *   'chat' — one running stream, newest at the bottom, no subjects.
     *   'mail' — a Gmail-shaped mailbox: many threads, each a TOP-LEVEL Message
     *            carrying a `subject`, with that message's one-level replies as
     *            the thread body. No new model; see Message.subject.
     *
     * This is a UI and structure choice, NOT email. Nothing here is ever sent
     * or received over SMTP, and no Message-ID exists anywhere in the product.
     */
    mode: {
      type: String,
      enum: ['chat', 'mail'],
      default: 'chat',
    },
    /**
     * Who `services/chatAudience.js` admits.
     *
     *   'team'   — org members with board read access. Nothing else, ever.
     *   'client' — the same team members PLUS the ClientContacts of the board,
     *              and only on a live advanced client board.
     *
     * Defaulting to 'team' is what keeps every room that predates this field
     * private: a surface fails closed unless someone deliberately opened it.
     */
    audience: {
      type: String,
      enum: ['team', 'client'],
      default: 'team',
    },
    // DMs ONLY: the two participants. This is the one deliberate exception to
    // "membership is never stored" — a DM's membership IS its identity, not a
    // cached copy of some other access rule, so there is nothing for it to
    // drift from. Rooms keep this empty and keep deriving.
    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    // DMs ONLY: '<orgId>:<lowUserId>:<highUserId>' — ids sorted, so the same
    // pair always lands on the same row and two racing "message this person"
    // taps converge on one DM instead of minting two.
    dmKey: {
      type: String,
      default: null,
    },
    // The board this channel is sectioned under; null = workspace-level.
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      default: null,
    },
    // For auto-created client channels: the group (client) this room is for.
    // Manual channels leave it null.
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    // Archived channels keep their history but leave the sidebar and refuse
    // new messages. Deleting chat history is not a thing this model offers.
    archived: {
      type: Boolean,
      default: false,
    },
    // Null for auto-created channels — nobody "made" them, the client roster did.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// The sidebar read: every channel in a workspace, sectioned by board.
channelSchema.index({ organisation: 1, board: 1, archived: 1 });

// One auto surface per (board, group, mode, audience) — what makes the lazy
// upsert idempotent rather than a race. Partial: manual channels (group null)
// are unlimited.
//
// MIGRATION NOTE, and it is the dangerous one. A Mongoose `default` applies on
// WRITE, never to documents already stored. Every channel written before `mode`
// and `audience` existed carries neither, and a unique index reads a missing
// field as null — so `(board, group, null, null)` and `(board, group, 'chat',
// 'team')` are DIFFERENT index entries, and the next upsert would mint a
// duplicate room for every existing tracker group.
//
// Order is therefore: $set both fields on every existing channel → build this
// index → verify → drop the old `{board, group}` one. Never drop the old index
// first; while it exists it is the only thing preventing that same race.
// See scripts/migrateChatSurfaces.js.
channelSchema.index(
  { board: 1, group: 1, mode: 1, audience: 1 },
  { unique: true, partialFilterExpression: { group: { $type: 'objectId' } } }
);

// One DM per pair per workspace — same upsert-under-unique-index race guard.
channelSchema.index(
  { dmKey: 1 },
  { unique: true, partialFilterExpression: { dmKey: { $type: 'string' } } }
);

// The sidebar's DM read: every DM this user is in, per workspace.
channelSchema.index({ organisation: 1, members: 1 });

module.exports = mongoose.model('Channel', channelSchema);

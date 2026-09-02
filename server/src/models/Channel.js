const mongoose = require('mongoose');

/**
 * Channel — one chat room.
 *
 * Chat is scoped to the WORKSPACE, with channels sectioned by board:
 *
 *   - A board channel (`board` set) belongs to one board. The auto-created
 *     client channels are these: one per (board, group), because a "client"
 *     in this product IS a group on a tracker board. There is no Client
 *     entity, so the same client on two boards is two channels — a unified
 *     per-client room needs that entity first, and pretending otherwise here
 *     would invent an identity the data model cannot back.
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
    kind: {
      type: String,
      enum: ['channel', 'dm'],
      default: 'channel',
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

// One auto channel per (board, group) — what makes the lazy backfill an
// idempotent upsert rather than a race. Partial: manual channels (group null)
// are unlimited.
channelSchema.index(
  { board: 1, group: 1 },
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

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

module.exports = mongoose.model('Channel', channelSchema);

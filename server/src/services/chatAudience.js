const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const { resolveAccess, resolveOrgAccess } = require('../utils/permissions');

/**
 * Who may currently SEE a channel — the fan-out list for SSE frames, mention
 * notifications, and system posts. One implementation, shared by the chat
 * controller and every service that posts into a channel, because two copies
 * of "who is in this room" is how one of them leaks.
 *
 * Derived fresh on every call: a revoked board share stops the stream the
 * moment it stops the board. Board channels follow board read access;
 * workspace channels follow the "internal member" test (`board.view_public`,
 * whose absence is the defining property of the guest role).
 *
 * `org` may be passed when the caller already holds the loaded document;
 * otherwise it is loaded here. Fails closed — no org, no board, no audience.
 */
const channelAudience = async (channel, org = null) => {
  const orgDoc =
    org || (await Organisation.findById(channel.organisation));
  if (!orgDoc) return [];

  const memberIds = (orgDoc.members || []).map((m) => String(m?._id || m));

  // A DM's audience is its two participants — nobody else, ever. NOT
  // filtered by workspace membership: a DM is a conversation between two
  // PEOPLE and follows them across workspaces (channel.organisation only
  // records where it was first opened).
  if (channel.kind === 'dm') {
    return (channel.members || []).map((m) => String(m?._id || m));
  }

  if (!channel.board) {
    return memberIds.filter((id) =>
      resolveOrgAccess(orgDoc, id).can('board.view_public')
    );
  }

  const boardId = channel.board?._id || channel.board;
  const board = await Board.findById(boardId);
  if (!board) return [];
  return memberIds.filter((id) => resolveAccess(board, orgDoc, id).canRead);
};

module.exports = { channelAudience };

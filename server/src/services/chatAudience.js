const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const ClientContact = require('../models/ClientContact');
const { resolveAccess, resolveOrgAccess } = require('../utils/permissions');
const { isAdvancedClientBoard } = require('../utils/clientBoard');

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
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF PRINCIPAL, AND WHY THE RETURN SHAPE CHANGED
 * ---------------------------------------------------------------------------
 *
 * A room used to hold `User`s only, so an array of user ids was the whole
 * answer. A client-facing surface also holds `ClientContact`s — people with no
 * `User` row at all, reached through a different auth plane and a different SSE
 * registry. They cannot share one array: a contact id and a user id are both
 * bare ObjectIds, so a merged list would be indistinguishable at the point of
 * use, and the first consumer to treat one as the other either notifies nobody
 * or notifies the wrong person.
 *
 * So this returns `{ userIds, contactIds }`, both arrays of strings, and every
 * caller must say which one it means. The compile-time-ish cost of that (three
 * call sites) is the point — it is no longer possible to fan out to "the
 * audience" without deciding which audience.
 *
 * THE GATE ON CONTACTS IS THREE-PART AND FAILS CLOSED AT EVERY PART:
 *
 *   1. `channel.audience === 'client'`. A `'team'` surface NEVER returns a
 *      contact, whatever the board is. This is the load-bearing one: the
 *      private team room and the client room differ ONLY by this field, and it
 *      is what makes an internal conversation internal.
 *   2. the board is a live ADVANCED client board — `isAdvancedClientBoard`
 *      AND `portalEnabled`. A basic-tier board has no client surfaces at all,
 *      and a disabled portal is the kill switch: it must stop a long-lived SSE
 *      stream, not just the next request, so it is re-read here on every call
 *      rather than trusted from whenever the connection opened.
 *   3. `contact.board === channel.board`, which the query expresses directly.
 *
 * A channel with no board can never be client-facing, and is left alone.
 */
const channelAudience = async (channel, org = null) => {
  const empty = { userIds: [], contactIds: [] };

  const orgDoc = org || (await Organisation.findById(channel.organisation));
  if (!orgDoc) return empty;

  const memberIds = (orgDoc.members || []).map((m) => String(m?._id || m));

  // A DM's audience is its two participants — nobody else, ever. NOT
  // filtered by workspace membership: a DM is a conversation between two
  // PEOPLE and follows them across workspaces (channel.organisation only
  // records where it was first opened). A DM is never client-facing.
  if (channel.kind === 'dm') {
    return {
      userIds: (channel.members || []).map((m) => String(m?._id || m)),
      contactIds: [],
    };
  }

  if (!channel.board) {
    return {
      userIds: memberIds.filter((id) =>
        resolveOrgAccess(orgDoc, id).can('board.view_public')
      ),
      contactIds: [],
    };
  }

  const boardId = channel.board?._id || channel.board;
  const board = await Board.findById(boardId);
  if (!board) return empty;

  const userIds = memberIds.filter((id) => resolveAccess(board, orgDoc, id).canRead);

  // Part 1 of the gate, checked before anything is loaded: an internal room
  // cannot leak by omission, because the only branch that can produce a
  // contact is the one guarded by an explicit `=== 'client'`.
  if (channel.audience !== 'client') return { userIds, contactIds: [] };

  // Parts 2 and 3.
  if (!isAdvancedClientBoard(board) || !board.portalEnabled) {
    return { userIds, contactIds: [] };
  }

  const contacts = await ClientContact.find({ board: boardId }).select('_id').lean();
  return { userIds, contactIds: contacts.map((c) => String(c._id)) };
};

/**
 * The team half only, as a plain array — for the many callers that address
 * `User`s and nothing else (bell notifications, `usersWithBoardRead`-style
 * fan-out). Exists so those sites read as what they are rather than as
 * `(await channelAudience(c)).userIds`, and so that adding a third principal
 * type later does not silently widen them.
 */
const channelUserAudience = async (channel, org = null) =>
  (await channelAudience(channel, org)).userIds;

module.exports = { channelAudience, channelUserAudience };

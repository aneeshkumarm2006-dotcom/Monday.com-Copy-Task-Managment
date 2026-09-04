/**
 * Which chat channels belong on which surface.
 *
 * Chat has two homes now, and they are deliberately disjoint:
 *
 *   /chat            — the workspace sidebar: workspace rooms, tracker-board
 *                      rooms, and DMs. The team's own conversations.
 *   a client board's — that client's rooms, a team-only and a client-facing
 *   Chat tab           one per workstream. These live ONLY on the board.
 *
 * A client board's rooms are kept out of the global sidebar on purpose: they
 * are conversations WITH an external company, and mixing them into the same
 * list as internal team chat is how someone answers the wrong room.
 *
 * The consequence to keep in mind: the mobile tab badge must not count them
 * either, or it advertises unread messages the user cannot reach from that
 * screen. `chatStore.totalUnread()` is the one place that sum is computed.
 *
 * The server already populates `channel.board.boardType` on every channel it
 * returns, so this needs no extra request and no extra field.
 */

/**
 * Does this channel live on a Client Portal board?
 *
 * Keyed on the BOARD's type rather than the channel's kind on purpose: it
 * catches the team-only room and any manual extra channel on a client board
 * too, not just the client-facing ones. A channel whose board did not come
 * back populated answers false — the safe side, since the only cost is a row
 * appearing in a sidebar the team can already read.
 *
 * @param {Object} channel - a channel from the chat API
 * @returns {boolean}
 */
export const isClientBoardChannel = (channel) =>
  channel?.board?.boardType === 'client';

/**
 * The channels the global /chat sidebar should show.
 * @param {Array} channels
 */
export const workspaceChannels = (channels = []) =>
  channels.filter((c) => !isClientBoardChannel(c));

/**
 * The channels belonging to one board, for its Chat tab.
 * @param {Array} channels
 * @param {string} boardId
 */
export const channelsForBoard = (channels = [], boardId) =>
  boardId
    ? channels.filter((c) => String(c?.board?._id || c?.board || '') === String(boardId))
    : [];

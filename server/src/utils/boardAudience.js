const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const { resolveBoardAccess } = require('./boardAccess');

/**
 * Async companion to [boardAccess.js](./boardAccess.js), which stays pure.
 *
 * `resolveBoardAccess` answers "may THIS user read THIS board" given docs the
 * caller already loaded. Fan-out code (notifications, mentions, automation
 * assignees) has the inverse question: "of these N users, which may read board
 * X?" — and holds no board doc at all. Rather than make every such site load a
 * board + org and loop, they funnel through here.
 *
 * This is the choke point that keeps private boards from leaking through
 * side channels: a task name in a notification, an @mention that resolves, an
 * automation assigning work on a board the assignee cannot open.
 */

/**
 * Of `userIds`, return a Set of the id strings that may READ `boardId`.
 *
 * A missing board, or a board whose org has vanished, yields an empty set —
 * fail closed. Callers treat the result as an allow-list.
 */
const filterUsersWithBoardRead = async (boardId, userIds) => {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Set();
  if (!boardId) return new Set(ids); // not board-scoped — nothing to gate on

  const board = await Board.findById(boardId).select(
    'visibility memberAccess createdBy organisation'
  );
  if (!board) return new Set();

  const org = await Organisation.findById(board.organisation).select(
    'admin admins members'
  );
  if (!org) return new Set();

  const allowed = new Set();
  for (const id of ids) {
    if (resolveBoardAccess(board, org, id).canRead) allowed.add(id);
  }
  return allowed;
};

/**
 * Convenience wrapper: the allowed ids as an array, order-preserving against
 * the input.
 */
const usersWithBoardRead = async (boardId, userIds) => {
  const allowed = await filterUsersWithBoardRead(boardId, userIds);
  return (userIds || [])
    .filter(Boolean)
    .filter((u) => allowed.has(String(u)));
};

module.exports = { filterUsersWithBoardRead, usersWithBoardRead };

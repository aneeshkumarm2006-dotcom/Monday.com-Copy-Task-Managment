const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const { resolveAccess } = require('./permissions');

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
    'visibility publicDefaultLevel memberAccess createdBy organisation'
  );
  if (!board) return new Set();

  // `roles` + `memberRoles` are required, not optional: read access now depends
  // on the ORG ROLE too — a Guest cannot read public boards at all — so a query
  // that omitted them would silently over-report who may see a board.
  const org = await Organisation.findById(board.organisation).select(
    'admin admins members roles memberRoles'
  );
  if (!org) return new Set();

  const allowed = new Set();
  for (const id of ids) {
    if (resolveAccess(board, org, id).canRead) allowed.add(id);
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

/**
 * Everyone who holds `capability` on this board, given docs the caller already
 * loaded. Pure and synchronous, unlike its siblings above — background jobs
 * (the month-end goal reminder) hold the board and the org already and would
 * otherwise re-query them once per candidate.
 *
 * THE CANDIDATE SET IS A UNION OF THREE, and missing any one under-notifies:
 *   1. org members — a PUBLIC board grants access through
 *      `publicDefaultLevel`, so on a public board the whole team qualifies and
 *      there is no `memberAccess` row to find them by.
 *   2. `board.memberAccess` — the explicit grants on a private board.
 *   3. `board.createdBy` — the creator holds every board-scoped capability
 *      unconditionally, even with no grant row of their own.
 *
 * `resolveAccess` then does the actual deciding, because it IS the AND of org
 * role and board level. Re-implementing any part of it here is how the two
 * drift.
 */
const usersWithBoardCapability = (board, org, capability) => {
  if (!board || !org) return [];

  const candidates = new Set();
  for (const m of org.members || []) candidates.add(String(m));
  for (const a of board.memberAccess || []) {
    if (a?.user) candidates.add(String(a.user));
  }
  if (board.createdBy) candidates.add(String(board.createdBy));

  return [...candidates].filter((id) => {
    const access = resolveAccess(board, org, id);
    return access.canRead && access.capabilities?.has(capability);
  });
};

module.exports = {
  filterUsersWithBoardRead,
  usersWithBoardRead,
  usersWithBoardCapability,
};

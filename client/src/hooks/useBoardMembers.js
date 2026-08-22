import { useEffect } from 'react';
import useBoardStore from '../store/boardStore';

/**
 * The people who may be ASSIGNED work on `boardId`.
 *
 * Every picker on a board page — task assignees, the group owner, a `person`
 * column, a goal's owner — used to render `useOrgStore.members`, the whole
 * workspace. On a PRIVATE board that offered people who are not on it: the
 * server refuses those assignments (`validateAssignees`), so picking one bought
 * an error message, and the names themselves leaked the workspace roster into a
 * board those people cannot open.
 *
 * So: ask the server which of its members this board actually has. Who can read
 * a private board is the AND of an org role and a board grant, and only the
 * server resolves that (see server/src/utils/permissions.js). Re-deriving it
 * from `board.memberAccess` on the client is the drift the two-layer model
 * exists to remove — and it would be wrong anyway, since the client never holds
 * the org's role matrix.
 *
 * The roster is cached per board in `boardStore`, so a page rendering twenty
 * pickers still costs one request.
 *
 * @param {string|null} boardId
 * @param {{ enabled?: boolean }} [opts] - `enabled: false` skips the fetch (a
 *        closed panel, a read-only view) while still returning whatever is
 *        already cached.
 * @returns {Array} the member list, `[]` until it lands
 */
const EMPTY = [];

const useBoardMembers = (boardId, { enabled = true } = {}) => {
  const id = boardId ? String(boardId) : null;
  const members = useBoardStore((s) => (id ? s.boardMembers[id] : null)) || EMPTY;
  const fetchBoardMembers = useBoardStore((s) => s.fetchBoardMembers);

  useEffect(() => {
    if (!id || !enabled) return;
    fetchBoardMembers(id).catch((err) =>
      // Non-fatal: the picker shows "No members" rather than the whole
      // workspace. Falling back to the org roster here would reinstate the very
      // leak this hook exists to close.
      console.error('Failed to load board members:', err)
    );
  }, [id, enabled, fetchBoardMembers]);

  return members;
};

export default useBoardMembers;

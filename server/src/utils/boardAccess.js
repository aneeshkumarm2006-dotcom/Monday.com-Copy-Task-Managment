/**
 * Board-level access resolution.
 *
 * Layered on top of the org admin/member model. A private board is visible
 * ONLY to its creator until the creator explicitly grants individual org
 * members one of two access levels via `board.memberAccess`:
 *
 *   - 'read' — may view the board and its tasks, but cannot mutate anything
 *   - 'edit' — admin-equivalent power over board CONTENT (create/edit/delete
 *              tasks, groups, columns, statuses, labels) — i.e. everything
 *              except the board's own lifecycle
 *
 * Sharing is a separate axis from content:
 *   - every 'edit' member may SEE who has access (canViewAccess), so the people
 *     running the board know who is on it
 *   - they may CHANGE it (canManageAccess) only if the owner gave that member
 *     FULL access — the per-member `canManage` flag on their grant
 *
 * Full access is owner-granted only, so it can't be chained: a full-access
 * member may hand out read/edit, but cannot mint another full-access member,
 * nor demote an existing one. The owner's own grant is always untouchable.
 *
 * Org admins get NO automatic access to a private board — they must be granted
 * access by the creator like any other member (the creator may, of course,
 * grant other admins). Public boards stay readable by every org member, with
 * org admins able to edit them (unchanged behaviour).
 */

/** Whether `userId` is the primary or an additional admin of `org`. */
const isOrgAdmin = (org, userId) =>
  !!org &&
  (
    (org.admin && org.admin.toString() === userId) ||
    (Array.isArray(org.admins) && org.admins.some((a) => a.toString() === userId))
  );

/** The raw `memberAccess` entry for this user, or null. */
const boardGrant = (board, userId) => {
  if (!board || !Array.isArray(board.memberAccess)) return null;
  return (
    board.memberAccess.find((e) => e.user && e.user.toString() === userId) || null
  );
};

/** 'read' | 'edit' | null — the explicit per-board grant level for this user. */
const boardGrantLevel = (board, userId) => {
  const grant = boardGrant(board, userId);
  return grant ? grant.level : null;
};

/** True when `userId` originally created the board. */
const isBoardCreator = (board, userId) =>
  !!board && !!board.createdBy && board.createdBy.toString() === userId;

/**
 * True when `userId` holds a FULL-access grant: 'edit' plus the owner-granted
 * `canManage` flag. Meaningless without 'edit', so both are required.
 */
const hasFullAccess = (board, userId) => {
  const grant = boardGrant(board, userId);
  return !!grant && grant.level === 'edit' && grant.canManage === true;
};

/**
 * Effective access for `userId` on `board` (within `org`):
 *   - orgAdmin:        a true org admin
 *   - creator:         owns the board (created it)
 *   - level:           the explicit grant ('read' | 'edit' | null)
 *   - fullAccess:      granted 'edit' + sharing rights (not the owner)
 *   - canRead:         may load the board + its tasks
 *   - canEdit:         admin-equivalent power over board content
 *   - readOnly:        explicitly view-only (so write paths can reject outright,
 *                      distinct from a public-board member who may still set status)
 *   - canViewAccess:   may open the share dialog and see who has access
 *   - canManageAccess: may grant/revoke access for other members
 */
const resolveBoardAccess = (board, org, userId) => {
  const orgAdmin = isOrgAdmin(org, userId);
  const creator = isBoardCreator(board, userId);
  const level = boardGrantLevel(board, userId);
  const fullAccess = hasFullAccess(board, userId);
  const isPublic = board.visibility === 'public';
  // Private boards: only the creator and explicitly granted members get in —
  // org admins have no automatic access. Public boards: every member reads,
  // org admins edit.
  const canRead = creator || isPublic || level === 'read' || level === 'edit';
  const canEdit = creator || level === 'edit' || (isPublic && orgAdmin);
  const readOnly = !canEdit && level === 'read';
  // Editors always see the roster; only the owner and full-access members change it.
  const canViewAccess = creator || level === 'edit';
  const canManageAccess = creator || fullAccess;
  return {
    orgAdmin,
    creator,
    level,
    fullAccess,
    canRead,
    canEdit,
    readOnly,
    canViewAccess,
    canManageAccess,
  };
};

module.exports = {
  isOrgAdmin,
  boardGrant,
  boardGrantLevel,
  isBoardCreator,
  hasFullAccess,
  resolveBoardAccess,
};

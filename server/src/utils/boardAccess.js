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
 * Access to the access list itself is a separate axis:
 *   - every 'edit' member may SEE who has access (canViewAccess), so the people
 *     running the board know who's on it
 *   - they may CHANGE it (canManageAccess) only if the owner opted in via the
 *     board's `editorsCanManageAccess` flag — and even then never for the
 *     owner's grant, their own grant, or the flag itself (owner-only)
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

/** 'read' | 'edit' | null — the explicit per-board grant for this user. */
const boardGrantLevel = (board, userId) => {
  if (!board || !Array.isArray(board.memberAccess)) return null;
  const entry = board.memberAccess.find(
    (e) => e.user && e.user.toString() === userId
  );
  return entry ? entry.level : null;
};

/** True when `userId` originally created the board. */
const isBoardCreator = (board, userId) =>
  !!board && !!board.createdBy && board.createdBy.toString() === userId;

/**
 * Effective access for `userId` on `board` (within `org`):
 *   - orgAdmin:      a true org admin
 *   - creator:       owns the board (created it)
 *   - level:         the explicit grant ('read' | 'edit' | null)
 *   - canRead:       may load the board + its tasks
 *   - canEdit:       admin-equivalent power over board content
 *   - readOnly:      explicitly view-only (so write paths can reject outright,
 *                    distinct from a public-board member who may still set status)
 *   - canViewAccess: may open the share dialog and see who has access
 *   - canManageAccess: may grant/revoke access for other members
 */
const resolveBoardAccess = (board, org, userId) => {
  const orgAdmin = isOrgAdmin(org, userId);
  const creator = isBoardCreator(board, userId);
  const level = boardGrantLevel(board, userId);
  const isPublic = board.visibility === 'public';
  // Private boards: only the creator and explicitly granted members get in —
  // org admins have no automatic access. Public boards: every member reads,
  // org admins edit.
  const canRead = creator || isPublic || level === 'read' || level === 'edit';
  const canEdit = creator || level === 'edit' || (isPublic && orgAdmin);
  const readOnly = !canEdit && level === 'read';
  // Editors always see the roster; they only change it when the owner opted in.
  const canViewAccess = creator || level === 'edit';
  const canManageAccess =
    creator || (level === 'edit' && board.editorsCanManageAccess === true);
  return {
    orgAdmin,
    creator,
    level,
    canRead,
    canEdit,
    readOnly,
    canViewAccess,
    canManageAccess,
  };
};

module.exports = {
  isOrgAdmin,
  boardGrantLevel,
  isBoardCreator,
  resolveBoardAccess,
};

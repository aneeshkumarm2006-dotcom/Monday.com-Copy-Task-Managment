/**
 * Board-level access resolution.
 *
 * Layered on top of the org admin/member model. A private board is normally
 * visible only to org admins; its creator can additionally grant individual
 * org members one of two access levels via `board.memberAccess`:
 *
 *   - 'read' — may view the board and its tasks, but cannot mutate anything
 *   - 'edit' — admin-equivalent power over board CONTENT (create/edit/delete
 *              tasks, groups, columns, statuses, labels) — i.e. everything
 *              except managing the board's own access list / lifecycle
 *
 * Public boards stay readable by every org member (unchanged behaviour).
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
 *   - orgAdmin: a true org admin
 *   - level:    the explicit grant ('read' | 'edit' | null)
 *   - canRead:  may load the board + its tasks
 *   - canEdit:  admin-equivalent power over board content
 *   - readOnly: explicitly view-only (so write paths can reject outright,
 *               distinct from a public-board member who may still set status)
 */
const resolveBoardAccess = (board, org, userId) => {
  const orgAdmin = isOrgAdmin(org, userId);
  const level = boardGrantLevel(board, userId);
  const isPublic = board.visibility === 'public';
  const canRead = orgAdmin || isPublic || level === 'read' || level === 'edit';
  const canEdit = orgAdmin || level === 'edit';
  const readOnly = !canEdit && level === 'read';
  return { orgAdmin, level, canRead, canEdit, readOnly };
};

module.exports = {
  isOrgAdmin,
  boardGrantLevel,
  isBoardCreator,
  resolveBoardAccess,
};

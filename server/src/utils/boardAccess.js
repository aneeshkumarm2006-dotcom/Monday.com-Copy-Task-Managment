const { normaliseLevel, levelAtLeast } = require('./capabilities');

/**
 * Coerce a ref that may be a raw ObjectId OR a populated Document to its id
 * string. A populated Document's toString() is its inspect string, not the hex
 * id, so a naive ref.toString() comparison silently fails the moment a caller
 * adds a .populate(). Mirrors idOf in permissions.js.
 */
const idOf = (ref) => String(ref?._id || ref || '');

/**
 * Board-level access resolution — the PURE standing primitive.
 *
 * This answers one narrow question: what is this user's standing ON this board?
 * Are they its creator, what rung were they granted, may they read it at all. It
 * knows nothing about org roles or the capability catalog.
 *
 * [permissions.js](./permissions.js) is the layer above: it expands this standing
 * into a capability set and ANDs it with the user's ORG ROLE. That is the
 * contract controllers should use — `resolveAccess`, not this. This file remains
 * because the expansion needs a primitive to expand, and because plain `canRead`
 * is wanted on paths (board listing, notification fan-out) that have no
 * capability question to ask.
 *
 * THE ACCESS LADDER — see [capabilities.js](./capabilities.js) `BOARD_LEVELS`:
 *
 *   view       — read the board
 *   comment    — + post updates and mention people
 *   contribute — + create tasks, and edit/complete tasks assigned to them
 *   edit       — + any task, groups, columns, statuses, notes, automations
 *
 * `read` is the legacy spelling of `view`; `normaliseLevel` folds it in, so
 * grants written before the ladder existed keep working with no data migration.
 *
 * Sharing is a separate axis from content: every 'edit' member may SEE who has
 * access (canViewAccess), but may CHANGE it (canManageAccess) only with the
 * owner-granted `canManage` flag. Full access is owner-granted only, so it cannot
 * be chained — a full-access member may hand out lower rungs but cannot mint
 * another full-access member, nor demote an existing one. The owner's own
 * standing is untouchable.
 *
 * Org admins get NO automatic access to a private board; they must be granted it
 * like anyone else. The single deliberate exception is the
 * `board.view_all_private` capability, which lives in the org role, is resolved
 * in permissions.js, and is OFF for every role by default.
 */

/**
 * Whether `userId` sits in the legacy `admin` / `admins[]` arrays.
 *
 * LEGACY, and no longer a permission decision in itself. Retained so that orgs
 * whose roles have not been backfilled yet still resolve correctly (see
 * `roleForUser` in permissions.js, which falls back to it). New code must not
 * branch on this — ask `can(capability)` instead. "Admin" is now a role like any
 * other, and what an admin may do is whatever its capability set says.
 */
const isOrgAdmin = (org, userId) =>
  !!org &&
  (
    (org.admin && idOf(org.admin) === String(userId)) ||
    (Array.isArray(org.admins) &&
      org.admins.some((a) => idOf(a) === String(userId)))
  );

/** The raw `memberAccess` entry for this user, or null. */
const boardGrant = (board, userId) => {
  if (!board || !Array.isArray(board.memberAccess)) return null;
  return (
    board.memberAccess.find(
      (e) => e.user && idOf(e.user) === String(userId)
    ) || null
  );
};

/** The explicit per-board grant, normalised onto the ladder, or null. */
const boardGrantLevel = (board, userId) => {
  const grant = boardGrant(board, userId);
  return grant ? normaliseLevel(grant.level) : null;
};

/** True when `userId` created the board — its owner. */
const isBoardCreator = (board, userId) =>
  !!board &&
  !!board.createdBy &&
  idOf(board.createdBy) === String(userId);

/**
 * True when `userId` holds a FULL-access grant: 'edit' plus the owner-granted
 * `canManage` flag. Meaningless below 'edit', so both are required.
 */
const hasFullAccess = (board, userId) => {
  const grant = boardGrant(board, userId);
  return (
    !!grant && normaliseLevel(grant.level) === 'edit' && grant.canManage === true
  );
};

/**
 * The rung this user stands on, ignoring their org role:
 *
 *   creator        → 'edit'  (they own the board)
 *   explicit grant → that rung
 *   public board   → the board's own `publicDefaultLevel`
 *   otherwise      → null    (no access)
 *
 * An explicit grant always beats the public default, so a public board can open
 * at `view` for the org while still handing one person `edit`.
 */
const effectiveLevel = (board, userId) => {
  if (!board) return null;
  if (isBoardCreator(board, userId)) return 'edit';

  const granted = boardGrantLevel(board, userId);
  if (granted) return granted;

  if (board.visibility === 'public') {
    return normaliseLevel(board.publicDefaultLevel) || 'contribute';
  }
  return null;
};

/**
 * Effective standing for `userId` on `board` (within `org`).
 *
 *   orgAdmin        legacy admins[] membership — informational only
 *   creator         owns the board
 *   level           the rung they stand on: view | comment | contribute | edit | null
 *   grantLevel      the EXPLICIT grant only — distinct from a public default
 *   fullAccess      granted 'edit' + sharing rights (and not the owner)
 *   canRead         may load the board and its tasks
 *   canEdit         may restructure board content
 *   readOnly        cannot even change a status, so write paths can reject outright
 *   canViewAccess   may open the share dialog and see who has access
 *   canManageAccess may grant/revoke access for other members
 */
const resolveBoardAccess = (board, org, userId) => {
  const orgAdmin = isOrgAdmin(org, userId);
  const creator = isBoardCreator(board, userId);
  const grantLevel = boardGrantLevel(board, userId);
  const fullAccess = hasFullAccess(board, userId);
  const level = effectiveLevel(board, userId);

  const canRead = !!level;
  const canEdit = levelAtLeast(level, 'edit');
  const readOnly = canRead && !levelAtLeast(level, 'contribute');

  const canViewAccess = creator || canEdit;
  const canManageAccess = creator || fullAccess;

  return {
    orgAdmin,
    creator,
    level,
    grantLevel,
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
  effectiveLevel,
  resolveBoardAccess,
};

const {
  ALL_CAPABILITIES,
  BOARD_SCOPED,
  OWNER_BOARD_CAPABILITIES,
  OWNER_ONLY_CAPABILITIES,
  NEVER_IMPLICIT,
  DEFAULT_ROLE_KEY,
  OWNER_ROLE_KEY,
  capabilitiesForLevel,
  normaliseLevel,
} = require('./capabilities');
const { resolveBoardAccess } = require('./boardAccess');

/**
 * THE permission contract. Everything that asks "may this user do X" goes
 * through here — controllers, services, and the payload the client renders its
 * UI from. One resolver, so a gate cannot drift from what the server enforces.
 *
 * Two layers, AND'd:
 *
 *     effective(cap) = orgRole grants cap  &&  boardLevel grants cap
 *
 * The org role is the floor, the board level the ceiling. Capabilities outside
 * BOARD_SCOPED consult the org role alone.
 *
 * Both functions are PURE — hand them docs you already loaded. The async
 * "which of these users can read board X" question lives in
 * [boardAudience.js](./boardAudience.js).
 */

/**
 * Coerce a ref that may be a raw ObjectId OR a populated Document to its id
 * string.
 *
 * This matters more than it looks. A populated Document's `toString()` returns
 * its inspect string ("{ name: 'Ann', _id: new ObjectId('…') }"), NOT the hex id
 * — so every `ref.toString() === userId` comparison silently evaluates false the
 * moment a caller adds a `.populate()`. `getOrg` populates `admin` and `members`,
 * which meant the owner failed their own ownership check and resolved to no
 * capabilities at all. Fail-closed, so it was invisible rather than loud.
 */
const idOf = (ref) => String(ref?._id || ref || '');

/** Is `userId` the org's owner? The one identity the matrix cannot touch. */
const isOrgOwner = (org, userId) =>
  !!org && !!org.admin && idOf(org.admin) === String(userId);

/**
 * The role subdocument this user holds, resolved in order:
 *   1. owner        → the `owner` role, always, regardless of memberRoles
 *   2. memberRoles  → their explicit assignment
 *   3. admins[]     → LEGACY fallback for orgs not yet migrated
 *   4. default      → the `member` role
 *
 * Step 3 is what lets this ship before the backfill has run everywhere: an org
 * still carrying only `admins[]` resolves correctly rather than silently
 * demoting every admin to member.
 */
const roleForUser = (org, userId) => {
  if (!org || !Array.isArray(org.roles) || org.roles.length === 0) return null;
  const uid = String(userId);
  const byKey = (k) => org.roles.find((r) => r.key === k) || null;

  if (isOrgOwner(org, uid)) return byKey(OWNER_ROLE_KEY);

  const assignment = (org.memberRoles || []).find(
    (m) => m.user && idOf(m.user) === uid
  );
  if (assignment) {
    const found = org.roles.find(
      (r) => r._id && r._id.toString() === assignment.role.toString()
    );
    // A role deleted out from under someone falls back to the default rather
    // than to "no capabilities" — losing your role should not lock you out.
    if (found) return found;
  }

  if (Array.isArray(org.admins) && org.admins.some((a) => idOf(a) === uid)) {
    return byKey('admin');
  }

  return byKey(DEFAULT_ROLE_KEY);
};

/**
 * The capability set `userId` holds at the ORG level (layer 1).
 *
 * The owner short-circuits to everything. A role that could strip the owner's
 * rights would be a lockout bug, so we never trust stored data for them.
 * OWNER_ONLY_CAPABILITIES are filtered out of every OTHER role no matter what
 * the matrix says — delegating the power to rewrite the matrix that constrains
 * you is how a delegate escalates to owner.
 *
 * NEVER_IMPLICIT is the one exception to the owner's short-circuit, and it is
 * deliberate. `board.view_all_private` opens every private board in the
 * workspace, and "private" has to mean private — including from the owner —
 * unless somebody consciously decides otherwise. So the owner does not get it for
 * free either: it has to be ticked ON in the matrix, like any other capability.
 * Without this carve-out, "default it off for every role" would have been a lie
 * the moment the owner logged in.
 */
const orgCapabilities = (org, userId) => {
  const role = roleForUser(org, userId);

  if (isOrgOwner(org, userId)) {
    const caps = new Set(ALL_CAPABILITIES);
    const explicit = new Set(role?.permissions || []);
    for (const cap of NEVER_IMPLICIT) {
      if (!explicit.has(cap)) caps.delete(cap);
    }
    return caps;
  }

  if (!role) return new Set();
  return new Set(
    (role.permissions || []).filter((c) => !OWNER_ONLY_CAPABILITIES.has(c))
  );
};

/**
 * Full org-level access summary for a user. `can` is the workhorse; the rest is
 * for the client payload and for callers that want to branch on identity.
 */
const resolveOrgAccess = (org, userId) => {
  const owner = isOrgOwner(org, userId);
  const role = roleForUser(org, userId);
  const caps = orgCapabilities(org, userId);
  // `members` may arrive raw (ObjectId) or populated (a User document). A
  // populated Document's toString() is its inspect string — "{ name: 'Ann', _id:
  // ... }" — never the hex id, so a naive `m.toString() === userId` silently
  // returned false for EVERY caller who had populated the path. Reach for `_id`
  // first, and only then fall back to the raw ref.
  const isMember =
    !!org &&
    Array.isArray(org.members) &&
    org.members.some((m) => String(m?._id || m) === String(userId));

  return {
    isOwner: owner,
    isMember,
    role: role
      ? { id: role._id, key: role.key, name: role.name, color: role.color }
      : null,
    capabilities: caps,
    can: (cap) => caps.has(cap),
  };
};

/**
 * The rung a user stands on, AFTER the org role's board-wide overrides.
 *
 * Two org capabilities can raise a user's standing above what the board itself
 * grants them, and both are visible in the matrix rather than hidden in code:
 *
 *   board.manage_public    → 'edit' on any PUBLIC board. This is the old
 *                            `canEdit = isPublic && orgAdmin` rule, made
 *                            explicit. Without it, a public board that opens at
 *                            `contribute` would stop admins from managing its
 *                            columns — a regression.
 *   board.view_all_private → 'view' on any PRIVATE board they'd otherwise not
 *                            reach. Read, not write: it lifts the visibility
 *                            gate, never the content ceiling. Off by default.
 */
const effectiveBoardLevel = (board, org, userId, orgAccess) => {
  const standing = resolveBoardAccess(board, org, userId).level;
  const isPublic = board.visibility === 'public';

  if (isPublic) {
    // A role that cannot see public boards at all (Guest) gets nothing from
    // publicness — only an explicit grant lets them in.
    if (!orgAccess.can('board.view_public')) {
      const granted = resolveBoardAccess(board, org, userId).grantLevel;
      if (!granted) return null;
      return orgAccess.can('board.manage_public') ? 'edit' : granted;
    }
    if (orgAccess.can('board.manage_public')) return 'edit';
    return standing;
  }

  if (standing) return standing;
  if (orgAccess.can('board.view_all_private')) return 'view';
  return null;
};

/**
 * The capability set `userId` holds ON A BOARD (layer 2) — before intersecting
 * with their org role.
 *
 * The board OWNER (createdBy) holds every board-scoped capability on their own
 * board, unconditionally — including delete and visibility, which no grant rung
 * confers. That is what makes "the creator owns their board" true in code, and it
 * fixes the old model, where a creator who was not an org admin could not rename
 * or delete the board they had made.
 */
const boardCapabilities = (board, org, userId, orgAccess) => {
  if (!board) return new Set();

  const access = resolveBoardAccess(board, org, userId);
  if (access.creator) return new Set(OWNER_BOARD_CAPABILITIES);

  const resolved = orgAccess || resolveOrgAccess(org, userId);

  // `board.manage_public` is owner-EQUIVALENT on a public board, not merely
  // 'edit'. The ladder deliberately keeps board LIFECYCLE (delete, visibility,
  // sharing) out of every rung — an edit grant is power over content, not over
  // the board's existence. So a rung alone could never let an admin delete a
  // public board, which is exactly what they could do before. This restores it,
  // scoped to public boards and visible in the matrix.
  if (board.visibility === 'public' && resolved.can('board.manage_public')) {
    return new Set(OWNER_BOARD_CAPABILITIES);
  }

  const level = effectiveBoardLevel(board, org, userId, resolved);
  if (!level) return new Set();

  return capabilitiesForLevel(level, { canManage: access.fullAccess });
};

/**
 * THE AND. Effective capabilities for a user on a specific board.
 *
 * Board-scoped capabilities require BOTH layers to allow. Everything else passes
 * through from the org role untouched, so e.g. `analytics.view` still works on a
 * board you can only view.
 */
const resolveAccess = (board, org, userId) => {
  const orgAccess = resolveOrgAccess(org, userId);
  const boardAccess = resolveBoardAccess(board, org, userId);
  const level = effectiveBoardLevel(board, org, userId, orgAccess);
  const boardCaps = boardCapabilities(board, org, userId, orgAccess);

  const effective = new Set();
  for (const cap of orgAccess.capabilities) {
    if (!BOARD_SCOPED.has(cap) || boardCaps.has(cap)) effective.add(cap);
  }

  const canRead = boardAccess.creator || !!level;

  return {
    ...orgAccess,
    board: boardAccess,
    level: boardAccess.creator ? 'edit' : level,
    canRead,
    capabilities: effective,
    can: (cap) => effective.has(cap),
    // The old vocabulary, derived from the new model so the two can never drift.
    // `canEdit` was "admin-equivalent over board content" — i.e. may restructure
    // the board, not merely fill it in.
    canEdit: effective.has('task.edit_any') && effective.has('group.manage'),
    // Can see it but cannot move a single thing on it.
    readOnly: canRead && !effective.has('task.change_status'),
    canViewAccess: boardAccess.creator || effective.has('group.manage'),
    canManageAccess:
      boardAccess.creator ||
      (boardAccess.fullAccess && effective.has('board.manage_access')),
  };
};

module.exports = {
  isOrgOwner,
  roleForUser,
  orgCapabilities,
  resolveOrgAccess,
  effectiveBoardLevel,
  boardCapabilities,
  resolveAccess,
};

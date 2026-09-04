const {
  ALL_CAPABILITIES,
  expandImplied,
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
 * NEVER_IMPLICIT is the one exception to the owner's short-circuit. It is empty
 * today — see the note on it in [capabilities.js](./capabilities.js) for why
 * withholding `board.view_all_private` from the owner turned out to be a
 * one-way door — so this loop is currently a no-op, kept because the set is
 * meant to be re-populatable.
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
  // `expandImplied` is what keeps a STORED role honest against a catalog that
  // has moved on. A workspace older than the `goal.create` split stores
  // `goal.manage` ("do anything to anyone's goal") and not `goal.create` ("add
  // one"), and this layer is an AND — so without the expansion the org role, not
  // the board, is what refused a board editor their own create. See
  // IMPLIED_CAPABILITIES in [capabilities.js](./capabilities.js) for the rule
  // about what may go in that table.
  //
  // Expand FIRST, then filter: an owner-only capability must not slip in through
  // the back door of something that implies it.
  return new Set(
    [...expandImplied(role.permissions || [])].filter(
      (c) => !OWNER_ONLY_CAPABILITIES.has(c)
    )
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
 * THE ORG OWNER STANDS ON `edit` EVERYWHERE, unconditionally. They own the
 * workspace, so there is no board in it they can be locked out of — see
 * `boardCapabilities` below for what that buys them and why the alternative was
 * a one-way door.
 *
 * Three org capabilities can raise everyone ELSE's standing above what the board
 * itself grants them, and all three are visible in the matrix rather than hidden
 * in code:
 *
 *   board.manage_public       → 'edit' on any PUBLIC board. This is the old
 *                               `canEdit = isPublic && orgAdmin` rule, made
 *                               explicit. Without it, a public board that opens
 *                               at `contribute` would stop admins from managing
 *                               its columns — a regression.
 *   board.view_all_private    → 'view' on any PRIVATE board they'd otherwise not
 *                               reach. Read, not write: it lifts the visibility
 *                               gate, never the content ceiling. Off by default.
 *   board.manage_all_private  → 'edit' on a PRIVATE board they can already
 *                               reach. The write half `view_all_private`
 *                               deliberately withheld, split out so the two can
 *                               be granted independently. Off by default.
 *
 * Note the ordering of the last two: `manage_all_private` never opens a board on
 * its own. Reach first (a grant, or `view_all_private`), power second — exactly
 * the division the public pair already uses.
 */
const effectiveBoardLevel = (board, org, userId, orgAccess) => {
  if (isOrgOwner(org, userId)) return 'edit';

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

  // Private. Reach is `standing` (creator or explicit grant) or the
  // `view_all_private` override; `manage_all_private` then decides how far.
  const reaches = !!standing || orgAccess.can('board.view_all_private');
  if (!reaches) return null;
  if (orgAccess.can('board.manage_all_private')) return 'edit';
  return standing || 'view';
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
 *
 * THE ORG OWNER HOLDS THE SAME SET ON EVERY BOARD IN THEIR WORKSPACE, and that
 * is the deliberate reversal of an earlier rule. Board lifecycle — rename,
 * delete, flip public/private — is conferred by NO rung of the ladder, only by
 * `createdBy`. So a board somebody else made private had exactly one account in
 * the whole organisation that could ever un-private it, and the matrix had no
 * capability that could stand in: `board.view_all_private` resolves to `view`,
 * which is read. A member could take a shared board private, leave the company,
 * and strand it permanently — with the workspace owner able to watch it and do
 * nothing. Whatever privacy that bought was not worth a board nobody can
 * administer.
 *
 * Note this is the ORG owner (`Organisation.admin`) — one person, not a role,
 * and not the legacy `admins[]` array. Org admins still get nothing on a private
 * board without a grant or `board.manage_all_private`.
 */
const boardCapabilities = (board, org, userId, orgAccess) => {
  if (!board) return new Set();

  if (isOrgOwner(org, userId)) return new Set(OWNER_BOARD_CAPABILITIES);

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

  // The private mirror of the branch above, and owner-EQUIVALENT for the same
  // reason: `edit` is power over CONTENT, and the whole point of this capability
  // is power over the board's EXISTENCE — the rename, the delete, the flip back
  // to public that no rung confers. Gated on `level` having resolved first, so
  // it still cannot open a board the holder has no reach into.
  if (
    board.visibility === 'private' &&
    resolved.can('board.manage_all_private')
  ) {
    return new Set(OWNER_BOARD_CAPABILITIES);
  }
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

  // `owns` is "holds this board outright" — the board's creator, or the org
  // owner, who owns every board in the workspace. The flags below used to read
  // `boardAccess.creator` alone, which is org-agnostic by design and therefore
  // cannot know about the second case.
  const owns = boardAccess.creator || orgAccess.isOwner;
  const canRead = owns || !!level;

  return {
    ...orgAccess,
    board: boardAccess,
    level: owns ? 'edit' : level,
    canRead,
    capabilities: effective,
    can: (cap) => effective.has(cap),
    // The old vocabulary, derived from the new model so the two can never drift.
    // `canEdit` was "admin-equivalent over board content" — i.e. may restructure
    // the board, not merely fill it in.
    canEdit: effective.has('task.edit_any') && effective.has('group.manage'),
    // Can see it but cannot move a single thing on it.
    readOnly: canRead && !effective.has('task.change_status'),
    canViewAccess: owns || effective.has('group.manage'),
    // Sharing is a separate axis from content: an `edit` grant alone never
    // confers it, only the owner-granted `canManage` flag does. `owns` covers
    // the two identities that hold the board outright, and the capability test
    // covers the third case the flag cannot see — a matrix override
    // (`board.manage_public` / `board.manage_all_private`) that resolved to the
    // owner-equivalent set, which INCLUDES `board.manage_access`. Without that
    // last clause the share dialog was read-only for exactly the people the
    // matrix had just declared able to fully manage the board.
    canManageAccess:
      owns ||
      ((boardAccess.fullAccess || boardCaps.has('board.manage_access')) &&
        effective.has('board.manage_access')),
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

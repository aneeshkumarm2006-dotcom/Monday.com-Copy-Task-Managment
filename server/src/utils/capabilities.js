/**
 * The capability catalog — the single source of truth for "what can be permitted".
 *
 * Before this file, a role was not data: it was a position in an array
 * (`org.admin`, `org.admins[]`, `org.members[]`). You could not add a fourth
 * role without adding a fourth array, and `admin` was one bit that granted
 * roughly fifteen unrelated powers at once. Here, a role becomes a *named set of
 * capability keys* — ordinary data — and the permissions matrix in the UI is
 * simply the editor for that data.
 *
 * PERMISSION IS RESOLVED IN TWO LAYERS THAT **AND** TOGETHER:
 *
 *   effective = orgRole grants CAP  &&  boardLevel grants CAP
 *
 * The org role is the floor (may you do this in the workspace at all?) and the
 * board level is the ceiling (may you do it on *this* board?). Neither can
 * silently outrank the other. That is the fix for the old model's central bug,
 * where `isOrgAdmin` overrode board access — which is how an org admin ended up
 * able to delete a private board they could not even open.
 *
 * Capabilities in BOARD_SCOPED are subject to both layers. Everything else is
 * org-scoped and consults the org role only.
 *
 * See [permissions.js](./permissions.js) for the resolver and
 * [boardAccess.js](./boardAccess.js) for the board-level ladder.
 */

/**
 * Every capability, grouped for the UI matrix. `group` order here is the order
 * the matrix renders. Keys are stable strings — they are persisted on the role
 * documents, so RENAMING A KEY IS A MIGRATION, not a refactor.
 */
const CAPABILITY_GROUPS = [
  {
    key: 'workspace',
    name: 'Workspace',
    capabilities: [
      ['org.view_members', 'See the member list'],
      ['org.invite_members', 'Invite people and send invite links'],
      ['org.remove_members', 'Remove people from the organisation'],
      ['org.assign_roles', 'Change which role a person has'],
      ['org.manage_roles', 'Create and edit roles — edit this matrix'],
      ['org.manage_settings', 'Rename the org, rotate the invite code'],
    ],
  },
  {
    key: 'boards',
    name: 'Boards',
    capabilities: [
      ['board.create', 'Create new boards'],
      ['board.rename', 'Rename a board or edit its description'],
      ['board.delete', 'Delete a board and everything in it'],
      ['board.change_visibility', 'Flip a board between public and private'],
      ['board.manage_access', 'Share boards they can already edit'],
      ['board.view_public', "See the organisation's public boards at all"],
      ['board.manage_public', 'Fully manage any public board'],
      ['board.view_all_private', 'Enter every private board — override'],
    ],
  },
  {
    key: 'content',
    name: 'Board content',
    capabilities: [
      ['task.create', 'Add tasks'],
      ['task.edit_assigned', 'Edit tasks assigned to them'],
      ['task.edit_any', 'Edit any task on the board'],
      ['task.change_status', "Change a task's status"],
      ['task.assign', 'Assign people to tasks'],
      ['task.delete', 'Delete tasks'],
      ['task.move', 'Move tasks between groups and boards'],
      ['group.manage', 'Add, rename, reorder and delete groups'],
      ['column.manage', 'Add, retype and delete columns, labels and statuses'],
      ['note.manage', 'Write group notes'],
    ],
  },
  {
    key: 'comments',
    name: 'Comments',
    capabilities: [
      ['update.create', 'Post updates and mention people'],
      ['update.delete_any', "Delete anyone's comment"],
    ],
  },
  {
    key: 'automations',
    name: 'Automations',
    capabilities: [
      ['automation.view', "See a board's automations"],
      ['automation.manage', 'Create, edit and delete automations'],
    ],
  },
  {
    key: 'trackers',
    name: 'Trackers',
    // Deliberately its own group rather than folded into `insights`. Insights
    // holds org-wide, cross-board reporting — `analytics.view` reads every board
    // in the org, `productivity.view_others` names individuals. A tracker is
    // per-board configuration that lives on the board, so its true peer is
    // `automation.view` / `automation.manage` directly above.
    capabilities: [
      ['tracker.view', "See a board's trackers and its Delivery view"],
      ['tracker.manage', 'Create, edit and delete trackers'],
    ],
  },
  {
    key: 'goals',
    name: 'Monthly goals',
    // Three rungs rather than the usual view/manage pair, because filling in a
    // number and changing what was promised are genuinely different acts. The
    // person who types "we reached rank 4" at month end is usually an executive
    // sitting on `contribute`; folding that into `goal.manage` would mean
    // over-permissioning them — handing them the power to edit targets — purely
    // so they could report a result.
    capabilities: [
      ['goal.view', "See a board's Monthly Goals and their scores"],
      ['goal.track', 'Fill in the final numbers on existing goals'],
      ['goal.manage', 'Create, edit and delete goals, and set targets'],
    ],
  },
  {
    key: 'insights',
    name: 'Insights',
    capabilities: [
      ['analytics.view', 'Board analytics and dashboards'],
      ['productivity.view_others', "See other people's productivity"],
      ['board.export_activity', "Export a board's activity log"],
    ],
  },
];

/** Flat list of every valid capability key. */
const ALL_CAPABILITIES = CAPABILITY_GROUPS.flatMap((g) =>
  g.capabilities.map(([key]) => key)
);

const CAPABILITY_SET = new Set(ALL_CAPABILITIES);

const isCapability = (key) => CAPABILITY_SET.has(key);

/**
 * Capabilities that are ALSO gated by the board access level. A user needs both
 * the org-role grant and sufficient board access to exercise these.
 *
 * Note what is NOT here: `board.create` (you cannot have board access to a board
 * that does not exist yet), the org.* family, `analytics.view`, and the three
 * board-visibility capabilities (`board.view_public`, `board.manage_public`,
 * `board.view_all_private) — those decide *whether* and *how far* you reach a
 * board in the first place, so gating them on board access would be circular.
 *
 * `board.export_activity` is deliberately org-scoped too, for the same reason
 * `analytics.view` is: no rung of LEVEL_ADDS confers it, so board-scoping it
 * would AND it away for everyone except the board's own creator. The export
 * endpoint still runs through `loadBoardContext`, so board READ access gates
 * which boards it reaches — which is the whole ceiling it needs.
 */
const BOARD_SCOPED = new Set([
  'board.rename',
  'board.delete',
  'board.change_visibility',
  'board.manage_access',
  'task.create',
  'task.edit_assigned',
  'task.edit_any',
  'task.change_status',
  'task.assign',
  'task.delete',
  'task.move',
  'group.manage',
  'column.manage',
  'note.manage',
  'update.create',
  'update.delete_any',
  'automation.view',
  'automation.manage',
  // Board-scoped is only SAFE because LEVEL_ADDS confers both below — `view`
  // grants tracker.view and `edit` grants tracker.manage. That is the actual
  // rule the analytics.view note above encodes: board-scope a capability no rung
  // confers and the AND strips it from everyone except the board's creator.
  'tracker.view',
  'tracker.manage',
  // Same reasoning, same obligation: all three are conferred by a LEVEL_ADDS
  // rung below, which is what makes board-scoping them safe.
  'goal.view',
  'goal.track',
  'goal.manage',
]);

/**
 * The board access ladder. Each rung is a superset of the one below it, so the
 * ladder is defined by what each rung ADDS. `LEVEL_CAPABILITIES` expands them.
 *
 * The old ladder had exactly two rungs — `read` and `edit` — and nothing between
 * them. `edit` meant "can delete columns and restructure the board", `read` meant
 * "cannot tick a checkbox". Almost everyone on a real board belongs in between,
 * which forced you to over-permission nearly the whole team. `comment` and
 * `contribute` are the missing middle.
 */
const BOARD_LEVELS = ['view', 'comment', 'contribute', 'edit'];

const LEVEL_ADDS = {
  // Read the board. (The old `read`, renamed.) Seeing whether the board is
  // meeting its commitments is reading it — a missed day the team cannot see is
  // a missed day nobody fixes.
  // Seeing whether the month's goals were met is likewise reading the board.
  view: ['tracker.view', 'goal.view'],
  // + weigh in without touching the data.
  comment: ['update.create'],
  // + do your own work, without being able to restructure the board.
  // Reporting a result you are responsible for is doing your own work; deciding
  // what the target should have been is not.
  contribute: ['task.create', 'task.edit_assigned', 'task.change_status', 'goal.track'],
  // + full control of board content. (The old `edit`.)
  edit: [
    'task.edit_any',
    'task.delete',
    'task.assign',
    'task.move',
    'group.manage',
    'column.manage',
    'note.manage',
    'update.delete_any',
    'automation.view',
    'automation.manage',
    'tracker.manage',
    'goal.manage',
    'board.rename',
  ],
};

/** level → Set of every capability that level confers (cumulative up the ladder). */
const LEVEL_CAPABILITIES = (() => {
  const out = {};
  const acc = [];
  for (const level of BOARD_LEVELS) {
    acc.push(...LEVEL_ADDS[level]);
    out[level] = new Set(acc);
  }
  return out;
})();

/**
 * Capabilities conferred by a board level, plus the sharing right that only
 * FULL access (edit + canManage) or the board owner carries.
 */
const capabilitiesForLevel = (level, { canManage = false } = {}) => {
  const base = LEVEL_CAPABILITIES[level];
  if (!base) return new Set();
  const out = new Set(base);
  if (canManage) out.add('board.manage_access');
  return out;
};

/**
 * The board OWNER (createdBy) holds every board-scoped capability on their own
 * board, unconditionally — including delete and visibility, which no grant level
 * confers. This is what makes "the creator owns the board" true in code rather
 * than by convention.
 */
const OWNER_BOARD_CAPABILITIES = new Set(BOARD_SCOPED);

/**
 * Legacy grant levels stored before the ladder existed. `read` and `edit` are
 * still accepted on the wire and in the DB; they mean the rungs they always
 * meant. Normalising here rather than migrating the documents keeps old rows
 * working untouched.
 */
const LEGACY_LEVEL_ALIASES = { read: 'view' };

const normaliseLevel = (level) => {
  if (!level) return null;
  const mapped = LEGACY_LEVEL_ALIASES[level] || level;
  return BOARD_LEVELS.includes(mapped) ? mapped : null;
};

/** Is `a` at least as high on the ladder as `b`? */
const levelAtLeast = (a, b) => {
  const ia = BOARD_LEVELS.indexOf(normaliseLevel(a));
  const ib = BOARD_LEVELS.indexOf(normaliseLevel(b));
  if (ia === -1 || ib === -1) return false;
  return ia >= ib;
};

// ---------------------------------------------------------------------------
// Escalation guards. Declared before SYSTEM_ROLES because the presets are
// defined in terms of them.
// ---------------------------------------------------------------------------

/**
 * Capabilities that are the owner's alone and can never be granted to another
 * role, no matter what the matrix says. Currently empty: `org.manage_roles`
 * used to live here, but the workspace decided delegating matrix editing (to
 * admins, typically) is acceptable — note that a role holding it can rewrite
 * the matrix that constrains itself. The plumbing stays so a capability can be
 * made owner-only again by listing it.
 */
const OWNER_ONLY_CAPABILITIES = new Set([]);

/**
 * Capabilities the OWNER does not get implicitly, despite otherwise holding
 * everything. They must be ticked ON in the matrix like any other permission.
 *
 * `board.view_all_private` opens every private board in the workspace. "Private"
 * has to mean private — including from the owner — until somebody consciously
 * decides otherwise. Without this carve-out, "off by default for every role"
 * would have been a lie the moment the owner logged in, because the resolver
 * short-circuits them to the full capability set.
 */
const NEVER_IMPLICIT = new Set(['board.view_all_private']);

// ---------------------------------------------------------------------------
// System roles — the presets every new org is seeded with.
// ---------------------------------------------------------------------------

/**
 * `owner` is special and deliberately NOT listed with a capability set: the owner
 * implicitly holds every capability, always. A role that could revoke the owner's
 * rights is a lockout bug waiting to happen, so the resolver short-circuits for
 * them rather than trusting stored data.
 *
 * The other three are ordinary data — editable in the matrix, and only
 * `isSystem` so they cannot be deleted out from under the members holding them.
 */
const SYSTEM_ROLES = [
  {
    key: 'owner',
    name: 'Owner',
    isSystem: true,
    color: '#7C3AED',
    description: 'Full control of the workspace. Cannot be edited or removed.',
    // Everything EXCEPT the never-implicit capabilities. The resolver grants the
    // owner the full set regardless of what is stored here — the only thing it
    // actually reads off this list is which NEVER_IMPLICIT capabilities the owner
    // has deliberately turned on. Seeding them here would silently switch
    // `board.view_all_private` on for the owner of every workspace.
    permissions: ALL_CAPABILITIES.filter((c) => !NEVER_IMPLICIT.has(c)),
  },
  {
    key: 'admin',
    name: 'Admin',
    isSystem: true,
    color: '#2563EB',
    description: 'Runs the workspace day to day.',
    permissions: [
      'org.view_members',
      'org.invite_members',
      'org.remove_members',
      'org.assign_roles',
      'org.manage_roles',
      'org.manage_settings',
      'board.create',
      'board.rename',
      'board.delete',
      'board.change_visibility',
      'board.manage_access',
      'board.view_public',
      // Preserves the old `canEdit = isPublic && orgAdmin` rule: admins run the
      // org's public boards outright, above whatever rung the board opens to
      // everyone else.
      'board.manage_public',
      'task.create',
      'task.edit_assigned',
      'task.edit_any',
      'task.change_status',
      'task.assign',
      'task.delete',
      'task.move',
      'group.manage',
      'column.manage',
      'note.manage',
      'update.create',
      'update.delete_any',
      'automation.view',
      'automation.manage',
      'tracker.view',
      'tracker.manage',
      'goal.view',
      'goal.track',
      'goal.manage',
      'analytics.view',
      'productivity.view_others',
      // Holding this only makes the export *possible*. Each admin still has to
      // switch `features.activityExport` on for themselves in Settings → Extra
      // features before the button appears or the endpoint answers.
      'board.export_activity',
    ],
    // NOT granted by default, on purpose: `board.view_all_private` (private
    // stays private until you say otherwise).
    //
    // NOTE for existing workspaces: `ensureSystemRoles` only seeds MISSING
    // ROLES, never missing capabilities on roles that already exist. So an org
    // created before this capability landed keeps its stored admin permission
    // list, and an admin there has to tick `board.export_activity` on once in
    // Members → Permissions. The owner is unaffected — the resolver
    // short-circuits them to the full catalog.
  },
  {
    key: 'member',
    name: 'Member',
    isSystem: true,
    color: '#16A34A',
    description: 'Does the work. The default role for everyone who joins.',
    permissions: [
      'org.view_members',
      'board.create',
      'board.view_public',
      // Board LIFECYCLE. Granting these at the org level does NOT mean a member
      // can rename or delete any board they can see — the board layer scopes them
      // to boards they OWN (no ladder rung confers lifecycle; only `createdBy`
      // does). Without them here the AND would strip the capability from the
      // board's own creator, which is precisely the bug this model set out to
      // fix: a creator who was not an org admin could not rename their own board.
      'board.rename',
      'board.delete',
      'board.change_visibility',
      'board.manage_access',
      'task.create',
      'task.edit_assigned',
      'task.edit_any',
      'task.change_status',
      'task.assign',
      'task.delete',
      'task.move',
      'group.manage',
      'column.manage',
      'note.manage',
      'update.create',
      // Moderate comments on boards they run. Board-scoped, so the AND still
      // limits it to boards where they hold `edit` — in practice, their own.
      'update.delete_any',
      'automation.view',
      'automation.manage',
      'tracker.view',
      'tracker.manage',
      'goal.view',
      'goal.track',
      'goal.manage',
    ],
    // NOT granted, on purpose: `analytics.view`. The analytics and productivity
    // pages were admin-only before this system existed, and quietly opening them
    // to every member would be a silent loosening. Tick it on in the matrix if
    // you want members to see them. (The DASHBOARD is a different endpoint and
    // stays open to everyone, as it always was.)
  },
  {
    key: 'viewer',
    name: 'Viewer',
    isSystem: true,
    color: '#6B7280',
    description: 'Read-only across the workspace.',
    // `tracker.view` and `goal.view` are reads. A viewer who can open a board
    // should be able to see whether that board is keeping its promises and
    // whether it hit its numbers; they still cannot create a tracker, confirm a
    // period, excuse a miss, or type a result into a goal.
    permissions: [
      'org.view_members', 'board.view_public', 'tracker.view', 'goal.view',
    ],
  },
  {
    key: 'guest',
    name: 'Guest',
    isSystem: true,
    color: '#EA580C',
    description:
      'External. Sees only the boards explicitly shared with them — never the ' +
      "organisation's public boards.",
    // The absence of `board.view_public` is the whole point of this role.
    permissions: [
      'task.create',
      'task.edit_assigned',
      'task.change_status',
      'update.create',
    ],
  },
];

/** The role a member gets when nothing else is specified. */
const DEFAULT_ROLE_KEY = 'member';
const OWNER_ROLE_KEY = 'owner';

/** Strip anything that isn't a real capability, and de-dupe. */
const sanitizePermissions = (permissions) => {
  if (!Array.isArray(permissions)) return [];
  return [...new Set(permissions.filter((p) => CAPABILITY_SET.has(p)))];
};

module.exports = {
  CAPABILITY_GROUPS,
  ALL_CAPABILITIES,
  BOARD_SCOPED,
  BOARD_LEVELS,
  LEVEL_ADDS,
  LEVEL_CAPABILITIES,
  OWNER_BOARD_CAPABILITIES,
  OWNER_ONLY_CAPABILITIES,
  NEVER_IMPLICIT,
  SYSTEM_ROLES,
  DEFAULT_ROLE_KEY,
  OWNER_ROLE_KEY,
  capabilitiesForLevel,
  normaliseLevel,
  levelAtLeast,
  isCapability,
  sanitizePermissions,
};

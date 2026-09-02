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
      ['org.remove_members', 'Remove people from the workspace'],
      ['org.assign_roles', 'Change which role a person has'],
      ['org.manage_roles', 'Create and edit roles — edit this matrix'],
      ['org.manage_settings', 'Rename the workspace, rotate the invite code'],
      // Its own capability rather than riding on org.manage_settings: marking a
      // day off changes what every board in the workspace counts as owed, which
      // an ops lead may well need to do without also being able to rename the
      // organisation or rotate its invite code.
      ['org.manage_holidays', 'Set the company holiday calendar'],
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
      // The private twin of `board.manage_public`, and it exists because its
      // absence was a one-way door. `view_all_private` lifts the VISIBILITY gate
      // and stops there — it resolves to the `view` rung, which confers no
      // lifecycle capability at all. So a private board whose creator left, or
      // who never shared it, could be looked at by an admin and administered by
      // nobody: not renamed, not deleted, not flipped back to public. The only
      // escape was the creator's own account.
      //
      // Same division of labour as the public pair above: `view_*` decides
      // WHETHER you reach the board, `manage_*` decides HOW FAR you go once you
      // do. Holding this alone opens nothing; it upgrades a private board you can
      // ALREADY reach — by grant, or by `view_all_private` — to owner-equivalent
      // control. Off for every seeded role, including admin.
      [
        'board.manage_all_private',
        'Fully manage every private board they can enter',
      ],
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
    // FOUR rungs rather than the usual view/manage pair, because three
    // genuinely different acts hide inside "edit a goal": filling in a number,
    // writing down a goal for the client you run, and rewriting what somebody
    // else promised. The person who types "we reached rank 4" at month end is
    // usually an executive sitting on `contribute`; folding that into
    // `goal.manage` would mean over-permissioning them — handing them the power
    // to edit anyone's targets — purely so they could report a result.
    //
    // `goal.create` is the rung that was missing, and its absence was not
    // theoretical: on a board left at the default `contribute`, an executive who
    // owns a client could report results but could not write down what they were
    // aiming for, because the only capability that could create a goal also
    // carried delete-anyone's. The split mirrors `task.edit_assigned` vs
    // `task.edit_any` exactly — "your own work" is a lower rung than "anything
    // on this board" — and it is deliberately the same shape rather than a new
    // idea, because a permission model people cannot predict is one they route
    // around.
    capabilities: [
      ['goal.view', "See a board's Monthly Goals and their scores"],
      ['goal.track', 'Fill in the final numbers on existing goals'],
      ['goal.create', 'Add goals, and edit or delete the ones they added'],
      ['goal.manage', "Edit and delete anyone's goals, and set targets"],
    ],
  },
  {
    key: 'adsBudget',
    name: 'Ads budgets',
    // Three rungs rather than the usual view/manage pair, and for exactly the
    // reason goals above has three: recording what was SPENT and deciding what
    // may be spent are different acts by different people. The account manager
    // who types in last week's Meta spend belongs on `contribute`; folding that
    // into `adsBudget.manage` would hand them the power to raise the client's
    // budget purely so they could report against it.
    capabilities: [
      ['adsBudget.view', "See a board's ads budgets"],
      ['adsBudget.track', 'Record spend against existing ads budgets'],
      [
        'adsBudget.manage',
        'Create, edit and delete ads budgets, set allocations, and switch the add-on on',
      ],
    ],
  },
  {
    key: 'vault',
    name: 'Vault',
    // A pair rather than the usual view/manage split doing double duty: here
    // `vault.view` does NOT mean "can read the secrets". Nobody can read them
    // without the vault password, which the server never has. It means "may the
    // Vault tab exist for this person at all" — the outer door, in front of the
    // one the password opens.
    //
    // That distinction is why the two sit on DIFFERENT rungs below: `vault.view`
    // on `view`, because the password is the real gate and the outer door alone
    // reveals nothing; `vault.manage` on `edit`, because deleting a credential
    // needs no password and cannot be undone.
    capabilities: [
      ['vault.view', "Open a board's Vault and read its items"],
      ['vault.manage', 'Add, edit and delete vault items, and set up the vault'],
    ],
  },
  {
    key: 'connectors',
    name: 'Connectors',
    // A pair, and note where the line falls. `connector.view` is "may this
    // person see the data we already pulled" — which is reading the board, so it
    // sits on `view` with the other read capabilities.
    //
    // `connector.manage` covers mapping a project to a group, editing field
    // mappings, and pressing Refresh. Refresh is the reason it sits at `edit`
    // rather than `contribute`: it spends a shared, finite quota against the
    // org's external account, and a mapping change silently rewires which
    // client's numbers land on which row. Neither is "doing your own work".
    //
    // Connecting an ACCOUNT is not here at all. That is credential handling for
    // the whole workspace, so it answers to the org-scoped
    // `org.manage_settings` instead — a board editor should not be able to
    // attach a new external identity to the organisation.
    capabilities: [
      ['connector.view', "See a board's connector data and Add-ons tab"],
      ['connector.manage', 'Map projects and fields, and refresh connector data'],
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
 * that does not exist yet), the org.* family, `analytics.view`, and the four
 * board-visibility capabilities (`board.view_public`, `board.manage_public`,
 * `board.view_all_private`, `board.manage_all_private`) — those decide *whether*
 * and *how far* you reach a board in the first place, so gating them on board
 * access would be circular.
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
  'goal.create',
  'goal.manage',
  // Same obligation again, and note the two are conferred by DIFFERENT rungs in
  // LEVEL_ADDS — `vault.view` by `view`, `vault.manage` by `edit`. Both are
  // conferred by some rung, which is what makes board-scoping them safe rather
  // than a silent revoke.
  'vault.view',
  'vault.manage',
  // Same obligation once more: both are conferred by a LEVEL_ADDS rung below —
  // `connector.view` by `view`, `connector.manage` by `edit` — which is what
  // makes board-scoping them safe rather than a silent revoke for everyone but
  // the board's creator.
  'connector.view',
  'connector.manage',
  // And once more. All three are conferred by a LEVEL_ADDS rung below —
  // `adsBudget.view` by `view`, `adsBudget.track` by `contribute`,
  // `adsBudget.manage` by `edit` — which is what makes board-scoping them safe
  // rather than a silent revoke for everyone but the board's creator.
  'adsBudget.view',
  'adsBudget.track',
  'adsBudget.manage',
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
  //
  // `vault.view` is here too, and it is the one rung placement worth pausing
  // over. It grants the outer door only: the Vault tab appears and the
  // ENCRYPTED items load. Reading any of them still needs the vault password,
  // which the server never holds and cannot hand out. Someone on the board who
  // has been given that password was trusted with it deliberately, by a person,
  // out of band — so making them climb to the `edit` rung as well only meant
  // over-permissioning them everywhere else in order to let them read a
  // password they already had.
  //
  // `connector.view` joins them for the same reason the first two are here:
  // what a connector has already pulled — this client's ranks, their traffic,
  // their audit — is board content. Someone who can read the board can read it.
  // Nothing here spends quota or reaches the provider; every byte comes from our
  // own snapshots.
  view: ['tracker.view', 'goal.view', 'vault.view', 'connector.view', 'adsBudget.view'],
  // + weigh in without touching the data.
  comment: ['update.create'],
  // + do your own work, without being able to restructure the board.
  // Reporting a result you are responsible for is doing your own work; deciding
  // what the target should have been is not.
  contribute: [
    'task.create',
    'task.edit_assigned',
    'task.change_status',
    'goal.track',
    // Writing down what you are aiming for on the client you run is doing your
    // own work, the same act as `task.create` two lines up. Editing and deleting
    // are limited to goals this person created — the controller checks
    // `createdBy` — so nobody at this rung can rewrite a target somebody else
    // agreed with a client, which is the part that stays on `edit`.
    'goal.create',
    // Typing in what a channel actually spent is reporting a result you are
    // responsible for, the same act as `goal.track` beside it. Deciding what
    // the allocation should be is not, and stays on `edit`.
    'adsBudget.track',
  ],
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
    'adsBudget.manage',
    'board.rename',
    // CHANGING a vault stays here, at the top, even though opening its door
    // dropped to `view`. Reading is gated twice — by this ladder and then by a
    // password the server does not have — but adding, overwriting and deleting
    // items are gated by the ladder ALONE. An unrecoverable delete needs no
    // password, so it needs the rung.
    'vault.manage',
    // Mapping decides which client's numbers land on which row, and Refresh
    // spends a shared quota against the org's external account. Both are
    // board-shaping acts rather than personal ones, so both sit at the top.
    'connector.manage',
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
 * CURRENTLY EMPTY, and that is a decision rather than an oversight. The set held
 * `board.view_all_private` so that "private" would mean private from the owner
 * too. It read well and it locked the workspace owner out of their own
 * workspace: a private board they did not create resolved to the `view` rung at
 * best, which confers no lifecycle capability, so a board somebody else made
 * private could be renamed, deleted, or flipped back to public by exactly one
 * account in the org — its creator's. If that person is on leave, or has left,
 * the board is stranded, and nothing in the matrix could rescue it because
 * ticking the override on only ever bought READ.
 *
 * So the owner now holds everything unconditionally, on every board in their
 * workspace — see `isOrgOwner` in [permissions.js](./permissions.js). Privacy
 * from EVERYONE ELSE is unchanged and still off by default: `board.view_all_private`
 * and its new companion `board.manage_all_private` are ordinary capabilities
 * that no seeded role carries, admins included.
 *
 * The plumbing stays. Listing a capability here withholds it from the owner
 * again, and the matrix will render that row as a togglable opt-in for them.
 */
const NEVER_IMPLICIT = new Set([]);

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
    // Everything EXCEPT the never-implicit capabilities — which is currently
    // everything, since that set is empty. The resolver grants the owner the
    // full set regardless of what is stored here; the only thing it actually
    // reads off this list is which NEVER_IMPLICIT capabilities the owner has
    // deliberately turned on, so seeding them here would switch them on for the
    // owner of every workspace.
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
      'org.manage_holidays',
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
      'goal.create',
      'goal.manage',
      'adsBudget.view',
      'adsBudget.track',
      'adsBudget.manage',
      'vault.view',
      'vault.manage',
      'connector.view',
      'connector.manage',
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
      'goal.create',
      'goal.manage',
      'adsBudget.view',
      'adsBudget.track',
      'adsBudget.manage',
      // Board-scoped, so the AND still limits this to boards where they hold
      // `edit` — in practice their own. A member who creates a board and cannot
      // open its vault would be locked out of a room in their own house.
      'vault.view',
      'vault.manage',
      // Same shape, same reasoning: board-scoped, so the AND limits `manage` to
      // boards where they hold `edit`. Note this only lets them switch a
      // connector on and map its projects — CONNECTING the account itself is
      // org-scoped `org.manage_settings`, which members do not have.
      'connector.view',
      'connector.manage',
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
    //
    // `vault.view` IS here, and it is a read like the two beside it: the Vault
    // tab appears and its encrypted items load, and that is the whole of it —
    // the password that turns them into text is not the workspace's to grant.
    // A viewer still cannot add, edit or delete an item; `vault.manage` is
    // absent here AND sits on the `edit` rung, so both layers refuse it.
    //
    // The `guest` role below deliberately does NOT get this. That is the line:
    // the team can see the door, external people shared into one board cannot.
    //
    // `connector.view` is a read too, and a cheap one: it serves rows out of our
    // own database and never contacts an external provider, so a viewer opening
    // the tab spends none of the workspace's API quota. They cannot map a
    // project, edit a field mapping, or press Refresh — `connector.manage` is
    // absent here AND sits on the `edit` rung, so both layers refuse it.
    permissions: [
      'org.view_members', 'board.view_public', 'tracker.view', 'goal.view', 'adsBudget.view',
      'vault.view', 'connector.view',
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
    //
    // `vault.view` is deliberately absent too, and unlike the viewer above that
    // absence is load-bearing rather than incidental: the vault door opens at
    // the `view` rung, so this org role is the ONLY thing standing between an
    // external collaborator and a board's encrypted credentials. Do not add it.
    //
    // `connector.view` is absent for the same load-bearing reason. It also opens
    // at the `view` rung, and the board endpoint behind it lists EVERY connected
    // account in the workspace by label so a board can pick projects from any of
    // them. For a guest shared into one board that is a list of other clients'
    // account names. Do not add it.
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

/**
 * permissions.test.js — the two-layer AND, exercised.
 *
 * Run from the server directory:
 *     node --test src/utils/permissions.test.js
 *
 * These are pure-function tests: no DB, no mongoose. `org` and `board` are plain
 * objects shaped like the documents, which is all the resolver ever touches.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SYSTEM_ROLES,
  sanitizePermissions,
  capabilitiesForLevel,
  normaliseLevel,
  levelAtLeast,
} = require('./capabilities');
const { resolveOrgAccess, resolveAccess } = require('./permissions');
const { resolveBoardAccess } = require('./boardAccess');

// --- fixtures --------------------------------------------------------------

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const MEMBER = 'aaaaaaaaaaaaaaaaaaaaaaa3';
const VIEWER = 'aaaaaaaaaaaaaaaaaaaaaaa4';
const GUEST = 'aaaaaaaaaaaaaaaaaaaaaaa5';
const OUTSIDER = 'aaaaaaaaaaaaaaaaaaaaaaa9';

/** Roles as they are seeded onto a fresh org, with stable fake _ids. */
const roles = SYSTEM_ROLES.map((r, i) => ({
  _id: `role${i}`,
  key: r.key,
  name: r.name,
  color: r.color,
  isSystem: true,
  permissions: sanitizePermissions(r.permissions),
}));

const roleId = (key) => roles.find((r) => r.key === key)._id;

const makeOrg = (overrides = {}) => ({
  admin: OWNER,
  admins: [],
  members: [OWNER, ADMIN, MEMBER, VIEWER, GUEST],
  roles,
  memberRoles: [
    { user: ADMIN, role: roleId('admin') },
    { user: MEMBER, role: roleId('member') },
    { user: VIEWER, role: roleId('viewer') },
    { user: GUEST, role: roleId('guest') },
  ],
  ...overrides,
});

const makeBoard = (overrides = {}) => ({
  _id: 'board1',
  createdBy: MEMBER,
  organisation: 'org1',
  visibility: 'private',
  publicDefaultLevel: 'contribute',
  memberAccess: [],
  ...overrides,
});

// --- the ladder ------------------------------------------------------------

test('ladder: legacy "read" normalises to "view"', () => {
  assert.equal(normaliseLevel('read'), 'view');
  assert.equal(normaliseLevel('edit'), 'edit');
  assert.equal(normaliseLevel('nonsense'), null);
});

test('ladder: each rung is a superset of the one below', () => {
  const view = capabilitiesForLevel('view');
  const comment = capabilitiesForLevel('comment');
  const contribute = capabilitiesForLevel('contribute');
  const edit = capabilitiesForLevel('edit');

  for (const c of view) assert.ok(comment.has(c), `comment ⊇ view (${c})`);
  for (const c of comment) assert.ok(contribute.has(c), `contribute ⊇ comment (${c})`);
  for (const c of contribute) assert.ok(edit.has(c), `edit ⊇ contribute (${c})`);

  assert.ok(!view.has('update.create'));
  assert.ok(comment.has('update.create'));
  assert.ok(!comment.has('task.create'));
  assert.ok(contribute.has('task.create'));
  assert.ok(contribute.has('task.edit_assigned'));
  assert.ok(!contribute.has('task.edit_any'), 'contribute must NOT edit others’ tasks');
  assert.ok(!contribute.has('column.manage'), 'contribute must NOT restructure the board');
  assert.ok(edit.has('task.edit_any'));
  assert.ok(edit.has('column.manage'));
});

test('ladder: the vault door opens at `view`, but changing it needs `edit`', () => {
  // The security-relevant half of the ladder, pinned deliberately.
  //
  // `vault.view` grants the OUTER door: the tab exists and the encrypted items
  // load. It is safe at the bottom rung precisely because a second gate the
  // server cannot open — the vault password — stands behind it.
  //
  // `vault.manage` has no such second gate. Deleting a credential needs no
  // password and cannot be undone, so it stays at the top. If someone ever
  // moves it down, this test is the thing that should stop them.
  assert.ok(capabilitiesForLevel('view').has('vault.view'), 'the door opens at view');
  assert.ok(capabilitiesForLevel('edit').has('vault.view'));

  for (const level of ['view', 'comment', 'contribute']) {
    assert.ok(
      !capabilitiesForLevel(level).has('vault.manage'),
      `${level} must NOT be able to change a vault`
    );
  }
  assert.ok(capabilitiesForLevel('edit').has('vault.manage'));
});

test('ladder: canManage adds sharing only at edit', () => {
  assert.ok(capabilitiesForLevel('edit', { canManage: true }).has('board.manage_access'));
  assert.ok(!capabilitiesForLevel('edit').has('board.manage_access'));
  assert.ok(levelAtLeast('edit', 'contribute'));
  assert.ok(!levelAtLeast('comment', 'contribute'));
});

// --- layer 1: org roles ----------------------------------------------------

test('org: owner cannot be locked out by a malicious matrix edit', () => {
  // Even with the owner role's permissions emptied, the owner keeps everything —
  // a matrix edit must never be able to lock the owner out of their workspace.
  const org = makeOrg({
    roles: roles.map((r) =>
      r.key === 'owner' ? { ...r, permissions: [] } : r
    ),
  });
  const a = resolveOrgAccess(org, OWNER);
  assert.equal(a.isOwner, true);
  assert.ok(a.can('org.manage_roles'));
  assert.ok(a.can('board.delete'));
  assert.ok(a.can('org.remove_members'));
  // Privacy overrides used to be the one exception. They are not any more: the
  // owner holds the whole catalog, NEVER_IMPLICIT is empty, and the reason is in
  // the note on that set — withholding `board.view_all_private` from the owner
  // stranded any private board whose creator was gone.
  assert.ok(a.can('board.view_all_private'));
  assert.ok(a.can('board.manage_all_private'));
});

test('org: org.manage_roles is grantable — admin holds it by default', () => {
  const org = makeOrg();
  // Matrix editing is deliberately delegable: the seeded admin role carries it,
  // and any role granted it in the matrix gets it. Roles without it do not.
  assert.ok(resolveOrgAccess(org, ADMIN).can('org.manage_roles'));
  assert.ok(resolveOrgAccess(org, OWNER).can('org.manage_roles'));
  assert.ok(!resolveOrgAccess(org, MEMBER).can('org.manage_roles'));
  assert.ok(!resolveOrgAccess(org, VIEWER).can('org.manage_roles'));
});

test('org: the private overrides are off for every seeded role EXCEPT the owner', () => {
  const org = makeOrg();
  for (const u of [ADMIN, MEMBER, VIEWER, GUEST]) {
    assert.ok(
      !resolveOrgAccess(org, u).can('board.view_all_private'),
      'private boards must stay private by default'
    );
    assert.ok(
      !resolveOrgAccess(org, u).can('board.manage_all_private'),
      'and un-administerable by default too — admins included'
    );
  }
  // The owner is not a role you can under-grant. They short-circuit to the whole
  // catalog, these two included.
  assert.ok(resolveOrgAccess(org, OWNER).can('board.view_all_private'));
  assert.ok(resolveOrgAccess(org, OWNER).can('board.manage_all_private'));
});

test('org: the owner cannot be locked out of a private board they own', () => {
  const org = makeOrg();
  const board = makeBoard({ createdBy: OWNER, visibility: 'private' });
  assert.ok(resolveAccess(board, org, OWNER).canRead);
});

test('org: the owner fully owns a private board SOMEONE ELSE created', () => {
  // The regression this whole rule exists for. A member takes a shared board
  // private and leaves; before, the org owner could not rename it, delete it, or
  // flip it back to public, and no matrix edit could grant them that — the
  // `view_all_private` override resolves to the `view` rung, which confers no
  // lifecycle capability at all. The board was stranded.
  const org = makeOrg();
  const board = makeBoard({ createdBy: MEMBER, visibility: 'private', memberAccess: [] });
  const a = resolveAccess(board, org, OWNER);

  assert.ok(a.canRead, 'the owner reaches every board in their workspace');
  assert.equal(a.level, 'edit');
  assert.equal(a.readOnly, false);
  assert.ok(a.can('board.change_visibility'), 'THE fix — they can make it public again');
  assert.ok(a.can('board.rename'));
  assert.ok(a.can('board.delete'));
  assert.ok(a.can('column.manage'));
  assert.ok(a.can('task.edit_any'));
  assert.ok(a.canManageAccess, 'and can hand access to somebody else');
});

test('org: the owner owns a private board even with the owner role emptied', () => {
  // Belt and braces: this must not depend on stored role data, or a bad matrix
  // write becomes a lockout again.
  const org = makeOrg({
    roles: roles.map((r) => (r.key === 'owner' ? { ...r, permissions: [] } : r)),
  });
  const board = makeBoard({ createdBy: MEMBER, visibility: 'private' });
  assert.ok(resolveAccess(board, org, OWNER).can('board.change_visibility'));
});

test('org: owning the workspace is NOT the same as being in admins[]', () => {
  // `Organisation.admin` is one person. The legacy `admins[]` array is not, and
  // widening the short-circuit to it would silently hand every org admin every
  // private board in the workspace.
  const org = makeOrg({ admins: [ADMIN] });
  const board = makeBoard({ createdBy: MEMBER, visibility: 'private' });
  assert.equal(resolveAccess(board, org, ADMIN).canRead, false);
});

// --- the private-board overrides -------------------------------------------

test('private board: manage_all_private is the write half view_all_private is not', () => {
  const withBoth = makeOrg({
    roles: roles.map((r) =>
      r.key === 'admin'
        ? {
            ...r,
            permissions: [
              ...r.permissions,
              'board.view_all_private',
              'board.manage_all_private',
            ],
          }
        : r
    ),
  });
  const board = makeBoard({ createdBy: MEMBER, visibility: 'private' });
  const a = resolveAccess(board, withBoth, ADMIN);

  assert.ok(a.canRead);
  assert.equal(a.readOnly, false);
  assert.ok(a.can('board.change_visibility'), 'this is what rescues a stranded board');
  assert.ok(a.can('board.delete'));
  assert.ok(a.can('column.manage'));
  assert.ok(a.canManageAccess, 'fully manage means the share dialog too');
});

test('private board: manage_all_private alone opens NOTHING', () => {
  // Reach first, power second — the same division the public pair uses. Without
  // `view_all_private` or a grant, holding the manage half must not become a
  // back door into every private board in the workspace.
  const org = makeOrg({
    roles: roles.map((r) =>
      r.key === 'admin'
        ? { ...r, permissions: [...r.permissions, 'board.manage_all_private'] }
        : r
    ),
  });
  const board = makeBoard({ createdBy: MEMBER, visibility: 'private' });
  const a = resolveAccess(board, org, ADMIN);

  assert.equal(a.canRead, false);
  assert.ok(!a.can('board.change_visibility'));
  assert.ok(!a.can('task.edit_any'));
});

test('private board: manage_all_private upgrades an EXPLICIT grant too', () => {
  // The other route to reach: a `view` grant. The manage half then lifts the
  // ceiling on it, which is the point of splitting the two.
  const org = makeOrg({
    roles: roles.map((r) =>
      r.key === 'admin'
        ? { ...r, permissions: [...r.permissions, 'board.manage_all_private'] }
        : r
    ),
  });
  const board = makeBoard({
    createdBy: MEMBER,
    visibility: 'private',
    memberAccess: [{ user: ADMIN, level: 'view', canManage: false }],
  });
  const a = resolveAccess(board, org, ADMIN);

  assert.ok(a.canRead);
  assert.ok(a.can('board.change_visibility'));
});

test('private board: manage_all_private does not touch a PUBLIC board', () => {
  // It is scoped to private boards; the public half is `board.manage_public`,
  // and a role holding only the private one must not inherit the public one.
  const org = makeOrg({
    roles: roles.map((r) =>
      r.key === 'viewer'
        ? {
            ...r,
            permissions: [
              ...r.permissions,
              'board.view_all_private',
              'board.manage_all_private',
            ],
          }
        : r
    ),
  });
  const board = makeBoard({
    createdBy: MEMBER,
    visibility: 'public',
    publicDefaultLevel: 'view',
  });
  const a = resolveAccess(board, org, VIEWER);

  assert.ok(a.canRead);
  assert.equal(a.readOnly, true, 'a Viewer stays a Viewer on a public board');
  assert.ok(!a.can('board.change_visibility'));
});
test('populated refs: a populated org still resolves (the invisible fail-closed bug)', () => {
  // getOrg does .populate('admin') and .populate('members'). A populated
  // Document's toString() is its inspect string, never the hex id — so every
  // `ref.toString() === userId` check silently evaluated FALSE, and the owner
  // failed their own ownership test and resolved to zero capabilities.
  const populated = {
    admin: { _id: OWNER, name: 'Owner', email: 'o@x.com' },
    admins: [],
    members: [
      { _id: OWNER, name: 'Owner' },
      { _id: MEMBER, name: 'Member' },
    ],
    roles,
    memberRoles: [{ user: MEMBER, role: roleId('member') }],
  };

  const owner = resolveOrgAccess(populated, OWNER);
  assert.equal(owner.isOwner, true, 'owner must be recognised through a populated ref');
  assert.equal(owner.isMember, true);
  assert.ok(owner.can('board.delete'));

  const member = resolveOrgAccess(populated, MEMBER);
  assert.equal(member.isMember, true);
  assert.equal(member.role.key, 'member');

  assert.equal(resolveOrgAccess(populated, OUTSIDER).isMember, false);
});

test('populated refs: a board with populated createdBy / memberAccess still resolves', () => {
  const org = makeOrg();
  const board = makeBoard({
    createdBy: { _id: MEMBER, name: 'Member' },
    memberAccess: [
      { user: { _id: ADMIN, name: 'Admin' }, level: 'edit', canManage: false },
    ],
  });
  assert.ok(resolveAccess(board, org, MEMBER).can('board.delete'), 'creator through a populated ref');
  assert.ok(resolveAccess(board, org, ADMIN).can('task.edit_any'), 'grantee through a populated ref');
});

test('roles: analytics stays admin-only, as it was before the migration', () => {
  const org = makeOrg();
  assert.ok(resolveOrgAccess(org, ADMIN).can('analytics.view'));
  assert.ok(
    !resolveOrgAccess(org, MEMBER).can('analytics.view'),
    'granting it to members would be a silent loosening'
  );
});

test('roles: a member can moderate comments only where they hold edit', () => {
  const org = makeOrg();
  const mine = makeBoard({ createdBy: MEMBER });
  const theirs = makeBoard({
    createdBy: OWNER,
    memberAccess: [{ user: MEMBER, level: 'contribute', canManage: false }],
  });
  assert.ok(resolveAccess(mine, org, MEMBER).can('update.delete_any'));
  assert.ok(!resolveAccess(theirs, org, MEMBER).can('update.delete_any'));
});

test('org: legacy admins[] still resolves to the admin role (pre-backfill orgs)', () => {
  const org = makeOrg({ memberRoles: [], admins: [ADMIN] });
  const a = resolveOrgAccess(org, ADMIN);
  assert.equal(a.role.key, 'admin');
  assert.ok(a.can('org.invite_members'));
});

test('org: a member with no assignment falls back to the default role', () => {
  const org = makeOrg({ memberRoles: [] });
  assert.equal(resolveOrgAccess(org, MEMBER).role.key, 'member');
});

test('org: a deleted role falls back to default rather than locking the user out', () => {
  const org = makeOrg({
    memberRoles: [{ user: MEMBER, role: 'role-that-no-longer-exists' }],
  });
  const a = resolveOrgAccess(org, MEMBER);
  assert.equal(a.role.key, 'member');
  assert.ok(a.can('task.create'));
});

// --- layer 2 + the AND: private boards -------------------------------------

test('private board: creator owns it — even though they are only a Member', () => {
  const org = makeOrg();
  const board = makeBoard({ createdBy: MEMBER });
  const a = resolveAccess(board, org, MEMBER);

  assert.ok(a.canRead);
  assert.ok(a.can('board.rename'), 'creator renames their own board');
  assert.ok(a.can('board.delete'), 'creator deletes their own board');
  assert.ok(a.can('column.manage'));
  assert.ok(a.can('board.manage_access'));
  assert.ok(a.can('automation.manage'), 'creator manages automations on their own board');
});

test('private board: an org ADMIN gets nothing without a grant', () => {
  const org = makeOrg();
  const board = makeBoard({ createdBy: MEMBER });
  const a = resolveAccess(board, org, ADMIN);

  assert.equal(a.canRead, false, 'admins do not auto-enter private boards');
  assert.ok(!a.can('board.delete'), 'and cannot delete what they cannot open');
  assert.ok(!a.can('automation.manage'));
  assert.ok(!a.can('task.edit_any'));
});

test('private board: view_all_private lifts READ but not WRITE', () => {
  const org = makeOrg({
    roles: roles.map((r) =>
      r.key === 'admin'
        ? { ...r, permissions: [...r.permissions, 'board.view_all_private'] }
        : r
    ),
  });
  const board = makeBoard({ createdBy: MEMBER });
  const a = resolveAccess(board, org, ADMIN);

  assert.ok(a.canRead, 'the override lets them in');
  assert.equal(a.readOnly, true, 'but it is a read override, not a write one');
  assert.ok(!a.can('task.edit_any'));
  assert.ok(!a.can('column.manage'));
  assert.ok(!a.can('board.delete'));
});

test('private board: a contribute grant does its own work and no more', () => {
  const org = makeOrg();
  const board = makeBoard({
    createdBy: OWNER,
    memberAccess: [{ user: MEMBER, level: 'contribute', canManage: false }],
  });
  const a = resolveAccess(board, org, MEMBER);

  assert.ok(a.canRead);
  assert.ok(a.can('task.create'));
  assert.ok(a.can('task.edit_assigned'));
  assert.ok(a.can('task.change_status'));
  assert.ok(a.can('update.create'));
  assert.ok(!a.can('task.edit_any'), 'cannot touch other people’s tasks');
  assert.ok(!a.can('task.delete'));
  assert.ok(!a.can('column.manage'), 'cannot delete the Status column');
  assert.ok(!a.can('group.manage'));
  assert.equal(a.canEdit, false);
  assert.equal(a.readOnly, false);
});

test('private board: a comment grant can talk but not touch', () => {
  const org = makeOrg();
  const board = makeBoard({
    createdBy: OWNER,
    memberAccess: [{ user: MEMBER, level: 'comment', canManage: false }],
  });
  const a = resolveAccess(board, org, MEMBER);

  assert.ok(a.canRead);
  assert.ok(a.can('update.create'));
  assert.ok(!a.can('task.create'));
  assert.ok(!a.can('task.change_status'));
  assert.equal(a.readOnly, true);
});

test('private board: legacy "read" grant still means view-only', () => {
  const org = makeOrg();
  const board = makeBoard({
    createdBy: OWNER,
    memberAccess: [{ user: MEMBER, level: 'read', canManage: false }],
  });
  const a = resolveAccess(board, org, MEMBER);

  assert.ok(a.canRead);
  assert.equal(a.readOnly, true);
  assert.ok(!a.can('update.create'));
  assert.ok(!a.can('task.change_status'));
});

test('private board: THE AND — a Viewer with an edit grant still cannot write', () => {
  // This is the whole point of the two layers. The board says "edit"; the org
  // role says "this person may not write anything, anywhere". Deny wins.
  const org = makeOrg();
  const board = makeBoard({
    createdBy: OWNER,
    memberAccess: [{ user: VIEWER, level: 'edit', canManage: true }],
  });
  const a = resolveAccess(board, org, VIEWER);

  assert.ok(a.canRead, 'the grant does let them see it');
  assert.ok(!a.can('task.create'), 'but the org role is a hard floor');
  assert.ok(!a.can('task.edit_any'));
  assert.ok(!a.can('column.manage'));
  assert.equal(a.canEdit, false);
});

test('private board: full access shares, plain edit does not', () => {
  const org = makeOrg();
  const board = makeBoard({
    createdBy: OWNER,
    memberAccess: [
      { user: MEMBER, level: 'edit', canManage: true },
      { user: ADMIN, level: 'edit', canManage: false },
    ],
  });
  assert.ok(resolveAccess(board, org, MEMBER).canManageAccess);
  assert.ok(!resolveAccess(board, org, ADMIN).canManageAccess);
  assert.ok(resolveAccess(board, org, ADMIN).canViewAccess, 'editors see the roster');
});

// --- the AND: public boards ------------------------------------------------

test('public board: publicDefaultLevel sets what "public" means', () => {
  const org = makeOrg();

  const announcements = makeBoard({
    createdBy: OWNER,
    visibility: 'public',
    publicDefaultLevel: 'view',
  });
  const readOnly = resolveAccess(announcements, org, MEMBER);
  assert.ok(readOnly.canRead);
  assert.equal(readOnly.readOnly, true);
  assert.ok(!readOnly.can('task.create'));

  const scratchpad = makeBoard({
    createdBy: OWNER,
    visibility: 'public',
    publicDefaultLevel: 'edit',
  });
  const open = resolveAccess(scratchpad, org, MEMBER);
  assert.ok(open.can('task.edit_any'));
  assert.ok(open.can('group.manage'));
});

test('public board: admins keep full control via board.manage_public', () => {
  // Regression guard for the old `canEdit = isPublic && orgAdmin` rule. A public
  // board that opens at `view` must still be manageable by an admin.
  const org = makeOrg();
  const board = makeBoard({
    createdBy: MEMBER,
    visibility: 'public',
    publicDefaultLevel: 'view',
  });
  const a = resolveAccess(board, org, ADMIN);

  assert.ok(a.canRead);
  assert.ok(a.can('column.manage'));
  assert.ok(a.can('task.edit_any'));
  assert.ok(a.can('board.delete'));
  assert.equal(a.canEdit, true);
});

test('public board: a Viewer is read-only even where the board is wide open', () => {
  const org = makeOrg();
  const board = makeBoard({
    createdBy: OWNER,
    visibility: 'public',
    publicDefaultLevel: 'edit',
  });
  const a = resolveAccess(board, org, VIEWER);

  assert.ok(a.canRead);
  assert.equal(a.readOnly, true);
  assert.ok(!a.can('task.create'));
});

// --- the Guest -------------------------------------------------------------

test('guest: cannot see public boards at all', () => {
  const org = makeOrg();
  const board = makeBoard({
    createdBy: OWNER,
    visibility: 'public',
    publicDefaultLevel: 'edit',
  });
  const a = resolveAccess(board, org, GUEST);

  assert.equal(a.canRead, false, 'this is what makes a Guest a Guest');
  assert.ok(!a.can('task.create'));
});

test('guest: sees exactly the boards shared with them, and can work there', () => {
  const org = makeOrg();
  const board = makeBoard({
    createdBy: OWNER,
    visibility: 'private',
    memberAccess: [{ user: GUEST, level: 'contribute', canManage: false }],
  });
  const a = resolveAccess(board, org, GUEST);

  assert.ok(a.canRead);
  assert.ok(a.can('task.create'));
  assert.ok(a.can('task.edit_assigned'));
  assert.ok(a.can('update.create'));
  assert.ok(!a.can('task.edit_any'));
  assert.ok(!a.can('column.manage'));
});

test('guest: an explicit grant on a PUBLIC board still lets them in', () => {
  // They cannot browse public boards, but sharing one with them explicitly works.
  const org = makeOrg();
  const board = makeBoard({
    createdBy: OWNER,
    visibility: 'public',
    publicDefaultLevel: 'edit',
    memberAccess: [{ user: GUEST, level: 'view', canManage: false }],
  });
  const a = resolveAccess(board, org, GUEST);

  assert.ok(a.canRead);
  assert.equal(a.readOnly, true, 'and only at the rung they were given');
  assert.ok(!a.can('task.create'));
});

// --- outsiders -------------------------------------------------------------

test('outsider: a non-member gets nothing anywhere', () => {
  const org = makeOrg();
  const priv = makeBoard({ createdBy: OWNER, visibility: 'private' });
  const pub = makeBoard({ createdBy: OWNER, visibility: 'public' });

  assert.equal(resolveOrgAccess(org, OUTSIDER).isMember, false);
  assert.equal(resolveAccess(priv, org, OUTSIDER).canRead, false);
  // A public board is readable to anyone the default role lets in; membership is
  // enforced separately, at the controller boundary. Assert the standing only.
  assert.equal(resolveBoardAccess(priv, org, OUTSIDER).canRead, false);
  assert.ok(!resolveAccess(pub, org, OUTSIDER).can('column.manage'));
});

// --- implied capabilities: stored roles vs a catalog that moved on ----------

/**
 * The regression these cover: `goal.create` was carved OUT of `goal.manage`
 * after these workspaces were created, and `ensureSystemRoles` never adds a
 * capability to a role that already exists. So every pre-split org stored
 * "edit and delete anyone's goals" and not "add a goal", and because the two
 * layers AND, the org role refused the create — to people the board had already
 * put at the top rung. On screen: the Add button appears (the client asks
 * `canManage || canCreate`) and saving answers 403 (goal.create).
 */
const preSplitOrg = () => {
  const stale = roles.map((r) => ({
    ...r,
    // Exactly what a workspace older than the split has on disk: the three goal
    // capabilities that existed then, minus the rung that did not.
    permissions: r.permissions.filter((c) => c !== 'goal.create'),
  }));
  return makeOrg({ roles: stale });
};

test('implied: goal.manage confers goal.create on a role stored before the split', () => {
  const org = preSplitOrg();
  const board = makeBoard({ createdBy: OWNER, visibility: 'public', publicDefaultLevel: 'edit' });

  const stored = org.roles.find((r) => r.key === 'member').permissions;
  assert.ok(!stored.includes('goal.create'), 'fixture must be genuinely pre-split');
  assert.ok(stored.includes('goal.manage'));

  const a = resolveAccess(board, org, MEMBER);
  assert.ok(a.can('goal.manage'), 'the stored capability still resolves');
  assert.ok(
    a.can('goal.create'),
    'a person who may rewrite ANYONE\'s goal must be able to add one — this is '
    + 'the 403 users hit on Add this goal'
  );
});

test('implied: it does not invent reach the board never gave', () => {
  // Same stale org, but the board only lets them look. The board layer refuses
  // both goal capabilities, so implication has nothing to expand into.
  const org = preSplitOrg();
  const board = makeBoard({
    createdBy: OWNER,
    visibility: 'public',
    publicDefaultLevel: 'view',
  });
  const a = resolveAccess(board, org, MEMBER);

  assert.ok(a.can('goal.view'));
  assert.ok(!a.can('goal.manage'));
  assert.ok(!a.can('goal.create'), 'the AND still holds — implication is not an override');
});

test('implied: a viewer gains nothing, because they hold nothing that implies', () => {
  const org = preSplitOrg();
  const board = makeBoard({ createdBy: OWNER, visibility: 'public', publicDefaultLevel: 'edit' });
  const a = resolveAccess(board, org, VIEWER);

  assert.ok(a.can('goal.view'));
  assert.ok(!a.can('goal.create'), 'read-only across the workspace stays read-only');
  assert.ok(!a.can('goal.track'));
});

test('implied: a custom role holding only goal.manage still gets the lower rungs', () => {
  // The case the grant script cannot reach — it leaves custom roles alone.
  const custom = { _id: 'roleX', key: 'strategist', name: 'Strategist', permissions: ['board.view_public', 'goal.manage'] };
  const org = makeOrg({ roles: [...roles, custom], memberRoles: [{ user: MEMBER, role: 'roleX' }] });
  const board = makeBoard({ createdBy: OWNER, visibility: 'public', publicDefaultLevel: 'edit' });
  const a = resolveAccess(board, org, MEMBER);

  assert.ok(a.can('goal.create'));
  assert.ok(a.can('goal.track'), 'and can type in the result of the goal they set');
  assert.ok(a.can('goal.view'));
  assert.ok(!a.can('column.manage'), 'nothing outside the goals group leaks in');
});

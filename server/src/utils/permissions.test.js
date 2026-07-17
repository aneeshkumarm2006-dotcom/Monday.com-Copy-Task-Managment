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
  // The one exception: privacy overrides are never implicit, even for the owner.
  assert.ok(!a.can('board.view_all_private'));
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

test('org: view_all_private is off for every seeded role — INCLUDING the owner', () => {
  const org = makeOrg();
  for (const u of [ADMIN, MEMBER, VIEWER, GUEST]) {
    assert.ok(
      !resolveOrgAccess(org, u).can('board.view_all_private'),
      'private boards must stay private by default'
    );
  }
  // The owner short-circuits to every capability, so without the NEVER_IMPLICIT
  // carve-out "off by default for every role" would be a lie the moment the
  // owner logged in — they would silently see every private board in the org.
  assert.ok(
    !resolveOrgAccess(org, OWNER).can('board.view_all_private'),
    'the owner must not get the privacy override for free'
  );
  // …but they can still turn it on deliberately.
  const opted = makeOrg({
    roles: roles.map((r) =>
      r.key === 'owner' ? { ...r, permissions: ['board.view_all_private'] } : r
    ),
  });
  assert.ok(resolveOrgAccess(opted, OWNER).can('board.view_all_private'));
  assert.ok(resolveOrgAccess(opted, OWNER).can('board.delete'), 'and keeps everything else');
});

test('org: the owner cannot be locked out of a private board they own', () => {
  const org = makeOrg();
  const board = makeBoard({ createdBy: OWNER, visibility: 'private' });
  assert.ok(resolveAccess(board, org, OWNER).canRead);
});

test('org: a private board is private FROM THE OWNER too, until they opt in', () => {
  const org = makeOrg();
  const board = makeBoard({ createdBy: MEMBER, visibility: 'private' });
  assert.equal(resolveAccess(board, org, OWNER).canRead, false);

  const opted = makeOrg({
    roles: roles.map((r) =>
      r.key === 'owner' ? { ...r, permissions: ['board.view_all_private'] } : r
    ),
  });
  const a = resolveAccess(board, opted, OWNER);
  assert.ok(a.canRead, 'the override opens it');
  assert.equal(a.readOnly, true, 'but read-only — it lifts visibility, not the ceiling');
  assert.ok(!a.can('task.edit_any'));
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

const { test } = require('node:test');
const assert = require('node:assert');

const { otherMemberIds } = require('./userCascade');

/**
 * The guard that stops one person's account deletion from destroying everyone
 * else's workspace.
 *
 * `deleteAccount` used to hand every org where `admin === you` straight to
 * `cascadeDeleteOrg`. `otherMemberIds` is the whole decision that now stands in
 * front of that: if it returns anything, the delete is refused and the person is
 * pointed at transfer-ownership instead. So the thing worth pinning is not the
 * cascade — it is that this function CANNOT MISS SOMEBODY.
 *
 * It is pure, so none of this needs a database. Ids are plain strings
 * throughout; the production callers pass ObjectIds, and the only thing the
 * function does with either is `String()` them through `idOf`.
 */

const ME = 'user-me';
const OTHER = 'user-other';
const THIRD = 'user-third';

test('a workspace you are alone in reports nobody', () => {
  const org = { admin: ME, admins: [ME], members: [ME], memberRoles: [] };
  assert.deepStrictEqual(otherMemberIds(org, ME), []);
});

test('an ordinary member is found', () => {
  const org = { admin: ME, admins: [], members: [ME, OTHER], memberRoles: [] };
  assert.deepStrictEqual(otherMemberIds(org, ME), [OTHER]);
});

test('somebody in admins but NOT in members is still found', () => {
  // `joinOrg` writes membership across two documents in two untransacted
  // writes, so the arrays really can disagree. The guard has to fail towards
  // "somebody is still in there", not towards a convenient empty list.
  const org = { admin: ME, admins: [ME, OTHER], members: [ME], memberRoles: [] };
  assert.deepStrictEqual(otherMemberIds(org, ME), [OTHER]);
});

test('somebody who only holds a role assignment is still found', () => {
  const org = {
    admin: ME,
    admins: [],
    members: [ME],
    memberRoles: [{ user: OTHER, role: 'role-1' }],
  };
  assert.deepStrictEqual(otherMemberIds(org, ME), [OTHER]);
});

test('a different owner counts as another person', () => {
  // Not the account-deletion path (that only loads orgs you own), but
  // `revokeUserFromOrg` reuses the same helper's reasoning and this is the
  // case where forgetting `admin` would under-count by exactly one.
  const org = { admin: OTHER, admins: [], members: [ME], memberRoles: [] };
  assert.deepStrictEqual(otherMemberIds(org, ME), [OTHER]);
});

test('one person appearing in all four places is counted once', () => {
  const org = {
    admin: OTHER,
    admins: [OTHER],
    members: [ME, OTHER],
    memberRoles: [{ user: OTHER, role: 'role-1' }],
  };
  assert.deepStrictEqual(otherMemberIds(org, ME), [OTHER]);
});

test('populated refs are compared by id, not by inspect string', () => {
  // `String(doc)` on a populated Mongoose document is its inspect string, never
  // the hex id — the trap `idOf` exists for. Two populated copies of the same
  // person must not read as two people, and the caller themselves must not read
  // as somebody else just because the ref arrived populated.
  const org = {
    admin: { _id: ME, name: 'Me' },
    admins: [],
    members: [{ _id: ME, name: 'Me' }, { _id: OTHER, name: 'Other' }],
    memberRoles: [{ user: { _id: OTHER, name: 'Other' }, role: 'r' }],
  };
  assert.deepStrictEqual(otherMemberIds(org, ME), [OTHER]);
});

test('null and empty entries are ignored, not counted as a stranger', () => {
  // A blocked delete that cannot be unblocked is worse than no guard: the only
  // way out would be transferring the workspace to a member who does not exist.
  const org = {
    admin: ME,
    admins: [null],
    members: [ME, null, undefined, ''],
    memberRoles: [{ user: null, role: 'r' }, {}],
  };
  assert.deepStrictEqual(otherMemberIds(org, ME), []);
});

test('missing arrays are tolerated — an old org document has no memberRoles', () => {
  assert.deepStrictEqual(otherMemberIds({ admin: ME, members: [ME] }, ME), []);
  assert.deepStrictEqual(otherMemberIds({}, ME), []);
  assert.deepStrictEqual(otherMemberIds(null, ME), []);
});

test('several other people are all reported, in first-seen order', () => {
  const org = {
    admin: ME,
    admins: [THIRD],
    members: [ME, OTHER],
    memberRoles: [],
  };
  assert.deepStrictEqual(otherMemberIds(org, ME), [THIRD, OTHER]);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

/**
 * `POST /orgs/:orgId/executive-views/:userId/declare` — "Make executive".
 *
 * Declaring somebody is the one place in this feature where two records move
 * together: a ROLE is assigned and a PROFILE is created, in one sequence over
 * one loaded org document. These tests pin that sequence and the four refusals
 * around it, because every one of them is a rule stated somewhere other than
 * this handler and therefore a rule this handler can quietly stop honouring:
 *
 *  - the owner can never be made an Executive (spec invariant 8);
 *  - a non-member cannot hold a profile in a workspace they are not in;
 *  - `org.manage_executive_views` buys the EDITOR and not the reach, so
 *    changing a role still needs `org.assign_roles` on top — the split the
 *    capability's own comment in `utils/capabilities.js` exists to describe;
 *  - and declaring twice must be a no-op, because `upsert` REPLACES and a
 *    second press would otherwise wipe a board list somebody just composed.
 *
 * ---- HOW THIS IS STUBBED, AND WHY AT THE MODULE BOUNDARY -------------------
 *
 * `services/executiveView.js` is the profile's only reader and writer, and it
 * is NOT what these tests are about — they are about the controller's ordering
 * and its gates. So the service is replaced wholesale by seeding `require.cache`
 * with a stand-in module before the controller is first required. That is the
 * CommonJS equivalent of an injected dependency, and it buys two things worth
 * having: the assertions can read exactly which arguments the controller passed
 * (`allowReachChange`, the actor, the empty shape), and this file stays green
 * regardless of how the real service chooses to shape its internals.
 *
 * Everything ELSE runs for real. `loadOrgContext`, `resolveOrgAccess`,
 * `roleForUser` and — the one that matters most — `applyRoleAssignment` from
 * `roleController.js` all execute against document-shaped fixtures, so these
 * tests cover the actual escalation guards rather than a mock of them. Only the
 * two mongoose lookups the handler makes (`Organisation.findById`,
 * `User.findById`) and `ActivityLog.create` are replaced, since there is no
 * database here.
 */

// ---------------------------------------------------------------------------
// The service stand-in. Installed BEFORE the controller is required.
// ---------------------------------------------------------------------------

const SERVICE_PATH = path.join(__dirname, '..', 'services', 'executiveView.js');

/** What the stand-in has been asked to do, reset between tests. */
const serviceCalls = {
  profiles: new Map(),
  upserts: [],
};

const profileKey = (orgId, userId) => `${String(orgId)}:${String(userId)}`;

const fakeService = {
  // The real list lives in the service; these tests only need it to be an array
  // the controller can hand to `validateShape`.
  BOARD_TABS: [
    'board',
    'chat',
    'delivery',
    'goals',
    'people',
    'vault',
    'addons',
    'adsbudget',
    'connector',
    'seo',
  ],
  SECTION_TYPES: [],
  // Declare only ever validates `{}`, so a pass-through that returns the
  // normalised empty shape is enough — and the assertions below check that the
  // controller passed an EMPTY body, which is the part that matters.
  validateShape: (body) => ({
    value: { boards: [], home: [], nav: {}, ...(body || {}) },
  }),
  getForUser: async (orgId, userId) =>
    serviceCalls.profiles.get(profileKey(orgId, userId)) || null,
  resolveForViewer: async () => ({ profile: null, skipped: [] }),
  upsert: async (org, userId, shape, opts) => {
    serviceCalls.upserts.push({
      org: String(org._id),
      userId: String(userId),
      shape,
      opts,
    });
    const profile = {
      _id: 'profile-1',
      organisation: String(org._id),
      user: String(userId),
      boards: [],
      home: [],
      nav: {},
    };
    serviceCalls.profiles.set(profileKey(org._id, userId), profile);
    return { profile, dropped: [] };
  },
  addBoard: async () => ({ profile: null }),
  removeBoard: async () => ({ profile: null, revoked: false }),
  remove: async () => ({}),
};

const stubModule = new Module(SERVICE_PATH, null);
stubModule.filename = SERVICE_PATH;
stubModule.loaded = true;
stubModule.exports = fakeService;
require.cache[SERVICE_PATH] = stubModule;

// Required AFTER the cache is seeded — this is the line the seeding is for.
const { declare } = require('./executiveViewController');

const Organisation = require('../models/Organisation');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const {
  SYSTEM_ROLES,
  sanitizePermissions,
  EXECUTIVE_ROLE_KEY,
} = require('../utils/capabilities');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '6b466b99ea3ab35ff1378e01';
const ADMIN = '6b466b99ea3ab35ff1378e02';
const OPS = '6b466b99ea3ab35ff1378e03';
const TARGET = '6b466b99ea3ab35ff1378e04';
const STRANGER = '6b466b99ea3ab35ff1378e05';
const ORG = '6b466b99ea3ab35ff1378e10';

/**
 * The seeded roles, plus one custom role that holds the executive-view
 * capability and NOT `org.assign_roles`. That combination is the whole point of
 * splitting the two capabilities — an ops lead who may compose somebody's home
 * page but may not decide who is an admin — so it needs a fixture rather than a
 * hypothetical.
 */
const roles = [
  ...SYSTEM_ROLES.map((r, i) => ({
    _id: `role-${i}`,
    key: r.key,
    name: r.name,
    color: r.color,
    isSystem: true,
    permissions: sanitizePermissions(r.permissions),
  })),
  {
    _id: 'role-ops',
    key: 'ops',
    name: 'Ops lead',
    color: '#888888',
    isSystem: false,
    permissions: sanitizePermissions([
      'org.view_members',
      'org.manage_executive_views',
    ]),
  },
];

const roleId = (key) => roles.find((r) => r.key === key)._id;

const makeOrg = ({ withExecutiveRole = true } = {}) => {
  const org = {
    _id: ORG,
    admin: OWNER,
    admins: [],
    members: [OWNER, ADMIN, OPS, TARGET],
    roles: withExecutiveRole
      ? roles.map((r) => ({ ...r }))
      : roles.filter((r) => r.key !== EXECUTIVE_ROLE_KEY).map((r) => ({ ...r })),
    memberRoles: [
      { user: ADMIN, role: roleId('admin') },
      { user: OPS, role: roleId('ops') },
      { user: TARGET, role: roleId('member') },
    ],
    saved: 0,
    // Already seeded (or deliberately not — see `withExecutiveRole`), so the
    // lazy heal in `loadOrgContext` reports no change either way. A fixture that
    // healed itself would make the "workspace never migrated" test impossible.
    ensureSystemRoles: () => false,
    roleByKey(key) {
      return (this.roles || []).find((r) => r.key === key);
    },
    async save() {
      this.saved += 1;
    },
  };
  return org;
};

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A thenable answering `.select().lean()` — the shape `loadTargetUser` uses. */
const chain = (value) => {
  const self = {
    select: () => self,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return self;
};

const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

const req = ({ actor = ADMIN, target = TARGET, body = {} } = {}) => ({
  params: { orgId: ORG, userId: target },
  query: {},
  body,
  user: { userId: actor, name: 'Test Actor' },
});

/**
 * Install the stubs for one test and hand back a restore function, the way
 * `connectorProjects.test.js` does. The activity rows are collected rather than
 * suppressed: "nothing was logged" is an assertion this file makes.
 */
const stubModels = (org) => {
  const originals = {
    orgFindById: Organisation.findById,
    userFindById: User.findById,
    logCreate: ActivityLog.create,
  };
  const rows = [];

  Organisation.findById = () => Promise.resolve(org);
  User.findById = (id) => chain({ _id: id, name: 'Target Person' });
  ActivityLog.create = async (doc) => {
    rows.push(doc);
    return doc;
  };

  serviceCalls.profiles.clear();
  serviceCalls.upserts.length = 0;

  const restore = () => {
    Organisation.findById = originals.orgFindById;
    User.findById = originals.userFindById;
    ActivityLog.create = originals.logCreate;
  };
  return { rows, restore };
};

/**
 * The activity writers are fire-and-forget — the controller never awaits them,
 * by design. One turn of the microtask queue is enough for a stubbed
 * `create` to have recorded its row.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** The role key `userId` holds on `org` right now, read the way the app reads it. */
const roleKeyOf = (org, userId) => {
  const assignment = (org.memberRoles || []).find(
    (m) => String(m.user) === String(userId)
  );
  if (!assignment) return null;
  return (org.roles.find((r) => r._id === String(assignment.role)) || {}).key;
};

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test('the workspace owner cannot be made an executive', async () => {
  // Invariant 8. The owner holds every capability implicitly, so an executive
  // role would not narrow their reach by one board — it would only take the
  // standard app away from the one person who cannot be locked out of it.
  const org = makeOrg();
  const { rows, restore } = stubModels(org);
  const res = fakeRes();
  await declare(req({ actor: OWNER, target: OWNER }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /owner/i);
  assert.equal(serviceCalls.upserts.length, 0);
  assert.equal(rows.length, 0);
  assert.equal(org.saved, 0);
});

test('somebody who is not a member of the workspace is refused', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  const res = fakeRes();
  await declare(req({ target: STRANGER }), res);
  restore();

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /not a member/i);
  assert.equal(serviceCalls.upserts.length, 0);
});

test('a malformed user id is a 400, not a cast error surfacing as a 500', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  const res = fakeRes();
  await declare(req({ target: 'not-an-id' }), res);
  restore();

  assert.equal(res.statusCode, 400);
});

test('org.manage_executive_views is required — a plain member cannot declare', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  const res = fakeRes();
  await declare(req({ actor: TARGET, target: ADMIN }), res);
  restore();

  assert.equal(res.statusCode, 403);
  assert.equal(serviceCalls.upserts.length, 0);
});

test('holding org.manage_executive_views but NOT org.assign_roles is refused', async () => {
  // The load-bearing half of the capability split. This endpoint changes a role;
  // the executive-view capability deliberately does not buy that, so an ops lead
  // who may compose the view may not be the one who hands out the role.
  const org = makeOrg();
  const { rows, restore } = stubModels(org);
  const res = fakeRes();
  await declare(req({ actor: OPS }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /role/i);
  // Nothing at all happened: no profile, no save, no history row.
  assert.equal(serviceCalls.upserts.length, 0);
  assert.equal(org.saved, 0);
  assert.equal(rows.length, 0);
  assert.equal(roleKeyOf(org, TARGET), 'member');
});

test('a workspace with no Executive role yet is a 500 that names the migration', async () => {
  // `ensureSystemRoles` seeds MISSING ROLES on first touch, so this should be
  // unreachable — but if it ever is reached, "Unknown role" would tell nobody
  // that the server simply has not run its migration.
  const org = makeOrg({ withExecutiveRole: false });
  const { restore } = stubModels(org);
  const res = fakeRes();
  await declare(req(), res);
  restore();

  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /migrate:executive/);
  assert.equal(serviceCalls.upserts.length, 0);
});

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

test('the role is assigned and the profile created together', async () => {
  const org = makeOrg();
  const { rows, restore } = stubModels(org);
  const res = fakeRes();
  await declare(req(), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.created, true);
  assert.equal(res.body.roleAssigned, true);
  assert.equal(res.body.role.key, EXECUTIVE_ROLE_KEY);
  assert.ok(res.body.profile);

  // Half one: the role actually moved on the org document, and the document was
  // saved exactly once — before the profile was written, so the only state this
  // can be interrupted in is "a role with no profile", which is the standard app.
  assert.equal(roleKeyOf(org, TARGET), EXECUTIVE_ROLE_KEY);
  assert.equal(org.saved, 1);

  // Half two: the profile was created through the service, on the admin plane,
  // from an EMPTY shape and attributed to the caller.
  assert.equal(serviceCalls.upserts.length, 1);
  const [call] = serviceCalls.upserts;
  assert.equal(call.userId, TARGET);
  assert.equal(call.opts.actor, ADMIN);
  assert.equal(call.opts.allowReachChange, true);
  assert.deepEqual(call.shape.boards, []);
  assert.deepEqual(call.shape.home, []);

  // And one history row, naming the person and the role they were handed.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'executive.declared');
  assert.equal(String(rows[0].organisation), ORG);
  assert.equal(rows[0].metadata.targetUser, TARGET);
  assert.equal(rows[0].metadata.roleKey, EXECUTIVE_ROLE_KEY);
  // An org-level row: no task, no board, so it never lands in a board export.
  assert.equal(rows[0].task, null);
  assert.equal(rows[0].board, null);
});

test('the owner may declare somebody, escalation checks skipped', async () => {
  // The owner short-circuits both no-escalation guards inside
  // `applyRoleAssignment`. Worth pinning: it is the path the first executive in
  // any workspace is created through.
  const org = makeOrg();
  const { restore } = stubModels(org);
  const res = fakeRes();
  await declare(req({ actor: OWNER }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 201);
  assert.equal(roleKeyOf(org, TARGET), EXECUTIVE_ROLE_KEY);
});

test('declaring twice is idempotent — nothing is written the second time', async () => {
  // A button on a list is reachable twice. The destructive version of getting
  // this wrong is the profile: `upsert` REPLACES, so a second declare with an
  // empty shape would wipe the board list and home layout just composed.
  const org = makeOrg();
  const { rows, restore } = stubModels(org);

  const first = fakeRes();
  await declare(req(), first);
  await flush();

  // Somebody has since curated the view. It must survive the second press.
  const stored = serviceCalls.profiles.get(profileKey(ORG, TARGET));
  stored.boards = [{ board: 'a-board' }];

  const second = fakeRes();
  await declare(req(), second);
  await flush();
  restore();

  assert.equal(second.statusCode, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.roleAssigned, false);
  assert.equal(second.body.role.key, EXECUTIVE_ROLE_KEY);

  // One upsert, one save, one history row — all from the FIRST call.
  assert.equal(serviceCalls.upserts.length, 1);
  assert.equal(org.saved, 1);
  assert.equal(rows.length, 1);
  // And the curated list is untouched.
  assert.deepEqual(second.body.profile.boards, [{ board: 'a-board' }]);
});

test('{ assignRole: false } creates the profile and leaves the role alone', async () => {
  // "They already hold a role I want to keep — just make the profile."
  const org = makeOrg();
  const { rows, restore } = stubModels(org);
  const res = fakeRes();
  await declare(req({ body: { assignRole: false } }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.created, true);
  assert.equal(res.body.roleAssigned, false);

  // The role is exactly what it was, and the org document was never saved.
  assert.equal(roleKeyOf(org, TARGET), 'member');
  assert.equal(org.saved, 0);

  // The profile was still created.
  assert.equal(serviceCalls.upserts.length, 1);

  // The row records the role they KEPT, not the one that was not assigned —
  // roles are data and can be renamed later, so this is the only record of what
  // they actually held at the moment the view was created.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'executive.declared');
  assert.equal(rows[0].metadata.roleKey, 'member');
});

test('{ assignRole: false } does not require org.assign_roles', async () => {
  // The other side of the capability split: a request that changes no role needs
  // no role capability, which is exactly the flow the two capabilities were
  // separated for.
  const org = makeOrg();
  const { restore } = stubModels(org);
  const res = fakeRes();
  await declare(req({ actor: OPS, body: { assignRole: false } }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.roleAssigned, false);
  assert.equal(serviceCalls.upserts.length, 1);
  assert.equal(roleKeyOf(org, TARGET), 'member');
});

test('an existing profile plus a missing role assigns the role without touching the profile', async () => {
  // The other half of idempotence: the two records move independently, so a
  // declare that finds one already in place must still complete the other.
  const org = makeOrg();
  const { rows, restore } = stubModels(org);

  // A profile exists (an admin created one with `assignRole: false` earlier) but
  // the person is still on the member role.
  const firstPass = fakeRes();
  await declare(req({ body: { assignRole: false } }), firstPass);
  await flush();
  assert.equal(roleKeyOf(org, TARGET), 'member');

  const res = fakeRes();
  await declare(req(), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.created, false);
  assert.equal(res.body.roleAssigned, true);
  assert.equal(roleKeyOf(org, TARGET), EXECUTIVE_ROLE_KEY);
  // The profile was NOT rewritten — still the one upsert from the first call.
  assert.equal(serviceCalls.upserts.length, 1);
  assert.equal(org.saved, 1);
  // Two declares that each changed something, so two rows.
  assert.equal(rows.length, 2);
});

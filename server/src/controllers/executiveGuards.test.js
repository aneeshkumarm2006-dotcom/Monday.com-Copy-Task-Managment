const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

/**
 * The five guards an adversarial read of phase 1 found missing, plus the home
 * endpoint they all stand around.
 *
 * Each one is a rule this feature states somewhere OTHER than the handler that
 * has to honour it, which is exactly the class of rule that rots quietly — the
 * code keeps working, it just stops refusing things:
 *
 *  1. INVARIANT 8 ON READ. "The owner cannot be made an Executive" was checked
 *     only on the way in, and ownership MOVES. A transfer hands the title to
 *     somebody who may already have a profile, with no write to this feature
 *     anywhere in it, and the incoming owner then inherits the executive shell:
 *     a curated list of four boards for the one person who implicitly reaches
 *     every board in the workspace. So `getMine`, `get` and the home endpoint
 *     answer "no profile" for the owner whatever the database says.
 *  2. THE TRANSFER ITSELF deletes that profile as it moves the title. The read
 *     guard is what makes the state correct; this is what stops a dead document
 *     sitting in the Executives strip describing somebody who is not one.
 *  3. THE SELF PUT'S REACH FILTER covered `boards[]` and not
 *     `home[].config.board`, so an Executive could name a board they cannot
 *     read inside a section. The composer refuses to read it, so this is
 *     defence in depth — but "the next layer catches it" is how leaks are built.
 *     The filter then had a second defect of its own: it nulled the refused
 *     board on EVERY type, and on `workspaceNumbers` a null board does not mean
 *     "unconfigured", it means "the whole workspace". Refusing one board's
 *     figures by silently promoting them to forty boards' figures is a wrong
 *     number rather than a missing one, so that type loses the section instead.
 *  4. `POST /:userId/boards` CREATED A PROFILE silently, via the service's
 *     `loadOrCreate`. That made "add a board" a second, differently-gated way
 *     to make somebody an Executive, bypassing `declare` entirely.
 *  5. `declare` DEMANDED `org.assign_roles` EVEN WHEN NO ROLE WOULD MOVE. The
 *     capability is owed to the change; a target who already holds the
 *     Executive role is only having a profile created for them.
 *
 * ---- HOW THIS IS STUBBED --------------------------------------------------
 *
 * The same technique `executiveDeclare.test.js` uses and for the same reason:
 * `require.cache` is seeded with stand-in modules BEFORE the controllers are
 * first required, which is the CommonJS equivalent of an injected dependency.
 * Three modules are replaced — the profile service (these tests are about the
 * controller's gates, not about how a document is written), the home composer
 * (another unit's subject; here it only has to record the arguments it was
 * handed) and the notification service (there is no database here).
 *
 * EVERYTHING ELSE RUNS FOR REAL, and that is the part worth protecting:
 * `loadOrgContext`, `resolveOrgAccess`, `applyRoleAssignment` and — the one
 * these tests turn on — `resolveAccess`. The board fixtures below are ordinary
 * documents, one public and one private, so "can this person read this board"
 * is answered by the real two-layer resolver rather than by a mock that would
 * agree with whatever the controller assumed.
 */

// ---------------------------------------------------------------------------
// The stand-ins. Installed BEFORE the controllers are required.
// ---------------------------------------------------------------------------

const SERVICE_PATH = path.join(__dirname, '..', 'services', 'executiveView.js');
const HOME_PATH = path.join(__dirname, '..', 'services', 'executiveHome.js');
const NOTIFY_PATH = path.join(
  __dirname,
  '..',
  'services',
  'notificationService.js'
);

const seedModule = (filename, exports) => {
  const stub = new Module(filename, null);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
};

/** What the stand-ins have been asked to do. Reset between tests. */
const calls = {
  profiles: new Map(),
  upserts: [],
  addBoards: [],
  resolves: [],
  composes: [],
};

const profileKey = (org, userId) =>
  `${String(org?._id || org || '')}:${String(userId)}`;

const fakeService = {
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
  SECTION_TYPES: [
    'boardTiles',
    'goalScores',
    'deliveryScores',
    'workspaceNumbers',
    'myWork',
    'note',
  ],

  /**
   * A pass-through that keeps ONLY the keys the body carried, which is the one
   * property of the real validator these tests depend on: `upsert` writes the
   * parts a shape names and leaves the rest alone, so the controller's new home
   * filter runs only when `home` was actually sent.
   */
  validateShape: (body) => {
    if (body == null) return { value: { boards: [], home: [], nav: {} } };
    const value = {};
    for (const key of ['boards', 'home', 'nav']) {
      if (body[key] !== undefined) value[key] = body[key];
    }
    return { value };
  },

  getForUser: async (orgId, userId) =>
    calls.profiles.get(profileKey(orgId, userId)) || null,

  /**
   * The RESOLVED profile is deliberately a different object from the stored
   * one — that is how the home test proves the composer is handed the resolved
   * list (boards elided) rather than the raw document.
   */
  resolveForViewer: async (org, userId) => {
    calls.resolves.push({
      org: String(org?._id || org),
      userId: String(userId),
    });
    const stored = calls.profiles.get(profileKey(org, userId));
    if (!stored) return { profile: null, skipped: [] };
    return { profile: { ...stored, resolved: true, boards: [] }, skipped: [] };
  },

  upsert: async (org, userId, shape, opts) => {
    calls.upserts.push({
      org: String(org?._id || org),
      userId: String(userId),
      shape,
      opts,
    });
    const existing = calls.profiles.get(profileKey(org, userId)) || {
      _id: 'profile-1',
      boards: [],
      home: [],
      nav: {},
    };
    const profile = { ...existing, ...shape };
    calls.profiles.set(profileKey(org, userId), profile);
    return { profile, dropped: [] };
  },

  addBoard: async (org, userId, boardId, opts) => {
    calls.addBoards.push({
      userId: String(userId),
      boardId: String(boardId),
      opts,
    });
    return {
      profile: calls.profiles.get(profileKey(org, userId)) || null,
      board: { _id: boardId, name: 'Open board' },
      level: 'edit',
      added: true,
    };
  },

  removeBoard: async () => ({ profile: null, removed: true, revoked: false }),

  remove: async (org, userId) => {
    const key = profileKey(org, userId);
    const profile = calls.profiles.get(key) || null;
    calls.profiles.delete(key);
    return { removed: !!profile, profile };
  },
};

/**
 * The REAL section registry, taken before the composer is stubbed out.
 *
 * The controller reads exactly one thing off it — `optionalBoard`, which says
 * whether a section's board is its SUBJECT or a NARROWING of it — and a stub
 * that asserted its own answer to that would let this file pass while the real
 * registry said something else. Requiring the module here loads it for real and
 * caches it; `seedModule` below then replaces that cache entry with the stub,
 * so the controller still gets a composer that only records its arguments.
 */
const { HANDLERS: REAL_HANDLERS } = require('../services/executiveHome');

const fakeHome = {
  SECTION_TYPES: fakeService.SECTION_TYPES,
  HANDLERS: REAL_HANDLERS,
  compose: async (org, userId, opts) => {
    calls.composes.push({
      org: String(org?._id || org),
      userId: String(userId),
      profile: opts && opts.profile,
    });
    return { sections: [{ id: 'section-1', type: 'note', state: 'ok' }] };
  },
};

const fakeNotifications = {
  createNotification: async () => null,
  createNotificationsForUsers: async () => [],
  notifyTaskAudience: async () => [],
  filterByEmailPreference: async () => [],
  isPushEnabled: () => false,
  PUSH_DEFAULT_ON: false,
};

seedModule(SERVICE_PATH, fakeService);
seedModule(HOME_PATH, fakeHome);
seedModule(NOTIFY_PATH, fakeNotifications);

// Required AFTER the cache is seeded — this is the line the seeding is for.
const {
  get,
  getMine,
  putMine,
  getMyHome,
  addBoard,
  declare,
} = require('./executiveViewController');
const { transferOrgOwnership } = require('./orgController');

const Organisation = require('../models/Organisation');
const Board = require('../models/Board');
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

const OWNER = '6b466b99ea3ab35ff1379a01';
const ADMIN = '6b466b99ea3ab35ff1379a02';
const OPS = '6b466b99ea3ab35ff1379a03';
const TARGET = '6b466b99ea3ab35ff1379a04';
const ORG = '6b466b99ea3ab35ff1379a10';

/** One board anybody in the workspace can open, and one only its creator can. */
const OPEN_BOARD = '6b466b99ea3ab35ff1379a20';
const CLOSED_BOARD = '6b466b99ea3ab35ff1379a21';

/** A section's own id — the identity the "already stored" rule matches on. */
const SECTION = '6b466b99ea3ab35ff1379a30';

const BOARDS = [
  {
    _id: OPEN_BOARD,
    organisation: ORG,
    name: 'Open board',
    visibility: 'public',
    publicDefaultLevel: 'contribute',
    createdBy: ADMIN,
    memberAccess: [],
  },
  {
    // Private, created by somebody else, no grant: the real resolver answers
    // `canRead: false` for every member here, which is the whole point of using
    // it rather than a stub that would agree with the controller.
    _id: CLOSED_BOARD,
    organisation: ORG,
    name: 'Closed board',
    visibility: 'private',
    createdBy: ADMIN,
    memberAccess: [],
  },
];

/**
 * The seeded roles plus one custom role holding the executive-view capability
 * and NOT `org.assign_roles` — the ops lead the capability split exists for.
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

const makeOrg = ({ targetRole = 'member' } = {}) => ({
  _id: ORG,
  name: 'Test workspace',
  admin: OWNER,
  admins: [],
  members: [OWNER, ADMIN, OPS, TARGET],
  roles: roles.map((r) => ({ ...r })),
  memberRoles: [
    { user: ADMIN, role: roleId('admin') },
    { user: OPS, role: roleId('ops') },
    { user: TARGET, role: roleId(targetRole) },
  ],
  saved: 0,
  // Already seeded, so the lazy heal in `loadOrgContext` reports no change and
  // a fixture never saves itself out from under a "nothing was written" assert.
  ensureSystemRoles: () => false,
  roleByKey(key) {
    return (this.roles || []).find((r) => r.key === key);
  },
  async save() {
    this.saved += 1;
  },
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A thenable answering `.select().lean()`, the shape the controllers use. */
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

const selfReq = ({ actor = TARGET, body = {} } = {}) => ({
  params: {},
  query: { org: ORG },
  body,
  user: { userId: actor, name: 'Test Actor' },
});

const adminReq = ({ actor = ADMIN, target = TARGET, body = {} } = {}) => ({
  params: { orgId: ORG, userId: target },
  query: {},
  body,
  user: { userId: actor, name: 'Test Actor' },
});

const stubModels = (org) => {
  const originals = {
    orgFindById: Organisation.findById,
    userFindById: User.findById,
    boardFind: Board.find,
    boardFindById: Board.findById,
    logCreate: ActivityLog.create,
  };
  const rows = [];

  Organisation.findById = () => Promise.resolve(org);
  User.findById = (id) => chain({ _id: id, name: 'Target Person' });
  // `Board.find({ _id: { $in: [...] }, organisation })`, answered off the
  // fixtures and scoped the same way the controller asks for it — a test that
  // named another workspace's board would get nothing back, which is exactly
  // what the real query does.
  Board.find = (query = {}) => {
    const wanted = (query._id && query._id.$in) || [];
    const ids = new Set(wanted.map(String));
    return Promise.resolve(
      BOARDS.filter(
        (b) =>
          ids.has(String(b._id)) &&
          String(b.organisation) === String(query.organisation)
      )
    );
  };
  Board.findById = (id) =>
    chain(BOARDS.find((b) => String(b._id) === String(id)) || null);
  ActivityLog.create = async (doc) => {
    rows.push(doc);
    return doc;
  };

  calls.profiles.clear();
  calls.upserts.length = 0;
  calls.addBoards.length = 0;
  calls.resolves.length = 0;
  calls.composes.length = 0;

  const restore = () => {
    Organisation.findById = originals.orgFindById;
    User.findById = originals.userFindById;
    Board.find = originals.boardFind;
    Board.findById = originals.boardFindById;
    ActivityLog.create = originals.logCreate;
  };
  return { rows, restore };
};

/** Store a profile for somebody, the way a declare would have. */
const giveProfile = (userId, profile = {}) => {
  const stored = {
    _id: `profile-${userId}`,
    organisation: ORG,
    user: userId,
    boards: [],
    home: [],
    nav: {},
    ...profile,
  };
  calls.profiles.set(profileKey(ORG, userId), stored);
  return stored;
};

/** The activity writers are fire-and-forget; one turn is enough to see a row. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** The role key `userId` holds on `org` right now. */
const roleKeyOf = (org, userId) => {
  const assignment = (org.memberRoles || []).find(
    (m) => String(m.user) === String(userId)
  );
  if (!assignment) return null;
  return (org.roles.find((r) => r._id === String(assignment.role)) || {}).key;
};

// ---------------------------------------------------------------------------
// 1. Invariant 8 on READ — the owner's profile is never served
// ---------------------------------------------------------------------------

test('the owner is not served their own profile, however it got there', async () => {
  // The state an ownership transfer used to leave behind. The document exists;
  // the answer is still "you are not an Executive", because the owner reaches
  // every board implicitly and a curated list of four is a strictly smaller
  // workspace than the one they now own.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(OWNER, { boards: [{ board: OPEN_BOARD }] });

  const res = fakeRes();
  await getMine(selfReq({ actor: OWNER }), res);
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profile, null);
  assert.deepEqual(res.body.skipped, []);
  // Refused BEFORE the read, so there is no document around to leak by accident.
  assert.equal(calls.resolves.length, 0);
});

test('a non-owner executive is still served their profile', async () => {
  // The control. Without it the test above passes just as well on a handler
  // that refuses everybody.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  await getMine(selfReq({ actor: TARGET }), res);
  restore();

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.profile);
  assert.equal(calls.resolves.length, 1);
});

test('the configurator is told the owner has no profile', async () => {
  // The same rule on the admin plane: an admin opening the owner's row must not
  // be handed a document that the page would then offer to edit.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(OWNER);

  const res = fakeRes();
  await get(adminReq({ actor: ADMIN, target: OWNER }), res);
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profile, null);
  assert.equal(calls.resolves.length, 0);
});

test('the owner gets no executive home to compose', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(OWNER, { home: [{ type: 'note', config: { text: 'hi' } }] });

  const res = fakeRes();
  await getMyHome(selfReq({ actor: OWNER }), res);
  restore();

  assert.equal(res.statusCode, 404);
  // Not one scorer ran.
  assert.equal(calls.composes.length, 0);
});

test('the owner cannot edit a view the reads say they do not have', async () => {
  // The write side has to agree with the read side or the two produce a shape
  // nobody can see and only one of them can change. `del` on the admin plane is
  // the path that clears a stale document up, and it deliberately keeps no
  // owner refusal for exactly that reason.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(OWNER);

  const res = fakeRes();
  await putMine(
    selfReq({ actor: OWNER, body: { nav: { boards: false } } }),
    res
  );
  restore();

  assert.equal(res.statusCode, 404);
  assert.equal(calls.upserts.length, 0);
});

// ---------------------------------------------------------------------------
// The home endpoint itself
// ---------------------------------------------------------------------------

test('the home endpoint composes the RESOLVED profile', async () => {
  // The composer must be handed the profile as that person will experience it —
  // boards they can no longer open already elided — and not the raw document.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET, { boards: [{ board: CLOSED_BOARD }] });

  const res = fakeRes();
  await getMyHome(selfReq({ actor: TARGET }), res);
  restore();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.sections, [
    { id: 'section-1', type: 'note', state: 'ok' },
  ]);

  assert.equal(calls.composes.length, 1);
  const [composed] = calls.composes;
  assert.equal(composed.org, ORG);
  assert.equal(composed.userId, TARGET);
  assert.equal(composed.profile.resolved, true);
  assert.deepEqual(composed.profile.boards, []);
});

test('somebody with no profile has no home — 404, not an empty page', async () => {
  // `sections: []` would read as "your home page is empty", which a real
  // profile can legitimately be. The two states must not look alike.
  const org = makeOrg();
  const { restore } = stubModels(org);

  const res = fakeRes();
  await getMyHome(selfReq({ actor: TARGET }), res);
  restore();

  assert.equal(res.statusCode, 404);
  assert.equal(calls.composes.length, 0);
});

test('the home endpoint takes its organisation the way its sibling does', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  const req = selfReq({ actor: TARGET });
  req.query = {};
  await getMyHome(req, res);
  restore();

  assert.equal(res.statusCode, 400);
  assert.equal(calls.composes.length, 0);
});

// ---------------------------------------------------------------------------
// 3. The self PUT's reach filter reaches into home sections
// ---------------------------------------------------------------------------

test('a self PUT cannot plant a board it cannot read into a section', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  await putMine(
    selfReq({
      actor: TARGET,
      body: {
        home: [
          { type: 'goalScores', config: { board: CLOSED_BOARD, month: null } },
        ],
      },
    }),
    res
  );
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(calls.upserts.length, 1);
  // Nulled on the way to the service, not merely refused at render time.
  assert.equal(calls.upserts[0].shape.home[0].config.board, null);
  // And said so, in the same vocabulary a dropped board ENTRY is reported in.
  assert.deepEqual(res.body.dropped, [CLOSED_BOARD]);
  // The rest of the config is untouched — this is a filter, not a reset.
  assert.equal(calls.upserts[0].shape.home[0].config.month, null);
  assert.equal(calls.upserts[0].shape.home[0].type, 'goalScores');
});

test('a board the caller CAN read is stored unchanged', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  await putMine(
    selfReq({
      actor: TARGET,
      body: { home: [{ type: 'goalScores', config: { board: OPEN_BOARD } }] },
    }),
    res
  );
  restore();

  assert.equal(calls.upserts[0].shape.home[0].config.board, OPEN_BOARD);
  assert.deepEqual(res.body.dropped, []);
});

test('an unreadable board already stored in that section survives the save', async () => {
  // The direction with no symptom, and the reason this is a filter rather than
  // a blanket null: a section an ADMIN composed for a board this person cannot
  // currently read is the admin's configuration. An Executive who merely
  // reorders their home must not destroy it — it comes back to life the moment
  // the grant does.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET, {
    home: [
      {
        _id: SECTION,
        type: 'goalScores',
        order: 0,
        config: { board: CLOSED_BOARD },
      },
    ],
  });

  const res = fakeRes();
  await putMine(
    selfReq({
      actor: TARGET,
      body: {
        home: [
          {
            _id: SECTION,
            type: 'goalScores',
            order: 0,
            config: { board: CLOSED_BOARD },
          },
        ],
      },
    }),
    res
  );
  restore();

  assert.equal(calls.upserts[0].shape.home[0].config.board, CLOSED_BOARD);
  // Nothing was refused, so nothing is reported: `dropped` would otherwise be a
  // message about something that did not happen.
  assert.deepEqual(res.body.dropped, []);
});

test('the same unreadable board in a DIFFERENT section is still refused', async () => {
  // "Already stored" is matched on the SECTION's id, not on the board's.
  // Otherwise one inherited section would launder that board into every new one.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET, {
    home: [
      {
        _id: SECTION,
        type: 'goalScores',
        order: 0,
        config: { board: CLOSED_BOARD },
      },
    ],
  });

  const res = fakeRes();
  await putMine(
    selfReq({
      actor: TARGET,
      body: {
        home: [
          {
            _id: SECTION,
            type: 'goalScores',
            order: 0,
            config: { board: CLOSED_BOARD },
          },
          { type: 'deliveryScores', order: 1, config: { board: CLOSED_BOARD } },
        ],
      },
    }),
    res
  );
  restore();

  const [stored] = calls.upserts;
  assert.equal(stored.shape.home[0].config.board, CLOSED_BOARD);
  assert.equal(stored.shape.home[1].config.board, null);
  assert.deepEqual(res.body.dropped, [CLOSED_BOARD]);
});

test('a list of boards in one config is filtered rather than nulled', async () => {
  // `boardTiles` names a LIST. The readable half must survive; only the id the
  // caller has no business naming goes.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  await putMine(
    selfReq({
      actor: TARGET,
      body: {
        home: [
          {
            type: 'boardTiles',
            config: { boards: [OPEN_BOARD, CLOSED_BOARD] },
          },
        ],
      },
    }),
    res
  );
  restore();

  assert.deepEqual(calls.upserts[0].shape.home[0].config.boards, [OPEN_BOARD]);
  assert.deepEqual(res.body.dropped, [CLOSED_BOARD]);
});

test('an unreadable NARROWING costs the section, never the narrowing', async () => {
  // `workspaceNumbers` reports on the whole workspace unless `config.board`
  // narrows it, so nulling that board would not disarm the section — it would
  // silently widen it from one board's figures to every board's, under the same
  // heading. The section goes instead, and the board is reported like any other.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  await putMine(
    selfReq({
      actor: TARGET,
      body: {
        home: [
          { type: 'note', order: 0, config: { title: 'Morning', text: '' } },
          {
            type: 'workspaceNumbers',
            order: 1,
            config: { range: '30d', board: CLOSED_BOARD },
          },
        ],
      },
    }),
    res
  );
  restore();

  assert.equal(res.statusCode, 200);
  const stored = calls.upserts[0].shape.home;
  // One section stored, and it is the one that named no board.
  assert.equal(stored.length, 1);
  assert.equal(stored[0].type, 'note');
  // Specifically NOT stored as a whole-workspace section.
  assert.equal(
    stored.some((s) => s.type === 'workspaceNumbers'),
    false
  );
  assert.deepEqual(res.body.dropped, [CLOSED_BOARD]);
});

test('a workspaceNumbers section that names no board is the whole workspace and survives', async () => {
  // The other half of the same rule: `board: null` is a legitimate, configured
  // state for this type — it is what "every board you can read" is spelled as —
  // so nothing above may mistake it for a refusal.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  await putMine(
    selfReq({
      actor: TARGET,
      body: {
        home: [
          { type: 'workspaceNumbers', order: 0, config: { range: '7d', board: null } },
          {
            type: 'workspaceNumbers',
            order: 1,
            config: { range: '30d', board: OPEN_BOARD },
          },
        ],
      },
    }),
    res
  );
  restore();

  assert.equal(res.statusCode, 200);
  const stored = calls.upserts[0].shape.home;
  assert.equal(stored.length, 2);
  assert.equal(stored[0].config.board, null);
  assert.equal(stored[1].config.board, OPEN_BOARD);
  assert.deepEqual(res.body.dropped, []);
});

test('a save that names no board at all does not touch the board collection', async () => {
  // The filter is skipped entirely when there is nothing to filter — a nav-only
  // save must not cost a board query.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  let queried = 0;
  const realFind = Board.find;
  Board.find = (...args) => {
    queried += 1;
    return realFind(...args);
  };

  const res = fakeRes();
  await putMine(
    selfReq({ actor: TARGET, body: { nav: { boards: false } } }),
    res
  );
  Board.find = realFind;
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(queried, 0);
  assert.deepEqual(res.body.dropped, []);
});

// ---------------------------------------------------------------------------
// 4. Adding a board never creates a profile
// ---------------------------------------------------------------------------

test('adding a board to somebody who is not an executive is a 404', async () => {
  // The service's `addBoard` calls `loadOrCreate`, so without the guard this
  // route quietly becomes a second "make executive" — one that never checks
  // `org.assign_roles`, never refuses the owner, never assigns the role and
  // never writes the `executive.declared` row that records who decided it.
  const org = makeOrg();
  const { rows, restore } = stubModels(org);

  const res = fakeRes();
  await addBoard(adminReq({ body: { boardId: OPEN_BOARD } }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /executive/i);
  // And nothing was created: the service was never reached.
  assert.equal(calls.addBoards.length, 0);
  assert.equal(calls.profiles.size, 0);
  assert.equal(rows.length, 0);
});

test('adding a board to an existing executive still works', async () => {
  const org = makeOrg();
  const { rows, restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  await addBoard(adminReq({ body: { boardId: OPEN_BOARD } }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(calls.addBoards.length, 1);
  assert.equal(calls.addBoards[0].boardId, OPEN_BOARD);
  assert.equal(calls.addBoards[0].opts.level, 'edit');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'executive.board_added');
});

test('a malformed board id is still refused before any profile lookup', async () => {
  // Order matters only for cost here, but it is worth pinning: a bad body must
  // not buy a query to be told it was bad.
  const org = makeOrg();
  const { restore } = stubModels(org);

  const res = fakeRes();
  await addBoard(adminReq({ body: { boardId: 'nope' } }), res);
  restore();

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /board/i);
});

// ---------------------------------------------------------------------------
// 5. `declare` asks for the role capability only when a role would move
// ---------------------------------------------------------------------------

test('declaring somebody who already holds the role needs no role capability', async () => {
  // The commonest repair this feature has: they hold the Executive role, their
  // view was deleted, give them one back. Nothing about their reach changes, so
  // the capability that governs reach is not the one being spent.
  const org = makeOrg({ targetRole: EXECUTIVE_ROLE_KEY });
  const { rows, restore } = stubModels(org);

  const res = fakeRes();
  await declare(adminReq({ actor: OPS }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.created, true);
  assert.equal(res.body.roleAssigned, false);
  // The role did not move, and the org document was never written.
  assert.equal(roleKeyOf(org, TARGET), EXECUTIVE_ROLE_KEY);
  assert.equal(org.saved, 0);
  // The profile was created, and the row records the role they KEPT.
  assert.equal(calls.upserts.length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metadata.roleKey, EXECUTIVE_ROLE_KEY);
});

test('declaring somebody whose role WOULD move is still refused without the capability', async () => {
  // The other half, and the half that must never loosen: the moment a role
  // actually moves, `org.assign_roles` is required and no body flag opts out.
  const org = makeOrg({ targetRole: 'member' });
  const { rows, restore } = stubModels(org);

  const res = fakeRes();
  await declare(adminReq({ actor: OPS }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /role/i);
  assert.equal(calls.upserts.length, 0);
  assert.equal(org.saved, 0);
  assert.equal(rows.length, 0);
  assert.equal(roleKeyOf(org, TARGET), 'member');
});

test('re-declaring an executive who already has a profile stays a no-op', async () => {
  // The conditional capability check must not have turned the idempotent case
  // into a write: `upsert` REPLACES, so a second press would wipe a curated
  // layout.
  const org = makeOrg({ targetRole: EXECUTIVE_ROLE_KEY });
  const { rows, restore } = stubModels(org);
  giveProfile(TARGET, { boards: [{ board: OPEN_BOARD }] });

  const res = fakeRes();
  await declare(adminReq({ actor: OPS }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.created, false);
  assert.equal(res.body.roleAssigned, false);
  assert.equal(calls.upserts.length, 0);
  assert.equal(rows.length, 0);
  assert.deepEqual(res.body.profile.boards, [{ board: OPEN_BOARD }]);
});

// ---------------------------------------------------------------------------
// 2. The transfer itself
// ---------------------------------------------------------------------------

const transferReq = (org, { actor = OWNER, target = TARGET } = {}) => ({
  params: { id: ORG },
  // `requireOrgOwner` has already loaded it and proved the caller owns it.
  org,
  body: { userId: target },
  user: { userId: actor, name: 'Outgoing owner' },
});

test('handing the workspace to an executive deletes their view', async () => {
  // Invariant 8, tidied up at the one event that can break it. The read guard
  // above already hides the document; this stops it existing at all, so the
  // Executives strip does not list somebody every other surface says is not one.
  const org = makeOrg();
  const { rows, restore } = stubModels(org);
  giveProfile(TARGET, {
    boards: [{ board: OPEN_BOARD }, { board: CLOSED_BOARD }],
  });

  const res = fakeRes();
  await transferOrgOwnership(transferReq(org), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(String(org.admin), TARGET);
  // The profile is gone, not merely hidden.
  assert.equal(calls.profiles.get(profileKey(ORG, TARGET)), undefined);

  // And the loss is recorded, with the board count captured off the deleted
  // document — afterwards there is nothing left to count.
  const removedRow = rows.find((r) => r.type === 'executive.removed');
  assert.ok(removedRow);
  assert.equal(String(removedRow.organisation), ORG);
  assert.equal(removedRow.metadata.targetUser, TARGET);
  assert.equal(removedRow.metadata.boardCount, 2);
  assert.equal(String(removedRow.actor), OWNER);
});

test('handing the workspace to somebody with no view writes no removal row', async () => {
  // The ordinary transfer. Nothing to delete, so nothing is said about one.
  const org = makeOrg();
  const { rows, restore } = stubModels(org);

  const res = fakeRes();
  await transferOrgOwnership(transferReq(org), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(String(org.admin), TARGET);
  assert.equal(rows.filter((r) => r.type === 'executive.removed').length, 0);
});

test('a refused transfer leaves the candidate’s view alone', async () => {
  // The delete runs AFTER the save for exactly this reason: a transfer that
  // never happened must not cost somebody the view they still have.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  await transferOrgOwnership(
    {
      params: { id: ORG },
      org,
      body: { userId: 'not-an-id' },
      user: { userId: OWNER },
    },
    res
  );
  await flush();
  restore();

  assert.equal(res.statusCode, 400);
  assert.equal(String(org.admin), OWNER);
  assert.ok(calls.profiles.get(profileKey(ORG, TARGET)));
});

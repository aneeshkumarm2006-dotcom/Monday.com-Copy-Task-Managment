const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

/**
 * The two phase-4 endpoints, and the two ways each of them can quietly lie.
 *
 * ---- WHAT IS ACTUALLY AT STAKE HERE ----------------------------------------
 *
 * COPY-FROM writes GRANTS. It is the one route in this feature that widens
 * several people's reach from a single click, driven by a list somebody else
 * composed — so the interesting cases are all about what it refuses to copy:
 *
 *  1. A board the ACTOR cannot share is SKIPPED, and NAMED in the response. Not
 *     failed (the other nine boards should still land, and an admin curating a
 *     view will routinely meet a board that is not theirs to give), and above
 *     all not silently dropped: a copy that loses three boards without saying
 *     which three leaves an admin looking at a list that is almost right.
 *  2. A board the SOURCE can no longer read is skipped too. There is no level to
 *     read off it, and falling back to the `edit` default would hand the target
 *     MORE reach than the person being copied from has — a copy that escalates.
 *  3. The LEVEL is read off the SOURCE's own resolved access, not off the
 *     profile (a board entry stores no level; a level lives on the board) and
 *     not off the "Add board" default. `edit + canManage` copies as full access;
 *     `comment` copies as `comment`.
 *  4. It creates NO PROFILE. `declare` is the only route that decides who is an
 *     Executive, and it is the only one that checks `org.assign_roles` when that
 *     decision moves a role. A copy-from that created a profile would be a
 *     second, differently-gated way to make somebody an Executive — the exact
 *     gap phase 2 closed on `POST /:userId/boards`.
 *
 * PREVIEW reads. Its whole reason for existing server-side is that the ADMIN's
 * reach must not leak into it: an admin composing a page can usually read more
 * boards than the person they are composing it for, and a preview drawn from the
 * admin's session would fill every tile while the target opens "you no longer
 * have access to this board" four times. So both directions are asserted — a
 * board only the ADMIN can read is ABSENT, a board only the TARGET can read is
 * PRESENT — along with the capability list, which is part of what the target
 * sees (`applyNavSwitches` runs AFTER the rail's capability gates, so the pane
 * needs the gates the TARGET passes, not the ones the caller passes).
 *
 * ---- HOW THIS IS STUBBED ---------------------------------------------------
 *
 * The technique `executiveGuards.test.js` uses, for the same reason: seeding
 * `require.cache` before the controller is first required is the CommonJS
 * equivalent of an injected dependency. What is different here is how much is
 * REAL, because these two handlers are almost entirely made of reach questions:
 *
 *  - `resolveAccess` is real, over ordinary board fixtures. Every "can the actor
 *    share this", "what level does the source hold", "can the target read this"
 *    below is answered by the two-layer AND the app actually ships, never by a
 *    mock that would agree with whatever the controller assumed.
 *  - `validateShape` and `resolveForViewer` are the REAL ones, captured before
 *    the service is stubbed. The copy's output has to survive the same validator
 *    every other save goes through, and the preview's honesty IS
 *    `resolveForViewer` — stubbing it would be stubbing the assertion.
 *  - `addBoard` and `upsert` are stand-ins (there is no database here), but the
 *    stand-in for `addBoard` makes the REAL authorisation check the real service
 *    makes, so a 403 in these tests is a genuine one.
 */

// ---------------------------------------------------------------------------
// The stand-ins. Installed BEFORE the controller is required.
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

const fakeNotifications = {
  createNotification: async () => null,
  createNotificationsForUsers: async () => [],
  notifyTaskAudience: async () => [],
  filterByEmailPreference: async () => [],
  isPushEnabled: () => false,
  PUSH_DEFAULT_ON: false,
};

// Seeded FIRST so that requiring the real profile service below — which pulls in
// `boardGrants`, which pulls in the notifier — never loads the real one. Nothing
// in these tests reaches a grant write, but a test file that can start a
// notification fan-out is a test file that can hang.
seedModule(NOTIFY_PATH, fakeNotifications);

/**
 * The REAL modules, taken before their cache entries are replaced.
 *
 * `validateShape` because the copy's output must pass the same gate every other
 * save passes — a stub pass-through would let this file agree with a shape the
 * document would refuse. `resolveForViewer` because it IS what the preview
 * asserts. `HANDLERS` because the controller reads `optionalBoard` off the real
 * registry (see its `reachFilterHome`).
 */
const realService = require('../services/executiveView');
const { HANDLERS: REAL_HANDLERS } = require('../services/executiveHome');

const { resolveAccess } = require('../utils/permissions');

/** What the stand-ins were asked to do. Reset between tests. */
const calls = {
  profiles: new Map(),
  upserts: [],
  addBoards: [],
  composes: [],
};

const profileKey = (org, userId) =>
  `${String(org?._id || org || '')}:${String(userId)}`;

const fakeService = {
  BOARD_TABS: realService.BOARD_TABS,
  SECTION_TYPES: realService.SECTION_TYPES,
  SKIP_REASONS: realService.SKIP_REASONS,
  KEEP_REASONS: realService.KEEP_REASONS,
  DEFAULT_LEVEL: realService.DEFAULT_LEVEL,

  // Real. See the header.
  validateShape: realService.validateShape,

  getForUser: async (orgId, userId) =>
    calls.profiles.get(profileKey(orgId, userId)) || null,

  /**
   * Real too — it reads through `ExecutiveView.findOne(...).lean()` and
   * `Board.find(...)`, both of which the model stubs below answer off the
   * fixtures, so the reach filtering inside it is the shipped one.
   */
  resolveForViewer: async (org, userId) =>
    realService.resolveForViewer(org, userId),

  /**
   * The stand-in that still refuses for real.
   *
   * The service's own `addBoard` authorises the grant on the ACTOR's
   * `resolveAccess(board, org, actor).canManageAccess` — that check is the thing
   * stopping this route handing out boards nobody gave the actor, so it is
   * reproduced here rather than mocked away. Everything else (the grant write,
   * the notification) is what there is no database for.
   */
  addBoard: async (org, userId, boardId, opts = {}) => {
    calls.addBoards.push({
      userId: String(userId),
      boardId: String(boardId),
      opts,
    });

    const doc = BOARDS.find((b) => String(b._id) === String(boardId));
    if (!doc) return { error: 'Board not found in this workspace.', status: 404 };
    if (!resolveAccess(doc, org, opts.actor).canManageAccess) {
      return { error: 'You cannot manage access on that board.', status: 403 };
    }

    const profile = calls.profiles.get(profileKey(org, userId));
    if (!profile) return { error: 'No profile', status: 404 };
    const already = (profile.boards || []).some(
      (e) => String(e.board) === String(boardId)
    );
    if (!already) {
      // Exactly what the service pushes: a BARE entry. The presentation is a
      // shape edit and arrives later, through `upsert` — which is the ordering
      // the copy handler depends on.
      profile.boards.push({
        board: String(boardId),
        label: '',
        order: profile.boards.length,
        defaultTab: null,
        tabs: null,
      });
    }
    return {
      profile,
      board: doc,
      level: opts.level,
      added: !already,
      existed: false,
    };
  },

  upsert: async (org, userId, shape, opts) => {
    calls.upserts.push({ userId: String(userId), shape, opts });
    const key = profileKey(org, userId);
    const existing = calls.profiles.get(key) || {
      _id: 'profile-new',
      organisation: ORG,
      user: userId,
      boards: [],
      home: [],
      nav: {},
    };
    const profile = { ...existing, ...shape };
    calls.profiles.set(key, profile);
    return { profile, dropped: [] };
  },

  removeBoard: async () => ({ profile: null, removed: true, revoked: false }),
  remove: async () => ({ removed: false, profile: null }),
};

const fakeHome = {
  SECTION_TYPES: realService.SECTION_TYPES,
  HANDLERS: REAL_HANDLERS,
  CONFIG_NORMALISERS: require('../services/executiveHome').CONFIG_NORMALISERS,
  compose: async (org, userId, opts) => {
    calls.composes.push({
      org: String(org?._id || org),
      userId: String(userId),
      profile: opts && opts.profile,
    });
    // Enough to prove the composer ran and whose page it ran for. What a section
    // actually renders is `executiveHome.test.js`'s subject, not this file's.
    return {
      sections: ((opts && opts.profile && opts.profile.home) || []).map(
        (section, index) => ({
          id: `section-${index}`,
          type: section.type,
          state: 'ok',
        })
      ),
    };
  },
};

seedModule(SERVICE_PATH, fakeService);
seedModule(HOME_PATH, fakeHome);

// Required AFTER the cache is seeded — this is the line the seeding is for.
const {
  copyFrom,
  preview,
  COPY_SKIP_REASONS,
} = require('./executiveViewController');

const Organisation = require('../models/Organisation');
const Board = require('../models/Board');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const ExecutiveView = require('../models/ExecutiveView');
const {
  SYSTEM_ROLES,
  sanitizePermissions,
  EXECUTIVE_ROLE_KEY,
} = require('../utils/capabilities');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '6c566b99ea3ab35ff1379b01';
const ADMIN = '6c566b99ea3ab35ff1379b02';
const OPS = '6c566b99ea3ab35ff1379b03';
const SOURCE = '6c566b99ea3ab35ff1379b04';
const TARGET = '6c566b99ea3ab35ff1379b05';
const ORG = '6c566b99ea3ab35ff1379b10';

/**
 * Six boards, chosen so that every branch of the copy is a REAL resolver answer
 * rather than a flag on a fixture:
 *
 *  FULL_BOARD    the source holds a full-access grant; the actor created it
 *  COMMENT_BOARD the source holds a `comment` grant; the actor created it
 *  LOCKED_BOARD  the source can read it, the actor cannot share it
 *  GONE_BOARD    on the source's list, no document behind it
 *  ADMIN_ONLY    only the caller can read it (preview: must be ABSENT)
 *  TARGET_ONLY   only the target can read it (preview: must be PRESENT)
 */
const FULL_BOARD = '6c566b99ea3ab35ff1379b20';
const COMMENT_BOARD = '6c566b99ea3ab35ff1379b21';
const LOCKED_BOARD = '6c566b99ea3ab35ff1379b22';
const GONE_BOARD = '6c566b99ea3ab35ff1379b23';
const ADMIN_ONLY = '6c566b99ea3ab35ff1379b24';
const TARGET_ONLY = '6c566b99ea3ab35ff1379b25';

const BOARDS = [
  {
    _id: FULL_BOARD,
    organisation: ORG,
    name: 'Client delivery',
    visibility: 'private',
    // The caller made it, so `canManageAccess` is true for them without any
    // grant — the ordinary case for a board an admin runs.
    createdBy: ADMIN,
    memberAccess: [{ user: SOURCE, level: 'edit', canManage: true }],
  },
  {
    _id: COMMENT_BOARD,
    organisation: ORG,
    name: 'Studio roadmap',
    visibility: 'private',
    createdBy: ADMIN,
    // Deliberately NOT full access: the copy must reproduce this rung rather
    // than the `edit` default the "Add board" button uses.
    memberAccess: [{ user: SOURCE, level: 'comment', canManage: false }],
  },
  {
    _id: LOCKED_BOARD,
    organisation: ORG,
    name: 'Board finances',
    visibility: 'private',
    // Owned by somebody else, and no grant for the caller. The admin role does
    // NOT carry `board.view_all_private` (off by default), so the real resolver
    // answers `canRead: false` for them — which is what makes this a genuine
    // "the actor cannot share it" rather than a fixture flag.
    createdBy: OWNER,
    memberAccess: [{ user: SOURCE, level: 'edit', canManage: false }],
  },
  {
    _id: ADMIN_ONLY,
    organisation: ORG,
    name: 'Admin scratch',
    visibility: 'private',
    createdBy: ADMIN,
    memberAccess: [],
  },
  {
    _id: TARGET_ONLY,
    organisation: ORG,
    name: 'Their own board',
    visibility: 'private',
    createdBy: TARGET,
    memberAccess: [],
  },
];

/**
 * The seeded roles plus one custom role holding the executive-view capability
 * and NOT `org.assign_roles` — the ops lead the capability split exists for, and
 * the actor for the "this route cannot make anybody an Executive" test.
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

const makeOrg = () => ({
  _id: ORG,
  name: 'Test workspace',
  admin: OWNER,
  admins: [],
  members: [OWNER, ADMIN, OPS, SOURCE, TARGET],
  roles: roles.map((r) => ({ ...r })),
  memberRoles: [
    { user: ADMIN, role: roleId('admin') },
    { user: OPS, role: roleId('ops') },
    { user: SOURCE, role: roleId('member') },
    { user: TARGET, role: roleId(EXECUTIVE_ROLE_KEY) },
  ],
  saved: 0,
  // Already seeded, so `loadOrgContext`'s lazy heal reports no change and a
  // fixture never saves itself out from under a "nothing was written" assert.
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

const copyReq = ({ actor = ADMIN, target = TARGET, source = SOURCE } = {}) => ({
  params: { orgId: ORG, userId: target, sourceUserId: source },
  query: {},
  body: {},
  user: { userId: actor, name: 'Test Actor' },
});

const previewReq = ({ actor = ADMIN, target = TARGET } = {}) => ({
  params: { orgId: ORG, userId: target },
  query: {},
  body: {},
  user: { userId: actor, name: 'Test Actor' },
});

const stubModels = (org) => {
  const originals = {
    orgFindById: Organisation.findById,
    userFindById: User.findById,
    boardFind: Board.find,
    boardFindById: Board.findById,
    logCreate: ActivityLog.create,
    viewFindOne: ExecutiveView.findOne,
  };
  const rows = [];

  Organisation.findById = () => Promise.resolve(org);
  User.findById = (id) => chain({ _id: id, name: 'Target Person' });
  // Answered off the fixtures and scoped the same way the callers ask for it —
  // a query naming another workspace's board gets nothing back, exactly as the
  // real one would.
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
  // What the REAL `resolveForViewer` reads through. Lean, like the real read.
  ExecutiveView.findOne = (query = {}) =>
    chain(calls.profiles.get(profileKey(query.organisation, query.user)) || null);

  calls.profiles.clear();
  calls.upserts.length = 0;
  calls.addBoards.length = 0;
  calls.composes.length = 0;

  const restore = () => {
    Organisation.findById = originals.orgFindById;
    User.findById = originals.userFindById;
    Board.find = originals.boardFind;
    Board.findById = originals.boardFindById;
    ActivityLog.create = originals.logCreate;
    ExecutiveView.findOne = originals.viewFindOne;
  };
  return { rows, restore };
};

/** Store a profile for somebody, the way a declare (and then an edit) would. */
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

/** A stored board entry, spelled the way the document stores one. */
const entry = (board, extra = {}) => ({
  board,
  label: '',
  order: 0,
  defaultTab: null,
  tabs: null,
  ...extra,
});

/** The activity writers are fire-and-forget; one turn is enough to see a row. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const skippedFor = (res, board) =>
  (res.body.skipped || []).find((s) => String(s.board) === String(board));

const copiedFor = (res, board) =>
  (res.body.copied || []).find((c) => String(c.board) === String(board));

// ---------------------------------------------------------------------------
// copy-from — what it refuses to copy
// ---------------------------------------------------------------------------

test('a board the actor cannot share is skipped, named, and does not stop the copy', async () => {
  // The headline case. `LOCKED_BOARD` is one the SOURCE can read and the caller
  // cannot share (owned by somebody else, no grant, and the admin role carries
  // no `board.view_all_private`), so the real resolver refuses the grant. The
  // other two boards must still land, and the refusal must arrive as a NAMED row
  // rather than as a shorter list.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(SOURCE, {
    boards: [
      entry(FULL_BOARD, { order: 0 }),
      entry(LOCKED_BOARD, { order: 1 }),
      entry(COMMENT_BOARD, { order: 2 }),
    ],
  });
  giveProfile(TARGET);

  const res = fakeRes();
  await copyFrom(copyReq(), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 200);

  const refused = skippedFor(res, LOCKED_BOARD);
  assert.ok(refused, 'the board the actor cannot share must be reported');
  assert.equal(refused.reason, COPY_SKIP_REASONS.CANNOT_SHARE);
  // The NAME, not just the id: an id in a dialog is not something anybody can
  // act on, and this row is the only account of what did not happen.
  assert.equal(refused.name, 'Board finances');
  assert.match(refused.error, /manage access/i);

  // The copy went on around it.
  assert.deepEqual(
    res.body.copied.map((c) => c.board),
    [FULL_BOARD, COMMENT_BOARD]
  );
  // And no grant was quietly written for the refused one — the service was
  // ASKED (that is where the authorisation lives) and said no.
  assert.equal(calls.addBoards.length, 3);
  const stored = calls.upserts[0].shape.boards.map((b) => b.board);
  assert.equal(stored.includes(LOCKED_BOARD), false);
});

test('a board the SOURCE can no longer read is skipped rather than granted the default', async () => {
  // The escalation this rule exists to stop. `ADMIN_ONLY` is on the source's
  // list but unreadable to them, so there is no level to copy; falling back to
  // the `edit` default would give the target more than the person being copied
  // from has — and the caller COULD grant it, which is what makes the mistake
  // invisible rather than impossible.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(SOURCE, { boards: [entry(ADMIN_ONLY, { order: 0 })] });
  giveProfile(TARGET);

  const res = fakeRes();
  await copyFrom(copyReq(), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 200);
  const refused = skippedFor(res, ADMIN_ONLY);
  assert.ok(refused);
  assert.equal(refused.reason, COPY_SKIP_REASONS.SOURCE_NO_ACCESS);
  assert.equal(refused.name, 'Admin scratch');
  // Never reached the service, so no grant could have been written.
  assert.equal(calls.addBoards.length, 0);
  assert.deepEqual(res.body.copied, []);
});

test('a board that no longer exists is reported under the label the entry kept', async () => {
  // A deleted board leaves nothing to read a name off. The profile's own label
  // is the only trace, which is why the entry keeps one.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(SOURCE, {
    boards: [entry(GONE_BOARD, { order: 0, label: 'Last quarter' })],
  });
  giveProfile(TARGET);

  const res = fakeRes();
  await copyFrom(copyReq(), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 200);
  const refused = skippedFor(res, GONE_BOARD);
  assert.ok(refused);
  assert.equal(refused.reason, COPY_SKIP_REASONS.DELETED);
  assert.equal(refused.name, 'Last quarter');
  assert.equal(calls.addBoards.length, 0);
});

// ---------------------------------------------------------------------------
// copy-from — what it copies, and at what level
// ---------------------------------------------------------------------------

test('the level comes off the SOURCE, not off the add-a-board default', async () => {
  // A board ENTRY stores no level — a level lives on the board — so "copy the
  // level" only means something once you say where it was read from. It is read
  // from the source's own RESOLVED access: a full-access grant copies as
  // `edit` + canManage, and a `comment` grant copies as `comment` rather than as
  // the `edit` the configurator's Add button would have used.
  //
  // (The clamp to the actor's own standing cannot bite in any fixture, and not
  // by accident: every route to `canManageAccess` also resolves the actor to
  // `edit`. It is in the handler because that is a property of today's ladder
  // rather than of this feature.)
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(SOURCE, {
    boards: [entry(FULL_BOARD, { order: 0 }), entry(COMMENT_BOARD, { order: 1 })],
  });
  giveProfile(TARGET);

  const res = fakeRes();
  await copyFrom(copyReq(), res);
  await flush();
  restore();

  const full = calls.addBoards.find((c) => c.boardId === FULL_BOARD);
  assert.equal(full.opts.level, 'edit');
  assert.equal(full.opts.canManage, true);

  const comment = calls.addBoards.find((c) => c.boardId === COMMENT_BOARD);
  assert.equal(comment.opts.level, 'comment');
  // `canManage` is read off the GRANT's own flag, and this grant does not carry
  // it. Reading the resolved `canManageAccess` instead would also be true for a
  // board's creator — which is not a fact that can be copied to anybody.
  assert.equal(comment.opts.canManage, false);

  // And the response says the same thing, so the configurator can show it.
  assert.equal(copiedFor(res, FULL_BOARD).level, 'edit');
  assert.equal(copiedFor(res, COMMENT_BOARD).level, 'comment');
  assert.equal(copiedFor(res, COMMENT_BOARD).canManage, false);
});

test('home, nav, labels and presets all copy faithfully', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(SOURCE, {
    boards: [
      entry(COMMENT_BOARD, {
        order: 0,
        label: 'Roadmap',
        defaultTab: 'goals',
        tabs: ['board', 'goals'],
      }),
      entry(FULL_BOARD, { order: 1 }),
    ],
    home: [
      {
        _id: '6c566b99ea3ab35ff1379b30',
        type: 'note',
        order: 0,
        width: 'half',
        config: { title: 'Monday', text: 'Read the delivery tab first.' },
      },
      {
        _id: '6c566b99ea3ab35ff1379b31',
        type: 'boardTiles',
        order: 1,
        width: 'full',
        config: { boards: [COMMENT_BOARD] },
      },
    ],
    nav: {
      boards: true,
      myWork: false,
      chat: false,
      calendar: true,
      notifications: true,
      members: false,
      analytics: true,
      productivity: true,
    },
  });
  giveProfile(TARGET);

  const res = fakeRes();
  await copyFrom(copyReq(), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(calls.upserts.length, 1);
  const { shape } = calls.upserts[0];

  // ---- home -------------------------------------------------------------
  assert.equal(shape.home.length, 2);
  assert.equal(shape.home[0].type, 'note');
  assert.equal(shape.home[0].width, 'half');
  assert.deepEqual(shape.home[0].config, {
    title: 'Monday',
    text: 'Read the delivery tab first.',
  });
  assert.equal(shape.home[1].type, 'boardTiles');
  assert.deepEqual(shape.home[1].config.boards, [COMMENT_BOARD]);
  // The section IDs are NOT copied. That id is the only stable identity a
  // section has, and two people's pages must not claim the same one.
  assert.equal(shape.home[0]._id, undefined);
  assert.equal(shape.home[1]._id, undefined);

  // ---- nav --------------------------------------------------------------
  // All eight, exactly as the source has them — including the three that are
  // off, which are the only ones that do anything.
  assert.equal(shape.nav.myWork, false);
  assert.equal(shape.nav.chat, false);
  assert.equal(shape.nav.members, false);
  assert.equal(shape.nav.boards, true);
  assert.equal(shape.nav.analytics, true);
  assert.equal(Object.keys(shape.nav).length, ExecutiveView.NAV_KEYS.length);

  // ---- labels and presets ----------------------------------------------
  const roadmap = shape.boards.find((b) => b.board === COMMENT_BOARD);
  assert.equal(roadmap.label, 'Roadmap');
  assert.equal(roadmap.defaultTab, 'goals');
  assert.deepEqual(roadmap.tabs, ['board', 'goals']);
  // And the source's ORDER, not the order the grants happened to be written in.
  assert.equal(roadmap.order, 0);
  assert.equal(shape.boards.find((b) => b.board === FULL_BOARD).order, 1);
});

test('the target keeps board entries the source never had', async () => {
  // `home` and `nav` are REPLACED — "copy from" means their page becomes the
  // source's page. A board list is not the same kind of thing: every entry on it
  // was put there by an admin, and an entry that vanishes is a board somebody
  // stops being able to find. So the copy merges, and what the target already
  // had keeps its own presentation and follows the copied boards.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(SOURCE, { boards: [entry(FULL_BOARD, { order: 0 })] });
  giveProfile(TARGET, {
    boards: [entry(TARGET_ONLY, { order: 0, label: 'Mine' })],
    home: [{ _id: '6c566b99ea3ab35ff1379b32', type: 'myWork', order: 0, width: 'full', config: {} }],
  });

  const res = fakeRes();
  await copyFrom(copyReq(), res);
  await flush();
  restore();

  const { shape } = calls.upserts[0];
  const kept = shape.boards.find((b) => b.board === TARGET_ONLY);
  assert.ok(kept, 'the target’s own board entry must survive the copy');
  assert.equal(kept.label, 'Mine');
  // Copied boards first, in the source's order; the rest after.
  assert.equal(shape.boards.find((b) => b.board === FULL_BOARD).order, 0);
  assert.equal(kept.order, 1);
  // The layout, by contrast, is the source's now.
  assert.equal(shape.home.length, 0);
});

test('a copy writes one update row and one row per board that landed', async () => {
  // A copy is an UPDATE plus N board additions, and it says so with the types
  // that already exist. The per-board rows carry the board, which is what puts
  // them in that board's own activity export beside the share events.
  const org = makeOrg();
  const { rows, restore } = stubModels(org);
  giveProfile(SOURCE, {
    boards: [
      entry(FULL_BOARD, { order: 0, label: 'Delivery' }),
      entry(LOCKED_BOARD, { order: 1 }),
    ],
  });
  giveProfile(TARGET);

  const res = fakeRes();
  await copyFrom(copyReq(), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 200);
  const added = rows.filter((r) => r.type === 'executive.board_added');
  // One per board that actually landed — never one for the board it skipped.
  assert.equal(added.length, 1);
  assert.equal(String(added[0].board), FULL_BOARD);
  assert.equal(added[0].metadata.level, 'edit');

  const updated = rows.filter((r) => r.type === 'executive.updated');
  assert.equal(updated.length, 1);
  // What actually moved, in the writer's own vocabulary.
  assert.deepEqual(updated[0].metadata.changed, ['home', 'nav', 'boards', 'labels']);
});

// ---------------------------------------------------------------------------
// copy-from — the refusals
// ---------------------------------------------------------------------------

test('copying somebody onto themselves is refused', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET, { boards: [entry(FULL_BOARD)] });

  const res = fakeRes();
  await copyFrom(copyReq({ source: TARGET, target: TARGET }), res);
  restore();

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /somebody else/i);
  assert.equal(calls.addBoards.length, 0);
  assert.equal(calls.upserts.length, 0);
});

test('the workspace owner can never be the target of a copy', async () => {
  // Invariant 8. `declare` and `put` refuse it; a route that writes a profile's
  // shape and hands out grants must refuse it too, or it is simply the way
  // round them.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(SOURCE, { boards: [entry(FULL_BOARD)] });
  giveProfile(OWNER);

  const res = fakeRes();
  await copyFrom(copyReq({ target: OWNER }), res);
  restore();

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /owner/i);
  assert.equal(calls.addBoards.length, 0);
  assert.equal(calls.upserts.length, 0);
});

test('a source with no executive view is a 404', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  await copyFrom(copyReq(), res);
  restore();

  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /copy/i);
  assert.equal(calls.upserts.length, 0);
});

test('the owner is never a source either, however their document got there', async () => {
  // The read half of invariant 8 on the other side of the copy: to every reader
  // the owner is not an Executive, so there is nothing of theirs to copy.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(OWNER, { boards: [entry(FULL_BOARD)] });
  giveProfile(TARGET);

  const res = fakeRes();
  await copyFrom(copyReq({ source: OWNER }), res);
  restore();

  assert.equal(res.statusCode, 404);
  assert.equal(calls.addBoards.length, 0);
});

test('copy-from cannot make anybody an executive, so declare’s role rule stands', async () => {
  // `declare` is the one route that decides who is an Executive, and the one
  // that checks `org.assign_roles` when that decision moves a role. The ops lead
  // below holds `org.manage_executive_views` and NOT `org.assign_roles` — so if
  // this route created a profile, it would be exactly the bypass the capability
  // split exists to prevent. It refuses instead, and nothing at all is written.
  const org = makeOrg();
  const { rows, restore } = stubModels(org);
  giveProfile(SOURCE, { boards: [entry(FULL_BOARD)] });

  const res = fakeRes();
  await copyFrom(copyReq({ actor: OPS }), res);
  await flush();
  restore();

  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /make them an executive first/i);
  assert.equal(calls.profiles.get(profileKey(ORG, TARGET)), undefined);
  assert.equal(calls.addBoards.length, 0);
  assert.equal(calls.upserts.length, 0);
  assert.equal(rows.length, 0);
  // And the role did not move either — the org document was never written.
  assert.equal(org.saved, 0);
});

test('somebody without the capability cannot copy at all', async () => {
  // The plane's own gate, asserted once here so the tests above cannot be read
  // as "any member may do this as long as the boards line up".
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(SOURCE, { boards: [entry(FULL_BOARD)] });
  giveProfile(TARGET);

  const res = fakeRes();
  await copyFrom(copyReq({ actor: SOURCE }), res);
  restore();

  assert.equal(res.statusCode, 403);
  assert.equal(calls.addBoards.length, 0);
});

// ---------------------------------------------------------------------------
// preview — resolved and composed AS THE TARGET
// ---------------------------------------------------------------------------

test('a board only the CALLER can read is absent from the preview', async () => {
  // The mistake this endpoint exists to prevent. The caller created
  // `ADMIN_ONLY`, so a preview drawn from their session would show it working;
  // the target cannot open it, and their real page will say so.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET, {
    boards: [entry(ADMIN_ONLY, { order: 0 }), entry(TARGET_ONLY, { order: 1 })],
  });

  const res = fakeRes();
  await preview(previewReq(), res);
  restore();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.profile.boards.map((b) => String(b.board)),
    [TARGET_ONLY]
  );
  // Reported rather than silently dropped — that IS the preview's finding.
  const missing = (res.body.skipped || []).find(
    (s) => String(s.board) === ADMIN_ONLY
  );
  assert.ok(missing);
  assert.equal(missing.reason, 'no-access');
  assert.equal(missing.name, 'Admin scratch');
  // And never a 403: showing this is the whole point of looking.
  assert.notEqual(res.statusCode, 403);
});

test('a board only the TARGET can read is present in the preview', async () => {
  // The control. Without it, the assertion above passes just as well on a
  // preview that shows nothing at all. `TARGET_ONLY` is private and created by
  // the target, so the CALLER cannot read it — and it must still be there.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET, { boards: [entry(TARGET_ONLY, { order: 0 })] });

  const res = fakeRes();
  await preview(previewReq(), res);
  restore();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.profile.boards.map((b) => String(b.board)),
    [TARGET_ONLY]
  );
  assert.deepEqual(res.body.skipped, []);
});

test('the preview composes as the target, off the resolved profile', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET, {
    boards: [entry(ADMIN_ONLY, { order: 0 })],
    home: [{ _id: '6c566b99ea3ab35ff1379b33', type: 'note', order: 0, width: 'full', config: { title: 'Hi', text: '' } }],
  });

  const res = fakeRes();
  await preview(previewReq(), res);
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(calls.composes.length, 1);
  // Whose page is being composed — never the caller's.
  assert.equal(calls.composes[0].userId, TARGET);
  assert.notEqual(calls.composes[0].userId, ADMIN);
  // And it was handed the RESOLVED profile, with the unreachable board already
  // elided, exactly as `/me/executive-home` hands it over.
  assert.deepEqual(calls.composes[0].profile.boards, []);
  assert.deepEqual(
    res.body.sections.map((s) => s.type),
    ['note']
  );
});

test('the preview ships the TARGET’s capabilities, not the caller’s', async () => {
  // The rail's capability gates run BEFORE the profile's switches, so a pane
  // that applied `nav` over the CALLER's capabilities would draw rows the target
  // will never see. The target here holds the Executive role, which deliberately
  // withholds `board.view_public`; the caller is an Admin, who has it.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET, { nav: { chat: false } });

  const res = fakeRes();
  await preview(previewReq(), res);
  restore();

  assert.equal(res.statusCode, 200);
  const caps = res.body.permissions.capabilities;
  assert.equal(res.body.permissions.role.key, EXECUTIVE_ROLE_KEY);
  assert.equal(res.body.permissions.isOwner, false);
  assert.equal(caps.includes('board.view_public'), false);
  assert.equal(caps.includes('org.manage_executive_views'), true);

  // The caller really does hold the capability the preview withheld — otherwise
  // this test would pass against a handler that shipped an empty list.
  assert.equal(
    resolveAccess(BOARDS[0], org, ADMIN).capabilities.has('board.view_public'),
    true
  );
});

test('the preview normalises nav, so a switch added later reads as on', async () => {
  // A profile written before a switch existed must not leave the pane inferring
  // a default: missing means ON, the same rule the client's filter states.
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET, { nav: { chat: false } });

  const res = fakeRes();
  await preview(previewReq(), res);
  restore();

  assert.equal(res.body.nav.chat, false);
  assert.equal(Object.keys(res.body.nav).length, ExecutiveView.NAV_KEYS.length);
  for (const key of ExecutiveView.NAV_KEYS) {
    if (key !== 'chat') assert.equal(res.body.nav[key], true);
  }
});

test('previewing somebody who is not an executive is a 404, never an empty page', async () => {
  // `sections: []` would read as "their home page is empty", which a real
  // profile can genuinely be. The two states must not look alike — the same
  // reasoning `/me/executive-home` sets out.
  const org = makeOrg();
  const { restore } = stubModels(org);

  const res = fakeRes();
  await preview(previewReq(), res);
  restore();

  assert.equal(res.statusCode, 404);
  assert.equal(calls.composes.length, 0);
});

test('the owner has no preview, whatever document exists for them', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(OWNER, { boards: [entry(FULL_BOARD)] });

  const res = fakeRes();
  await preview(previewReq({ target: OWNER }), res);
  restore();

  assert.equal(res.statusCode, 404);
  // Refused before the read, so there is no document around to leak by accident.
  assert.equal(calls.composes.length, 0);
});

test('somebody without the capability cannot preview', async () => {
  const org = makeOrg();
  const { restore } = stubModels(org);
  giveProfile(TARGET);

  const res = fakeRes();
  await preview(previewReq({ actor: SOURCE }), res);
  restore();

  assert.equal(res.statusCode, 403);
  assert.equal(calls.composes.length, 0);
});

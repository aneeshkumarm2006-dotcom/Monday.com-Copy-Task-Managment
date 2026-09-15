const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * executiveView.test.js — the profile service, exercised without a database.
 *
 * Run from the server directory:
 *     node --test src/services/executiveView.test.js
 *
 * WHAT THIS FILE IS PINNING. Two of the feature's nine invariants live entirely
 * inside this service and are invisible at runtime when they break:
 *
 *   - "a listed board the person cannot read is SKIPPED, never errored"
 *     (invariant 4). When this regresses, an executive's home page 500s on the
 *     afternoon somebody tidies a board's share list — a failure with no
 *     connection, in time or in code, to the change that caused it.
 *   - "the self path never widens reach" (invariant 2). When THIS regresses
 *     nothing visibly fails at all: a board the person cannot open simply sits
 *     on their list, and the day a grant appears from somewhere else it looks
 *     like it was always meant to be there.
 *
 * HOW IT AVOIDS MONGO. `org` and `board` are plain objects shaped like the
 * documents, exactly as `utils/permissions.test.js` does it — `resolveAccess`
 * is a pure function and is deliberately NOT stubbed here, because a stub would
 * make every reach assertion below a test of the stub. The real resolver runs
 * against the real seeded role presets, so "the executive cannot read a public
 * board they were not granted" is the actual permission contract and not this
 * file's opinion of it.
 *
 * The three model statics and the two grant writers ARE stubbed, on the module
 * objects themselves, which works because the service reaches them through the
 * module binding at call time — the pattern `services/boardGrants.test.js` and
 * `controllers/connectorData.test.js` already use.
 */

const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');
const ExecutiveView = require('../models/ExecutiveView');
const Board = require('../models/Board');
const boardGrants = require('./boardGrants');

const {
  BOARD_TABS,
  SECTION_TYPES,
  SKIP_REASONS,
  KEEP_REASONS,
  getForUser,
  resolveForViewer,
  validateShape,
  upsert,
  addBoard,
  removeBoard,
  remove,
} = require('./executiveView');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Real 24-hex ids: the service validates every id it is handed, so a readable
// placeholder like 'board1' would be refused before any rule under test ran.
const ORG = '6a466b99ea3ab35ff1378e10';
const OWNER = '6a466b99ea3ab35ff1378e01';
const EXEC = '6a466b99ea3ab35ff1378e02';
const MEMBER = '6a466b99ea3ab35ff1378e03';
const BOARD_OPEN = '6a466b99ea3ab35ff1378b01';
const BOARD_CLOSED = '6a466b99ea3ab35ff1378b02';
const BOARD_GONE = '6a466b99ea3ab35ff1378b03';
/** A second board this person CAN read — needed to tell a removal from a skip. */
const BOARD_SECOND = '6a466b99ea3ab35ff1378b04';
const GROUP = '6a466b99ea3ab35ff1378c01';

/** Roles as `ensureSystemRoles` seeds them, with stable fake ids. */
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
  _id: ORG,
  admin: OWNER,
  admins: [],
  members: [OWNER, EXEC, MEMBER],
  roles,
  memberRoles: [
    { user: EXEC, role: roleId('executive') },
    { user: MEMBER, role: roleId('member') },
  ],
  ...overrides,
});

const makeBoard = (overrides = {}) => ({
  _id: BOARD_OPEN,
  name: 'SEO Tracker 2026',
  organisation: ORG,
  createdBy: MEMBER,
  visibility: 'public',
  publicDefaultLevel: 'contribute',
  memberAccess: [],
  ...overrides,
});

/**
 * The board the Executive CAN read: public, plus an explicit grant. The
 * Executive preset is Admin minus `board.view_public`, so publicness alone
 * buys them nothing — the grant is the whole of their reach.
 */
const openBoard = () =>
  makeBoard({
    _id: BOARD_OPEN,
    memberAccess: [{ user: EXEC, level: 'edit', canManage: true }],
  });

/** The same board with the grant taken away, which is all a revoke does. */
const closedBoard = () =>
  makeBoard({ _id: BOARD_CLOSED, name: 'Ads 2026', memberAccess: [] });

/** Another board they can read, so "left out of the save" has two meanings. */
const secondBoard = () =>
  makeBoard({
    _id: BOARD_SECOND,
    name: 'Tech 2026',
    memberAccess: [{ user: EXEC, level: 'edit', canManage: true }],
  });

/**
 * A profile as it comes back from a `.lean()` read: plain, with whatever
 * `boards[]` the test is about.
 */
const leanProfile = (boards = []) => ({
  _id: '6a466b99ea3ab35ff1378d01',
  organisation: ORG,
  user: EXEC,
  boards,
  home: [],
  nav: {},
});

const entry = (board, extra = {}) => ({
  board,
  label: '',
  order: 0,
  defaultTab: null,
  tabs: null,
  ...extra,
});

/**
 * A stand-in for a hydrated profile document: the mutators assign whole arrays
 * onto it and then save, which is all they ever do to one.
 */
const makeDoc = (over = {}) => ({
  _id: '6a466b99ea3ab35ff1378d01',
  organisation: ORG,
  user: EXEC,
  boards: [],
  home: [],
  nav: {},
  createdBy: null,
  updatedBy: null,
  saves: 0,
  async save() {
    this.saves += 1;
    return this;
  },
  ...over,
});

/**
 * Stub every collection and grant writer the service can reach, recording each
 * call so a MISSING one is as visible as a wrong one. Returns the log and the
 * restore function; every test restores in a `finally`.
 */
const stubAll = ({ profile = null, boards = [], board = null } = {}) => {
  const originals = {
    findOne: ExecutiveView.findOne,
    create: ExecutiveView.create,
    findOneAndDelete: ExecutiveView.findOneAndDelete,
    boardFind: Board.find,
    boardFindOne: Board.findOne,
    grant: boardGrants.grant,
    revoke: boardGrants.revoke,
  };
  const calls = {
    findOne: [],
    create: [],
    deletes: [],
    boardFind: [],
    boardFindOne: [],
    grants: [],
    revokes: [],
  };

  // One stub answers both call shapes: `await ExecutiveView.findOne(...)` (the
  // mutators, which need a document to save) and `.lean()` (the reader, which
  // must never hand a savable document to a caller that drops entries off it).
  let current = profile;
  ExecutiveView.findOne = (filter) => {
    calls.findOne.push(filter);
    const doc = current;
    return {
      lean: async () => doc,
      then: (res, rej) => Promise.resolve(doc).then(res, rej),
    };
  };
  ExecutiveView.create = async (fields) => {
    calls.create.push(fields);
    current = makeDoc(fields);
    return current;
  };
  ExecutiveView.findOneAndDelete = async (filter) => {
    calls.deletes.push(filter);
    const doc = current;
    current = null;
    return doc;
  };
  Board.find = async (filter) => {
    calls.boardFind.push(filter);
    return boards;
  };
  Board.findOne = async (filter) => {
    calls.boardFindOne.push(filter);
    return board;
  };
  boardGrants.grant = async (args) => {
    calls.grants.push(args);
    return { board: args.board, existed: false };
  };
  boardGrants.revoke = async (args) => {
    calls.revokes.push(args);
    return { board: args.board, existed: true };
  };

  const restore = () => {
    ExecutiveView.findOne = originals.findOne;
    ExecutiveView.create = originals.create;
    ExecutiveView.findOneAndDelete = originals.findOneAndDelete;
    Board.find = originals.boardFind;
    Board.findOne = originals.boardFindOne;
    boardGrants.grant = originals.grant;
    boardGrants.revoke = originals.revoke;
  };

  return { calls, restore, doc: () => current };
};

// ---------------------------------------------------------------------------
// resolveForViewer — invariant 4, both halves
// ---------------------------------------------------------------------------

test('a board the viewer can no longer read moves into skipped, it does not vanish and it does not throw', async () => {
  const org = makeOrg();
  const { calls, restore } = stubAll({
    profile: leanProfile([entry(BOARD_OPEN), entry(BOARD_CLOSED, { order: 1 })]),
    boards: [openBoard(), closedBoard()],
  });
  try {
    const { profile, skipped } = await resolveForViewer(org, EXEC);

    assert.equal(profile.boards.length, 1, 'only the reachable board survives');
    assert.equal(String(profile.boards[0].board), BOARD_OPEN);

    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].board, BOARD_CLOSED);
    // The configurator renders this name; without it the flag reads "you have
    // lost access to 6a466b99…".
    assert.equal(skipped[0].name, 'Ads 2026');
    assert.equal(skipped[0].reason, SKIP_REASONS.NO_ACCESS);

    // ONE query for the board documents, not one per entry. A profile is read
    // on every sign-in and every home compose.
    assert.equal(calls.boardFind.length, 1);
    assert.deepEqual(calls.boardFind[0]._id.$in.sort(), [BOARD_OPEN, BOARD_CLOSED].sort());
    // Scoped to the workspace: an id from another org must not be resolved
    // against THIS org's roles and grants.
    assert.equal(calls.boardFind[0].organisation, ORG);
  } finally {
    restore();
  }
});

test('a board id that no longer resolves to a document is skipped, not crashed on', async () => {
  const org = makeOrg();
  const { restore } = stubAll({
    // The board was deleted outright; only the profile entry is left.
    profile: leanProfile([entry(BOARD_GONE, { label: 'Old ads board' })]),
    boards: [],
  });
  try {
    const { profile, skipped } = await resolveForViewer(org, EXEC);

    assert.equal(profile.boards.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].board, BOARD_GONE);
    assert.equal(skipped[0].reason, SKIP_REASONS.DELETED);
    // The label is the only trace of a board nobody can look up any more.
    assert.equal(skipped[0].name, 'Old ads board');
  } finally {
    restore();
  }
});

test('no profile is an answer, not an error', async () => {
  const { restore } = stubAll({ profile: null });
  try {
    const resolved = await resolveForViewer(makeOrg(), EXEC);
    assert.equal(resolved.profile, null);
    assert.deepEqual(resolved.skipped, []);
    // `isExecutive` on the client is `profile !== null`, so this is the shape
    // every non-executive in the workspace gets on every sign-in.
    assert.equal(await getForUser(ORG, EXEC), null);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// validateShape — what may be stored at all
// ---------------------------------------------------------------------------

test('validateShape rejects an unknown section type', () => {
  // The property under test is "a type with no handler must not be storable",
  // and it is deliberately asserted with a name that is not a section type and
  // never will be. An EARLIER version of this test used `reportWidget` as the
  // example, because at the time it was the one still to be built — and it
  // started failing the day that type shipped. A test whose fixture is a real
  // feature's name has a expiry date nobody wrote down; one whose fixture is
  // nonsense does not.
  const bad = validateShape({ home: [{ type: 'notASectionType' }] });
  assert.ok(bad.error, 'a type with no handler must not be storable');
  assert.equal(bad.value, undefined);
  assert.ok(!SECTION_TYPES.includes('notASectionType'));
  // And the positive half, so this cannot pass by rejecting everything: two
  // real types, one from the original set and one added later, both store.
  assert.ok(validateShape({ home: [{ type: 'goalScores' }] }).value);
  assert.ok(validateShape({ home: [{ type: 'reportWidget' }] }).value);
});

test('validateShape rejects an unknown nav key', () => {
  const bad = validateShape({ nav: { boards: true, dashbaord: false } });
  assert.ok(bad.error);
  // Dropping it instead would answer "saved" to a client that believes it just
  // turned something off.
  assert.match(bad.error, /dashbaord/);
});

test('validateShape rejects a board entry that is not an ObjectId', () => {
  assert.ok(validateShape({ boards: [{ board: 'the seo board' }] }).error);
  assert.ok(validateShape({ boards: [{ label: 'SEO' }] }).error);
  assert.ok(validateShape({ boards: [{ board: BOARD_OPEN }] }).value);
});

test('validateShape rejects a defaultTab that is not a known tab', () => {
  assert.ok(validateShape({ boards: [{ board: BOARD_OPEN, defaultTab: 'Goals' }] }).error);
  assert.ok(validateShape({ boards: [{ board: BOARD_OPEN, defaultTab: 'reports' }] }).error);
  const ok = validateShape({ boards: [{ board: BOARD_OPEN, defaultTab: 'goals' }] });
  assert.equal(ok.value.boards[0].defaultTab, 'goals');
  // Absent, null and '' are all "the board page's own default".
  assert.equal(validateShape({ boards: [{ board: BOARD_OPEN }] }).value.boards[0].defaultTab, null);
});

test('a tab allowlist that omits "board" is refused, and an empty one is refused separately', () => {
  const noBoard = validateShape({ boards: [{ board: BOARD_OPEN, tabs: ['goals', 'delivery'] }] });
  assert.ok(noBoard.error, 'a board with no board tab is unreachable');
  assert.match(noBoard.error, /board/);

  const empty = validateShape({ boards: [{ board: BOARD_OPEN, tabs: [] }] });
  assert.ok(empty.error, 'an empty allowlist is "no tabs", which strands the board');

  const unknown = validateShape({ boards: [{ board: BOARD_OPEN, tabs: ['board', 'roadmap'] }] });
  assert.ok(unknown.error);
});

test('tabs: null means every tab, and is a different statement from tabs: []', () => {
  const nulled = validateShape({ boards: [{ board: BOARD_OPEN, tabs: null }] });
  assert.equal(nulled.value.boards[0].tabs, null, 'null survives as null');

  const listed = validateShape({ boards: [{ board: BOARD_OPEN, tabs: ['board', 'goals'] }] });
  assert.deepEqual(listed.value.boards[0].tabs, ['board', 'goals']);

  // The pair is the whole reason the field defaults to null rather than [].
  assert.ok(validateShape({ boards: [{ board: BOARD_OPEN, tabs: [] }] }).error);
});

test('every missing nav key defaults to true, and values are coerced', () => {
  // `{ nav: {} }`, not `{}`: sending the nav object and leaving a switch out of
  // it is "that switch is on", while leaving NAV ITSELF out is "this save is not
  // about the rail" and writes nothing — the two are tested apart, below.
  const all = validateShape({ nav: {} }).value.nav;
  for (const key of ExecutiveView.NAV_KEYS) {
    assert.equal(all[key], true, `${key} defaults on`);
  }

  const some = validateShape({ nav: { chat: false, analytics: 'false', members: 0, myWork: 1 } }).value.nav;
  assert.equal(some.chat, false);
  // `Boolean('false')` is true; a rail entry that reappeared because a client
  // stringified a checkbox is a bug report nobody can reproduce.
  assert.equal(some.analytics, false, 'the string "false" is false');
  assert.equal(some.members, false);
  assert.equal(some.myWork, true);
  assert.equal(some.boards, true, 'untouched switches stay on');
  assert.equal(Object.keys(some).length, ExecutiveView.NAV_KEYS.length);
});

test('validateShape never throws, and a null body is a legal empty shape', () => {
  for (const body of [null, undefined, 0, '', NaN]) {
    const result = validateShape(body);
    assert.ok(result.value || result.error, 'always one or the other, never a throw');
  }
  const empty = validateShape(null).value;
  assert.deepEqual(empty.boards, []);
  assert.deepEqual(empty.home, []);
  assert.equal(empty.nav.boards, true);

  assert.ok(validateShape({ boards: 'nope' }).error);
  assert.ok(validateShape({ home: { type: 'note' } }).error);
  assert.ok(validateShape([]).error);
});

test('a shape speaks only about the keys it carries, and null is still an explicit empty', () => {
  // The three parts are edited from three different screens (a drag on My
  // Boards, the home section editor, a rail switch in Settings). A body about
  // one of them must not be a statement about the other two.
  const partial = validateShape({ home: [{ type: 'note' }] }).value;
  assert.deepEqual(Object.keys(partial), ['home']);
  assert.equal(partial.boards, undefined, 'an omitted key never comes back');
  assert.equal(partial.nav, undefined);

  // `{}` is a save about nothing at all, not a save of nothing.
  assert.deepEqual(validateShape({}).value, {});

  // An explicit null IS a statement — JSON has no `undefined`, so a client that
  // means "clear this" has to be able to say it.
  const cleared = validateShape({ boards: null, nav: null }).value;
  assert.deepEqual(cleared.boards, []);
  assert.equal(cleared.nav.chat, true, 'nav: null is the eight defaults');
  assert.equal(cleared.home, undefined);

  // The null BODY keeps its own meaning: the whole empty shape, spelled out.
  // `declare` asks for exactly that and stores all three parts.
  assert.deepEqual(Object.keys(validateShape(null).value).sort(), [
    'boards',
    'home',
    'nav',
  ]);
});

test('section config is normalised per type and unknown keys are dropped', () => {
  const { value } = validateShape({
    home: [
      {
        type: 'goalScores',
        width: 'half',
        config: {
          board: BOARD_OPEN,
          month: 'not-a-month',
          groups: [GROUP, 'junk', GROUP],
          secret: 'dropped',
        },
      },
      { type: 'workspaceNumbers', config: { range: '90d' } },
      { type: 'myWork', config: { due: 'nonsense', limit: 9999 } },
    ],
  });

  const goals = value.home[0];
  assert.equal(goals.width, 'half');
  assert.equal(goals.config.board, BOARD_OPEN);
  // A bad month becomes null — "the board's current month" — rather than
  // refusing the save of the eight sections that were fine.
  assert.equal(goals.config.month, null);
  assert.deepEqual(goals.config.groups, [GROUP], 'deduplicated, junk removed');
  assert.equal(goals.config.secret, undefined, 'unknown keys never reach the blob');

  assert.equal(value.home[1].config.range, '90d');
  assert.equal(value.home[2].config.due, 'all');
  assert.equal(value.home[2].config.limit, 50, 'clamped to the cap');

  assert.ok(validateShape({ home: [{ type: 'note', width: 'third' }] }).error);
});

test('the known tab list is the client registry, in order', () => {
  // Mirrors VIEW_TABS in client/src/pages/BoardDetailPage.jsx. If that registry
  // gains a tab and this list does not, the preset for it cannot be saved.
  assert.deepEqual(BOARD_TABS, [
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
  ]);
});

// ---------------------------------------------------------------------------
// upsert — invariant 2: shape only, on both planes
// ---------------------------------------------------------------------------

test('the self path cannot add a board it cannot read, and says which it dropped', async () => {
  const org = makeOrg();
  const { calls, restore } = stubAll({
    profile: makeDoc(),
    boards: [openBoard(), closedBoard()],
  });
  try {
    const shape = validateShape({
      boards: [{ board: BOARD_OPEN }, { board: BOARD_CLOSED }],
    }).value;

    const result = await upsert(org, EXEC, shape, {
      actor: EXEC,
      allowReachChange: false,
    });

    assert.equal(result.profile.boards.length, 1);
    assert.equal(String(result.profile.boards[0].board), BOARD_OPEN);
    // Reported, not swallowed: the person sees a list one board shorter and
    // only this array can tell them why.
    assert.deepEqual(result.dropped, [BOARD_CLOSED]);
    // And it certainly did not fix the problem by granting the board.
    assert.equal(calls.grants.length, 0, 'the self path never writes a grant');
  } finally {
    restore();
  }
});

test('a self save keeps an entry the person was never shown, and still removes one they were', async () => {
  const org = makeOrg();
  const profile = makeDoc({
    boards: [
      entry(BOARD_OPEN, { order: 0 }),
      entry(BOARD_CLOSED, { order: 1, label: 'Ads' }),
      entry(BOARD_SECOND, { order: 2 }),
    ],
  });
  const { calls, restore } = stubAll({
    profile,
    boards: [openBoard(), closedBoard(), secondBoard()],
  });
  try {
    // THE regression this test exists for. `resolveForViewer` handed this
    // person their list WITHOUT the closed board (invariant 4), My Boards
    // rebuilt `boards[]` out of exactly what it was given, and they dropped one
    // tile they could see. If the save takes that array at face value, the
    // closed board is deleted from the document by somebody who never saw it —
    // and nothing in the product can tell them, or the admin, that it was ever
    // there.
    const shape = validateShape({ boards: [{ board: BOARD_OPEN, order: 0 }] }).value;

    const result = await upsert(org, EXEC, shape, {
      actor: EXEC,
      allowReachChange: false,
    });

    assert.deepEqual(
      result.profile.boards.map((b) => String(b.board)),
      [BOARD_OPEN, BOARD_CLOSED],
      'the unreadable entry survives; the readable one they left out does not'
    );
    // Kept verbatim — label included, since that is what the configurator will
    // show beside "no longer has access".
    assert.equal(result.profile.boards[1].label, 'Ads');
    // And re-densified around it, so the next append can still trust `length`.
    assert.deepEqual(result.profile.boards.map((b) => b.order), [0, 1]);
    // Nothing was refused: reporting a drop for an entry that is still there
    // would put a message on screen about something that did not happen.
    assert.deepEqual(result.dropped, []);
    assert.equal(calls.grants.length, 0, 'and still no grant, either way');
  } finally {
    restore();
  }
});

test('a hidden entry is not editable on the self plane either', async () => {
  const org = makeOrg();
  const profile = makeDoc({
    boards: [entry(BOARD_CLOSED, { label: 'Ads', order: 0 })],
  });
  const { restore } = stubAll({ profile, boards: [closedBoard()] });
  try {
    // A client that round-trips the skipped entry (the configurator does) must
    // not be able to rewrite it through this plane: the person could not see
    // what they were changing, so the stored entry wins.
    const shape = validateShape({
      boards: [{ board: BOARD_CLOSED, label: 'Renamed', defaultTab: 'goals' }],
    }).value;

    const result = await upsert(org, EXEC, shape, {
      actor: EXEC,
      allowReachChange: false,
    });

    assert.equal(result.profile.boards.length, 1);
    assert.equal(result.profile.boards[0].label, 'Ads');
    assert.equal(result.profile.boards[0].defaultTab, null);
    assert.deepEqual(result.dropped, []);
  } finally {
    restore();
  }
});

test('a save about one part leaves the other two exactly as they were', async () => {
  const org = makeOrg();
  const profile = makeDoc({
    boards: [entry(BOARD_OPEN)],
    home: [{ type: 'note', order: 0, width: 'full', config: { title: 'Q4', text: '' } }],
    nav: { chat: false },
  });
  const { calls, restore } = stubAll({ profile, boards: [openBoard()] });
  try {
    // Phase 2's section editor saves `{ home }` and nothing else — the client
    // store's own signature says it may. If an absent key meant "empty", that
    // one call would delete the board list an admin composed and switch the
    // rail back on behind the person's back, and the history row would say
    // "changed: home".
    const shape = validateShape({ home: [{ type: 'myWork' }] }).value;

    const result = await upsert(org, EXEC, shape, {
      actor: EXEC,
      allowReachChange: false,
    });

    assert.deepEqual(result.profile.boards.map((b) => String(b.board)), [BOARD_OPEN]);
    assert.equal(result.profile.nav.chat, false, 'a switch they turned off stays off');
    assert.deepEqual(result.profile.home.map((s) => s.type), ['myWork']);
    // A save that is not about boards does not even need to read them.
    assert.equal(calls.boardFind.length, 0);
    assert.equal(profile.saves, 1);
  } finally {
    restore();
  }
});

test('re-attached entries cannot push the list past the cap and into a failed save', async () => {
  const org = makeOrg();
  // A full list of readable boards, plus one stored entry they can no longer
  // see. `validateShape` capped what was SENT and knew nothing about the one
  // being carried, so without a second check this reaches `save()` and comes
  // back as a mongoose ValidationError — a 500 on an ordinary drag.
  const many = Array.from({ length: ExecutiveView.MAX_BOARDS }, (_, i) =>
    makeBoard({
      _id: `6a466b99ea3ab35ff137${i.toString(16).padStart(4, '0')}`,
      memberAccess: [{ user: EXEC, level: 'edit', canManage: true }],
    })
  );
  const profile = makeDoc({ boards: [entry(BOARD_CLOSED)] });
  const { restore } = stubAll({ profile, boards: [...many, closedBoard()] });
  try {
    const shape = validateShape({
      boards: many.map((b) => ({ board: String(b._id) })),
    }).value;

    const result = await upsert(org, EXEC, shape, {
      actor: EXEC,
      allowReachChange: false,
    });

    assert.equal(result.status, 400, 'refused, and recoverable by removing one');
    assert.match(result.error, /at most/);
    assert.equal(profile.saves, 0, 'and nothing was written');
  } finally {
    restore();
  }
});

test('the admin path keeps the entry and still writes no grant', async () => {
  const org = makeOrg();
  const { calls, restore } = stubAll({ profile: makeDoc(), boards: [] });
  try {
    const shape = validateShape({ boards: [{ board: BOARD_CLOSED }] }).value;

    const result = await upsert(org, OWNER, shape, {
      actor: OWNER,
      allowReachChange: true,
    });

    // An admin may list a board the subject cannot read yet — the entry is a
    // description, and `resolveForViewer` will flag it until a grant exists.
    assert.equal(result.profile.boards.length, 1);
    assert.deepEqual(result.dropped, []);
    // Reach moves through addBoard, which authorises the actor board by board.
    // A PUT that could grant would make the profile a second permission system.
    assert.equal(calls.grants.length, 0, 'a PUT is never a grant');
    assert.equal(calls.boardFind.length, 0, 'and it does not even need to look');
  } finally {
    restore();
  }
});

test('order is densified on save, on both arrays', async () => {
  const org = makeOrg();
  const { restore } = stubAll({ profile: makeDoc(), boards: [] });
  try {
    const shape = validateShape({
      boards: [
        { board: BOARD_CLOSED, order: 9 },
        { board: BOARD_OPEN, order: 4 },
      ],
      home: [
        { type: 'note', order: 7 },
        { type: 'myWork', order: 7 },
        { type: 'boardTiles', order: 1.5 },
      ],
    }).value;

    const { profile } = await upsert(org, EXEC, shape, {
      actor: OWNER,
      allowReachChange: true,
    });

    // Sorted by the order that was sent, then renumbered 0..n-1, so the client
    // never has to and every later append can trust `length`.
    assert.deepEqual(
      profile.boards.map((b) => [String(b.board), b.order]),
      [
        [BOARD_OPEN, 0],
        [BOARD_CLOSED, 1],
      ]
    );
    // A tie keeps the order it was sent in rather than swapping between saves.
    assert.deepEqual(
      profile.home.map((s) => [s.type, s.order]),
      [
        ['boardTiles', 0],
        ['note', 1],
        ['myWork', 2],
      ]
    );
    assert.equal(profile.saves, 1);
    assert.equal(String(profile.updatedBy), OWNER);
  } finally {
    restore();
  }
});

test('a first save creates the document and stamps who declared them', async () => {
  const org = makeOrg();
  const { calls, restore } = stubAll({ profile: null, boards: [] });
  try {
    const result = await upsert(org, EXEC, validateShape(null).value, {
      actor: OWNER,
      allowReachChange: true,
    });

    assert.equal(calls.create.length, 1);
    assert.equal(String(calls.create[0].organisation), ORG);
    assert.equal(String(calls.create[0].user), EXEC);
    assert.equal(result.created, true);
    assert.equal(String(result.profile.createdBy), OWNER);
    assert.equal(String(result.profile.updatedBy), OWNER);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// addBoard — the check that stops this route being a way in
// ---------------------------------------------------------------------------

test('addBoard refuses when the actor cannot manage access on that board, and grants nothing', async () => {
  const org = makeOrg();
  // A private board the actor has no standing on at all.
  const board = makeBoard({
    _id: BOARD_CLOSED,
    visibility: 'private',
    createdBy: OWNER,
    memberAccess: [],
  });
  const { calls, restore } = stubAll({ profile: makeDoc(), board });
  try {
    const result = await addBoard(org, EXEC, BOARD_CLOSED, {
      actor: MEMBER,
      level: 'edit',
      canManage: true,
    });

    assert.equal(result.status, 403);
    assert.ok(result.error);
    // THE assertion. An Executive holds `org.manage_executive_views`; without
    // this check that capability would be a way to reach any board in the
    // workspace by adding it to a profile and taking the grant that follows.
    assert.equal(calls.grants.length, 0, 'no grant may be written on a refusal');
    assert.equal(calls.create.length, 0, 'and no profile is touched either');
  } finally {
    restore();
  }
});

test('addBoard twice is idempotent: one entry, and the grant is re-applied', async () => {
  const org = makeOrg();
  const board = openBoard();
  const { calls, restore, doc } = stubAll({ profile: null, board });
  try {
    const first = await addBoard(org, EXEC, BOARD_OPEN, { actor: OWNER });
    assert.equal(first.added, true);
    assert.equal(first.level, 'edit');
    assert.equal(doc().boards.length, 1);

    const second = await addBoard(org, EXEC, BOARD_OPEN, {
      actor: OWNER,
      level: 'view',
    });

    assert.equal(second.added, false, 'the entry is not duplicated');
    assert.equal(doc().boards.length, 1);
    // The second call is how the configurator CHANGES a level, so the grant is
    // written both times even though the entry was not.
    assert.equal(calls.grants.length, 2);
    assert.equal(calls.grants[0].level, 'edit');
    assert.equal(calls.grants[1].level, 'view');
    assert.equal(String(calls.grants[1].targetUserId), EXEC);
    // Scoped to the workspace, like every other board lookup here.
    assert.equal(calls.boardFindOne[0].organisation, ORG);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// removeBoard — a screen change and a reach change, separable on purpose
// ---------------------------------------------------------------------------

test('removeBoard takes the entry and, when asked and allowed, the grant too', async () => {
  const org = makeOrg();
  const profile = makeDoc({
    boards: [entry(BOARD_OPEN), entry(BOARD_CLOSED, { order: 1 })],
  });
  const { calls, restore } = stubAll({ profile, board: openBoard() });
  try {
    const result = await removeBoard(org, EXEC, BOARD_OPEN, {
      revoke: true,
      actor: OWNER,
    });

    assert.equal(result.removed, true);
    assert.equal(result.revoked, true);
    assert.equal(result.grantLeft, false);
    assert.equal(result.profile.boards.length, 1);
    // The hole in the order sequence closes, so the next addBoard can still
    // trust `length` as the next free slot.
    assert.deepEqual(result.profile.boards.map((b) => b.order), [0]);
    // The revoke cleanup (follows, stale notifications) is boardGrants' job and
    // is never reimplemented here.
    assert.equal(calls.revokes.length, 1);
    assert.equal(String(calls.revokes[0].targetUserId), EXEC);
  } finally {
    restore();
  }
});

test('an actor who cannot share the board still gets the entry removed, and is told the grant stayed', async () => {
  const org = makeOrg();
  const board = makeBoard({
    _id: BOARD_CLOSED,
    visibility: 'private',
    createdBy: OWNER,
    memberAccess: [],
  });
  const profile = makeDoc({ boards: [entry(BOARD_CLOSED)] });
  const { calls, restore } = stubAll({ profile, board });
  try {
    const result = await removeBoard(org, EXEC, BOARD_CLOSED, {
      revoke: true,
      actor: MEMBER,
    });

    // Tidying a list needs no authority over the board; revoking does. Failing
    // the whole call would leave the board sitting there flagged, which teaches
    // people to ignore the flag.
    assert.equal(result.removed, true);
    assert.equal(result.profile.boards.length, 0);
    assert.equal(result.revoked, false);
    assert.equal(result.grantLeft, true);
    assert.equal(result.reason, KEEP_REASONS.CANNOT_MANAGE_ACCESS);
    assert.equal(calls.revokes.length, 0);
  } finally {
    restore();
  }
});

test('removing a board whose document is gone reports it instead of failing', async () => {
  const org = makeOrg();
  const profile = makeDoc({ boards: [entry(BOARD_GONE)] });
  const { calls, restore } = stubAll({ profile, board: null });
  try {
    const result = await removeBoard(org, EXEC, BOARD_GONE, {
      revoke: true,
      actor: OWNER,
    });
    assert.equal(result.removed, true);
    assert.equal(result.revoked, false);
    // The grant lived on the board and went with it — there is nothing left to
    // revoke, and that is not an error.
    assert.equal(result.grantLeft, false);
    assert.equal(result.reason, KEEP_REASONS.BOARD_MISSING);
    assert.equal(calls.revokes.length, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// remove — invariant 3, and what it deliberately leaves alone
// ---------------------------------------------------------------------------

test('deleting the profile touches neither the grants nor the role', async () => {
  const org = makeOrg();
  const profile = makeDoc({ boards: [entry(BOARD_OPEN)] });
  const { calls, restore } = stubAll({ profile, board: openBoard() });
  try {
    const result = await remove(org, EXEC, { actor: OWNER });

    assert.equal(result.removed, true);
    // Returned so the controller can name the person in the activity row it
    // writes — this service writes none.
    assert.equal(String(result.profile.user), EXEC);
    assert.equal(calls.deletes.length, 1);
    assert.equal(String(calls.deletes[0].organisation), ORG);
    // "Stop curating this person's screen" is not "take their boards away", and
    // an admin who meant the first and got the second has no way back.
    assert.equal(calls.revokes.length, 0);
    assert.equal(calls.grants.length, 0);

    const second = await remove(org, EXEC, { actor: OWNER });
    assert.equal(second.removed, false, 'deleting twice is not an error');
  } finally {
    restore();
  }
});

test('addBoard refuses an access level that is not on the ladder', async () => {
  const org = makeOrg();
  const { calls, restore } = stubAll({ profile: makeDoc(), board: openBoard() });
  try {
    const result = await addBoard(org, EXEC, BOARD_OPEN, {
      actor: OWNER,
      level: 'full',
    });
    assert.equal(result.status, 400);
    assert.equal(calls.grants.length, 0);
    // Quietly granting `edit` instead of whatever 'full' was meant to be is the
    // wrong way to discover a broken dropdown.
  } finally {
    restore();
  }
});

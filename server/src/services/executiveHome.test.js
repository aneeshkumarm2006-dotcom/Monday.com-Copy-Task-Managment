const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * executiveHome.test.js — the home composer, exercised without a database.
 *
 * Run from the server directory:
 *     node --test src/services/executiveHome.test.js
 *
 * WHAT THIS FILE IS PINNING. The composer is the one place in the feature where
 * a mistake is both invisible and serious:
 *
 *   - INVARIANT 1, "every board passes `resolveAccess(...).canRead` before any
 *     scorer runs". When this regresses nothing looks wrong. The page renders,
 *     the numbers are real, and they are a private board's client names, goal
 *     targets and spend on the home page of somebody who was never given that
 *     board. So the test for it does not merely assert the state string — it
 *     asserts the QUERIES WERE NEVER ISSUED. A section that says "unavailable"
 *     after reading the board has already leaked it into a log and a cache.
 *   - "one broken section must not blank the page". When this regresses, one
 *     unusual tracker on one board takes down the front door of the app for the
 *     person it belongs to, and the connection between the two is a stack trace
 *     nobody is looking at.
 *   - "adding a section type is a handler, a renderer and a config row". The
 *     registry assertion is what makes that sentence true rather than aspirational.
 *
 * HOW IT AVOIDS MONGO. `org`, `board` and the profile are plain objects shaped
 * like the documents, exactly as `executiveView.test.js` and
 * `utils/permissions.test.js` do it. `resolveAccess` is deliberately NOT stubbed:
 * it is pure, it runs against the real seeded role presets, and a stub would make
 * every reach assertion below a test of the stub rather than of the permission
 * contract.
 *
 * The MODELS are stubbed on the module objects, and so are the two services that
 * query — `deliveryReport` and `analyticsReport` — which is why `executiveHome.js`
 * reaches those two through their module object instead of destructuring them at
 * require time. The pure scorers (`goalTypes`, `adsBudgetPacing`) are left alone
 * and actually run.
 *
 * `Board.find` APPLIES ITS FILTER rather than returning the fixture list, because
 * one of the rules under test is a property of the filter: a board id from
 * another workspace must not resolve. A stub that ignored `organisation` would
 * pass that test while the query that stops it was being deleted.
 */

const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');
const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Goal = require('../models/Goal');
const Tracker = require('../models/Tracker');
const AdsBudget = require('../models/AdsBudget');
const Task = require('../models/Task');
const User = require('../models/User');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');
const BoardConnector = require('../models/BoardConnector');
const deliveryReport = require('./deliveryReport');
const analyticsReport = require('./analyticsReport');

const {
  compose,
  SECTION_TYPES,
  CONFIG_NORMALISERS,
  HANDLERS,
  MESSAGES,
  REPORT_WIDGET_TYPES,
} = require('./executiveHome');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Real 24-hex ids: `mongoose.Types.ObjectId.isValid` guards every id this file
// hands in, so a readable placeholder like 'board1' would be discarded before
// the rule under test ever ran.
const ORG = '6a466b99ea3ab35ff1378e10';
const OTHER_ORG = '6a466b99ea3ab35ff1378e11';
const OWNER = '6a466b99ea3ab35ff1378e01';
const EXEC = '6a466b99ea3ab35ff1378e02';
/** Somebody on the plain `member` preset, which does not hold `analytics.view`. */
const MEMBER = '6a466b99ea3ab35ff1378e03';
/**
 * Somebody on the `guest` preset, which holds none of `goal.view`,
 * `tracker.view` or `adsBudget.view` — and who is nonetheless granted a board
 * outright below. They are the shape of the second half of the gate: reach and
 * capability are different questions, and this person answers yes to one of them.
 *
 * Not a hypothetical. The spec allows an executive's ROLE to be changed without
 * their profile being deleted ("they remain two records"), and the permissions
 * matrix can untick any of these three on any role at any time.
 */
const GUEST = '6a466b99ea3ab35ff1378e04';

const BOARD_OPEN = '6a466b99ea3ab35ff1378b01';
const BOARD_CLOSED = '6a466b99ea3ab35ff1378b02';
const BOARD_GONE = '6a466b99ea3ab35ff1378b03';
const BOARD_SECOND = '6a466b99ea3ab35ff1378b04';
/** Same grant, same person, different workspace. Only the query scope stops it. */
const BOARD_FOREIGN = '6a466b99ea3ab35ff1378b05';

const GROUP_A = '6a466b99ea3ab35ff1378c01';
const GROUP_B = '6a466b99ea3ab35ff1378c02';

/** The connector project one group's report is built from. */
const PROJECT = '6a466b99ea3ab35ff1378a01';

/**
 * The two markets a rank tracker can hold readings for at once.
 *
 * Named so the ALPHABETICAL one is not the newest one below: the composer picks
 * `variants.sort()[0]` to agree with the Report tab, and a fixture where the two
 * rules pick the same row could not tell them apart.
 */
const MARKET_GB = 'gb';
const MARKET_US = 'us';

/** Where a report widget's readings come from, as `publicProject` shapes them. */
const dfsProject = (over = {}) => ({
  _id: PROJECT,
  name: 'acme.com',
  domain: 'acme.com',
  // The provider that declares dashboard screens, which is where the Report
  // screen lives. `connectors.getConnector` is asked, not a name comparison.
  provider: 'dataforseo',
  ...over,
});

/**
 * One stored reading. `data` is the normalised payload WHOLE — `depth` is there
 * because `aiRows.comparability` reads it to refuse a delta between two rank
 * readings bought to different depths, and a payload narrowed to the fields a
 * widget draws would drop it and turn that refusal into a printed number.
 */
const snap = (kind, variant, periodKey, data, status = 'ok') => ({
  _id: `snap-${kind}-${variant}-${periodKey}`,
  kind,
  variant,
  periodKey,
  collectedAt: new Date(`${periodKey}T06:00:00Z`),
  status,
  data,
  fetchedAt: new Date(`${periodKey}T06:05:00Z`),
});

/**
 * The instant every test composes against, chosen so the three timezones below
 * disagree about which MONTH it is: 13:00 UTC on the last day of August is
 * already 1 September in Auckland and still 31 August in Los Angeles. A test
 * that used "now" could not tell the board's month from the server's.
 */
const NOW = new Date('2026-08-31T13:00:00Z');

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
  members: [OWNER, EXEC, MEMBER, GUEST],
  roles,
  memberRoles: [
    { user: EXEC, role: roleId('executive') },
    { user: MEMBER, role: roleId('member') },
    { user: GUEST, role: roleId('guest') },
  ],
  // The workspace holiday calendar rides on the org document the caller already
  // loaded; the delivery handler must pass it through rather than re-reading it.
  holidays: [],
  ...overrides,
});

const makeBoard = (over = {}) => ({
  _id: BOARD_OPEN,
  name: 'SEO Tracker 2026',
  organisation: ORG,
  createdBy: OWNER,
  boardType: 'tracker',
  monthTimezone: 'UTC',
  visibility: 'public',
  publicDefaultLevel: 'contribute',
  memberAccess: [],
  statuses: [{ _id: 'status-done', key: 'done' }],
  // The add-on is ON by default here because that is the state the pacing tests
  // are about. `enabled: false` is its own test — rows survive the switch, so a
  // board with money in the collection and the tab switched off is a real state
  // the composer has to refuse rather than report.
  adsBudget: { enabled: true, currency: 'GBP' },
  ...over,
});

/** A grant is the whole of an Executive's reach: the preset drops view_public. */
const grantedToExec = [
  { user: EXEC, level: 'edit', canManage: true },
  // Same board, granted to the Guest as well. `canRead` will be true for them —
  // which is exactly why the capability half of the gate has to exist.
  { user: GUEST, level: 'view' },
];

/**
 * The Board collection, as the stub below queries it. `BOARD_GONE` is absent on
 * purpose — that is what "deleted out from under the profile" looks like.
 */
const BOARDS = [
  makeBoard({ _id: BOARD_OPEN, memberAccess: grantedToExec }),
  makeBoard({ _id: BOARD_CLOSED, name: 'Ads 2026', memberAccess: [] }),
  makeBoard({
    _id: BOARD_SECOND,
    name: 'Tech 2026',
    monthTimezone: 'Pacific/Auckland',
    memberAccess: grantedToExec,
  }),
  makeBoard({
    _id: BOARD_FOREIGN,
    name: 'Another workspace',
    organisation: OTHER_ORG,
    // Granted to the same person. If the batch query ever stops scoping on
    // `organisation`, this board resolves and is read against THIS org's roles.
    memberAccess: grantedToExec,
  }),
];

const section = (type, config = {}, over = {}) => ({
  _id: `6a466b99ea3ab35ff1378f0${over.n || 1}`,
  type,
  order: over.order === undefined ? 0 : over.order,
  width: over.width || 'full',
  config,
});

const profileWith = (home, boards = []) => ({
  _id: '6a466b99ea3ab35ff1378d01',
  organisation: ORG,
  user: EXEC,
  boards,
  home,
  nav: {},
});

const boardEntry = (board, over = {}) => ({
  board,
  label: '',
  order: 0,
  defaultTab: null,
  tabs: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Stubbing
// ---------------------------------------------------------------------------

/**
 * A mongoose query that answers to every chain the composer uses and resolves to
 * `rows` whether it is awaited or `.lean()`ed. `record` collects the arguments
 * that matter to an assertion — `sort` and `limit`, because those two are what
 * the My Work section APPLIES rather than passes through, and between them they
 * decide WHICH rows survive the cut rather than merely how they are drawn.
 */
const query = (rows, record = {}) => {
  const q = {
    select: () => q,
    sort: (s) => {
      record.sort = s;
      return q;
    },
    populate: () => q,
    limit: (n) => {
      record.limit = n;
      return q;
    },
    lean: async () => rows,
    then: (res, rej) => Promise.resolve(rows).then(res, rej),
  };
  return q;
};

/**
 * Replace every collection and both querying services, recording each call so a
 * MISSING one is as visible as a wrong one — which is the whole shape of the
 * invariant-1 test. Returns the log and a restore function; every test restores
 * in a `finally`.
 */
const stubAll = (over = {}) => {
  const originals = {
    boardFind: Board.find,
    groupFind: TaskGroup.find,
    goalFind: Goal.find,
    trackerFind: Tracker.find,
    adsFind: AdsBudget.find,
    taskFind: Task.find,
    userFindById: User.findById,
    projectFind: ConnectorProject.find,
    snapshotFind: ConnectorSnapshot.find,
    linkFind: BoardConnector.find,
    planDelivery: deliveryReport.planDelivery,
    fetchDeliveryInputs: deliveryReport.fetchDeliveryInputs,
    evaluatePlans: deliveryReport.evaluatePlans,
    buildAnalytics: analyticsReport.buildAnalytics,
  };

  const calls = {
    boardFind: [],
    groupFind: [],
    goalFind: [],
    trackerFind: [],
    adsFind: [],
    taskFind: [],
    userFindById: [],
    projectFind: [],
    snapshotFind: [],
    linkFind: [],
    planDelivery: [],
    fetchDeliveryInputs: [],
    evaluatePlans: [],
    buildAnalytics: [],
    // One record per Task.find, in order. An array rather than a single object
    // because the "all" due bucket deliberately issues TWO queries and the whole
    // point of the second is that it carries a different sort and a smaller
    // limit — a shared record would remember only the last of them.
    taskQueries: [],
  };

  // The one stub that applies its filter: `organisation` scoping is a rule under
  // test, not plumbing.
  Board.find = (filter) => {
    calls.boardFind.push(filter);
    const ids = filter?._id?.$in ? filter._id.$in.map(String) : null;
    const org = filter?.organisation ? String(filter.organisation) : null;
    const rows = BOARDS.filter(
      (b) =>
        (!ids || ids.includes(String(b._id)))
        && (!org || String(b.organisation) === org)
    );
    return query(rows);
  };

  TaskGroup.find = (filter) => {
    calls.groupFind.push(filter);
    if (over.groupsThrow) throw over.groupsThrow;
    return query(over.groups || []);
  };
  Goal.find = (filter) => {
    calls.goalFind.push(filter);
    return query(over.goals || []);
  };
  Tracker.find = (filter) => {
    calls.trackerFind.push(filter);
    return query(over.trackers || []);
  };
  AdsBudget.find = (filter) => {
    calls.adsFind.push(filter);
    return query(over.adsRows || []);
  };
  Task.find = (filter) => {
    calls.taskFind.push(filter);
    const record = {};
    calls.taskQueries.push(record);
    // `{ dueDate: null }` is the undated top-up the "all" bucket asks for
    // second. Answering it from the same fixture as the dated query would hand
    // the composer the same rows twice and hide the bug this stub is here to
    // catch, so the two fixtures are separate.
    const rows = filter?.dueDate === null ? over.undatedTasks || [] : over.tasks || [];
    return query(rows, record);
  };
  User.findById = (id) => {
    calls.userFindById.push(String(id));
    return query(over.user === undefined ? { timezone: 'Europe/London' } : over.user);
  };

  /**
   * The three collections the `reportWidget` handler reads, and the ONLY three
   * it may. There is no connector client, no session and no credential in this
   * file: if that handler ever reached a provider it would have to go through
   * one of those, none of which is stubbed here, and the attempt would fail
   * loudly in a test process with no network and no database rather than quietly
   * spending money in production.
   */
  ConnectorProject.find = (filter) => {
    calls.projectFind.push(filter);
    return query(over.projects || []);
  };
  ConnectorSnapshot.find = (filter) => {
    calls.snapshotFind.push(filter);
    const record = {};
    return query(over.snapshots || [], record);
  };
  BoardConnector.find = (filter) => {
    calls.linkFind.push(filter);
    return query(over.links || []);
  };

  deliveryReport.planDelivery = (args) => {
    calls.planDelivery.push(args);
    return over.plan || { plans: [], scanFrom: null, scanTo: null, overCap: null };
  };
  deliveryReport.fetchDeliveryInputs = async (args) => {
    calls.fetchDeliveryInputs.push(args);
    return { tasks: [], updateRows: [], entriesByTracker: new Map() };
  };
  deliveryReport.evaluatePlans = (args) => {
    calls.evaluatePlans.push(args);
    return over.results || [];
  };
  analyticsReport.buildAnalytics = async (args) => {
    calls.buildAnalytics.push(args);
    return over.analytics || { summary: { totalTasks: 0 } };
  };

  const restore = () => {
    Board.find = originals.boardFind;
    TaskGroup.find = originals.groupFind;
    Goal.find = originals.goalFind;
    Tracker.find = originals.trackerFind;
    AdsBudget.find = originals.adsFind;
    Task.find = originals.taskFind;
    User.findById = originals.userFindById;
    ConnectorProject.find = originals.projectFind;
    ConnectorSnapshot.find = originals.snapshotFind;
    BoardConnector.find = originals.linkFind;
    deliveryReport.planDelivery = originals.planDelivery;
    deliveryReport.fetchDeliveryInputs = originals.fetchDeliveryInputs;
    deliveryReport.evaluatePlans = originals.evaluatePlans;
    analyticsReport.buildAnalytics = originals.buildAnalytics;
  };

  return { calls, restore };
};

/** Run something with `console.error` muted — the composer logs on purpose. */
const quietly = async (fn) => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = original;
  }
};

const composeFor = (org, userId, home, boards = []) =>
  compose(org, userId, { profile: profileWith(home, boards), now: NOW });

// ---------------------------------------------------------------------------
// Invariant 1 — reach is checked before anything runs
// ---------------------------------------------------------------------------

test('a board the viewer cannot read is unavailable, and the scorer never runs', async () => {
  const { calls, restore } = stubAll({ goals: [{ group: GROUP_A, type: 'number' }] });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('goalScores', { board: BOARD_CLOSED, month: '2026-08', groups: null }),
    ]);

    assert.equal(sections.length, 1);
    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.NO_ACCESS);
    assert.equal(sections[0].data, null, 'nothing about that board travels');

    // THE assertion. "Unavailable" after reading the board is still a read: the
    // rows were on the wire, in a log and in a cache. The gate has to come first.
    assert.equal(calls.groupFind.length, 0, 'no group query for an unreadable board');
    assert.equal(calls.goalFind.length, 0, 'no goal query for an unreadable board');
  } finally {
    restore();
  }
});

test('an unreadable board on one section does not stop the readable one beside it', async () => {
  const { calls, restore } = stubAll();
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('goalScores', { board: BOARD_CLOSED, month: '2026-08', groups: null }, { n: 1, order: 0 }),
      section('goalScores', { board: BOARD_OPEN, month: '2026-08', groups: null }, { n: 2, order: 1 }),
    ]);

    assert.equal(sections[0].state, 'unavailable');
    assert.notEqual(sections[1].state, 'unavailable');
    // Exactly one section was allowed to query, and it was the readable one.
    assert.equal(calls.goalFind.length, 1);
    assert.equal(String(calls.goalFind[0].board), BOARD_OPEN);
  } finally {
    restore();
  }
});

test('a board id that no longer resolves is unavailable, not an exception', async () => {
  const { calls, restore } = stubAll();
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('deliveryScores', { board: BOARD_GONE, month: '2026-08' }),
    ]);

    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.BOARD_GONE);
    assert.equal(calls.trackerFind.length, 0);
    assert.equal(calls.planDelivery.length, 0);
  } finally {
    restore();
  }
});

test('a board id from another workspace never resolves, however it was granted', async () => {
  const { calls, restore } = stubAll();
  try {
    // BOARD_FOREIGN carries a full-access grant for this very person. The only
    // thing standing between them and it is that the batch query is scoped to
    // the organisation the composer was called for.
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('adsBudgetPacing', { board: BOARD_FOREIGN, month: '2026-08' }),
    ]);

    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.BOARD_GONE);
    assert.equal(calls.adsFind.length, 0, 'no spend read for a board in another org');
    assert.equal(String(calls.boardFind[0].organisation), ORG);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The second half of the gate — the capability the board's own tab requires
// ---------------------------------------------------------------------------

/**
 * `canRead` says a board is theirs to open. It does not say the Goals tab, the
 * Delivery tab or the Ads Budget tab are theirs to read — each of those asks a
 * BOARD_SCOPED capability of its own, and a role is data that an owner edits in
 * the matrix long after a home page was composed. A composer that asked only the
 * first question would serve scored percentages, missed-period counts and spend
 * for tabs that answer 403 on the board itself.
 *
 * The table walks all FOUR so a fifth board-reading section type cannot be
 * added with a capability and no test, or without a capability at all. Each row
 * carries its own config because the fourth one is not about a month: a report
 * widget names a client and a widget, and passing a goal section's config to it
 * would test the wrong refusal.
 */
for (const [type, capability, message, config] of [
  ['goalScores', 'goal.view', 'NO_GOAL_CAP', { board: BOARD_OPEN, month: '2026-08', groups: null }],
  ['deliveryScores', 'tracker.view', 'NO_TRACKER_CAP', { board: BOARD_OPEN, month: '2026-08' }],
  ['adsBudgetPacing', 'adsBudget.view', 'NO_ADS_CAP', { board: BOARD_OPEN, month: '2026-08' }],
  [
    'reportWidget',
    'connector.view',
    'NO_CONNECTOR_CAP',
    { board: BOARD_OPEN, group: GROUP_A, widget: { type: 'number', title: 'Referring domains' } },
  ],
]) {
  test(`${type} is unavailable without ${capability}, and nothing is read`, async () => {
    const { calls, restore } = stubAll({
      goals: [{ group: GROUP_A, type: 'number' }],
      trackers: [{ _id: 'tr1', name: 'Weekly report', enabled: true }],
      adsRows: [{ _id: 'p1', group: GROUP_A, allocated: 5000, spent: 4000, lifecycle: 'active' }],
      groups: [{ _id: GROUP_A, name: 'Acme' }],
      projects: [dfsProject()],
      links: [{ provider: 'dataforseo', enabled: true }],
      snapshots: [snap('positions', MARKET_GB, '2026-08-24', { totals: { top10: 12 } })],
    });
    try {
      // The Guest CAN read this board — it is granted to them outright. What
      // their role does not hold is the capability behind this section's data.
      const { sections } = await composeFor(makeOrg(), GUEST, [section(type, config)]);

      assert.equal(sections[0].state, 'unavailable');
      assert.equal(sections[0].error, MESSAGES[message]);
      assert.equal(sections[0].data, null, 'no numbers travel with the refusal');

      // Refused BEFORE the query, for the same reason invariant 1 is: a refusal
      // issued after the read has already put the rows on the wire and in a log.
      assert.equal(calls.goalFind.length, 0);
      assert.equal(calls.groupFind.length, 0);
      assert.equal(calls.trackerFind.length, 0);
      assert.equal(calls.adsFind.length, 0);
      assert.equal(calls.planDelivery.length, 0);
      assert.equal(calls.projectFind.length, 0);
      assert.equal(calls.snapshotFind.length, 0);
      assert.equal(calls.linkFind.length, 0);
    } finally {
      restore();
    }
  });
}

test('the same board and the same person still compose when the role holds the capability', async () => {
  // The control for the three above: nothing about the Guest's BOARD access is
  // what refused them, so the Executive — same board, same section — is served.
  const { calls, restore } = stubAll();
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('goalScores', { board: BOARD_OPEN, month: '2026-08', groups: null }),
    ]);
    assert.notEqual(sections[0].state, 'unavailable');
    assert.equal(calls.goalFind.length, 1);
  } finally {
    restore();
  }
});

test('every board-reading registry entry names a capability and a sentence for it', async () => {
  for (const [type, entry] of Object.entries(HANDLERS)) {
    if (!entry.capability) continue;
    assert.ok(
      typeof entry.capabilityError === 'string' && entry.capabilityError.length > 0,
      `${type} refuses on ${entry.capability} with no sentence to show for it`
    );
  }
  // The three board tabs whose data this composer serves. Stated positively so
  // that DELETING a capability from the registry fails here rather than passing
  // quietly — the vacuous half of the assertion above cannot catch that.
  assert.equal(HANDLERS.goalScores.capability, 'goal.view');
  assert.equal(HANDLERS.deliveryScores.capability, 'tracker.view');
  assert.equal(HANDLERS.adsBudgetPacing.capability, 'adsBudget.view');
  // A connector report is connector data, and `connectorDataController` serves
  // none of it below `connector.view`.
  assert.equal(HANDLERS.reportWidget.capability, 'connector.view');
});

test('a section that was never given a board is unavailable and says so', async () => {
  const { calls, restore } = stubAll();
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('goalScores', { board: null, month: null, groups: null }),
    ]);

    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.NO_BOARD);
    assert.equal(calls.goalFind.length, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Degrading — a broken part is a broken part, not a broken page
// ---------------------------------------------------------------------------

test('an unknown section type is unavailable rather than a thrown page', async () => {
  const { restore } = stubAll();
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      // `validateShape` refuses unknown types on the way IN, so a stored one is
      // a type that was removed by a deploy after somebody saved it.
      { _id: '6a466b99ea3ab35ff1378f09', type: 'crystalBall', order: 0, width: 'full', config: { board: BOARD_OPEN } },
    ]);

    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.UNKNOWN_TYPE);
    assert.equal(sections[0].type, 'crystalBall', 'the envelope still names it');
    // An unknown type has no normaliser, so its config comes back as the empty
    // object rather than as a blob nothing on the client can read.
    assert.deepEqual(sections[0].config, {});
  } finally {
    restore();
  }
});

test('a handler that throws takes only its own section down, and the error is logged', async () => {
  const boom = new Error('the goals collection is on fire');
  const { calls, restore } = stubAll({ groupsThrow: boom });
  try {
    const { result, logged } = await quietly(() =>
      composeFor(makeOrg(), EXEC, [
        section('goalScores', { board: BOARD_OPEN, month: '2026-08', groups: null }, { n: 1, order: 0 }),
        section('note', { title: 'Board meeting', text: 'Thursday' }, { n: 2, order: 1 }),
      ]));

    assert.equal(result.sections[0].state, 'unavailable');
    assert.equal(result.sections[0].error, MESSAGES.FAILED);
    assert.ok(
      !String(result.sections[0].error).includes('on fire'),
      'the real error goes to the log, not to the page'
    );
    assert.ok(logged.some((args) => args.includes(boom)), 'and it does reach the log');

    // The section beside it rendered normally.
    assert.equal(result.sections[1].state, 'ok');
    assert.equal(result.sections[1].data.title, 'Board meeting');
    assert.equal(calls.groupFind.length, 1);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Each handler gets the board it was configured with
// ---------------------------------------------------------------------------

test('each handler queries the board its own config named', async () => {
  const { calls, restore } = stubAll({
    trackers: [{ _id: 'tracker1', name: 'Daily post', enabled: true }],
  });
  try {
    await composeFor(makeOrg(), EXEC, [
      section('goalScores', { board: BOARD_OPEN, month: '2026-08', groups: null }, { n: 1, order: 0 }),
      section('adsBudgetPacing', { board: BOARD_SECOND, month: '2026-08' }, { n: 2, order: 1 }),
      section('deliveryScores', { board: BOARD_OPEN, month: '2026-08' }, { n: 3, order: 2 }),
    ]);

    assert.equal(String(calls.goalFind[0].board), BOARD_OPEN);
    assert.equal(String(calls.adsFind[0].board), BOARD_SECOND);
    // The delivery pipeline is handed the whole board document, because
    // `evaluatePlans` resolves each task's done-status against `board.statuses`.
    assert.equal(String(calls.evaluatePlans[0].board._id), BOARD_OPEN);
    assert.equal(String(calls.fetchDeliveryInputs[0].board._id), BOARD_OPEN);
  } finally {
    restore();
  }
});

test('N sections over one board issue ONE board query, scoped to the workspace', async () => {
  const { calls, restore } = stubAll();
  try {
    await composeFor(makeOrg(), EXEC, [
      section('goalScores', { board: BOARD_OPEN, month: '2026-08', groups: null }, { n: 1, order: 0 }),
      section('deliveryScores', { board: BOARD_OPEN, month: '2026-08' }, { n: 2, order: 1 }),
      section('adsBudgetPacing', { board: BOARD_OPEN, month: '2026-08' }, { n: 3, order: 2 }),
      section('goalScores', { board: BOARD_SECOND, month: '2026-08', groups: null }, { n: 4, order: 3 }),
    ]);

    assert.equal(calls.boardFind.length, 1, 'one batch, not one query per section');
    assert.deepEqual(
      calls.boardFind[0]._id.$in.map(String).sort(),
      [BOARD_OPEN, BOARD_SECOND].sort()
    );
    assert.equal(String(calls.boardFind[0].organisation), ORG);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// `month: null` — the board's month, in the board's timezone
// ---------------------------------------------------------------------------

test('month: null resolves in the BOARD timezone, and two boards can disagree', async () => {
  const { calls, restore } = stubAll();
  try {
    // At NOW it is 1 September in Auckland and 31 August everywhere west of it.
    // BOARD_OPEN is a UTC board; BOARD_SECOND is Pacific/Auckland.
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('goalScores', { board: BOARD_OPEN, month: null, groups: null }, { n: 1, order: 0 }),
      section('goalScores', { board: BOARD_SECOND, month: null, groups: null }, { n: 2, order: 1 }),
    ]);

    assert.equal(calls.goalFind[0].monthKey, '2026-08', 'the UTC board is still in August');
    assert.equal(calls.goalFind[1].monthKey, '2026-09', 'the Auckland board has rolled over');

    assert.equal(sections[0].data.monthKey, '2026-08');
    assert.equal(sections[1].data.monthKey, '2026-09');

    // And the resolved month is NEVER written back — the config the envelope
    // carries still says null, or the section pins itself to August forever.
    assert.equal(sections[0].config.month, null);
    assert.equal(sections[1].config.month, null);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The registry is the contract
// ---------------------------------------------------------------------------

test('every section type has a handler and every handler has a section type', async () => {
  assert.deepEqual(
    Object.keys(HANDLERS).sort(),
    [...SECTION_TYPES].sort(),
    'a type without a handler stores a section nothing can draw; a handler '
    + 'without a type is unreachable code'
  );
  // The types are the keys of the config table by construction, so this also
  // pins that every handler's config can actually be normalised.
  assert.deepEqual([...SECTION_TYPES].sort(), Object.keys(CONFIG_NORMALISERS).sort());
  for (const [type, entry] of Object.entries(HANDLERS)) {
    assert.equal(typeof entry.run, 'function', `${type} has no run()`);
  }
});

test('the profile service still exports the section types it no longer owns', async () => {
  // The table moved to this file in phase 2; `executiveView.js` re-exports it so
  // the controller, the client and the phase-1 tests keep reading ONE list.
  // Required HERE rather than at the top: this is the only assertion that cares,
  // and requiring it at module scope would load the profile service into every
  // other test in this file for nothing.
  const executiveView = require('./executiveView');
  assert.deepEqual(executiveView.SECTION_TYPES, SECTION_TYPES);
});

test('reportWidget is the eighth type, registered in all three tables at once', async () => {
  // It was deliberately absent until phase 4, because listing a type before its
  // renderer exists lets an admin save a section nothing can draw. It is here
  // now, and the point of asserting all three is that the promise in this file's
  // header — a type is a config row, a handler and a renderer, and nothing else
  // — is only kept while the three agree.
  assert.ok(SECTION_TYPES.includes('reportWidget'));
  assert.equal(typeof HANDLERS.reportWidget.run, 'function');
  assert.equal(typeof CONFIG_NORMALISERS.reportWidget, 'function');
  assert.equal(HANDLERS.reportWidget.boardKey, 'board', 'or the reach gate skips it');
});

test('the widget-type list is the five, and a sixth cannot arrive by being stored', async () => {
  /**
   * `client/src/utils/reportWidgets.js` is a closed table of five primitives
   * whose whole point is that a sixth is a reviewed edit rather than an object
   * literal somebody adds inline. The server cannot import that module, so this
   * list mirrors it — and a mirror with no test is a list that drifts.
   *
   * Spelled out rather than compared against a length, so that ADDING one here
   * fails this assertion and sends whoever did it to the client module to check
   * `WIDGETS` says the same thing.
   */
  assert.deepEqual([...REPORT_WIDGET_TYPES].sort(), ['bar', 'donut', 'line', 'number', 'table']);

  for (const type of REPORT_WIDGET_TYPES) {
    const value = CONFIG_NORMALISERS.reportWidget({ widget: { type, title: 'Anything' } });
    assert.equal(value.widget.type, type, `${type} is one of the five and must survive`);
  }
});

test('an unknown widget type does not survive the normaliser at all', async () => {
  // Coerced to `null`, not stored and not passed on. `buildWidget` THROWS on a
  // sixth type by design, so a stored one would be a tile that crashed its own
  // renderer forever — which is why this is the one value inside a config that
  // is refused rather than nudged to the nearest legal neighbour.
  const value = CONFIG_NORMALISERS.reportWidget({
    board: BOARD_OPEN,
    group: GROUP_A,
    widget: { type: 'sankey', title: 'Where the traffic went' },
  });
  assert.equal(value.widget, null);
  assert.equal(String(value.board), BOARD_OPEN);
  assert.equal(String(value.group), GROUP_A);

  // The same is true of every other shape a Mixed field can hold.
  for (const junk of [null, undefined, 'number', 42, ['number'], {}]) {
    assert.equal(CONFIG_NORMALISERS.reportWidget({ widget: junk }).widget, null);
  }
});

test('a section whose widget did not survive is unavailable, and reads nothing', async () => {
  const { calls, restore } = stubAll({
    groups: [{ _id: GROUP_A, name: 'Acme' }],
    projects: [dfsProject()],
    links: [{ provider: 'dataforseo', enabled: true }],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('reportWidget', {
        board: BOARD_OPEN,
        group: GROUP_A,
        widget: { type: 'sankey' },
      }),
    ]);

    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.NO_WIDGET);
    // An unfinished section is not a reason to read a client's rankings.
    assert.equal(calls.projectFind.length, 0);
    assert.equal(calls.snapshotFind.length, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Per-handler behaviour
// ---------------------------------------------------------------------------

test('goalScores scores through the real scorer, and empty is not the same as zero', async () => {
  const goals = [
    { _id: 'g1', group: GROUP_A, type: 'numeric', config: { target: 10 }, actual: 10, weight: 1 },
    { _id: 'g2', group: GROUP_A, type: 'numeric', config: { target: 10 }, actual: 5, weight: 1 },
  ];
  const groups = [
    { _id: GROUP_A, name: 'Client A', order: 0 },
    { _id: GROUP_B, name: 'Client B', order: 1 },
  ];

  const withGoals = stubAll({ groups, goals });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('goalScores', { board: BOARD_OPEN, month: '2026-08', groups: null }),
    ]);
    const data = sections[0].data;
    assert.equal(sections[0].state, 'ok');
    assert.equal(data.groups.length, 2);
    // The real scorer ran: 100% and 50%, equally weighted, is 75. If this number
    // ever stops matching the Goals tab, one of the two screens is lying.
    assert.equal(data.groups[0].summary.pct, 75);
    // Client B set no goals, so it scores null rather than 0 — an empty client
    // is not a failing client, and that distinction belongs to `scoreGroup`.
    assert.equal(data.groups[1].summary.pct, null);
    assert.equal(data.summary.totalGoals, 2);
    // NOW is 31 August for a UTC board, so August is the month still running.
    assert.equal(data.partialMonth, true);
  } finally {
    withGoals.restore();
  }

  const noGoals = stubAll({ groups, goals: [] });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('goalScores', { board: BOARD_OPEN, month: '2026-08', groups: null }),
    ]);
    assert.equal(
      sections[0].state,
      'empty',
      '"no goals were set this month" must not render as "here are zero goals"'
    );
    assert.equal(sections[0].data.monthKey, '2026-08', 'and it still knows its month');
  } finally {
    noGoals.restore();
  }
});

test('goalScores narrowed to some groups rolls up only those groups', async () => {
  const groups = [
    { _id: GROUP_A, name: 'Client A', order: 0 },
    { _id: GROUP_B, name: 'Client B', order: 1 },
  ];
  const goals = [
    { _id: 'g1', group: GROUP_A, type: 'numeric', config: { target: 10 }, actual: 10, weight: 1 },
    { _id: 'g2', group: GROUP_B, type: 'numeric', config: { target: 10 }, actual: 0, weight: 1 },
  ];
  const { restore } = stubAll({ groups, goals });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('goalScores', { board: BOARD_OPEN, month: '2026-08', groups: [GROUP_A] }),
    ]);
    const data = sections[0].data;
    assert.equal(data.groups.length, 1);
    assert.equal(data.groups[0]._id, GROUP_A);
    // The board line is a roll-up of what is ON SCREEN: Client B's zero must not
    // drag down a section that does not show Client B.
    assert.equal(data.summary.totalGoals, 1);
  } finally {
    restore();
  }
});

test('deliveryScores honours planDelivery\'s cap as unavailable, never a 400', async () => {
  const { calls, restore } = stubAll({
    trackers: [{ _id: 'tracker1', name: 'Daily post', enabled: true }],
    plan: {
      plans: [],
      scanFrom: null,
      scanTo: null,
      overCap: { tracker: { name: 'Daily post' }, cells: 41000 },
    },
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('deliveryScores', { board: BOARD_OPEN, month: '2026-08' }),
    ]);

    assert.equal(sections[0].state, 'unavailable');
    assert.match(sections[0].error, /Daily post/);
    assert.match(sections[0].error, /41000 group-periods/);
    assert.match(sections[0].error, /Scope the tracker/);
    // It bailed out before the expensive half.
    assert.equal(calls.fetchDeliveryInputs.length, 0);
    assert.equal(calls.evaluatePlans.length, 0);
  } finally {
    restore();
  }
});

test('deliveryScores ships per-group summaries and drops the per-cell grid', async () => {
  const { calls, restore } = stubAll({
    trackers: [{ _id: 'tracker1', name: 'Daily post', enabled: true }],
    plan: { plans: [{ tracker: { _id: 'tracker1' } }], scanFrom: '2026-08-01', scanTo: '2026-08-31', overCap: null },
    results: [
      {
        tracker: { _id: 'tracker1', name: 'Daily post', enabled: true },
        rows: [
          {
            groupId: GROUP_A,
            groupName: 'Client A',
            cells: [{ s: 'met' }, { s: 'missed' }],
            summary: { met: 12, missed: 2, required: 14, keptPct: 86 },
          },
        ],
        summary: { groupCount: 1, onTrack: 0, slipping: 1, atRisk: 0, met: 12, required: 14, keptPct: 86 },
      },
    ],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('deliveryScores', { board: BOARD_OPEN, month: '2026-08' }),
    ]);

    assert.equal(sections[0].state, 'ok');
    const tracker = sections[0].data.trackers[0];
    // The shape `components/board/delivery/DeliverySummary.jsx` reads.
    assert.equal(tracker.enabled, true);
    assert.equal(tracker.rows[0].groupId, GROUP_A);
    assert.equal(tracker.rows[0].summary.missed, 2);
    assert.equal(tracker.rows[0].cells, undefined, 'the grid is not shipped to a tile');

    // The window is the month, clamped to today, with the holiday calendar off
    // the org document the caller already loaded.
    const range = calls.planDelivery[0].resolveRange({ todayKey: '2026-08-20' });
    assert.deepEqual(range, { from: '2026-08-01', to: '2026-08-20' });
    assert.deepEqual(calls.planDelivery[0].orgHolidays, []);
  } finally {
    restore();
  }
});

test('deliveryScores on a board with no trackers is empty, not four confident zeroes', async () => {
  const { calls, restore } = stubAll({ trackers: [] });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('deliveryScores', { board: BOARD_OPEN, month: '2026-08' }),
    ]);
    assert.equal(sections[0].state, 'empty');
    assert.deepEqual(sections[0].data.trackers, []);
    assert.equal(calls.planDelivery.length, 0);
  } finally {
    restore();
  }
});

test('adsBudgetPacing sums PLATFORM rows only, through the real rollUp', async () => {
  const { calls, restore } = stubAll({
    adsRows: [
      { _id: 'p1', group: GROUP_A, allocated: 1000, spent: 500, lifecycle: 'active' },
      { _id: 'p2', group: GROUP_B, allocated: 1000, spent: 250, lifecycle: 'active' },
    ],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('adsBudgetPacing', { board: BOARD_OPEN, month: '2026-08' }),
    ]);

    // `parent: null` is what keeps campaigns from being counted twice.
    assert.equal(calls.adsFind[0].parent, null);
    assert.equal(calls.adsFind[0].monthKey, '2026-08');

    const data = sections[0].data;
    assert.equal(sections[0].state, 'ok');
    assert.equal(data.totals.allocated, 2000);
    assert.equal(data.totals.spent, 750);
    assert.equal(data.currency, 'GBP', 'the board names its own currency');
    // August is fully elapsed at NOW for a UTC board only on the 31st — the
    // window comes from `monthWindow`, which is the only thing that decides it.
    assert.equal(data.window.totalDays, 31);
    assert.equal(data.window.elapsedDays, 31);
  } finally {
    restore();
  }
});

test('adsBudgetPacing on a board with no Ads Budget currency reads the WORKSPACE unit', async () => {
  // `adsBudget.currency` defaults to null now. A bare `|| 'USD'` put a rupee
  // (here: Canadian) workspace's spend on this tile in dollars while the tab it
  // links to said CA$ — the same three steps as the controller, or the two lie.
  const { restore } = stubAll({
    adsRows: [{ _id: 'p1', group: GROUP_A, allocated: 1000, spent: 500, lifecycle: 'active' }],
  });
  const boards = Board.find;
  try {
    const unset = makeBoard({
      _id: BOARD_OPEN,
      memberAccess: grantedToExec,
      adsBudget: { enabled: true, currency: null },
    });
    Board.find = () => query([unset]);
    const { sections } = await composeFor(makeOrg({ baseCurrency: 'CAD' }), EXEC, [
      section('adsBudgetPacing', { board: BOARD_OPEN, month: '2026-08' }),
    ]);
    assert.equal(sections[0].state, 'ok');
    assert.equal(sections[0].data.currency, 'CAD');

    // Neither the add-on nor the workspace says anything: dollars, as before.
    const { sections: bare } = await composeFor(makeOrg({ baseCurrency: undefined }), EXEC, [
      section('adsBudgetPacing', { board: BOARD_OPEN, month: '2026-08' }),
    ]);
    assert.equal(bare[0].data.currency, 'USD');
  } finally {
    Board.find = boards;
    restore();
  }
});

test('adsBudgetPacing with nothing budgeted is empty rather than $0 of $0', async () => {
  const { restore } = stubAll({ adsRows: [] });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('adsBudgetPacing', { board: BOARD_OPEN, month: '2026-08' }),
    ]);
    assert.equal(sections[0].state, 'empty');
    assert.equal(sections[0].data.platformCount, 0);
  } finally {
    restore();
  }
});

test('adsBudgetPacing on a board whose add-on was switched off publishes nothing', async () => {
  // Switching the add-on off does not delete the rows — they live in their own
  // collection — so the money is still there to be read. Every board endpoint
  // answers 404 ADS_BUDGET_OFF in this state and the tab disappears; a home tile
  // that kept printing spend, with an "open in board" link to a `?view=adsbudget`
  // that no longer resolves, would be the only surface in the app still saying it.
  const { calls, restore } = stubAll({
    adsRows: [{ _id: 'p1', group: GROUP_A, allocated: 9000, spent: 8000, lifecycle: 'active' }],
  });
  try {
    const org = makeOrg();
    const boards = Board.find;
    // The same fixture board with the switch off, swapped in for this test only.
    const switchedOff = makeBoard({
      _id: BOARD_OPEN,
      memberAccess: grantedToExec,
      adsBudget: { enabled: false, currency: 'GBP' },
    });
    Board.find = () => query([switchedOff]);
    try {
      const { sections } = await composeFor(org, EXEC, [
        section('adsBudgetPacing', { board: BOARD_OPEN, month: '2026-08' }),
      ]);

      assert.equal(sections[0].state, 'unavailable');
      assert.equal(sections[0].error, MESSAGES.ADS_BUDGET_OFF);
      // NOT `empty`: "nothing budgeted this month" is a false statement about a
      // board with nine thousand pounds allocated on it.
      assert.equal(sections[0].data, null);
      assert.equal(calls.adsFind.length, 0, 'the rows are never read');
    } finally {
      Board.find = boards;
    }
  } finally {
    restore();
  }
});

test('workspaceNumbers without analytics.view is unavailable, never a 403 page', async () => {
  const { calls, restore } = stubAll();
  try {
    // The `member` preset does not hold `analytics.view`. An owner who trims the
    // Executive preset in the matrix produces exactly this state.
    const { sections } = await compose(makeOrg(), MEMBER, {
      profile: profileWith([section('workspaceNumbers', { range: '30d', board: null })]),
      now: NOW,
    });

    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.NO_ANALYTICS);
    assert.equal(calls.buildAnalytics.length, 0, 'the report is not built to be thrown away');
  } finally {
    restore();
  }
});

test('workspaceNumbers picks only the summary, and never asks to see other people', async () => {
  const { calls, restore } = stubAll({
    analytics: {
      summary: { totalTasks: 412, completionRate: 64, overdueTasks: 9, activeBoards: 6 },
      // Everything below names boards and people. None of it may reach the tile.
      boards: [{ _id: BOARD_CLOSED, name: 'Ads 2026' }],
      overdue: { byAssignee: { someone: 3 } },
      boardPerformance: [{ name: 'Ads 2026' }],
    },
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('workspaceNumbers', { range: '90d', board: null }),
    ]);

    assert.equal(sections[0].state, 'ok');
    assert.deepEqual(Object.keys(sections[0].data).sort(), ['boardId', 'range', 'summary']);
    assert.equal(sections[0].data.summary.totalTasks, 412);
    assert.equal(calls.buildAnalytics[0].range, '90d');
    assert.equal(calls.buildAnalytics[0].canSeeOthers, false, 'fail closed, always');
    // The report is built FOR the executive, not for whoever asked.
    assert.equal(String(calls.buildAnalytics[0].userId), EXEC);
  } finally {
    restore();
  }
});

test('workspaceNumbers narrowed to a board is gated like any other board section', async () => {
  const { calls, restore } = stubAll();
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('workspaceNumbers', { range: '30d', board: BOARD_CLOSED }),
    ]);
    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.NO_ACCESS);
    assert.equal(calls.buildAnalytics.length, 0);
  } finally {
    restore();
  }
});

test('a refusal from buildAnalytics is this section\'s problem, not the page\'s', async () => {
  const { restore } = stubAll({
    analytics: { error: 'Board not found in this workspace', status: 404 },
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('workspaceNumbers', { range: '30d', board: null }, { n: 1, order: 0 }),
      section('note', { title: 'Still here', text: '' }, { n: 2, order: 1 }),
    ]);
    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, 'Board not found in this workspace');
    assert.equal(sections[1].state, 'ok');
  } finally {
    restore();
  }
});

test('myWork keeps BOTH branches of the query and applies the limit in the query', async () => {
  const { calls, restore } = stubAll({
    tasks: [{ _id: 't1', name: 'Approve the retainer' }],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('myWork', { due: 'all', limit: 5 }),
    ]);

    assert.equal(sections[0].state, 'ok');
    const filter = calls.taskFind[0];
    assert.equal(filter.$or.length, 2, 'personal AND assigned — it is literally "my work"');
    assert.equal(filter.$or[0].isPersonal, true);
    assert.equal(String(filter.$or[0].createdBy), EXEC);
    assert.equal(String(filter.$or[1].assignedTo), EXEC);

    // The board branch is scoped to the boards this person can READ, which is
    // every readable board in the workspace and not the profile's list — work
    // assigned on a board somebody shared directly is still their work.
    const ids = filter.$or[1].board.$in.map(String).sort();
    assert.deepEqual(ids, [BOARD_OPEN, BOARD_SECOND].sort());

    // Limited in the QUERY. Filtering after a limit would answer "the first five
    // of your tasks, of which two are overdue" under a heading saying Overdue.
    assert.equal(calls.taskQueries[0].limit, 5);
  } finally {
    restore();
  }
});

test('myWork "all" spends its limit on dated rows before undated ones', async () => {
  // THE bug this pins. `Task.dueDate` has no default, so an undated row has no
  // such field, and a MISSING field sorts before any Date in BSON. A single
  // `sort({ dueDate: 1 }).limit(10)` therefore fills the tile with the least
  // urgent things the person owns and cuts the overdue ones off the bottom —
  // silently, and on the one screen bought to surface exactly those.
  const { calls, restore } = stubAll({
    tasks: [
      { _id: 't1', name: 'Overdue retainer' },
      { _id: 't2', name: 'Due Friday' },
    ],
    undatedTasks: [{ _id: 't9', name: 'Someday' }],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('myWork', { due: 'all', limit: 3 }),
    ]);

    assert.equal(calls.taskFind.length, 2, '"all" is two buckets, in order');

    // First: everything that HAS a date, soonest first, for the whole limit.
    assert.deepEqual(calls.taskFind[0].dueDate, { $ne: null });
    assert.deepEqual(calls.taskQueries[0].sort, { dueDate: 1, createdAt: -1 });
    assert.equal(calls.taskQueries[0].limit, 3);

    // Then, and only with room left over, the undated ones — newest first, for
    // exactly the rows the first query did not fill.
    assert.equal(calls.taskFind[1].dueDate, null);
    assert.deepEqual(calls.taskQueries[1].sort, { createdAt: -1 });
    assert.equal(calls.taskQueries[1].limit, 1, 'only the room the dated rows left');

    // Both branches of the `$or` survive the split: the second query is the same
    // "my work" question, narrowed by date, not a different one.
    assert.equal(calls.taskFind[1].$or.length, 2);

    const ids = sections[0].data.tasks.map((t) => t._id);
    assert.deepEqual(ids, ['t1', 't2', 't9'], 'dated first, undated last');
  } finally {
    restore();
  }
});

test('myWork "all" asks nothing extra once the dated rows have filled the tile', async () => {
  const { calls, restore } = stubAll({
    tasks: [{ _id: 't1' }, { _id: 't2' }],
    undatedTasks: [{ _id: 't9' }],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('myWork', { due: 'all', limit: 2 }),
    ]);

    // The common case for anybody with a full calendar. A second round trip that
    // could only be thrown away is a round trip this page should not pay for.
    assert.equal(calls.taskFind.length, 1, 'no top-up query when there is no room');
    assert.deepEqual(sections[0].data.tasks.map((t) => t._id), ['t1', 't2']);
  } finally {
    restore();
  }
});

test('a due bucket stays ONE query — a date range cannot match an undated row', async () => {
  const { calls, restore } = stubAll({ tasks: [{ _id: 't1' }], undatedTasks: [{ _id: 't9' }] });
  try {
    await composeFor(makeOrg(), EXEC, [section('myWork', { due: 'today', limit: 10 })]);

    // BSON compares within a type, so `$gte`/`$lt` on a Date never matches a
    // missing field. The bucket is already dated-only; splitting it would issue
    // a second query that can return nothing.
    assert.equal(calls.taskFind.length, 1);
    assert.ok(calls.taskFind[0].dueDate.$gte instanceof Date);
    assert.deepEqual(calls.taskQueries[0].sort, { dueDate: 1, createdAt: -1 });
  } finally {
    restore();
  }
});

test('myWork overdue asks for a past due date in the person\'s own day, and excludes done', async () => {
  const { calls, restore } = stubAll({
    tasks: [],
    user: { timezone: 'Pacific/Auckland' },
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('myWork', { due: 'overdue', limit: 10 }),
    ]);

    const filter = calls.taskFind[0];
    // Auckland has already started 1 September at NOW, so "before today" is
    // before Auckland's midnight — not the server's, and not UTC's.
    assert.equal(sections[0].data.timezone, 'Pacific/Auckland');
    assert.equal(sections[0].data.todayDayKey, '2026-09-01');
    assert.ok(filter.dueDate.$lt instanceof Date);
    assert.equal(filter.dueDate.$lt.toISOString(), '2026-08-31T12:00:00.000Z');

    // A finished task is never overdue, however long ago it was due. "Done" is
    // per board plus the legacy string a personal task carries.
    assert.ok(filter.status.$nin.includes('done'));
    assert.ok(filter.status.$nin.includes('status-done'));

    assert.equal(sections[0].state, 'empty', 'nothing overdue is a sentence, not a blank tile');
  } finally {
    restore();
  }
});

test('myWork week runs from today through the next seven days, never backwards', async () => {
  const { calls, restore } = stubAll({ tasks: [], user: { timezone: 'UTC' } });
  try {
    await composeFor(makeOrg(), EXEC, [section('myWork', { due: 'week', limit: 10 })]);
    const range = calls.taskFind[0].dueDate;
    assert.equal(range.$gte.toISOString(), '2026-08-31T00:00:00.000Z');
    // 31 August + 7 days = 7 September, inclusive, so the bound is its midnight.
    assert.equal(range.$lt.toISOString(), '2026-09-08T00:00:00.000Z');
  } finally {
    restore();
  }
});

test('boardTiles drops the boards this person lost and keeps the rest in order', async () => {
  const { calls, restore } = stubAll();
  try {
    const { sections } = await composeFor(
      makeOrg(),
      EXEC,
      [section('boardTiles', { boards: [] })],
      [
        boardEntry(BOARD_SECOND, { order: 0, label: 'Tech' }),
        boardEntry(BOARD_CLOSED, { order: 1 }),
        boardEntry(BOARD_OPEN, { order: 2 }),
      ]
    );

    const tiles = sections[0].data.boards;
    assert.deepEqual(tiles.map((t) => t.board), [BOARD_SECOND, BOARD_OPEN]);
    // The nickname AND the board's real name both travel; which one a surface
    // shows is that surface's decision, and it cannot make it with only one.
    assert.equal(tiles[0].label, 'Tech');
    assert.equal(tiles[0].name, 'Tech 2026');
    // No scorer, no second query: the batch is the whole of it.
    assert.equal(calls.boardFind.length, 1);
    assert.equal(calls.groupFind.length, 0);
  } finally {
    restore();
  }
});

test('boardTiles with no reachable board is empty rather than an error', async () => {
  const { restore } = stubAll();
  try {
    const { sections } = await composeFor(
      makeOrg(),
      EXEC,
      [section('boardTiles', { boards: [BOARD_CLOSED, BOARD_GONE] })],
      [boardEntry(BOARD_CLOSED)]
    );
    assert.equal(sections[0].state, 'empty');
    assert.deepEqual(sections[0].data.boards, []);
  } finally {
    restore();
  }
});

test('note echoes its config, clamped, and runs no query at all', async () => {
  const { calls, restore } = stubAll();
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('note', { title: '  Board meeting  ', text: 'x'.repeat(5000) }, { n: 1, order: 0 }),
      section('note', { title: '', text: '   ' }, { n: 2, order: 1 }),
    ]);

    assert.equal(sections[0].state, 'ok');
    assert.equal(sections[0].data.title, 'Board meeting');
    assert.equal(sections[0].data.text.length, 4000);
    assert.equal(sections[1].state, 'empty', 'an unwritten note has nothing to show');
    assert.equal(calls.boardFind.length, 0, 'no section named a board, so nothing was loaded');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The envelope itself
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// reportWidget — readings only, and never a provider
// ---------------------------------------------------------------------------

/** The section under test, pointed at the readable board by default. */
const reportSection = (over = {}) =>
  section('reportWidget', {
    board: BOARD_OPEN,
    group: GROUP_A,
    widget: { type: 'number', title: 'Referring domains' },
    ...over,
  });

test('reportWidget on an unreadable board touches no connector collection', async () => {
  const { calls, restore } = stubAll({
    groups: [{ _id: GROUP_A, name: 'Acme' }],
    projects: [dfsProject()],
    links: [{ provider: 'dataforseo', enabled: true }],
    snapshots: [snap('positions', MARKET_GB, '2026-08-24', { totals: { top10: 12 } })],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      reportSection({ board: BOARD_CLOSED }),
    ]);

    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.NO_ACCESS);
    assert.equal(sections[0].data, null);

    // THE assertion, in the same form invariant 1 takes for the other types: a
    // client's site, its rankings and its backlink profile are not things that
    // may reach a log or a cache on the way to being refused.
    assert.equal(calls.groupFind.length, 0);
    assert.equal(calls.projectFind.length, 0);
    assert.equal(calls.snapshotFind.length, 0);
    assert.equal(calls.linkFind.length, 0);
  } finally {
    restore();
  }
});

test('a client with no site mapped is empty, and no reading is even looked for', async () => {
  const { calls, restore } = stubAll({
    groups: [{ _id: GROUP_A, name: 'Acme' }],
    projects: [],
    links: [{ provider: 'dataforseo', enabled: true }],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [reportSection()]);

    // `empty`, not `unavailable`: nothing is broken and nobody lost access.
    assert.equal(sections[0].state, 'empty');
    assert.equal(sections[0].error, null);
    assert.equal(sections[0].data.groupName, 'Acme');
    assert.equal(sections[0].data.report, null, 'there is no report to ship');
    assert.equal(calls.snapshotFind.length, 0);
  } finally {
    restore();
  }
});

test('a mapped client with no readings yet is empty, with the site still named', async () => {
  const { restore } = stubAll({
    groups: [{ _id: GROUP_A, name: 'Acme' }],
    projects: [dfsProject()],
    links: [{ provider: 'dataforseo', enabled: true }],
    snapshots: [],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [reportSection()]);

    // The first week of a board. A sentence, not a fault — and the payload still
    // carries the site so the tile can say WHICH client has nothing yet.
    assert.equal(sections[0].state, 'empty');
    assert.equal(sections[0].error, null);
    assert.equal(sections[0].data.report.project.domain, 'acme.com');
    assert.deepEqual(sections[0].data.report.snapshots, {});
  } finally {
    restore();
  }
});

test('a connector switched off on the board publishes nothing, and says why', async () => {
  const { calls, restore } = stubAll({
    groups: [{ _id: GROUP_A, name: 'Acme' }],
    projects: [dfsProject()],
    // Nothing enabled. Readings are NOT deleted when a board switches a
    // connector off, so without this the tile would go on publishing last
    // month's rankings under a link to a tab that no longer exists.
    links: [],
    snapshots: [snap('positions', MARKET_GB, '2026-08-24', { totals: { top10: 12 } })],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [reportSection()]);

    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.CONNECTOR_OFF);
    assert.equal(calls.snapshotFind.length, 0, 'no point reading what cannot be opened');
  } finally {
    restore();
  }
});

test('a group that is no longer on this board is refused by name', async () => {
  const { restore } = stubAll({
    // The board-scoped group query found nothing: the id belongs to another
    // board, or that client was removed after the section was configured.
    groups: [],
    projects: [dfsProject()],
    links: [{ provider: 'dataforseo', enabled: true }],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [reportSection()]);
    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.GROUP_GONE);
  } finally {
    restore();
  }
});

test('a section with no client is unavailable and says which control to fill in', async () => {
  const { calls, restore } = stubAll();
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [reportSection({ group: null })]);
    assert.equal(sections[0].state, 'unavailable');
    assert.equal(sections[0].error, MESSAGES.NO_GROUP);
    assert.equal(calls.groupFind.length, 0);
  } finally {
    restore();
  }
});

test('the readings ship whole: newest per kind, an ok baseline, ONE market', async () => {
  /**
   * The fold under test is `connectorDataController`'s, mirrored — see the
   * handler's header for why it is mirrored rather than imported. Three rules
   * ride on it and every one of them is a wrong number rather than a crash:
   *
   *   ONE MARKET. A US rank and a GB rank are two facts. Subtracting them
   *   reports a change of country as movement.
   *   AN `ok` BASELINE. A `partial` reading is a short collection, and half a
   *   keyword list compared with a whole one reports every missing keyword as
   *   having fallen out of the rankings.
   *   THE PAYLOAD WHOLE. `depth` is read by the guard that refuses a delta
   *   between two readings bought to different depths. A payload narrowed to
   *   what a widget draws would drop it, and the refusal would stop happening.
   */
  const { calls, restore } = stubAll({
    groups: [{ _id: GROUP_A, name: 'Acme' }],
    projects: [dfsProject()],
    links: [{ provider: 'dataforseo', enabled: true }],
    // Newest first, which is the order `{ periodKey: -1, fetchedAt: -1 }` hands
    // back. The stub does not sort — it answers the query the handler wrote.
    snapshots: [
      snap('positions', MARKET_US, '2026-08-24', { depth: 10, totals: { averageRank: 30 } }),
      snap('positions', MARKET_GB, '2026-08-24', {
        depth: 10,
        totals: { tracked: 40, top10: 12, averageRank: 14.2 },
        keywords: [{ keyword: 'blue widgets', position: 3 }],
      }),
      snap('positions', MARKET_GB, '2026-08-17', { depth: 10, totals: { averageRank: 99 } }, 'partial'),
      snap('positions', MARKET_GB, '2026-08-10', { depth: 10, totals: { top10: 9, averageRank: 16 } }),
      // Outside the 90-day window the report's line is drawn over, and still a
      // legitimate row for the fold above it.
      snap('positions', MARKET_GB, '2026-04-06', { depth: 10, totals: { averageRank: 40 } }),
      snap('backlinks_summary', '0|any|any', '2026-08-24', { profile: { referringDomains: 120 } }),
      snap('backlinks_summary', '0|any|any', '2026-08-17', { profile: { referringDomains: 100 } }),
    ],
  });
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [reportSection()]);
    const { data } = sections[0];

    assert.equal(sections[0].state, 'ok');
    assert.equal(data.provider, 'dataforseo');
    assert.equal(data.boardName, 'SEO Tracker 2026');
    assert.equal(data.groupName, 'Acme');
    // Echoed, so the renderer draws what was configured rather than guessing.
    assert.deepEqual(data.widget, { type: 'number', title: 'Referring domains' });

    // The alphabetical market, which is the one the Report tab shows. The tile
    // and the tab it links to must be about the same country.
    assert.equal(data.report.variant, MARKET_GB);
    assert.equal(data.report.snapshots.positions.variant, MARKET_GB);
    assert.equal(data.report.snapshots.positions.periodKey, '2026-08-24');
    // The partial reading in between was skipped as a baseline.
    assert.equal(data.report.previousSnapshots.positions.periodKey, '2026-08-10');
    // A backlink profile is a property of a domain and its variant can never
    // equal a rank variant — the descriptor's `sameVariant` is what stops it
    // being filtered out, and this is that rule holding.
    assert.equal(data.report.snapshots.backlinks_summary.data.profile.referringDomains, 120);
    assert.equal(data.report.previousSnapshots.backlinks_summary.data.profile.referringDomains, 100);

    // The guard's field travelled. See the docstring.
    assert.equal(data.report.snapshots.positions.data.depth, 10);

    // The line, oldest first, bounded by the window and by the market.
    assert.deepEqual(
      data.report.trend.map((t) => t.periodKey),
      ['2026-08-10', '2026-08-17', '2026-08-24']
    );
    assert.equal(data.report.trend[2].totals.averageRank, 14.2);
    assert.ok(
      !('keywords' in data.report.trend[2]),
      'the per-keyword detail behind a six-number chart never travels'
    );

    // ONE snapshot query, for this project, narrowed to the four kinds a report
    // is built from — the other nine draw nothing in one.
    assert.equal(calls.snapshotFind.length, 1);
    assert.equal(String(calls.snapshotFind[0].project), PROJECT);
    assert.deepEqual(
      [...calls.snapshotFind[0].kind.$in].sort(),
      ['backlinks_summary', 'movement', 'positions', 'site_audit']
    );
    // And the group was read SCOPED TO THE BOARD, or a client from another
    // board would resolve past a gate that was never asked about them.
    assert.equal(String(calls.groupFind[0]._id), GROUP_A);
    assert.equal(String(calls.groupFind[0].board), BOARD_OPEN);
  } finally {
    restore();
  }
});

test('every composed section carries the contract envelope, in profile order', async () => {
  const { restore } = stubAll();
  try {
    const { sections } = await composeFor(makeOrg(), EXEC, [
      section('note', { title: 'Second', text: '' }, { n: 2, order: 5, width: 'half' }),
      section('note', { title: 'First', text: '' }, { n: 1, order: 1 }),
    ]);

    assert.deepEqual(
      sections.map((s) => s.data.title),
      ['First', 'Second'],
      'order is what somebody dragged, not the order mongo happened to store'
    );
    for (const composed of sections) {
      assert.deepEqual(
        Object.keys(composed).sort(),
        ['config', 'data', 'error', 'id', 'order', 'state', 'type', 'width'].sort()
      );
    }
    // The subdoc `_id` is the section's identity: two notes are otherwise
    // identical, so a client keyed on anything else loses its place on reorder.
    assert.equal(sections[0].id, '6a466b99ea3ab35ff1378f01');
    assert.equal(sections[1].width, 'half');
    assert.equal(sections[0].error, null, 'the key is always present');
  } finally {
    restore();
  }
});

test('a profile with no sections composes to nothing, and asks the database nothing', async () => {
  const { calls, restore } = stubAll();
  try {
    assert.deepEqual(await composeFor(makeOrg(), EXEC, []), { sections: [] });
    assert.deepEqual(await compose(makeOrg(), EXEC, { profile: null }), { sections: [] });
    assert.deepEqual(await compose(makeOrg(), EXEC), { sections: [] });
    assert.equal(calls.boardFind.length, 0);
  } finally {
    restore();
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const BoardConnector = require('../models/BoardConnector');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorBudget = require('../models/ConnectorBudget');
const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');

const { getConnectorUsage } = require('./connectorDataController');
const { setBoardConnector, readIntervalHours } = require('./connectorController');
const dfs = require('../services/connectors/dataforseo');

/**
 * The Usage & Spend read, and the two `BoardConnector` fields phase 5 added.
 *
 * ---- The properties this file exists to hold -------------------------------
 *
 * IT NEVER CONTACTS A PROVIDER. Nothing here supplies a session, a credential or
 * a client, so a handler that tried to read the account's live balance would
 * throw rather than quietly making an outbound call on every page load. That is
 * the same rule the data read already holds, and it is a stronger claim here,
 * because DataForSEO's balance endpoint is free and therefore tempting.
 *
 * IT NEVER WRITES A BUDGET DOCUMENT. `describeBudget` returns null for a period
 * with no row, and null is the honest answer: the row is minted at the first
 * reservation, and creating one from a read would stamp today's environment
 * `capUsd` onto a month that has not started — the "a cap silently rose because
 * somebody redeployed" failure the phase-3 design took care to avoid.
 *
 * THE ORG CAP IS NOT A BOARD FACT. It is the whole workspace's money, so a board
 * reader is told what this board spent and what its own allocation is, and
 * nothing about the ceiling.
 *
 * `kinds` AND `enabledScreens` ARE NOT THE SAME SWITCH. `kinds` is unioned
 * across every board mapping a project, so narrowing it reaches a co-tenant;
 * `enabledScreens` is local and free. The write path has to keep them apart, and
 * has to refuse a screen key no provider declares.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '6a466b99ea3ab35ff1378c01';
const MEMBER = '6a466b99ea3ab35ff1378c02';
const VIEWER = '6a466b99ea3ab35ff1378c03';
const OUTSIDER = '6a466b99ea3ab35ff1378c04';
const ORG = '6a466b99ea3ab35ff1378c10';
const BOARD = '6a466b99ea3ab35ff1378c20';
const PROJECT = '6a466b99ea3ab35ff1378c40';

const roles = SYSTEM_ROLES.map((r, i) => ({
  _id: `role${i}`,
  key: r.key,
  name: r.name,
  color: r.color,
  isSystem: true,
  permissions: sanitizePermissions(r.permissions),
}));
const roleId = (key) => roles.find((r) => r.key === key)._id;

const makeOrg = () => ({
  _id: ORG,
  admin: OWNER,
  admins: [],
  members: [OWNER, MEMBER, VIEWER],
  roles,
  memberRoles: [
    { user: MEMBER, role: roleId('member') },
    { user: VIEWER, role: roleId('viewer') },
  ],
  ensureSystemRoles: () => false,
});

const makeBoard = (overrides = {}) => ({
  _id: BOARD,
  createdBy: OWNER,
  organisation: ORG,
  boardType: 'tracker',
  visibility: 'public',
  publicDefaultLevel: 'edit',
  memberAccess: [],
  ...overrides,
});

const makeProject = () => ({
  _id: PROJECT,
  account: '6a466b99ea3ab35ff1378c50',
  organisation: ORG,
  provider: 'dataforseo',
  externalId: PROJECT,
  name: 'Acme',
  domain: 'acme.com',
  board: BOARD,
  group: '6a466b99ea3ab35ff1378c30',
  locallyAuthored: true,
});

/** A thenable answering `.sort().select().limit().lean()` in any order. */
const chain = (value) => {
  const self = {
    sort: () => self,
    select: () => self,
    limit: () => self,
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

const req = (overrides = {}) => ({
  params: { boardId: BOARD, provider: 'dataforseo', ...(overrides.params || {}) },
  query: overrides.query || {},
  body: overrides.body || {},
  user: { userId: overrides.userId || OWNER },
});

const stubModels = ({
  board = makeBoard(),
  org = makeOrg(),
  projects = [makeProject()],
  boardConnector = {
    enabled: true,
    kinds: [],
    enabledScreens: [],
    intervalHours: null,
    budget: { monthlyUsd: null, alertAtPct: 80 },
  },
  budgets = [],
  usage = null,
} = {}) => {
  const originals = {
    boardFindById: Board.findById,
    orgFindById: Organisation.findById,
    projectFind: ConnectorProject.find,
    bcFindOne: BoardConnector.findOne,
    budgetFindOne: ConnectorBudget.findOne,
    describeUsage: dfs.describeUsage,
  };
  const calls = { describeUsage: [] };

  Board.findById = () => Promise.resolve(board);
  Organisation.findById = () => Promise.resolve(org);
  ConnectorProject.find = () => chain(projects);
  BoardConnector.findOne = () => chain(boardConnector);
  ConnectorBudget.findOne = (filter) =>
    chain(budgets.find((b) => b.scope === filter.scope) || null);

  if (usage !== null) {
    dfs.describeUsage = async (args) => {
      calls.describeUsage.push(args);
      return usage;
    };
  }

  return {
    calls,
    restore: () => {
      Board.findById = originals.boardFindById;
      Organisation.findById = originals.orgFindById;
      ConnectorProject.find = originals.projectFind;
      BoardConnector.findOne = originals.bcFindOne;
      ConnectorBudget.findOne = originals.budgetFindOne;
      dfs.describeUsage = originals.describeUsage;
    },
  };
};

const budgetRow = (scope, overrides = {}) => ({
  periodKey: '2026-09',
  scope,
  capUsd: 5,
  reservedUsd: 0.5,
  spentUsd: 1.5,
  releasedUsd: 0,
  ...overrides,
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a board reader may see this board’s spend', async () => {
  const stub = stubModels({ usage: { queued: 3 } });
  try {
    const res = fakeRes();
    await getConnectorUsage(req({ userId: VIEWER }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.canManage, false);
    assert.equal(res.body.ledger.queued, 3);
  } finally {
    stub.restore();
  }
});

test('somebody outside the organisation gets nothing', async () => {
  const stub = stubModels({ usage: {} });
  try {
    const res = fakeRes();
    await getConnectorUsage(req({ userId: OUTSIDER }), res);
    assert.ok(res.statusCode === 403 || res.statusCode === 404);
    assert.equal(res.body.ledger, undefined);
  } finally {
    stub.restore();
  }
});

test('the ORG cap is withheld from a reader and shown to a manager', async () => {
  const budgets = [budgetRow('org'), budgetRow('board', { capUsd: 2, spentUsd: 0.4 })];

  let stub = stubModels({ budgets, usage: {} });
  try {
    const res = fakeRes();
    await getConnectorUsage(req({ userId: VIEWER }), res);
    // The workspace's ceiling is not a fact about this board.
    assert.equal(res.body.orgBudget, null);
    // Its own allocation is.
    assert.equal(res.body.boardBudget.capUsd, 2);
  } finally {
    stub.restore();
  }

  stub = stubModels({ budgets, usage: {} });
  try {
    const res = fakeRes();
    await getConnectorUsage(req({ userId: OWNER }), res);
    assert.equal(res.body.orgBudget.capUsd, 5);
    // committed = reserved + spent, and remaining is what is left under the cap.
    assert.equal(res.body.orgBudget.committedUsd, 2);
    assert.equal(res.body.orgBudget.remainingUsd, 3);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('the usage read contacts no provider and opens no session', async () => {
  // Nothing below supplies a session or a credential. `describeUsage` is handed
  // the board's projects and a clock and nothing that could reach the network.
  const stub = stubModels({ usage: { queued: 0 } });
  try {
    const res = fakeRes();
    await getConnectorUsage(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(stub.calls.describeUsage.length, 1);
    const args = stub.calls.describeUsage[0];
    assert.equal(args.session, undefined);
    assert.equal(args.client, undefined);
    assert.equal(args.projects.length, 1);
  } finally {
    stub.restore();
  }
});

test('a month nobody has spent in reports null rather than minting a cap', async () => {
  const stub = stubModels({ budgets: [], usage: {} });
  try {
    const res = fakeRes();
    await getConnectorUsage(req(), res);
    assert.equal(res.body.orgBudget, null);
    assert.equal(res.body.boardBudget, null);
    // The screen still renders — the period key and the board's own settings are
    // enough to say "nothing has been spent this month".
    assert.match(res.body.periodKey, /^\d{4}-\d{2}$/);
  } finally {
    stub.restore();
  }
});

test('a provider with no ledger hook answers with the budget alone', async () => {
  const original = dfs.describeUsage;
  delete dfs.describeUsage;
  const stub = stubModels({ budgets: [budgetRow('org')] });
  try {
    const res = fakeRes();
    await getConnectorUsage(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ledger, null);
    assert.equal(res.body.orgBudget.capUsd, 5);
  } finally {
    stub.restore();
    dfs.describeUsage = original;
  }
});

test('a ledger that throws does not fail the page', async () => {
  const original = dfs.describeUsage;
  dfs.describeUsage = async () => {
    throw new Error('task table unavailable');
  };
  const stub = stubModels({ budgets: [budgetRow('org')] });
  try {
    const res = fakeRes();
    await getConnectorUsage(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ledger, null);
  } finally {
    stub.restore();
    dfs.describeUsage = original;
  }
});

// ---------------------------------------------------------------------------
// `enabledScreens` and `intervalHours` on the write path
// ---------------------------------------------------------------------------

const stubBoardWrite = ({ board = makeBoard(), org = makeOrg() } = {}) => {
  const originals = {
    boardFindById: Board.findById,
    orgFindById: Organisation.findById,
    bcUpdate: BoardConnector.findOneAndUpdate,
  };
  const written = [];

  Board.findById = () => Promise.resolve(board);
  Organisation.findById = () => Promise.resolve(org);
  BoardConnector.findOneAndUpdate = (filter, update) => {
    written.push(update.$set);
    return chain({
      enabled: update.$set.enabled,
      kinds: update.$set.kinds || [],
      enabledScreens: update.$set.enabledScreens || [],
      intervalHours: update.$set.intervalHours ?? null,
      budget: {
        monthlyUsd: update.$set['budget.monthlyUsd'] ?? null,
        alertAtPct: update.$set['budget.alertAtPct'] ?? 80,
      },
      lastRefreshAt: null,
    });
  };

  return {
    written,
    restore: () => {
      Board.findById = originals.boardFindById;
      Organisation.findById = originals.orgFindById;
      BoardConnector.findOneAndUpdate = originals.bcUpdate;
    },
  };
};

test('the model carries both fields, so the schedule seam reads a real one', () => {
  // `scheduleForProvider` has selected `intervalHours` since phase 0 and it read
  // `undefined` on every row, which is indistinguishable from "no opinion" — a
  // seam with nothing on the other side of it. These two assertions are what
  // make the min-across-boards behaviour, already covered in
  // `snapshotPending.test.js`, reachable from a board.
  const paths = BoardConnector.schema.paths;
  assert.equal(paths.intervalHours.instance, 'Number');
  assert.equal(paths.intervalHours.defaultValue, null);
  assert.ok(paths.enabledScreens, 'enabledScreens must exist beside kinds');
  assert.ok(paths.kinds, 'kinds must remain separate from enabledScreens');
});

test('a screen key the provider does not declare is refused, never stored', async () => {
  /**
   * The failure this prevents is delayed and silent: a key stored today that no
   * screen answers to is indistinguishable from a deliberate choice on the day
   * a screen with that name ships, and it would switch the screen on for a
   * client who never asked for it.
   *
   * `backlinks` was the example until phase 7 declared it — which is the case
   * arriving rather than the case going away, so the placeholder moved to a key
   * no phase in the plan will ever ship.
   */
  const stub = stubBoardWrite();
  try {
    const res = fakeRes();
    await setBoardConnector(
      req({ body: { enabled: true, enabledScreens: ['overview', 'astrology'] } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(stub.written[0].enabledScreens, ['overview']);
    assert.deepEqual(res.body.connector.enabledScreens, ['overview']);
  } finally {
    stub.restore();
  }
});

test('narrowing the screens leaves the collected kinds alone', async () => {
  // The two are separate fields because `kinds` is unioned across every board
  // mapping a project — narrowing it can take a section away from a co-tenant —
  // while `enabledScreens` cannot leave this board.
  const stub = stubBoardWrite();
  try {
    const res = fakeRes();
    await setBoardConnector(
      req({ body: { enabled: true, enabledScreens: ['overview'] } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal('kinds' in stub.written[0], false);
  } finally {
    stub.restore();
  }
});

test('a cadence under an hour is refused rather than stored', async () => {
  const stub = stubBoardWrite();
  try {
    for (const bad of [0, -1, 0.5]) {
      const res = fakeRes();
      // eslint-disable-next-line no-await-in-loop
      await setBoardConnector(req({ body: { enabled: true, intervalHours: bad } }), res);
      assert.equal(res.statusCode, 400, `intervalHours ${bad} should be refused`);
    }
    assert.equal(stub.written.length, 0);
  } finally {
    stub.restore();
  }
});

test('a blank cadence clears the override rather than meaning zero', async () => {
  const stub = stubBoardWrite();
  try {
    const res = fakeRes();
    await setBoardConnector(req({ body: { enabled: true, intervalHours: null } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(stub.written[0].intervalHours, null);
  } finally {
    stub.restore();
  }
});

test('readIntervalHours agrees with snapshotService about what is usable', () => {
  const { askedInterval } = require('../services/connectors/snapshotService');
  for (const bad of [0, -3, Number.NaN, Infinity]) {
    const stored = readIntervalHours(bad);
    // Either the write refuses it, or the read must treat it as "no opinion".
    // What must never happen is a stored 0 that the planner trusts.
    if (stored.ok) assert.equal(askedInterval(stored.value), null);
    else assert.equal(stored.ok, false);
  }
  assert.equal(readIntervalHours(24).value, 24);
  assert.equal(askedInterval(24), 24);
});

test('a negative or absurd allocation is refused', async () => {
  const stub = stubBoardWrite();
  try {
    const res = fakeRes();
    await setBoardConnector(
      req({ body: { enabled: true, budget: { monthlyUsd: -5 } } }),
      res
    );
    assert.equal(res.statusCode, 400);

    const res2 = fakeRes();
    await setBoardConnector(
      req({ body: { enabled: true, budget: { monthlyUsd: 12, alertAtPct: 400 } } }),
      res2
    );
    assert.equal(res2.statusCode, 400);
  } finally {
    stub.restore();
  }
});

test('a zero allocation is stored as "no allocation", not as a zero ceiling', async () => {
  // A stored 0 would create a board budget document whose cap refuses every
  // reservation — an accidental total stop dressed as a setting.
  const stub = stubBoardWrite();
  try {
    const res = fakeRes();
    await setBoardConnector(
      req({ body: { enabled: true, budget: { monthlyUsd: 0 } } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(stub.written[0]['budget.monthlyUsd'], null);
  } finally {
    stub.restore();
  }
});

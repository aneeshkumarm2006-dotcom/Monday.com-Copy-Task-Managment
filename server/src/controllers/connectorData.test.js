const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const BoardConnector = require('../models/BoardConnector');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');
const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');

const {
  getConnectorData,
  resolveRange,
  parseDay,
} = require('./connectorDataController');

/**
 * The data-plane read, through its real authorization gate.
 *
 * Only the model lookups are stubbed. `loadBoardContext` and `resolveAccess`
 * run for real, so these cover the thing that actually decides who may see a
 * client's rank history: the two-layer AND of org role and board level, plus the
 * tracker-board check on top of it.
 *
 * ---- The property this file exists to hold ---------------------------------
 *
 * THE READ NEVER CONTACTS THE PROVIDER. The stubs below make that testable
 * rather than assumed: nothing here provides a session, a token or an MCP
 * client, so a handler that tried to fetch would throw rather than quietly
 * spending a quota shared by the entire workspace. Ten people opening this tab
 * must generate zero outbound calls.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '6a466b99ea3ab35ff1378e01';
const MEMBER = '6a466b99ea3ab35ff1378e02';
const VIEWER = '6a466b99ea3ab35ff1378e03';
const OUTSIDER = '6a466b99ea3ab35ff1378e04';
const ORG = '6a466b99ea3ab35ff1378e10';
const BOARD = '6a466b99ea3ab35ff1378e20';
const PROJECT = '6a466b99ea3ab35ff1378e40';
const OTHER_PROJECT = '6a466b99ea3ab35ff1378e41';

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

const makeProject = (overrides = {}) => ({
  _id: PROJECT,
  account: '6a466b99ea3ab35ff1378e50',
  organisation: ORG,
  provider: 'ubersuggest',
  externalId: '5512',
  name: 'Acme',
  domain: 'acme.com',
  locations: [{ locId: 2840, lang: 'en', label: 'United States' }],
  group: '6a466b99ea3ab35ff1378e30',
  board: BOARD,
  lastFetchedAt: new Date('2026-08-24T07:00:00Z'),
  ...overrides,
});

/**
 * One positions snapshot. The keyword set carries the case that matters: a
 * `null` rank on an `ok` status, which means "not in the top 100" and is a final
 * answer rather than a gap.
 */
const makeSnapshot = (overrides = {}) => ({
  _id: `snap-${overrides.periodKey || '1'}-${overrides.variant || 'v'}`,
  kind: 'positions',
  variant: 'desktop|en|2840',
  periodKey: '2026-08-24',
  collectedAt: new Date('2026-08-24T06:12:00Z'),
  subject: 'project:5512',
  status: 'ok',
  note: '',
  raw: { secret: 'bulky provider payload' },
  data: {
    totals: { tracked: 2, ranking: 1, notRanking: 1 },
    averagePositions: [{ date: '2026-08-24', value: 24.5 }],
    keywords: [
      { keyword: 'luxury lingerie', status: 'ok', position: 3, previousPosition: 8, ranked: true },
      { keyword: 'bridal corset', status: 'ok', position: null, previousPosition: null, ranked: true },
    ],
  },
  fetchedAt: new Date('2026-08-24T07:00:00Z'),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

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
  params: { boardId: BOARD, provider: 'ubersuggest', ...(overrides.params || {}) },
  query: overrides.query || {},
  body: overrides.body || {},
  user: { userId: overrides.userId || OWNER },
});

const stubModels = ({
  board = makeBoard(),
  org = makeOrg(),
  mappedProjects = [makeProject()],
  extraProjects = [],
  snapshots = [makeSnapshot()],
  withData = [],
  boardConnector = { enabled: true, kinds: [], lastRefreshAt: null },
} = {}) => {
  const originals = {
    boardFindById: Board.findById,
    orgFindById: Organisation.findById,
    projectFind: ConnectorProject.find,
    snapshotFind: ConnectorSnapshot.find,
    snapshotDistinct: ConnectorSnapshot.distinct,
    bcFindOne: BoardConnector.findOne,
  };

  Board.findById = () => Promise.resolve(board);
  Organisation.findById = () => Promise.resolve(org);
  // Two different call shapes: `projectsForBoard` filters by board, the
  // has-data top-up filters by `_id.$in`.
  ConnectorProject.find = (filter) =>
    chain(filter && filter._id?.$in ? extraProjects : mappedProjects);
  ConnectorSnapshot.find = () => chain(snapshots);
  ConnectorSnapshot.distinct = () => Promise.resolve(withData);
  BoardConnector.findOne = () => chain(boardConnector);

  return () => {
    Board.findById = originals.boardFindById;
    Organisation.findById = originals.orgFindById;
    ConnectorProject.find = originals.projectFind;
    ConnectorSnapshot.find = originals.snapshotFind;
    ConnectorSnapshot.distinct = originals.snapshotDistinct;
    BoardConnector.findOne = originals.bcFindOne;
  };
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a board reader may see connector data', async () => {
  // `connector.view` sits on the bottom rung of the board ladder precisely
  // because nothing this endpoint does costs anything.
  const restore = stubModels();
  try {
    const res = fakeRes();
    await getConnectorData(req({ userId: VIEWER }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.canManage, false);
  } finally {
    restore();
  }
});

test('an editor is told they may manage, a viewer is not', async () => {
  const restore = stubModels();
  try {
    const res = fakeRes();
    await getConnectorData(req({ userId: OWNER }), res);
    assert.equal(res.body.canManage, true);
  } finally {
    restore();
  }
});

test('somebody outside the organisation gets nothing', async () => {
  const restore = stubModels();
  try {
    const res = fakeRes();
    await getConnectorData(req({ userId: OUTSIDER }), res);
    assert.ok(res.statusCode === 403 || res.statusCode === 404);
    assert.equal(res.body.projects, undefined);
  } finally {
    restore();
  }
});

test('a standard board 404s, matching the goals and trackers precedent', async () => {
  // On a standard board connectors do not exist, so there is nothing to be
  // refused access to — 404 rather than 403, and the same shape goalController
  // uses.
  const restore = stubModels({ board: makeBoard({ boardType: 'standard' }) });
  try {
    const res = fakeRes();
    await getConnectorData(req(), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'NOT_TRACKER_BOARD');
  } finally {
    restore();
  }
});

test('an unknown provider is refused before anything is read', async () => {
  const restore = stubModels();
  try {
    const res = fakeRes();
    await getConnectorData(req({ params: { provider: 'semrush' } }), res);
    assert.equal(res.statusCode, 400);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// What it returns
// ---------------------------------------------------------------------------

test('the payload carries the provider’s kind catalog, so the tab is not hardcoded', async () => {
  const restore = stubModels();
  try {
    const res = fakeRes();
    await getConnectorData(req(), res);
    const keys = res.body.provider.kinds.map((k) => k.key);
    assert.ok(keys.includes('positions'));
    assert.ok(keys.includes('site_audit'));
  } finally {
    restore();
  }
});

test('the latest reading of each kind is selected, newest first', async () => {
  const restore = stubModels({
    snapshots: [
      makeSnapshot({ periodKey: '2026-08-24' }),
      makeSnapshot({ periodKey: '2026-08-17', data: { totals: { tracked: 1 } } }),
      makeSnapshot({ kind: 'backlinks', variant: 'default', data: { backlinks: 5 } }),
    ],
  });
  try {
    const res = fakeRes();
    await getConnectorData(req(), res);
    assert.equal(res.body.snapshots.positions.periodKey, '2026-08-24');
    assert.equal(res.body.snapshots.backlinks.data.backlinks, 5);
  } finally {
    restore();
  }
});

test('`raw` is withheld by default, even from someone who could re-fetch it', async () => {
  // Bulky, undocumented and rendered by nothing. Returned only when explicitly
  // asked for — the same rule `publicProject` already applies.
  const restore = stubModels();
  try {
    const res = fakeRes();
    await getConnectorData(req(), res);
    assert.equal('raw' in res.body.snapshots.positions, false);
  } finally {
    restore();
  }
});

test('`raw` is refused to somebody who could not refresh it either', async () => {
  const restore = stubModels();
  try {
    const res = fakeRes();
    await getConnectorData(req({ userId: VIEWER, query: { includeRaw: '1' } }), res);
    assert.equal('raw' in res.body.snapshots.positions, false);
  } finally {
    restore();
  }
});

test('a not-in-top-100 rank survives the round trip as an explicit null', async () => {
  // The single most important thing this endpoint must not smooth away. `null`
  // with `ranked: true` is a final answer; the client renders it as "not in top
  // 100" and never as an empty cell, which is what a failed sync looks like.
  const restore = stubModels();
  try {
    const res = fakeRes();
    await getConnectorData(req(), res);
    const row = res.body.snapshots.positions.data.keywords.find(
      (k) => k.keyword === 'bridal corset'
    );
    assert.equal(row.position, null);
    assert.equal(row.ranked, true);
  } finally {
    restore();
  }
});

test('rank variants are kept apart, and one is chosen rather than mixed', async () => {
  // A US rank and a UK rank for the same keyword on the same day are two facts.
  // Showing whichever was written last would flip the table between markets.
  const restore = stubModels({
    snapshots: [
      makeSnapshot({ variant: 'desktop|en|2840', data: { totals: { tracked: 9 }, keywords: [] } }),
      makeSnapshot({ variant: 'desktop|en|2826', data: { totals: { tracked: 4 }, keywords: [] } }),
    ],
  });
  try {
    const res = fakeRes();
    await getConnectorData(req({ query: { variant: 'desktop|en|2826' } }), res);
    assert.deepEqual(res.body.variants, ['desktop|en|2826', 'desktop|en|2840']);
    assert.equal(res.body.variant, 'desktop|en|2826');
    assert.equal(res.body.snapshots.positions.data.totals.tracked, 4);
  } finally {
    restore();
  }
});

test('the trend series drops the per-keyword bulk', async () => {
  // A year of weekly readings on a 300-keyword project is 15,600 rows of detail
  // for a chart that draws six numbers per point.
  const restore = stubModels();
  try {
    const res = fakeRes();
    await getConnectorData(req({ query: { from: '2026-01-01', to: '2026-12-31' } }), res);
    assert.equal(res.body.trend.length, 1);
    assert.equal('keywords' in res.body.trend[0], false);
    assert.ok(res.body.trend[0].totals);
  } finally {
    restore();
  }
});

test('one keyword’s history is the thing the provider cannot answer at all', async () => {
  const restore = stubModels({
    snapshots: [
      makeSnapshot({
        periodKey: '2026-08-24',
        data: { keywords: [{ keyword: 'luxury lingerie', position: 3, ranked: true, status: 'ok' }] },
      }),
      makeSnapshot({
        periodKey: '2026-08-17',
        data: { keywords: [{ keyword: 'luxury lingerie', position: 8, ranked: true, status: 'ok' }] },
      }),
    ],
  });
  try {
    const res = fakeRes();
    await getConnectorData(req({ query: { keyword: 'Luxury Lingerie' } }), res);
    // Oldest first, matched case-insensitively.
    assert.deepEqual(res.body.keywordHistory.points.map((p) => p.position), [8, 3]);
  } finally {
    restore();
  }
});

test('a project that was unmapped keeps its history reachable', async () => {
  // Six months of collection does not stop mattering because somebody changed a
  // mapping. Hiding it would leave the rows on disk forever with no way in.
  const restore = stubModels({
    mappedProjects: [],
    withData: [OTHER_PROJECT],
    extraProjects: [makeProject({ _id: OTHER_PROJECT, group: null, board: null })],
  });
  try {
    const res = fakeRes();
    await getConnectorData(req(), res);
    assert.equal(res.body.projects.length, 1);
    assert.equal(res.body.projects[0].mappedHere, false);
    assert.equal(String(res.body.project._id), OTHER_PROJECT);
  } finally {
    restore();
  }
});

test('a board with nothing mapped and nothing collected answers cleanly', async () => {
  // Empty, not broken. The tab renders an EmptyState from this rather than
  // throwing on a null project.
  const restore = stubModels({ mappedProjects: [], withData: [], snapshots: [] });
  try {
    const res = fakeRes();
    await getConnectorData(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.project, null);
    assert.deepEqual(res.body.projects, []);
    assert.deepEqual(res.body.trend, []);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The date window
// ---------------------------------------------------------------------------

test('a malformed date is rejected, not coerced into "everything"', () => {
  // `new Date('last tuesday')` is Invalid Date, and letting that through would
  // silently widen the range.
  assert.equal(parseDay('last tuesday'), null);
  assert.equal(parseDay('2026-8-1'), null);
  assert.equal(parseDay(''), null);
  assert.equal(parseDay('2026-08-01'), '2026-08-01');
});

test('the window defaults to 90 days back from today', () => {
  const r = resolveRange({}, new Date('2026-08-27T10:00:00Z'));
  assert.equal(r.to, '2026-08-27');
  assert.equal(r.from, '2026-05-29');
});

test('`to` is deliberately NOT clamped to today', () => {
  // A board looking at a month that has not finished still wants the whole
  // month, and clamping would make the chart's right edge creep day by day.
  const r = resolveRange({ from: '2026-08-01', to: '2026-08-31' }, new Date('2026-08-10T00:00:00Z'));
  assert.equal(r.to, '2026-08-31');
});

test('a reversed range collapses rather than returning nothing', () => {
  const r = resolveRange({ from: '2026-09-01', to: '2026-08-01' });
  assert.equal(r.from, '2026-08-01');
  assert.equal(r.to, '2026-08-01');
});

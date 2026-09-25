const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const TaskGroup = require('../models/TaskGroup');
const ConnectorAccount = require('../models/ConnectorAccount');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');
const DfsTask = require('../models/DfsTask');
const DfsSerpResult = require('../models/DfsSerpResult');
const DfsCacheProbe = require('../models/DfsCacheProbe');
const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');

const {
  createConnectorSite,
  updateConnectorSite,
  launchConnectorSite,
  deleteConnectorSite,
  setConnectorProjectGroup,
} = require('./connectorController');

/**
 * THE STAGED SETUP'S LIFECYCLE, through the real gate.
 *
 * ---- What is being defended --------------------------------------------
 *
 * A draft is a row that is deliberately allowed to be incomplete, and the whole
 * safety of that rests on three claims:
 *
 *   1. A DRAFT IS NEVER COLLECTED FOR. It cannot be bound to a group, and the
 *      scheduler skips it. Two independent gates, because what is on the other
 *      side is money.
 *   2. `readSiteForm` IS STILL THE ONLY WAY OUT. Launch is the single moment the
 *      whole site is checked, and it checks the STORED row rather than trusting
 *      a browser that may have been open since yesterday.
 *   3. DELETING NEVER DISCARDS HISTORY. A site with readings is unmapped, not
 *      deleted, because the row parents every reading ever taken for the domain.
 *
 * Only the model lookups are stubbed. `loadBoardContext` and `resolveAccess` run
 * for real, so the two-layer AND of org role and board level is the one that
 * ships.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '7b466b99ea3ab35ff1378d01';
const VIEWER = '7b466b99ea3ab35ff1378d03';
const ORG = '7b466b99ea3ab35ff1378d10';
const BOARD = '7b466b99ea3ab35ff1378d20';
const GROUP = '7b466b99ea3ab35ff1378d30';
const PROJECT = '7b466b99ea3ab35ff1378d40';
const ACCOUNT = '7b466b99ea3ab35ff1378d50';

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
  members: [OWNER, VIEWER],
  roles,
  memberRoles: [{ user: VIEWER, role: roleId('viewer') }],
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

const chain = (value) => {
  const self = {
    sort: () => self,
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

const makeProjectDoc = (overrides = {}) => {
  const doc = {
    _id: PROJECT,
    account: ACCOUNT,
    organisation: ORG,
    provider: 'dataforseo',
    externalId: PROJECT,
    name: 'Acme',
    domain: 'acme.com',
    scope: 'domain',
    scopePath: '',
    status: 'live',
    trackedKeywords: ['best crm'],
    targets: [{ locationCode: 2840, languageCode: 'en', device: 'desktop', label: null }],
    competitors: [],
    businessName: '',
    locallyAuthored: true,
    group: null,
    board: null,
    saved: 0,
    ...overrides,
  };
  doc.save = async () => {
    doc.saved += 1;
  };
  return doc;
};

const req = (overrides = {}) => ({
  params: {
    boardId: BOARD,
    provider: 'dataforseo',
    projectId: PROJECT,
    ...(overrides.params || {}),
  },
  query: {},
  body: overrides.body === undefined ? {} : overrides.body,
  user: { userId: overrides.userId || OWNER },
});

const stubModels = ({
  board = makeBoard(),
  org = makeOrg(),
  accounts = [{ _id: ACCOUNT, organisation: ORG, provider: 'dataforseo', label: 'Main', status: 'active' }],
  clash = null,
  projectDoc = null,
  otherProject = null,
  group = { _id: GROUP, board: BOARD, name: 'Acme Ltd' },
  snapshotCount = 0,
  openJobs = [],
} = {}) => {
  const originals = {
    boardFindById: Board.findById,
    orgFindById: Organisation.findById,
    groupFindById: TaskGroup.findById,
    accountFind: ConnectorAccount.find,
    accountFindOne: ConnectorAccount.findOne,
    projectFindOne: ConnectorProject.findOne,
    projectCreate: ConnectorProject.create,
    projectDelete: ConnectorProject.deleteOne,
    snapshotCount: ConnectorSnapshot.countDocuments,
    // The delete path's outstanding-job sweep. Stubbed for the same reason
    // everything above is: this file runs the real handler against no database,
    // so a model the handler reaches and the stub does not is a ten-second
    // buffering timeout, not a failed assertion about behaviour.
    dfsTaskFind: DfsTask.find,
    dfsTaskUpdateOne: DfsTask.updateOne,
    serpDelete: DfsSerpResult.deleteMany,
    probeDelete: DfsCacheProbe.deleteMany,
  };
  const calls = { created: [], deleted: [], closedJobs: [], swept: [] };

  Board.findById = () => Promise.resolve(board);
  Organisation.findById = () => Promise.resolve(org);
  TaskGroup.findById = () => chain(group);
  ConnectorAccount.find = () => chain(accounts);
  ConnectorAccount.findOne = () => chain(accounts[0] || null);

  ConnectorProject.findOne = (filter) => {
    // The clash lookup names a domain; the "is this group taken" lookup names a
    // group; everything else is the document the handler is going to save.
    if (filter && filter.domain) return chain(clash);
    if (filter && filter.group) return chain(otherProject);
    return Promise.resolve(projectDoc);
  };
  ConnectorProject.create = async (doc) => {
    calls.created.push(doc);
    return doc;
  };
  ConnectorProject.deleteOne = async (filter) => {
    calls.deleted.push(filter);
    return { deletedCount: 1 };
  };
  ConnectorSnapshot.countDocuments = async () => snapshotCount;

  // A site with no readings has, by construction, no bodies and no probes — the
  // `HAS_HISTORY` refusal above is what guarantees it — so the sweeps are
  // recorded rather than populated. `openJobs` lets a test hand the handler an
  // outstanding purchase to close.
  DfsTask.find = () => chain(openJobs);
  DfsTask.updateOne = async (filter, update) => {
    calls.closedJobs.push({ filter, update });
    return { modifiedCount: 1 };
  };
  DfsSerpResult.deleteMany = async (filter) => {
    calls.swept.push({ model: 'DfsSerpResult', filter });
    return { deletedCount: 0 };
  };
  DfsCacheProbe.deleteMany = async (filter) => {
    calls.swept.push({ model: 'DfsCacheProbe', filter });
    return { deletedCount: 0 };
  };

  return {
    calls,
    restore: () => {
      Board.findById = originals.boardFindById;
      Organisation.findById = originals.orgFindById;
      TaskGroup.findById = originals.groupFindById;
      ConnectorAccount.find = originals.accountFind;
      ConnectorAccount.findOne = originals.accountFindOne;
      ConnectorProject.findOne = originals.projectFindOne;
      ConnectorProject.create = originals.projectCreate;
      ConnectorProject.deleteOne = originals.projectDelete;
      ConnectorSnapshot.countDocuments = originals.snapshotCount;
      DfsTask.find = originals.dfsTaskFind;
      DfsTask.updateOne = originals.dfsTaskUpdateOne;
      DfsSerpResult.deleteMany = originals.serpDelete;
      DfsCacheProbe.deleteMany = originals.probeDelete;
    },
  };
};

const run = async (handler, request, opts = {}) => {
  const stubs = stubModels(opts);
  const res = fakeRes();
  try {
    await handler(request, res);
  } finally {
    stubs.restore();
  }
  return { res, calls: stubs.calls };
};

// ---------------------------------------------------------------------------
// Creating a draft
// ---------------------------------------------------------------------------

test('a draft is created from a domain alone, and is born inert', async () => {
  const { res, calls } = await run(
    createConnectorSite,
    req({ body: { draft: true, domain: 'https://www.acme.com/pricing?x=1' } })
  );

  assert.equal(res.statusCode, 201);
  const created = calls.created[0];
  assert.equal(created.status, 'draft');
  // `www.` is kept — for a rank tracker it is a different target.
  assert.equal(created.domain, 'www.acme.com');
  assert.equal(created.name, 'www.acme.com');
  assert.equal(created.locallyAuthored, true);
  // Nothing to collect, and nothing claiming there is.
  assert.equal(created.trackedKeywords, undefined);
  assert.equal(created.targets, undefined);
});

test('a draft still refuses a domain that is not one', async () => {
  const { res } = await run(
    createConnectorSite,
    req({ body: { draft: true, domain: 'not a domain' } })
  );
  assert.equal(res.statusCode, 400);
});

test('a draft is refused a domain another site already holds', async () => {
  const { res } = await run(
    createConnectorSite,
    req({ body: { draft: true, domain: 'acme.com' } }),
    { clash: { _id: 'x', name: 'Acme', domain: 'acme.com' } }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'DOMAIN_TAKEN');
});

test('without the draft flag the full form still applies', async () => {
  /**
   * The one-shot create has not been loosened. A body with no keywords is
   * refused exactly as it always was — the draft path is a different reader,
   * not a softer version of this one.
   */
  const { res } = await run(createConnectorSite, req({ body: { domain: 'acme.com' } }));
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// Patching a draft vs replacing a live site
// ---------------------------------------------------------------------------

test('a draft is PATCHED: one step cannot erase another', async () => {
  const doc = makeProjectDoc({
    status: 'draft',
    trackedKeywords: [],
    targets: [{ locationCode: 2840, languageCode: 'en', device: 'desktop', label: null }],
  });

  const { res } = await run(
    updateConnectorSite,
    req({ body: { trackedKeywords: ['best crm', 'seo audit'] } }),
    { projectDoc: doc }
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(doc.trackedKeywords, ['best crm', 'seo audit']);
  // The markets saved on an earlier step survived a request that did not mention
  // them. This is the whole reason a draft is not a full replacement.
  assert.equal(doc.targets.length, 1);
  assert.equal(doc.status, 'draft', 'patching does not finish the setup');
});

test('a LIVE site is still a full replacement, and a partial body is refused', async () => {
  const doc = makeProjectDoc({ status: 'live' });

  const { res } = await run(
    updateConnectorSite,
    req({ body: { trackedKeywords: ['best crm'] } }),
    { projectDoc: doc }
  );

  // No domain and no targets in the body: the full reader says so rather than
  // quietly keeping what was there.
  assert.equal(res.statusCode, 400);
  assert.equal(doc.saved, 0);
});

// ---------------------------------------------------------------------------
// The two gates that keep a draft from costing anything
// ---------------------------------------------------------------------------

test('a draft CANNOT be mapped to a group', async () => {
  const doc = makeProjectDoc({ status: 'draft', trackedKeywords: [], targets: [] });

  const { res } = await run(setConnectorProjectGroup, req({ body: { group: GROUP } }), {
    projectDoc: doc,
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'SITE_DRAFT');
  assert.equal(doc.saved, 0, 'nothing was written');
});

test('UNMAPPING a draft is always allowed — it can only reduce what is collected', async () => {
  const doc = makeProjectDoc({ status: 'draft', group: GROUP, board: BOARD });

  const { res } = await run(setConnectorProjectGroup, req({ body: { group: null } }), {
    projectDoc: doc,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(doc.group, null);
});

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

test('launch validates the STORED row, not the request', async () => {
  /**
   * The wizard's last step sends nothing new, so the check has to run against
   * what the server holds. A tab left open overnight cannot launch yesterday's
   * keyword list.
   */
  const doc = makeProjectDoc({
    status: 'draft',
    trackedKeywords: ['best crm', 'seo audit'],
    targets: [{ locationCode: 2840, languageCode: 'en', device: 'desktop', label: 'US' }],
  });

  const { res } = await run(launchConnectorSite, req({ body: {} }), { projectDoc: doc });

  assert.equal(res.statusCode, 200);
  assert.equal(doc.status, 'live');
  assert.equal(doc.saved, 1);
  assert.equal(res.body.project.status, 'live');
});

test('launch REFUSES a draft that is not collectable, and leaves it a draft', async () => {
  const doc = makeProjectDoc({ status: 'draft', trackedKeywords: [], targets: [] });

  const { res } = await run(launchConnectorSite, req({ body: {} }), { projectDoc: doc });

  assert.equal(res.statusCode, 400);
  assert.equal(doc.status, 'draft', 'a failed launch must not half-finish the site');
  assert.equal(doc.saved, 0);
});

test('launch refuses a search operator, which is a x5 cost multiplier', async () => {
  const doc = makeProjectDoc({ status: 'draft' });

  const { res } = await run(
    launchConnectorSite,
    req({ body: { trackedKeywords: ['site:acme.com'] } }),
    { projectDoc: doc }
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'SEARCH_OPERATOR');
  assert.equal(doc.status, 'draft');
});

test('launch refuses a mirrored project — those are set up at the provider', async () => {
  const doc = makeProjectDoc({ status: 'draft', locallyAuthored: false });
  const { res } = await run(launchConnectorSite, req({ body: {} }), { projectDoc: doc });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'NOT_AUTHORED');
});

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

test('a site with no readings is deleted', async () => {
  const doc = makeProjectDoc({ status: 'draft' });
  const { res, calls } = await run(deleteConnectorSite, req(), {
    projectDoc: doc,
    snapshotCount: 0,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, String(PROJECT));
  assert.equal(calls.deleted.length, 1);
});

test('a site that has COLLECTED anything is refused, because the row parents its history', async () => {
  const doc = makeProjectDoc({ status: 'live' });
  const { res, calls } = await run(deleteConnectorSite, req(), {
    projectDoc: doc,
    snapshotCount: 42,
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'HAS_HISTORY');
  assert.match(res.body.error, /Unmap it/);
  assert.equal(calls.deleted.length, 0, 'nothing was removed');
});

test('deleting is `connector.manage`, so a viewer cannot', async () => {
  const { res } = await run(deleteConnectorSite, req({ userId: VIEWER }), {
    board: makeBoard({ visibility: 'public', publicDefaultLevel: 'view' }),
    projectDoc: makeProjectDoc(),
  });
  assert.equal(res.statusCode, 403);
});

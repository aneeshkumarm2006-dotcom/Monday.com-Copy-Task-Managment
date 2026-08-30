const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const ConnectorAccount = require('../models/ConnectorAccount');
const ConnectorProject = require('../models/ConnectorProject');
const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');

const { createConnectorSite, updateConnectorSite } = require('./connectorController');

/**
 * Sites — a project this app AUTHORS, exercised through its real gate.
 *
 * ---- Why these endpoints exist at all --------------------------------------
 *
 * Every other project in this collection is a mirror of somebody else's record.
 * DataForSEO has no record to mirror: it is a stateless billing API that takes a
 * keyword, a location, a language and a device on every call and remembers
 * nothing between them. So the row is the original, `externalId` is our own id,
 * and there has to be a way to create one.
 *
 * ---- What is actually being defended ---------------------------------------
 *
 * This document is what a collection is BOUGHT FROM. Its keyword list times its
 * target list is the size of the bill, which is why the gate is
 * `connector.manage`, why search operators are refused here rather than in a
 * form, and why the whole thing is a full replacement rather than a patch.
 *
 * Only the model lookups are stubbed. `loadBoardContext` and `resolveAccess` run
 * for real, so the two-layer AND of org role and board level is the one that
 * actually ships.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '6b466b99ea3ab35ff1378d01';
const MEMBER = '6b466b99ea3ab35ff1378d02';
const VIEWER = '6b466b99ea3ab35ff1378d03';
const ORG = '6b466b99ea3ab35ff1378d10';
const BOARD = '6b466b99ea3ab35ff1378d20';
const PROJECT = '6b466b99ea3ab35ff1378d40';
const ACCOUNT = '6b466b99ea3ab35ff1378d50';
const OTHER_ACCOUNT = '6b466b99ea3ab35ff1378d51';

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

const SITE = {
  name: 'Acme',
  domain: 'https://acme.com/pricing',
  trackedKeywords: ['Best CRM', 'best crm', 'seo audit'],
  targets: [
    { locationCode: 2840, languageCode: 'en', device: 'desktop', label: 'United States' },
  ],
  competitors: ['rival.com'],
};

const req = (overrides = {}) => ({
  params: { boardId: BOARD, provider: 'dataforseo', ...(overrides.params || {}) },
  query: {},
  body: overrides.body === undefined ? { ...SITE } : overrides.body,
  user: { userId: overrides.userId || OWNER },
});

const account = (overrides = {}) => ({
  _id: ACCOUNT,
  organisation: ORG,
  provider: 'dataforseo',
  label: 'Main',
  status: 'active',
  ...overrides,
});

/** A stand-in for a loaded ConnectorProject document. */
const makeProjectDoc = (overrides = {}) => {
  const doc = {
    _id: PROJECT,
    account: ACCOUNT,
    organisation: ORG,
    provider: 'dataforseo',
    externalId: PROJECT,
    name: 'Acme',
    domain: 'acme.com',
    trackedKeywords: ['best crm'],
    targets: [{ locationCode: 2840, languageCode: 'en', device: 'desktop', label: null }],
    competitors: [],
    locallyAuthored: true,
    saved: 0,
    ...overrides,
  };
  doc.save = async () => {
    doc.saved += 1;
    if (doc.saveError) throw doc.saveError;
  };
  return doc;
};

const stubModels = ({
  board = makeBoard(),
  org = makeOrg(),
  accounts = [account()],
  accountRow = undefined,
  clash = null,
  projectDoc = null,
  createError = null,
} = {}) => {
  const originals = {
    boardFindById: Board.findById,
    orgFindById: Organisation.findById,
    accountFind: ConnectorAccount.find,
    accountFindOne: ConnectorAccount.findOne,
    projectFindOne: ConnectorProject.findOne,
    projectCreate: ConnectorProject.create,
  };
  const calls = { created: [], clashFilters: [] };

  Board.findById = () => Promise.resolve(board);
  Organisation.findById = () => Promise.resolve(org);
  ConnectorAccount.find = () => chain(accounts);
  ConnectorAccount.findOne = () =>
    chain(accountRow === undefined ? accounts[0] || null : accountRow);

  // Two shapes share this static: the handler loads the project as a DOCUMENT
  // (it gets saved) and separately looks for a same-domain clash with `.lean()`.
  // `domain` in the filter tells them apart.
  ConnectorProject.findOne = (filter) => {
    if (filter && filter.domain) {
      calls.clashFilters.push(filter);
      return chain(clash);
    }
    return Promise.resolve(projectDoc);
  };
  ConnectorProject.create = async (doc) => {
    calls.created.push(doc);
    if (createError) throw createError;
    return doc;
  };

  return {
    calls,
    restore: () => {
      Board.findById = originals.boardFindById;
      Organisation.findById = originals.orgFindById;
      ConnectorAccount.find = originals.accountFind;
      ConnectorAccount.findOne = originals.accountFindOne;
      ConnectorProject.findOne = originals.projectFindOne;
      ConnectorProject.create = originals.projectCreate;
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
// 1. The gate
// ---------------------------------------------------------------------------

test('a standard board has no connectors to be refused access to', async () => {
  const { res } = await run(createConnectorSite, req(), {
    board: makeBoard({ boardType: 'standard' }),
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'NOT_TRACKER_BOARD');
});

test('a viewer cannot author a site — this is what gets bought', async () => {
  const { res, calls } = await run(createConnectorSite, req({ userId: VIEWER }), {
    board: makeBoard({ visibility: 'public', publicDefaultLevel: 'view' }),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(calls.created.length, 0);
});

test('a provider that MIRRORS its projects refuses to have one invented', async () => {
  // The mirror of `saveCredentials` refusing a consent provider. Ubersuggest
  // projects exist at Ubersuggest, and a row we made up here would be a project
  // no `list_projects` will ever return — permanently `missing` on the first
  // refresh.
  const { res, calls } = await run(
    createConnectorSite,
    req({ params: { provider: 'ubersuggest' } })
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'NOT_AUTHORED');
  assert.equal(calls.created.length, 0);
});

test('an unknown provider is a 400 before anything is read', async () => {
  const { res } = await run(createConnectorSite, req({ params: { provider: 'nope' } }));
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// 2. Creating a site
// ---------------------------------------------------------------------------

test('a site is created with OUR id as its externalId', async () => {
  const { res, calls } = await run(createConnectorSite, req());

  assert.equal(res.statusCode, 201);
  assert.equal(calls.created.length, 1);
  const doc = calls.created[0];

  // The provider has no id to offer and the field is required, indexed and
  // unique per account. Ours, spelled once, keeps that index doing real work —
  // and two identifiers for one row could not drift apart if they are the same
  // value.
  assert.equal(doc.externalId, String(doc._id));
  assert.equal(doc.locallyAuthored, true);
  assert.equal(doc.raw, null);
  assert.equal(doc.missing, false);
  assert.equal(String(doc.account), ACCOUNT);
  assert.equal(String(doc.organisation), ORG);

  // Normalised on the way in, by the provider's own reader.
  assert.equal(doc.domain, 'acme.com');
  assert.deepEqual(doc.trackedKeywords, ['best crm', 'seo audit']);
  assert.equal(doc.keywordCount, 2);
  assert.deepEqual(doc.targets, [
    { locationCode: 2840, languageCode: 'en', device: 'desktop', label: 'United States' },
  ]);

  // And the response is the ordinary public shape, carrying the authored half.
  assert.deepEqual(res.body.project.trackedKeywords, ['best crm', 'seo audit']);
  assert.equal(res.body.project.locallyAuthored, true);
  assert.equal(res.body.project.targets[0].locationCode, 2840);
});

test('a search operator is refused at the ENDPOINT, not just in a form', async () => {
  // x5 per operator, and they stack. A cost multiplier that only a browser
  // checks is a cost multiplier.
  const { res, calls } = await run(
    createConnectorSite,
    req({ body: { ...SITE, trackedKeywords: ['best crm', 'site:acme.com'] } })
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'SEARCH_OPERATOR');
  assert.match(res.body.error, /site:acme\.com/);
  assert.match(res.body.error, /five times/);
  assert.equal(calls.created.length, 0);
});

test('the keyword cap and the target cap are enforced server-side', async () => {
  const many = Array.from({ length: 201 }, (_, i) => `keyword ${i}`);
  const tooManyKeywords = await run(
    createConnectorSite,
    req({ body: { ...SITE, trackedKeywords: many } })
  );
  assert.equal(tooManyKeywords.res.statusCode, 400);
  assert.equal(tooManyKeywords.calls.created.length, 0);

  const targets = Array.from({ length: 5 }, (_, i) => ({
    locationCode: 2840 + i,
    languageCode: 'en',
  }));
  const tooManyTargets = await run(
    createConnectorSite,
    req({ body: { ...SITE, targets } })
  );
  assert.equal(tooManyTargets.res.statusCode, 400);
  assert.equal(tooManyTargets.calls.created.length, 0);
});

test('a site needs somewhere to be collected FROM', async () => {
  const noAccount = await run(createConnectorSite, req(), { accounts: [] });
  assert.equal(noAccount.res.statusCode, 409);
  assert.equal(noAccount.res.body.code, 'NO_ACCOUNT');

  // With several in the pool, picking one for somebody would attach a client's
  // site to whichever account sorted first.
  const ambiguous = await run(createConnectorSite, req(), {
    accounts: [account(), account({ _id: OTHER_ACCOUNT, label: 'Second' })],
  });
  assert.equal(ambiguous.res.statusCode, 400);
  assert.match(ambiguous.res.body.error, /which connected account/);

  // Named explicitly, it works.
  const named = await run(
    createConnectorSite,
    req({ body: { ...SITE, account: OTHER_ACCOUNT } }),
    { accountRow: account({ _id: OTHER_ACCOUNT, label: 'Second' }) }
  );
  assert.equal(named.res.statusCode, 201);
  assert.equal(String(named.calls.created[0].account), OTHER_ACCOUNT);
});

test('an account from another workspace is a 404, not a silent cross-org write', async () => {
  const { res, calls } = await run(
    createConnectorSite,
    req({ body: { ...SITE, account: OTHER_ACCOUNT } }),
    { accountRow: null }
  );
  assert.equal(res.statusCode, 404);
  assert.equal(calls.created.length, 0);
});

test('one domain per workspace per provider, and the index is still the authority', async () => {
  const clashing = await run(createConnectorSite, req(), {
    clash: { _id: 'other', name: 'Acme', domain: 'acme.com' },
  });
  assert.equal(clashing.res.statusCode, 409);
  assert.equal(clashing.res.body.code, 'DOMAIN_TAKEN');
  assert.equal(clashing.calls.created.length, 0);
  assert.deepEqual(clashing.calls.clashFilters[0], {
    organisation: ORG,
    provider: 'dataforseo',
    domain: 'acme.com',
  });

  // Two admins racing both pass the check above.
  const raced = await run(createConnectorSite, req(), {
    createError: Object.assign(new Error('dup'), { code: 11000 }),
  });
  assert.equal(raced.res.statusCode, 409);
});

// ---------------------------------------------------------------------------
// 3. Editing a site
// ---------------------------------------------------------------------------

test('an edit REPLACES the authored fields and leaves the binding alone', async () => {
  const doc = makeProjectDoc({
    group: 'a-group',
    board: BOARD,
    trackedKeywords: ['best crm', 'seo audit', 'crm pricing', 'crm reviews'],
  });
  const { res } = await run(
    updateConnectorSite,
    req({
      params: { projectId: PROJECT },
      body: { ...SITE, trackedKeywords: ['best crm'], competitors: [] },
    }),
    { projectDoc: doc }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(doc.saved, 1);
  // A full replacement: an edit that drops three keywords has to be able to say
  // so. A partial update of a list costs money in one direction and loses
  // history in the other.
  assert.deepEqual(doc.trackedKeywords, ['best crm']);
  assert.equal(doc.keywordCount, 1);
  assert.deepEqual(doc.competitors, []);

  // And the things an edit must never be mistaken for: this is the same site.
  assert.equal(doc.group, 'a-group');
  assert.equal(String(doc.account), ACCOUNT);
  assert.equal(doc.externalId, PROJECT);
  assert.equal(doc.locallyAuthored, true);
});

test('a MIRRORED project cannot be edited here', async () => {
  // Our edit and the next refresh would be in a fight the refresh always wins.
  const doc = makeProjectDoc({ locallyAuthored: false });
  const { res } = await run(
    updateConnectorSite,
    req({ params: { projectId: PROJECT } }),
    { projectDoc: doc }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'NOT_AUTHORED');
  assert.equal(doc.saved, 0);
});

test('an edit to a site in another workspace is a 404', async () => {
  const { res } = await run(
    updateConnectorSite,
    req({ params: { projectId: PROJECT } }),
    { projectDoc: null }
  );
  assert.equal(res.statusCode, 404);
});

test('a bad project id is refused before anything is loaded', async () => {
  const { res } = await run(updateConnectorSite, req({ params: { projectId: 'nope' } }));
  assert.equal(res.statusCode, 400);
});

test('renaming a site onto another site domain is a 409; keeping its own is not', async () => {
  const doc = makeProjectDoc({ domain: 'acme.com' });
  const moved = await run(
    updateConnectorSite,
    req({ params: { projectId: PROJECT }, body: { ...SITE, domain: 'rival.com' } }),
    { projectDoc: doc, clash: { _id: 'other', domain: 'rival.com' } }
  );
  assert.equal(moved.res.statusCode, 409);
  assert.equal(moved.res.body.code, 'DOMAIN_TAKEN');
  assert.equal(doc.saved, 0);

  // Saving without changing the domain must not collide with ITSELF.
  const same = makeProjectDoc({ domain: 'acme.com' });
  const kept = await run(
    updateConnectorSite,
    req({ params: { projectId: PROJECT } }),
    { projectDoc: same, clash: { _id: PROJECT, domain: 'acme.com' } }
  );
  assert.equal(kept.res.statusCode, 200);
  assert.equal(same.saved, 1);
});

test('a viewer cannot edit a site either', async () => {
  const doc = makeProjectDoc();
  const { res } = await run(
    updateConnectorSite,
    req({ params: { projectId: PROJECT }, userId: VIEWER }),
    {
      board: makeBoard({ visibility: 'public', publicDefaultLevel: 'view' }),
      projectDoc: doc,
    }
  );
  assert.equal(res.statusCode, 403);
  assert.equal(doc.saved, 0);
});

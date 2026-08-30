const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const Organisation = require('../../models/Organisation');
const ConnectorAccount = require('../../models/ConnectorAccount');
const connectorCrypto = require('../../utils/connectorCrypto');
const { SYSTEM_ROLES, sanitizePermissions } = require('../../utils/capabilities');

const {
  getConnector,
  listConnectors,
  validateDescriptor,
  checkRegistry,
} = require('./index');
const { SOURCE_TYPES } = require('./fieldMapping');
const { openSession } = require('./session');
const {
  saveCredentials,
  startAuthorization,
  readCredentialForm,
} = require('../../controllers/connectorController');

/**
 * The credential seam — a second way to connect an account, for a provider that
 * issues a key instead of running an authorization server.
 *
 * ---- What was in the way ---------------------------------------------------
 *
 * `validateDescriptor` required `oauth.buildAuthorizeUrl` outright, and
 * `handleCallback` was the ONLY code path in the app that had ever created a
 * `ConnectorAccount`. Between them, a provider whose entire authentication is a
 * login and a password could be written, registered, and then never connected to
 * anything — with the failure appearing as a 500 from a consent flow that had
 * nowhere to send the browser.
 *
 * ---- What is deliberately unchanged ----------------------------------------
 *
 *   `connectorCrypto`      — it seals arbitrary JSON already, with `orgId|
 *                            provider` as AAD. A "credential" envelope variant
 *                            would be a second format and a second keyring for
 *                            no gain, and the tests below assert the ordinary
 *                            one round-trips a `{login, password}` pair.
 *   `ConnectorAuthAttempt` — `codeVerifier` and `redirectUri` are both `required`
 *                            and both meaningless for a request that has no
 *                            round trip to protect. Loosening them would weaken
 *                            the record that makes the public callback safe.
 *   the Vault              — zero-knowledge by construction: the key is derived
 *                            in the browser. A weekly sync at 04:00 has no
 *                            browser and nobody to type a passphrase.
 *
 * ---- And the rule the whole feature is under -------------------------------
 *
 * A credential goes IN and never comes back out. There is no GET, the response
 * is a `publicAccount`, and `sealedTokens` stays `select: false`.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '6c466b99ea3ab35ff1378d01';
const MEMBER = '6c466b99ea3ab35ff1378d02';
const ORG = '6c466b99ea3ab35ff1378d10';
const ACCOUNT = '6c466b99ea3ab35ff1378d20';

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
  members: [OWNER, MEMBER],
  roles,
  memberRoles: [{ user: MEMBER, role: roleId('member') }],
  ensureSystemRoles: () => false,
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

const req = (overrides = {}) => ({
  params: { orgId: ORG, provider: 'dataforseo', ...(overrides.params || {}) },
  query: {},
  body: overrides.body || {},
  user: { userId: overrides.userId || OWNER },
});

const GOOD = { login: 'ops@example.com', password: 'sup3r-secret-value' };

/**
 * Stub only the model calls. `loadOrgContext` and `resolveOrgAccess` run for
 * real, so the gate under test is the one that actually ships.
 */
const stubModels = ({
  org = makeOrg(),
  clash = null,
  created = null,
  updated = null,
  /**
   * What the provider says about the credential before it is stored.
   *
   * Phase 1 gave the descriptor a `verifyCredentials`, so `saveCredentials` now
   * asks the provider whether a key is real before sealing it — there is no
   * consent screen to fail, and without the check a mistyped API password is
   * stored, reported as success, and only surfaces days later as a cron job
   * marking the account `needs_reauth`.
   *
   * Stubbed here rather than left live for the obvious reason: nothing in this
   * suite may depend on a network, and there is no live key. `false` is a
   * REFUSAL (a wrong password); an Error is "we could not find out", which the
   * handler must treat differently.
   */
  verify = true,
} = {}) => {
  const descriptor = getConnector('dataforseo');
  const originals = {
    orgFindById: Organisation.findById,
    findOne: ConnectorAccount.findOne,
    create: ConnectorAccount.create,
    findOneAndUpdate: ConnectorAccount.findOneAndUpdate,
    verifyCredentials: descriptor.verifyCredentials,
  };
  const calls = { created: [], updated: [], verified: [] };

  descriptor.verifyCredentials = async (credentials) => {
    calls.verified.push(credentials);
    if (verify instanceof Error) throw verify;
    if (verify === false) {
      const err = new Error('DataForSEO rejected the credentials.');
      err.needsReauth = true;
      throw err;
    }
    return { externalEmail: 'ops@example.com', tier: 'pay-as-you-go' };
  };

  Organisation.findById = () => Promise.resolve(org);
  ConnectorAccount.findOne = () => chain(clash);
  ConnectorAccount.create = async (doc) => {
    calls.created.push(doc);
    if (created instanceof Error) throw created;
    return { toObject: () => ({ _id: ACCOUNT, ...doc }) };
  };
  ConnectorAccount.findOneAndUpdate = (filter, update) => {
    calls.updated.push({ filter, update });
    return chain(updated === undefined ? null : updated);
  };

  return {
    calls,
    restore: () => {
      Organisation.findById = originals.orgFindById;
      ConnectorAccount.findOne = originals.findOne;
      ConnectorAccount.create = originals.create;
      ConnectorAccount.findOneAndUpdate = originals.findOneAndUpdate;
      descriptor.verifyCredentials = originals.verifyCredentials;
    },
  };
};

const post = async (body, opts = {}) => {
  const stubs = stubModels(opts);
  const res = fakeRes();
  try {
    await saveCredentials(req({ body, userId: opts.userId }), res);
  } finally {
    stubs.restore();
  }
  return { res, calls: stubs.calls };
};

// ---------------------------------------------------------------------------
// 1. The registry accepts a second authentication mode
// ---------------------------------------------------------------------------

const apiKeyDescriptor = (overrides = {}) => ({
  name: 'keyed',
  label: 'Keyed',
  blurb: 'A provider with no authorization server.',
  requiresBrowserConsent: false,
  syncIntervalHours: 168,
  apiKey: {
    label: 'API credentials',
    fields: [
      { key: 'login', label: 'Login', secret: false },
      { key: 'password', label: 'Password', secret: true },
    ],
  },
  refreshTokens: async () => {
    const err = new Error('wrong');
    err.needsReauth = true;
    throw err;
  },
  ...overrides,
});

test('a descriptor with an apiKey form and no oauth is valid', () => {
  assert.deepEqual(validateDescriptor('keyed', apiKeyDescriptor()), []);
});

test('EXACTLY one authentication mode — never both', () => {
  const both = apiKeyDescriptor({
    oauth: { buildAuthorizeUrl: () => 'https://example.com' },
  });
  assert.match(
    validateDescriptor('keyed', both).join(' '),
    /declares both oauth and apiKey/
  );
});

test('a descriptor with neither still fails on the oauth sentence it always did', () => {
  // The existing message is load-bearing: `registrySeam.test.js` matches on it,
  // and a provider that simply forgot its auth block is far more likely to be an
  // unfinished OAuth one than an unfinished keyed one.
  const neither = apiKeyDescriptor({ apiKey: undefined });
  assert.match(
    validateDescriptor('keyed', neither).join(' '),
    /no usable oauth.buildAuthorizeUrl/
  );
});

test('the four ways a credential form goes wrong are each named', () => {
  const withForm = (apiKey) => apiKeyDescriptor({ apiKey });

  assert.match(
    validateDescriptor('keyed', withForm({ fields: [{ key: 'k', label: 'K', secret: true }] })).join(' '),
    /apiKey has no label/
  );
  assert.match(
    validateDescriptor('keyed', withForm({ label: 'X', fields: [] })).join(' '),
    /apiKey declares no fields/
  );
  assert.match(
    validateDescriptor(
      'keyed',
      withForm({
        label: 'X',
        fields: [
          { key: 'k', label: 'K', secret: true },
          { key: 'k', label: 'K again', secret: true },
        ],
      })
    ).join(' '),
    /apiKey declares field "k" twice/
  );
  // A form with nothing secret on it is a settings panel, not a credential —
  // and there would be nothing for the UI to mask or `preview` to summarise.
  assert.match(
    validateDescriptor('keyed', withForm({ label: 'X', fields: [{ key: 'k', label: 'K' }] })).join(' '),
    /apiKey marks no field secret/
  );
});

test('a keyed provider may not claim it needs a browser, and must declare refreshTokens', () => {
  // The flag is what `ConnectorsTab` branches on. A keyed provider that claims
  // otherwise gets the consent dialog and no key box: a form nobody can complete.
  assert.match(
    validateDescriptor('keyed', apiKeyDescriptor({ requiresBrowserConsent: true })).join(' '),
    /claims requiresBrowserConsent/
  );
  // Nothing to refresh, but a 401 still has to land somewhere. Without this the
  // failure is a TypeError inside a cron job nobody is watching.
  assert.match(
    validateDescriptor('keyed', apiKeyDescriptor({ refreshTokens: undefined })).join(' '),
    /declares no refreshTokens/
  );
});

test('the shipped registry still validates, with two providers and two modes', () => {
  assert.equal(checkRegistry().ok, true);
  assert.equal(getConnector('ubersuggest').requiresBrowserConsent, true);
  assert.equal(getConnector('dataforseo').requiresBrowserConsent, false);
  assert.equal(getConnector('ubersuggest').apiKey, undefined);
  assert.ok(getConnector('dataforseo').apiKey);
  assert.equal(getConnector('dataforseo').oauth, undefined);
});

// ---------------------------------------------------------------------------
// 2. The catalog carries the empty form, and nothing else
// ---------------------------------------------------------------------------

test('the catalog carries a credential FORM and never a value', () => {
  const byName = Object.fromEntries(listConnectors().map((c) => [c.name, c]));

  assert.equal(byName.ubersuggest.credentialForm, null);

  const form = byName.dataforseo.credentialForm;
  assert.equal(typeof form.label, 'string');
  assert.deepEqual(
    form.fields.map((f) => f.key),
    ['login', 'password']
  );
  assert.equal(form.fields.find((f) => f.key === 'password').secret, true);
  // The login is the account email, not a credential on its own, and showing it
  // is how somebody tells two stored accounts apart.
  assert.equal(form.fields.find((f) => f.key === 'login').secret, false);

  // Nothing executable, and nothing beyond the shape of an empty form. The whole
  // catalog is serialised to every member of the org on board load.
  const serialised = JSON.parse(JSON.stringify(byName.dataforseo));
  assert.deepEqual(serialised.credentialForm, form);
  for (const field of form.fields) {
    assert.deepEqual(Object.keys(field).sort(), [
      'help',
      'key',
      'label',
      'placeholder',
      'secret',
    ]);
  }
});

// ---------------------------------------------------------------------------
// 3. Reading the posted form
// ---------------------------------------------------------------------------

const SPEC = getConnector('dataforseo').apiKey;

test('the credential is built from the DESCRIPTOR, never from the request', () => {
  // The direction is the point: a client cannot introduce a property, so nothing
  // unexpected reaches `sealJson` and lives forever inside an envelope nobody
  // will think to look in.
  const out = readCredentialForm(SPEC, {
    credentials: { ...GOOD, apiKey: 'smuggled', __proto__: 'nope' },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(Object.keys(out.credentials).sort(), ['login', 'password']);
});

test('every declared field is required, and the refusal names the field', () => {
  assert.deepEqual(readCredentialForm(SPEC, { credentials: { login: 'a@b.c' } }), {
    ok: false,
    error: 'API password is required.',
  });
  assert.deepEqual(readCredentialForm(SPEC, { credentials: { ...GOOD, password: '   ' } }), {
    ok: false,
    error: 'API password is required.',
  });
  assert.equal(readCredentialForm(SPEC, {}).ok, false);
  assert.equal(readCredentialForm(SPEC, { credentials: 'nope' }).ok, false);
  assert.equal(readCredentialForm(SPEC, { credentials: ['nope'] }).ok, false);
});

test('values are trimmed and capped', () => {
  const out = readCredentialForm(SPEC, {
    credentials: { login: '  ops@example.com  ', password: ' pw ' },
  });
  assert.deepEqual(out.credentials, { login: 'ops@example.com', password: 'pw' });

  // A mistyped paste of a whole file must not become a sealed envelope the size
  // of a document.
  assert.equal(
    readCredentialForm(SPEC, { credentials: { ...GOOD, password: 'x'.repeat(501) } }).ok,
    false
  );
});

// ---------------------------------------------------------------------------
// 4. The endpoint
// ---------------------------------------------------------------------------

test('only an org admin may store a credential', async () => {
  const { res, calls } = await post({ label: 'Main', credentials: GOOD }, { userId: MEMBER });
  assert.equal(res.statusCode, 403);
  assert.equal(calls.created.length, 0);
});

test('a good POST seals the credential and answers with an account carrying no secret', async () => {
  const { res, calls } = await post({ label: 'Main', credentials: GOOD });

  assert.equal(res.statusCode, 201);
  assert.equal(calls.created.length, 1);

  // Sealed with the ORDINARY envelope, AAD-bound to this org and provider.
  // `connectorCrypto` needed no change to carry a login and a password.
  const opened = connectorCrypto.openJson(calls.created[0].sealedTokens, {
    orgId: ORG,
    provider: 'dataforseo',
  });
  assert.deepEqual(opened, GOOD);
  assert.throws(() =>
    connectorCrypto.openJson(calls.created[0].sealedTokens, {
      orgId: '6c466b99ea3ab35ff1378d99',
      provider: 'dataforseo',
    })
  );

  // And nothing derived from it crosses back. This is the rule the whole
  // controller is under.
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('sealedTokens'));
  assert.ok(!body.includes(GOOD.password));
  assert.ok(!body.includes(GOOD.login));
  assert.equal(res.body.account.status, 'active');
  assert.equal(res.body.account.label, 'Main');
});

test('the label rules and the duplicate-label 409 are the SAME ones the consent path uses', async () => {
  const noLabel = await post({ credentials: GOOD });
  assert.equal(noLabel.res.statusCode, 400);
  assert.match(noLabel.res.body.error, /Give this account a name/);

  const tooLong = await post({ label: 'x'.repeat(61), credentials: GOOD });
  assert.equal(tooLong.res.statusCode, 400);

  const dupe = await post(
    { label: 'Main', credentials: GOOD },
    { clash: { _id: 'other', label: 'Main' } }
  );
  assert.equal(dupe.res.statusCode, 409);
  assert.match(dupe.res.body.error, /already have a DataForSEO account called "Main"/);
  assert.equal(dupe.calls.created.length, 0);

  // The consent path answers identically, which is the whole reason the
  // preflight is shared rather than copied.
  const stubs = stubModels({ clash: { _id: 'other', label: 'Main' } });
  const res = fakeRes();
  try {
    await startAuthorization(
      req({ params: { provider: 'ubersuggest' }, body: { label: 'Main' } }),
      res
    );
  } finally {
    stubs.restore();
  }
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /already have an? Ubersuggest account called "Main"/);
});

test('a reconnect updates IN PLACE, so mappings and history survive', async () => {
  const { res, calls } = await post(
    { label: 'Main', credentials: GOOD, reconnectAccount: ACCOUNT },
    { updated: { _id: ACCOUNT, provider: 'dataforseo', label: 'Main', status: 'active' } }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.updated.length, 1);
  assert.equal(String(calls.updated[0].filter._id), ACCOUNT);
  // Back to active: re-entering a credential is exactly how an account leaves
  // `needs_reauth`.
  assert.equal(calls.updated[0].update.$set.status, 'active');
  assert.ok(calls.updated[0].update.$set.sealedTokens);
});

test('a reconnect against an account that is not there is a 404, not a silent no-op', async () => {
  const { res } = await post(
    { label: 'Main', credentials: GOOD, reconnectAccount: ACCOUNT },
    { updated: null }
  );
  assert.equal(res.statusCode, 404);
});

test('the unique index is still the authority when two admins race', async () => {
  const e11000 = Object.assign(new Error('dup'), { code: 11000 });
  const { res } = await post({ label: 'Main', credentials: GOOD }, { created: e11000 });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /already have a DataForSEO account called "Main"/);
});

test('the two paths refuse each other rather than half-working', async () => {
  // A consent flow for a keyed provider has nowhere to send the browser; a
  // credential POST for a consent provider stores something that can never
  // authenticate anything. Both are 400s that say which door to use.
  const stubs = stubModels();
  const res = fakeRes();
  try {
    await saveCredentials(
      { ...req({ body: { label: 'Main', credentials: GOOD } }), params: { orgId: ORG, provider: 'ubersuggest' } },
      res
    );
  } finally {
    stubs.restore();
  }
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'REQUIRES_BROWSER_CONSENT');

  const stubs2 = stubModels();
  const res2 = fakeRes();
  try {
    await startAuthorization(
      { ...req({ body: { label: 'Main' } }), params: { orgId: ORG, provider: 'dataforseo' } },
      res2
    );
  } finally {
    stubs2.restore();
  }
  assert.equal(res2.statusCode, 400);
  assert.equal(res2.body.code, 'REQUIRES_CREDENTIALS');
});

test('an unknown provider is a 400 before anything is sealed', async () => {
  const stubs = stubModels();
  const res = fakeRes();
  try {
    await saveCredentials(
      { ...req({ body: { label: 'Main', credentials: GOOD } }), params: { orgId: ORG, provider: 'nope' } },
      res
    );
  } finally {
    stubs.restore();
  }
  assert.equal(res.statusCode, 400);
  assert.equal(stubs.calls.created.length, 0);
});

// ---------------------------------------------------------------------------
// 5. The session hands the whole credential to a transport, and nothing else
// ---------------------------------------------------------------------------

const stubAccountRead = (row) => {
  const original = ConnectorAccount.findById;
  ConnectorAccount.findById = () => ({ select: async () => row });
  return () => {
    ConnectorAccount.findById = original;
  };
};

const sealedRow = (credentials, overrides = {}) => ({
  _id: ACCOUNT,
  organisation: ORG,
  provider: 'dataforseo',
  label: 'Main',
  status: 'active',
  sealedTokens: connectorCrypto.sealJson(credentials, {
    orgId: ORG,
    provider: 'dataforseo',
  }),
  ...overrides,
});

test('getCredentials returns the whole credential — getAccessToken still returns one string', async () => {
  const restore = stubAccountRead(sealedRow(GOOD));
  try {
    const session = await openSession(ACCOUNT);
    assert.deepEqual(session.getCredentials(), GOOD);
    // Additive. `getAccessToken` has exactly two callers, both of which want
    // precisely one string, and widening them would put credential-shape
    // knowledge back into the transports this file exists to keep it out of.
    assert.equal(session.getAccessToken(), undefined);
  } finally {
    restore();
  }
});

test('getCredentials hands back a COPY, so a transport cannot corrupt the session', async () => {
  // Mutating the live token set would be re-sealed on the next refresh and would
  // look exactly like a provider revoking a credential.
  const restore = stubAccountRead(sealedRow(GOOD));
  try {
    const session = await openSession(ACCOUNT);
    const creds = session.getCredentials();
    creds.password = 'clobbered';
    assert.equal(session.getCredentials().password, GOOD.password);
  } finally {
    restore();
  }
});

test('a keyed provider drives a dead credential to needs_reauth through the EXISTING catch', async () => {
  // The decision this rests on: a 401 on Basic auth means the password is wrong,
  // not stale. `refreshTokens` throwing `{needsReauth: true}` reaches the catch
  // that was already in `session.refresh()`, so there is no second branch and no
  // per-provider special case — the same Reconnect button in front of the same
  // admin.
  const statuses = [];
  const restoreRead = stubAccountRead(sealedRow(GOOD));
  const originalUpdate = ConnectorAccount.updateOne;
  ConnectorAccount.updateOne = async (_f, update) => {
    statuses.push(update.$set.status);
    return { acknowledged: true };
  };
  try {
    const session = await openSession(ACCOUNT);
    await assert.rejects(() => session.refresh(), (err) => err.needsReauth === true);
    assert.deepEqual(statuses, ['needs_reauth']);
  } finally {
    ConnectorAccount.updateOne = originalUpdate;
    restoreRead();
  }
});

// ---------------------------------------------------------------------------
// 6. The seam itself
// ---------------------------------------------------------------------------

test('the generic engines name no provider — including the new one', () => {
  // The same property `registrySeam.test.js` asserts for the first tenant. A
  // second provider is the moment that claim gets tested for real: a
  // `if (provider === 'dataforseo')` anywhere below is the failure this whole
  // shape exists to prevent.
  const generic = [
    'services/connectors/session.js',
    'services/connectors/projectMirror.js',
    'services/connectors/snapshotService.js',
    'services/connectors/fieldMapping.js',
    'services/connectorGoalWriteback.js',
    'services/connectorSyncRunner.js',
    'controllers/connectorController.js',
    'controllers/connectorDataController.js',
    'controllers/connectorFieldController.js',
    'controllers/connectorLinkController.js',
  ];

  const offenders = [];
  for (const rel of generic) {
    const file = path.join(__dirname, '..', '..', rel);
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!/dataforseo/i.test(line)) return;
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        offenders.push(`${rel}:${i + 1}  ${trimmed}`);
      });
  }

  assert.deepEqual(offenders, [], `provider named in generic code:\n${offenders.join('\n')}`);
});

test('the provider is registered, and the bill never shipped before the brake', () => {
  const d = getConnector('dataforseo');

  /**
   * THE THREE ARRIVE TOGETHER, AND THEY ARRIVE AFTER THE GATE.
   *
   * Phase 1 deliberately withheld `fetch`, `resolveKinds` and `kinds`, because
   * `connectorSyncRunner.syncProvider` skips a descriptor missing either of the
   * first two and `connectorDataController.gateProvider` answers 409
   * `NO_DATA_SUPPORT` for one with no `kinds` — so between them the hourly tick
   * could not reach this provider and a person pressing Refresh could not
   * either.
   *
   * That mattered more here than for the first connector. DataForSEO bills AT
   * POST, `isFresh` is false for anything that is not `ok`, and the cron
   * re-enters hourly, so a fetcher WITHOUT an anti-repost gate is charged 168
   * times per weekly datapoint. The gate is the partial unique index on an open
   * `DfsTask`, and this test asserts both halves in one place: the three
   * capabilities exist, AND the index that makes them safe exists too. Either
   * one alone is the failure this phase split was designed around.
   */
  assert.equal(typeof d.fetch, 'function');
  assert.equal(typeof d.resolveKinds, 'function');
  assert.equal(Array.isArray(d.kinds), true);

  const DfsTask = require('../../models/DfsTask');
  const gate = DfsTask.schema
    .indexes()
    .find(([keys]) => JSON.stringify(keys) === JSON.stringify({ project: 1, kind: 1, variant: 1 }));
  assert.ok(gate, 'the anti-repost gate must exist wherever `fetch` does');
  assert.equal(gate[1].unique, true);
  assert.deepEqual(gate[1].partialFilterExpression, { state: 'open' });

  const listed = listConnectors().find((c) => c.name === 'dataforseo');
  /**
   * Phase 2 shipped two kinds; phase 6 added the four Labs ones, phase 7 the
   * four Backlinks ones, phase 8 the crawl and phase 10 two more. The list is
   * asserted in FULL rather than by `includes`,
   * deliberately: every entry here is something a board can switch on and
   * therefore something that can be bought, so a kind appearing in this catalog
   * without anybody noticing is a new line on an invoice without anybody
   * noticing.
   *
   * PHASE 10'S TWO, AND WHAT THEY COST. `referring_networks` is one Backlinks
   * request a week ($0.024) for every Site, because it has no gate — the same
   * terms `anchors` and `referring_domains` landed on in phase 7.
   * `business_profile` is $0.0054 a week and is gated on `businessName` being
   * non-empty, so a Site that has not named a business never buys it. Four of
   * phase 10's six features add NO kind at all.
   */
  assert.deepEqual(listed.availableKinds.map((k) => k.key), [
    'positions',
    'movement',
    'keyword_metrics',
    'competitors',
    'keyword_gap',
    'top_pages',
    'backlinks_summary',
    'backlinks_timeseries',
    'referring_domains',
    'anchors',
    'referring_networks',
    'business_profile',
    'site_audit',
  ]);
  /**
   * Phase 9's catalog, asserted on the two properties that make a field
   * BINDABLE rather than on the list itself.
   *
   * Not asserted in full, unlike the kinds above it, and the difference is
   * deliberate: a kind is a line that can appear on an invoice, and a field is
   * not — it is read out of a snapshot that has already been paid for. What
   * matters is that every entry declares a type `fieldMapping` can accept and a
   * kind this provider actually collects, because a field failing either is
   * savable and then permanently unfillable, which looks exactly like "the sync
   * has not run yet". `dataforseo/fields.test.js` covers the readers.
   */
  const kindKeys = new Set(listed.availableKinds.map((k) => k.key));
  assert.ok(listed.availableFields.length > 100, 'the catalog should be the phase-9 one');
  for (const field of listed.availableFields) {
    assert.ok(SOURCE_TYPES.includes(field.type), `${field.key} has type ${field.type}`);
    assert.ok(kindKeys.has(field.kind), `${field.key} names kind ${field.kind}`);
  }
  assert.equal(typeof d.readField, 'function');
  // The phase-9 guard: nothing from phases 7-8 may be bound without it.
  assert.equal(typeof d.comparability, 'function');

  // What phase 1 added and phase 2 leaves untouched: a transport, an account
  // read, and projects authored here because there is nothing to mirror.
  assert.equal(typeof d.listProjects, 'function');
  assert.equal(typeof d.createClient, 'function');
  assert.equal(typeof d.describeAccount, 'function');
  assert.equal(typeof d.verifyCredentials, 'function');
  assert.equal(typeof d.projectAuthoring.readForm, 'function');
});

test('a credential is CHECKED before it is stored, and a refusal stores nothing', async () => {
  // There is no consent screen to fail. Without this, a mistyped API password is
  // sealed, saved, reported as success, and surfaces days later as a cron job
  // marking the account `needs_reauth` with nothing to say what was wrong.
  const rejected = await post({ label: 'Main', credentials: GOOD }, { verify: false });
  assert.equal(rejected.res.statusCode, 400);
  assert.equal(rejected.res.body.code, 'CREDENTIALS_REJECTED');
  assert.equal(rejected.calls.created.length, 0);

  // The check ran against what was READ off the form, not the raw body.
  const good = await post({ label: 'Main', credentials: GOOD });
  assert.equal(good.res.statusCode, 201);
  assert.deepEqual(good.calls.verified, [GOOD]);
});

test('"we could not ask" is not "the password is wrong"', async () => {
  // Conflating them would mean a DataForSEO outage stops an admin from
  // configuring anything. A transport failure is logged and allowed through; the
  // credential still has to work before anything is collected, and the run report
  // is where that surfaces.
  const outage = Object.assign(new Error('socket hang up'), { retryable: true });
  const { res, calls } = await post({ label: 'Main', credentials: GOOD }, { verify: outage });
  assert.equal(res.statusCode, 201);
  assert.equal(calls.created.length, 1);
});

test('the check leaks nothing back — not even the login it just confirmed', async () => {
  // For this provider the login IS the account email, so echoing what the check
  // learned would break the rule the whole endpoint is under: a credential goes
  // in and never comes back out. Identity is recorded later, by the project
  // refresh, into the field built for it.
  const { res, calls } = await post({ label: 'Main', credentials: GOOD });
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes(GOOD.login));
  assert.equal(res.body.account.externalEmail, null);
  assert.equal('externalEmail' in calls.created[0], false);
  assert.equal('lastSeenQuota' in calls.created[0], false);
});

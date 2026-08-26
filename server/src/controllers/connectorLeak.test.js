const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const { publicAccount, publicProject } = require('./connectorController');
const ConnectorAccount = require('../models/ConnectorAccount');
const ConnectorProject = require('../models/ConnectorProject');
const connectorCrypto = require('../utils/connectorCrypto');

/**
 * The one property that matters most in this feature: a connector's OAuth tokens
 * must never reach a client.
 *
 * `select: false` on the model is the first line of defence, but it only helps
 * for queries that do not ask for the field — and the sync runner has to ask.
 * `publicAccount` is the second line, and it is hand-built rather than a spread
 * precisely so a field added to the schema later cannot leak by default.
 *
 * These tests exist because both defences are easy to erode by accident: someone
 * adds `.select('+sealedTokens')` for debugging, or replaces the projection with
 * `{ ...account }` because it is shorter.
 */

const ORG = '69d4cd1aac4378a532868559';
const SECRET = 'rt_this_must_never_reach_a_browser';

const buildAccount = () =>
  new ConnectorAccount({
    organisation: ORG,
    provider: 'ubersuggest',
    label: 'Main',
    externalEmail: 'seo@davnoot.com',
    tier: 'enterprise',
    sealedTokens: connectorCrypto.sealJson(
      { accessToken: 'at_x', refreshToken: SECRET },
      { orgId: ORG, provider: 'ubersuggest' }
    ),
    scopes: ['profile', 'projects'],
    createdBy: '6a466b99ea3ab35ff1378df6',
  });

test('sealedTokens is select:false on the schema', () => {
  assert.strictEqual(
    ConnectorAccount.schema.path('sealedTokens').options.select,
    false
  );
});

test('publicAccount omits sealedTokens entirely', () => {
  const out = publicAccount(buildAccount());
  assert.strictEqual('sealedTokens' in out, false);
});

test('no serialisation of publicAccount contains the secret', () => {
  // The real leak is transitive — a token nested inside some field that got
  // copied along. Check the whole JSON, not just the top-level keys.
  const json = JSON.stringify(publicAccount(buildAccount()));
  assert.ok(!json.includes(SECRET));
  assert.ok(!json.includes('sealedTokens'));
  assert.ok(!json.includes('refreshToken'));
});

test('publicAccount still carries what the UI actually needs', () => {
  const out = publicAccount(buildAccount());
  assert.strictEqual(out.label, 'Main');
  assert.strictEqual(out.provider, 'ubersuggest');
  assert.strictEqual(out.externalEmail, 'seo@davnoot.com');
  assert.strictEqual(out.tier, 'enterprise');
  assert.strictEqual(out.status, 'active');
  assert.deepStrictEqual(out.scopes, ['profile', 'projects']);
});

test('publicAccount does not blow up on a freshly-created row', () => {
  // createdAt/updatedAt/lastSync* are all absent until mongoose or a sync fills
  // them. The projection must tolerate that rather than throwing on undefined.
  const bare = new ConnectorAccount({
    organisation: ORG,
    provider: 'ubersuggest',
    label: 'Agency 2',
    sealedTokens: 'v1:1:a:b:c',
    createdBy: '6a466b99ea3ab35ff1378df6',
  });
  const out = publicAccount(bare);
  assert.strictEqual(out.externalEmail, null);
  assert.strictEqual(out.tier, null);
  assert.strictEqual(out.lastSyncAt, null);
  assert.deepStrictEqual(out.lastSeenQuota, {});
});

test('a sealed token set round-trips only with its own org and provider', () => {
  // The same guarantee connectorCrypto.test.js covers, asserted here against a
  // real model document — so a future change to how the field is populated
  // cannot quietly break the AAD binding.
  const account = buildAccount();
  const ctx = { orgId: ORG, provider: 'ubersuggest' };
  assert.strictEqual(
    connectorCrypto.openJson(account.sealedTokens, ctx).refreshToken,
    SECRET
  );
  assert.throws(() =>
    connectorCrypto.openJson(account.sealedTokens, {
      orgId: '6a2900f384b12104e52f8369',
      provider: 'ubersuggest',
    })
  );
});

// ---------------------------------------------------------------------------
// Mirrored projects (phase 2)
// ---------------------------------------------------------------------------

const buildProject = () =>
  new ConnectorProject({
    account: '6a466b99ea3ab35ff1378df7',
    organisation: ORG,
    provider: 'ubersuggest',
    externalId: '5512',
    name: 'Davnoot',
    domain: 'davnoot.com',
    locations: [{ locId: 2840, lang: 'en', label: 'United States' }],
    raw: { id: 5512, domain: 'davnoot.com', internal_field: 'not for the wire' },
  });

test('publicProject withholds the raw payload unless it is asked for', () => {
  const out = publicProject(buildProject());
  assert.strictEqual('raw' in out, false);

  const withRaw = publicProject(buildProject(), { includeRaw: true });
  assert.strictEqual(withRaw.raw.internal_field, 'not for the wire');
});

test('publicProject carries what the Add-ons tab renders', () => {
  const out = publicProject(buildProject());
  assert.strictEqual(out.externalId, '5512');
  assert.strictEqual(out.domain, 'davnoot.com');
  assert.strictEqual(out.group, null);
  assert.strictEqual(out.missing, false);
  assert.strictEqual(out.locations[0].locId, 2840);
});

test('publicProject is hand-built, so an added field cannot leak by default', () => {
  // The same property publicAccount is tested for. A field set on the document
  // but absent from the projection must not appear in the response.
  const project = buildProject();
  project.set('boundBy', '6a466b99ea3ab35ff1378df6');
  const json = JSON.stringify(publicProject(project));
  assert.ok(!json.includes('boundBy'));
  assert.ok(!json.includes('internal_field'));
});

// ---------------------------------------------------------------------------
// Snapshots (phase 3)
// ---------------------------------------------------------------------------

const ConnectorSnapshot = require('../models/ConnectorSnapshot');
const { publicSnapshot } = require('./connectorDataController');

const buildSnapshot = () =>
  new ConnectorSnapshot({
    organisation: ORG,
    account: '6a466b99ea3ab35ff1378df7',
    project: '6a466b99ea3ab35ff1378df8',
    provider: 'ubersuggest',
    kind: 'positions',
    variant: 'desktop|en|2840',
    periodKey: '2026-08-24',
    subject: 'project:5512',
    data: { totals: { tracked: 2 }, keywords: [] },
    raw: { internal_field: 'bulky and not for the wire' },
    fetchedBy: '6a466b99ea3ab35ff1378df6',
  });

test('publicSnapshot withholds the raw payload unless it is asked for', () => {
  // Same rule as publicProject, same reason: kept so a field the normaliser
  // missed is a code change rather than lost history, but bulky, undocumented,
  // and rendered by nothing.
  const out = publicSnapshot(buildSnapshot());
  assert.strictEqual('raw' in out, false);

  const withRaw = publicSnapshot(buildSnapshot(), { includeRaw: true });
  assert.strictEqual(withRaw.raw.internal_field, 'bulky and not for the wire');
});

test('publicSnapshot is hand-built, so an added field cannot leak by default', () => {
  const json = JSON.stringify(publicSnapshot(buildSnapshot()));
  assert.ok(!json.includes('internal_field'));
  // `fetchedBy` is set on the document and deliberately absent from the shape —
  // who pressed Refresh is bookkeeping, not something the tab renders.
  assert.ok(!json.includes('fetchedBy'));
});

test('publicSnapshot keeps the semantics the tab depends on', () => {
  const out = publicSnapshot(buildSnapshot());
  assert.strictEqual(out.kind, 'positions');
  assert.strictEqual(out.variant, 'desktop|en|2840');
  assert.strictEqual(out.periodKey, '2026-08-24');
  assert.strictEqual(out.status, 'ok');
});

test('a snapshot can never be stored as failed', () => {
  // A failure would have to claim a periodKey — and the only one available is
  // today's, which would then squat in the slot the real reading needs when the
  // provider recovers, with the unique index keeping the good data out.
  // Failures live on the run report instead.
  const statuses = ConnectorSnapshot.schema.path('status').enumValues;
  assert.deepStrictEqual(statuses.slice().sort(), ['ok', 'partial']);
});

test('the snapshot identity index is unique on all four parts', () => {
  // (project, kind, variant, periodKey). Dropping `variant` would collapse a US
  // rank and a UK rank onto one row; dropping `periodKey` would keep only the
  // newest reading, which is the entire history this feature exists to build.
  const identity = ConnectorSnapshot.schema.indexes().find(
    ([fields]) =>
      fields.project === 1 &&
      fields.kind === 1 &&
      fields.variant === 1 &&
      fields.periodKey === 1
  );
  assert.ok(identity, 'the identity index is missing');
  assert.strictEqual(identity[1].unique, true);
});

// ---------------------------------------------------------------------------
// Phase 4 — the field mappings
// ---------------------------------------------------------------------------

const ConnectorFieldMapping = require('../models/ConnectorFieldMapping');

const findIndex = (model, match) =>
  model.schema.indexes().find(([fields]) => match(fields));

test('one mapping per (board, provider, sourceField), enforced by the database', () => {
  // Upserted against, which is what makes re-pointing a field REPLACE its
  // binding rather than add a second one — the property behind "remap it and the
  // old column stops updating".
  const identity = findIndex(
    ConnectorFieldMapping,
    (f) => f.board === 1 && f.provider === 1 && f.sourceField === 1
  );
  assert.ok(identity, 'the identity index is missing');
  assert.strictEqual(identity[1].unique, true);
});

test('a goal column can be filled by only one connector field', () => {
  // Without this, two fields could both claim a column and the winner would be
  // decided by document order. Scoped to the BOARD rather than to
  // (board, provider): the column belongs to the board, so two connectors
  // fighting over it is the same bug as one connector fighting with itself.
  const [fields, options] = findIndex(
    ConnectorFieldMapping,
    (f) => f.board === 1 && f['target.columnId'] === 1
  );
  assert.ok(fields);
  assert.strictEqual(options.unique, true);
  // Partial, because `columnId` is null on every builtin mapping and a plain
  // unique index would allow exactly one of those per board.
  assert.deepStrictEqual(options.partialFilterExpression, {
    'target.columnId': { $type: 'objectId' },
  });
});

test('the same rule holds for the built-in targets', () => {
  const [, options] = findIndex(
    ConnectorFieldMapping,
    (f) => f.board === 1 && f['target.builtin'] === 1
  );
  assert.strictEqual(options.unique, true);
  assert.deepStrictEqual(options.partialFilterExpression, {
    'target.builtin': { $type: 'string' },
  });
});

// `validate()` rather than `validateSync()` throughout: the invariant lives in a
// `pre('validate')` hook, and the sync path deliberately skips document
// middleware. Testing it synchronously would pass on a row `save()` rejects.

test('a target names a column OR a builtin, never both', async () => {
  // A row with both set would be a target the phase-5 writeback could read two
  // ways. Re-pointing a mapping is the case that produces one: the old value has
  // to be cleared, not left alongside, or the partial index above would still
  // see it.
  const row = new ConnectorFieldMapping({
    board: '69d4cd1aac4378a532868501',
    organisation: ORG,
    provider: 'ubersuggest',
    sourceField: 'rank',
    target: { kind: 'goalBuiltin', builtin: 'actual', columnId: '69d4cd1aac4378a532868502' },
    createdBy: '6a466b99ea3ab35ff1378df6',
  });
  await row.validate();
  assert.strictEqual(row.target.columnId, null);
  assert.strictEqual(row.target.builtin, 'actual');
});

test('a mapping that names nowhere is refused by the model', async () => {
  const row = new ConnectorFieldMapping({
    board: '69d4cd1aac4378a532868501',
    organisation: ORG,
    provider: 'ubersuggest',
    sourceField: 'rank',
    target: { kind: 'goalColumn' },
    createdBy: '6a466b99ea3ab35ff1378df6',
  });
  await assert.rejects(() => row.validate(), /column id/i);
});

test('the mapping target is an ObjectId, so a column key can never stand in for it', () => {
  // `Goal.columnValues` is keyed by `_id`, which is what makes renaming a column
  // free. The three SEO boards also disagree about the spelling of the
  // difficulty key — `keyword_difficultly` on one, `keyword_difficulty` on the
  // other two — so a mapping keyed by slug would bind on one board and silently
  // miss on the others.
  const path = ConnectorFieldMapping.schema.path('target').schema.path('columnId');
  assert.strictEqual(path.instance, 'ObjectId');
});

// ---------------------------------------------------------------------------
// Phase 5 — the goal links
// ---------------------------------------------------------------------------

const GoalConnectorLink = require('../models/GoalConnectorLink');
const { publicLink } = require('./connectorLinkController');

test('one link per goal, enforced by the database', () => {
  // A goal reports one thing, so it is about one keyword. Upserted against, so
  // re-pointing a goal REPLACES its link rather than adding a second — which is
  // what stops two sources filling one row and the winner being decided by
  // document order.
  assert.strictEqual(GoalConnectorLink.schema.path('goal').options.unique, true);
});

test('provenance sits BESIDE the values, never inside them', () => {
  // The whole reason this model exists in this shape. Wrapping `Goal.actual` or
  // a `columnValues` entry would ripple through `goalTypes.js`, `scoreGoal`,
  // `scoreGroup`, `missingFinalValues`, `checkRequiredColumns`, the month-close
  // logic, the trend query and the SHARED `cellComponentFor` registry — each of
  // which would then have to tolerate both shapes forever, because every
  // existing row is bare.
  const Goal = require('../models/Goal');
  assert.strictEqual(Goal.schema.path('actual').instance, 'Number');
  assert.strictEqual(GoalConnectorLink.schema.path('applied').instance, 'Map');
  assert.strictEqual(GoalConnectorLink.schema.path('suggested').instance, 'Map');
});

test('publicLink never carries a provider payload or an account reference', () => {
  // Same rule as `publicAccount` and `publicSnapshot`: hand-built, so a field
  // added to the model later cannot reach a client by default.
  const json = JSON.stringify(
    publicLink({
      _id: '69d4cd1aac4378a532868511',
      goal: '69d4cd1aac4378a532868512',
      group: '69d4cd1aac4378a532868513',
      monthKey: '2026-08',
      provider: 'ubersuggest',
      project: '69d4cd1aac4378a532868514',
      keyword: 'best crm for agencies',
      applied: {},
      suggested: {},
      account: '69d4cd1aac4378a532868515',
      sealedTokens: SECRET,
    })
  );
  assert.ok(!json.includes(SECRET));
  assert.ok(!json.includes('sealedTokens'));
  assert.ok(!json.includes('account'));
});

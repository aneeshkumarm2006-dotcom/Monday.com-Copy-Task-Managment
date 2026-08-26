const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getConnector, checkRegistry, validateDescriptor } = require('./index');
const { planProjectWork, isFresh } = require('./snapshotService');
const {
  targetsForBoard,
  checkCompatibility,
  targetAppliesTo,
  readGoalTarget,
} = require('./fieldMapping');
const {
  planGoalWrites,
  selectSnapshots,
  applyWrite,
  resolveMappings,
} = require('../connectorGoalWriteback');
const { getGoalType } = require('../../utils/goalTypes');
const { CONNECTOR_PROVIDERS } = require('../../utils/connectorProviders');

const ads = require('./__sketch__/ads');

/**
 * Phase 6 — the second-provider proof.
 *
 * ---- What this file is asserting -------------------------------------------
 *
 * Every phase since 2 has claimed the same property in a comment: "this half is
 * GENERIC, a second provider is a new directory and nothing else changes." The
 * claim is load-bearing — it is why `snapshotService.js`, `fieldMapping.js` and
 * `connectorGoalWriteback.js` are shaped the way they are, and why each of them
 * pays a real cost in indirection to stay that way. Until now it has never been
 * checked, and a seam nothing runs through is a seam that has quietly closed.
 *
 * So this file drives the generic engines with a descriptor that is NOT
 * Ubersuggest and NOT registered — `__sketch__/ads.js`, an ads provider whose
 * subject is an ad account, whose cadence is daily, whose variants fan out over
 * placements, and most of whose goals are about no keyword at all. If any of
 * those four differences needed a change on the generic side, it would fail
 * here.
 *
 * ---- What it deliberately does NOT assert ----------------------------------
 *
 * That the ads provider works. It has no `fetch`, no `listProjects` and no real
 * OAuth, because it has no API behind it. Stubbing those to return plausible
 * fixtures would make the seam LOOK proven while proving only that the stubs
 * match the fixtures. What is exercised here is every generic decision that can
 * be made from data alone: what to fetch, what may bind to what, and where a
 * collected value lands.
 */

// ---------------------------------------------------------------------------
// Fixtures — an ads board, an ads account, ads snapshots
// ---------------------------------------------------------------------------

const COL_SPEND = '6b466b99ea3ab35ff1379001';
const COL_STATUS = '6b466b99ea3ab35ff1379002';
const COL_PREVIEW = '6b466b99ea3ab35ff1379003';
const COL_OWNER = '6b466b99ea3ab35ff1379004';

/**
 * Ads vocabulary lives in board CONFIGURATION, exactly as the standing rule
 * requires — these are goal columns a person made, not types in code.
 */
const makeBoard = () => ({
  _id: '6b466b99ea3ab35ff1379d20',
  goalColumns: [
    { _id: COL_SPEND, name: 'Spend', key: 'spend', type: 'number', order: 0 },
    { _id: COL_STATUS, name: 'Status', key: 'status', type: 'text', order: 1 },
    { _id: COL_PREVIEW, name: 'Creative', key: 'creative', type: 'link', order: 2 },
    { _id: COL_OWNER, name: 'Buyer', key: 'buyer', type: 'person', order: 3 },
  ],
});

const account = (overrides = {}) => ({
  _id: 'a1',
  externalId: 'act_88117',
  // No domain, no keywordCount, no locations. An ad account has none of the
  // SEO-shaped mirrored fields, and the placements live in `raw` — see the
  // sketch's header for why that is both fine today and worth writing down.
  raw: { placements: ['feed', 'reels'] },
  ...overrides,
});

const HOUR = 3_600_000;
const DAILY = ads.descriptor.syncIntervalHours; // 24
const NOW = new Date('2026-08-27T12:00:00Z');

const plan = (args = {}) =>
  planProjectWork({
    project: account(),
    kinds: ads.resolveKinds([]),
    variantsFor: ads.variantsFor,
    latest: new Map(),
    intervalHours: DAILY,
    now: NOW,
    ...args,
  });

const snapshot = (overrides = {}) => ({
  kind: 'campaign_performance',
  variant: 'placement|feed',
  status: 'ok',
  fetchedAt: NOW,
  ...overrides,
});

/** The campaign report a run would have stored. */
const CAMPAIGNS = {
  campaigns: [
    { name: 'Q3 Retargeting', spend: 1200, results: 48, clicks: 960, impressions: 80000, status: 'Active' },
    { name: 'Prospecting — broad', spend: 640, results: 0, clicks: 210, impressions: 51000, status: 'Paused' },
  ],
};

const ACCOUNT = { spend: 1840, reach: 62000, impressions: 186000, reportedOn: '2026-08-26' };

// ---------------------------------------------------------------------------
// 1. The registry validator accepts a descriptor it has never seen
// ---------------------------------------------------------------------------

test('the ads sketch passes the same validation the shipped providers do', () => {
  assert.deepEqual(validateDescriptor('ads', ads.descriptor), []);
});

test('no new provider is BUILT — the sketch is unreachable through the registry', () => {
  // The whole point of phase 6 is a proof, not a product. If this ever starts
  // failing, somebody has shipped an ads connector and this file should be
  // deleted in favour of that directory's own tests.
  assert.equal(getConnector('ads'), null);
  assert.ok(!CONNECTOR_PROVIDERS.includes('ads'));
  assert.equal(checkRegistry().ok, true);
});

test('the validator catches the four ways a second catalog goes wrong', () => {
  const broken = (fields) => ({ ...ads.descriptor, fields });
  const one = ads.FIELDS[0];

  assert.match(
    validateDescriptor('ads', broken([one, { ...one }])).join(' '),
    /declares field "spend" twice/
  );
  assert.match(
    validateDescriptor('ads', broken([{ ...one, read: 'nope' }])).join(' '),
    /has no read\(\)/
  );
  assert.match(
    validateDescriptor('ads', broken([{ ...one, kind: 'rank_tracking' }])).join(' '),
    /names kind "rank_tracking", which it does not collect/
  );
  assert.match(
    validateDescriptor('ads', broken([{ ...one, type: 'currency' }])).join(' '),
    /type "currency", which no goal target can accept/
  );
});

test('a descriptor that lies about its own name, or cannot start an OAuth flow, is refused', () => {
  assert.match(
    validateDescriptor('metaAds', ads.descriptor).join(' '),
    /reports its name as "ads"/
  );
  assert.match(
    validateDescriptor('ads', { ...ads.descriptor, oauth: {} }).join(' '),
    /no usable oauth.buildAuthorizeUrl/
  );
});

// ---------------------------------------------------------------------------
// 2. The planner — a fan-out axis and a cadence it has never heard of
// ---------------------------------------------------------------------------

test('the planner fans out over PLACEMENTS without knowing what a placement is', () => {
  const { todo } = plan();
  const campaign = todo.filter((t) => t.kind.key === 'campaign_performance');

  assert.deepEqual(
    campaign.map((t) => t.variant.key),
    ['placement|feed', 'placement|reels']
  );
  // Everything else has one variant, exactly as rank tracking is the only
  // Ubersuggest kind that splits.
  assert.deepEqual(
    todo.filter((t) => t.kind.key !== 'campaign_performance').map((t) => t.variant.key),
    ['all', 'all']
  );
});

test('a capped fan-out is REPORTED, not silently truncated', () => {
  const { todo, skipped } = plan({
    project: account({
      raw: { placements: ['feed', 'reels', 'stories', 'search', 'audience', 'marketplace'] },
    }),
  });

  assert.equal(todo.filter((t) => t.kind.key === 'campaign_performance').length, 4);
  assert.ok(
    skipped.some((s) => s.kind === 'campaign_performance' && /2 further/.test(s.reason)),
    'the two dropped placements must appear in the report'
  );
});

test('a kind is skipped BEFORE a call when the account lacks the field it requires', () => {
  const { todo, skipped } = plan({ project: account({ externalId: '' }) });

  assert.ok(!todo.some((t) => t.kind.key === 'account_overview'));
  assert.deepEqual(
    skipped.find((s) => s.kind === 'account_overview'),
    { kind: 'account_overview', variant: 'default', reason: 'needs a externalId' }
  );
});

test('the sync interval belongs to the DESCRIPTOR — the same row is fresh daily and stale weekly', () => {
  const yesterday = snapshot({ fetchedAt: new Date(NOW.getTime() - 30 * HOUR) });

  // 30 hours old: stale against the ads cadence, fresh against Ubersuggest's.
  assert.equal(isFresh(yesterday, DAILY, NOW), false);
  assert.equal(isFresh(yesterday, 168, NOW), true);

  const latest = new Map([[`campaign_performance|placement|feed`, yesterday]]);
  const { todo } = plan({ latest });
  assert.ok(
    todo.some(
      (t) => t.kind.key === 'campaign_performance' && t.variant.key === 'placement|feed'
    ),
    'a 30-hour-old daily reading must be re-collected'
  );

  const twelve = new Map([
    [`campaign_performance|placement|feed`, snapshot({ fetchedAt: new Date(NOW.getTime() - 12 * HOUR) })],
  ]);
  const fresh = plan({ latest: twelve });
  assert.ok(
    !fresh.todo.some(
      (t) => t.kind.key === 'campaign_performance' && t.variant.key === 'placement|feed'
    )
  );
});

test('a dependency is pulled in even when the board narrowed to the dependant', () => {
  // The contract the runner relies on, implemented independently by the second
  // provider. Getting this wrong returns an empty creative report that is
  // indistinguishable from a provider failure.
  assert.deepEqual(
    ads.resolveKinds(['creative_performance']).map((k) => k.key),
    ['campaign_performance', 'creative_performance']
  );
  assert.deepEqual(ads.resolveKinds([]).map((k) => k.key), [
    'campaign_performance',
    'creative_performance',
    'account_overview',
  ]);
  // A selection of nothing but unknown keys is a misconfiguration, not a
  // request for silence.
  assert.equal(ads.resolveKinds(['positions']).length, 3);
});

// ---------------------------------------------------------------------------
// 3. Compatibility — the same rule, over a catalog it was not written for
// ---------------------------------------------------------------------------

test('type compatibility holds over ads fields with no ads-specific rule', () => {
  const board = makeBoard();
  const targets = targetsForBoard(board);
  const at = (id) => targets.find((t) => t.id === id);
  const field = (key) => ads.FIELDS.find((f) => f.key === key);
  const check = (key, targetId) => checkCompatibility(field(key), at(targetId));

  // Widening is allowed: a number reads perfectly well as text.
  assert.equal(check('spend', `column:${COL_SPEND}`).ok, true);
  assert.equal(check('spend', `column:${COL_STATUS}`).ok, true);

  // Narrowing is not, and the refusal names both sides.
  const refusal = check('campaign_status', `column:${COL_SPEND}`);
  assert.equal(refusal.ok, false);
  assert.match(refusal.reason, /Campaign status/);
  assert.match(refusal.reason, /Spend/);

  // A link goes to a link column and nowhere numeric.
  assert.equal(check('creative_preview', `column:${COL_PREVIEW}`).ok, true);
  assert.equal(check('creative_preview', `column:${COL_SPEND}`).ok, false);

  // Nothing a connector produces may land on a person, and the refusal says so
  // rather than leaving a greyed-out row unexplained.
  for (const f of ads.FIELDS) {
    const person = checkCompatibility(f, at(`column:${COL_OWNER}`));
    assert.equal(person.ok, false, `${f.key} must not be writable into a person column`);
    assert.match(person.reason, /team/);
  }

  // A date field reaches the deadline builtin, and a number does not.
  assert.equal(check('last_reported_on', 'builtin:actualDayKey').ok, true);
  assert.equal(check('account_spend', 'builtin:actualDayKey').ok, false);
});

// ---------------------------------------------------------------------------
// 4. The writeback — an ads goal, which is about no keyword at all
// ---------------------------------------------------------------------------

const MAPPINGS = [
  { provider: 'ads', sourceField: 'account_spend', target: { kind: 'goalBuiltin', builtin: 'actual', columnId: null }, autoFill: true },
  { provider: 'ads', sourceField: 'spend', target: { kind: 'goalColumn', builtin: null, columnId: COL_SPEND }, autoFill: true },
  { provider: 'ads', sourceField: 'campaign_status', target: { kind: 'goalColumn', builtin: null, columnId: COL_STATUS }, autoFill: true },
  { provider: 'ads', sourceField: 'cost_per_result', target: { kind: 'goalBuiltin', builtin: 'config.target', columnId: null }, autoFill: true },
];

const SNAPSHOT_ROWS = [
  { kind: 'campaign_performance', variant: 'placement|feed', periodKey: '2026-08-26', data: CAMPAIGNS, collectedAt: new Date('2026-08-26T04:00:00Z') },
  { kind: 'account_overview', variant: 'all', periodKey: '2026-08-26', data: ACCOUNT, collectedAt: new Date('2026-08-26T04:00:00Z') },
];

const window = { monthStart: '2026-08-01', monthEnd: '2026-08-31', variant: null };

const planFor = ({ goal, link, mappings = MAPPINGS, can = () => true }) =>
  planGoalWrites({
    goal,
    link,
    mappings: resolveMappings(makeBoard(), mappings),
    fieldFor: (key) => ads.FIELDS.find((f) => f.key === key) || null,
    readField: ads.readField,
    snapshots: selectSnapshots(SNAPSHOT_ROWS, window),
    canWrite: can,
    now: NOW,
  });

const numericGoal = (overrides = {}) => ({
  _id: 'g1',
  type: 'numeric',
  name: 'Meta — Q3 retargeting',
  config: {},
  columnValues: new Map(),
  ...overrides,
});

test('a link with NO keyword fills the project-scoped fields and skips the rest', () => {
  // The ads case phase 5 declared `scope` for. An ads goal is named after a
  // piece of work, not a campaign, so most links carry no sub-subject — and a
  // writeback that assumed one would fill nothing at all here.
  const result = planFor({ goal: numericGoal(), link: { autoFill: true, keyword: null } });

  assert.deepEqual(
    result.writes.map((w) => w.sourceField),
    ['account_spend']
  );
  assert.equal(result.writes[0].value, 1840);
  assert.equal(result.skipped, 3);
});

test('a link that names a campaign fills the campaign-scoped fields too', () => {
  const result = planFor({
    goal: numericGoal(),
    // Matched case-insensitively, same as a keyword — the phrase comes from the
    // provider on one side and a person on the other.
    link: { autoFill: true, keyword: 'q3 retargeting' },
  });

  const byField = Object.fromEntries(result.writes.map((w) => [w.sourceField, w.value]));
  assert.deepEqual(byField, {
    account_spend: 1840,
    spend: 1200,
    campaign_status: 'Active',
    cost_per_result: 25,
  });
});

test('a null is never written, and an answer-shaped one becomes a note', () => {
  // "Prospecting — broad" has spent 640 and converted nobody. Cost per result
  // is genuinely undefined, and writing a 0 or a blank would read as "nobody
  // did the work" in a cell whose empty state already says that.
  const result = planFor({
    goal: numericGoal(),
    link: { autoFill: true, keyword: 'Prospecting — broad' },
  });

  assert.ok(!result.writes.some((w) => w.sourceField === 'cost_per_result'));
  assert.ok(
    result.notes.some((n) => /Cost per result: No results attributed yet/.test(n)),
    'the answer-shaped null must be said out loud'
  );
  // The rest of the row still fills.
  assert.deepEqual(
    result.writes.map((w) => w.sourceField).sort(),
    ['account_spend', 'campaign_status', 'spend']
  );
});

test('the ownership rule holds for a provider it was not written for', () => {
  const goal = numericGoal({ columnValues: new Map([[COL_SPEND, 999]]) });
  const link = {
    autoFill: true,
    keyword: 'Q3 Retargeting',
    // Already claimed, and the connector last wrote 1100 into Spend. Somebody
    // has since typed 999 over it.
    claimedAt: new Date('2026-08-02T00:00:00Z'),
    applied: { spend: { value: 1100 } },
  };

  const result = planFor({ goal, link });

  assert.ok(!result.writes.some((w) => w.sourceField === 'spend'));
  const offer = result.suggestions.find((s) => s.sourceField === 'spend');
  assert.equal(offer.reason, 'humanEdited');
  assert.equal(offer.value, 1200);
  assert.equal(offer.current, 999);
});

test('an unattended ads run fills the result and only OFFERS the promise', () => {
  const result = planFor({
    goal: numericGoal(),
    link: { autoFill: true, keyword: 'Q3 Retargeting' },
    can: (cap) => cap === 'goal.track',
  });

  assert.ok(result.writes.some((w) => w.sourceField === 'account_spend'));
  const promise = result.suggestions.find((s) => s.sourceField === 'cost_per_result');
  assert.equal(promise.reason, 'needsPermission');
  assert.equal(promise.capability, 'goal.manage');
});

test('a mapping is skipped against an ads goal TYPE that has no such field', () => {
  // The same board carries "Ship 8 creatives" as a checklist. It promises a
  // total and has no target, so `config.target` must not land on it.
  const checklist = getGoalType('checklist');
  assert.equal(
    targetAppliesTo({ kind: 'goalBuiltin', builtin: 'config.target' }, checklist),
    false
  );
  assert.equal(targetAppliesTo({ kind: 'goalColumn', columnId: COL_SPEND }, checklist), true);

  const result = planFor({
    goal: { _id: 'g2', type: 'checklist', name: 'Ship 8 creatives', config: {}, columnValues: new Map() },
    link: { autoFill: true, keyword: 'Q3 Retargeting' },
  });
  assert.ok(!result.writes.some((w) => w.sourceField === 'cost_per_result'));
});

test('the planned values land on the goal in the shape every reader already expects', () => {
  const goal = numericGoal({ markModified: () => {} });
  const result = planFor({ goal, link: { autoFill: true, keyword: 'Q3 Retargeting' } });
  result.writes.forEach((w) => applyWrite(goal, w));

  assert.equal(goal.actual, 1840);
  assert.equal(goal.columnValues.get(COL_SPEND), 1200);
  assert.equal(goal.config.target, 25);

  // Bare values, not `{ v, src, … }` envelopes. `goalTypes.js`, `scoreGoal` and
  // the shared cell components read these directly, and the sidecar on the link
  // is what carries the provenance instead.
  assert.equal(readGoalTarget(goal, { kind: 'goalColumn', columnId: COL_SPEND }), 1200);
  assert.equal(typeof goal.columnValues.get(COL_SPEND), 'number');
});

// ---------------------------------------------------------------------------
// 5. The seam itself — no provider may be named on the generic side
// ---------------------------------------------------------------------------

test('the generic engines name no provider', () => {
  // The property every "this half is generic" comment in this feature is
  // claiming, checked rather than believed. A hardcoded `if (provider ===
  // 'ubersuggest')` in any of these is the failure this whole shape exists to
  // prevent, and it is the sort of thing that gets added at 2am to fix one
  // board.
  // `services/connectors/index.js` is exempt and is the ONLY exemption: mapping
  // a name to a directory is what a registry is for, and the test below is what
  // keeps it the only place that does it.
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
    const source = fs.readFileSync(file, 'utf8');
    source.split('\n').forEach((line, i) => {
      if (!/ubersuggest/i.test(line)) return;
      // A comment may name the first tenant — that is how the reasoning is
      // recorded. Code may not.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      offenders.push(`${rel}:${i + 1}  ${trimmed}`);
    });
  }

  assert.deepEqual(offenders, [], `provider named in generic code:\n${offenders.join('\n')}`);
});

test('the registry is the ONLY place a provider directory is reached from', () => {
  // `require('./ubersuggest')` outside the registry is the other way the seam
  // closes: one direct import and the generic caller has a provider's internals
  // in scope and will start using them.
  const root = path.join(__dirname, '..', '..');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__sketch__') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
      const rel = path.relative(root, full).replace(/\\/g, '/');
      // The provider's own directory, and the registry that maps a name to it.
      if (rel.startsWith('services/connectors/ubersuggest/')) continue;
      if (rel === 'services/connectors/index.js') continue;

      const source = fs.readFileSync(full, 'utf8');
      if (/require\(['"][^'"]*ubersuggest[^'"]*['"]\)/.test(source)) offenders.push(rel);
    }
  };
  walk(root);

  assert.deepEqual(offenders, [], `provider imported directly:\n${offenders.join('\n')}`);
});

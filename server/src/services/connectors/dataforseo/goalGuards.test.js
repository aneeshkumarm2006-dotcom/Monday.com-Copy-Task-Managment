const test = require('node:test');
const assert = require('node:assert/strict');

const {
  comparability,
  auditComparability,
  backlinksComparability,
  rankComparability,
  COMPARABLE_CRAWL_DRIFT,
} = require('./comparability');
const dataforseo = require('./index');
const ubersuggest = require('../ubersuggest');
const { selectSnapshots, planGoalWrites } = require('../../connectorGoalWriteback');

/**
 * The two ways a goal quietly becomes a number about our own settings.
 *
 * Both of them run through `connectorGoalWriteback`, which is generic and must
 * stay that way, so both are asked of the PROVIDER through a descriptor hook.
 * This file asserts the hooks and the plumbing together, because either one
 * alone proves nothing: a rule nothing calls is a comment, and a call site with
 * no rule behind it is the behaviour that was already there.
 *
 *   WHICH SERIES. `selectSnapshots` used to match `kind === 'positions'` and
 *   compare variant keys literally. DataForSEO now has THREE variant shapes in
 *   one provider — `2840|en|desktop` for rank, `2840|en|any` for Labs (those
 *   endpoints take no device) and `0|any|any` for Backlinks and the crawl (a
 *   link profile has no market at all) — so the literal comparison drops every
 *   Labs row and the "only positions is filtered" half feeds one country's
 *   search volumes into another country's goals. `movement` was never filtered
 *   at all, on either provider, because it is not spelled `positions`.
 *
 *   WHICH PAIR. `config.baseline` and `actual` are the two ends of every graded
 *   score. For the audit and the backlink kinds, two readings taken under
 *   different settings are two measurements of two different things — and the
 *   screens refuse those comparisons and print the reason, while a goal cell has
 *   no caption anybody could read.
 */

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const crawl = (over = {}) => ({
  configHash: 'aaaaaaaaaaaaaaaa',
  config: { max_crawl_pages: 1000 },
  crawl: { pagesCrawled: 500, stopReason: null },
  totals: { onpageScore: 80 },
  ...over,
});

test('two crawls run with different settings cannot be subtracted', () => {
  const verdict = auditComparability(
    crawl(),
    crawl({ configHash: 'bbbbbbbbbbbbbbbb', config: { max_crawl_pages: 100 } })
  );
  assert.equal(verdict.ok, false);
  // A reason, not a boolean — the whole shape of `auditRows.comparability`,
  // because a silently missing number is not information.
  assert.match(verdict.reason, /different settings/);
  assert.match(verdict.reason, /up to 100 pages, then up to 1000/);
});

test('a crawl that stopped early is not comparable with a complete one', () => {
  const verdict = auditComparability(
    crawl(),
    crawl({ crawl: { pagesCrawled: 500, stopReason: 'limit_exceeded' } })
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /stopped early \(limit_exceeded\)/);
});

test('a crawl size that drifted is refused even when the config did not', () => {
  // `max_crawl_pages` is a CEILING. A site that grew from 90 pages to 600 moved
  // the denominator with nobody touching a setting, and the issue counts are
  // absolute so most of the difference would be the difference in coverage.
  const grown = auditComparability(crawl({ crawl: { pagesCrawled: 600 } }), crawl({ crawl: { pagesCrawled: 90 } }));
  assert.equal(grown.ok, false);
  assert.match(grown.reason, /very different numbers of pages \(90 then 600\)/);

  // Just inside the tolerance, which is the same judgement the client makes.
  assert.equal(COMPARABLE_CRAWL_DRIFT, 0.2);
  const nudged = auditComparability(
    crawl({ crawl: { pagesCrawled: 110 } }),
    crawl({ crawl: { pagesCrawled: 100 } })
  );
  assert.equal(nudged.ok, true);
});

test('two identical crawls are comparable', () => {
  assert.equal(auditComparability(crawl(), crawl()).ok, true);
});

test('a changed backlink status type recomputes rather than filters, so it refuses', () => {
  // DataForSEO's own example shows one domain at rank 509 under `lost` and 562
  // under `live`. The two readings are two graphs, not two dates.
  const verdict = backlinksComparability(
    { statusType: 'live', rankScale: 'one_thousand' },
    { statusType: 'all', rankScale: 'one_thousand' }
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /different link sets/);
});

test('a changed rank scale is a change of units, not of the profile', () => {
  const verdict = backlinksComparability(
    { statusType: 'live', rankScale: 'one_hundred' },
    { statusType: 'live', rankScale: 'one_thousand' }
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /different rank scales/);
});

test('two rank readings bought to different depths are refused', () => {
  // Neither client file has this one, because a screen only ever compares a
  // kind with itself and the two rank kinds have fixed depths. A goal can meet
  // it, because `DEPTH_CENSUS` is a constant somebody can change.
  const verdict = rankComparability({ depth: 10 }, { depth: 100 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /different depths \(100 results, then 10\)/);
  assert.equal(rankComparability({ depth: 100 }, { depth: 100 }).ok, true);
});

test('a kind with nothing to guard, and a missing reading, both answer yes', () => {
  // The four Labs kinds carry no setting that recomputes what they mean, and
  // "there is nothing to compare" is the caller's business rather than a
  // refusal — a monthStart with no latest beside it is simply the first month.
  assert.equal(comparability('keyword_metrics', { a: 1 }, { a: 2 }).ok, true);
  assert.equal(comparability('competitors', {}, {}).ok, true);
  assert.equal(comparability('site_audit', null, crawl()).ok, true);
  assert.equal(comparability('a_kind_from_2028', {}, {}).ok, true);
});

test('the descriptor routes each kind to its own rule', () => {
  assert.equal(typeof dataforseo.comparability, 'function');
  assert.equal(
    dataforseo.comparability('site_audit', crawl(), crawl({ configHash: 'z' })).ok,
    false
  );
  assert.equal(
    dataforseo.comparability('anchors', { statusType: 'live' }, { statusType: 'all' }).ok,
    false
  );
  assert.equal(dataforseo.comparability('movement', { depth: 10 }, { depth: 100 }).ok, false);
});

// ---------------------------------------------------------------------------
// selectSnapshots — which series
// ---------------------------------------------------------------------------

const row = (kind, periodKey, variant) => ({
  kind,
  variant,
  periodKey,
  data: { marker: `${kind}:${variant}:${periodKey}` },
});

const US = '2840|en|desktop';
const UK = '2826|en|desktop';
const US_MARKET = '2840|en|any';
const UK_MARKET = '2826|en|any';
const WHOLE_DOMAIN = '0|any|any';

const WINDOW = { monthStart: '2026-09-01', monthEnd: '2026-09-30' };

const dfsRows = [
  row('positions', '2026-09-22', US),
  row('positions', '2026-09-21', UK),
  row('movement', '2026-09-24', UK),
  row('movement', '2026-09-23', US),
  row('keyword_metrics', '2026-09-05', UK_MARKET),
  row('keyword_metrics', '2026-09-04', US_MARKET),
  row('backlinks_summary', '2026-09-14', WHOLE_DOMAIN),
  row('site_audit', '2026-09-03', WHOLE_DOMAIN),
];

const pickDfs = (variant) =>
  selectSnapshots(dfsRows, { ...WINDOW, variant, sameVariant: dataforseo.sameVariant });

test('a market-scoped Labs row answers for a device-scoped rank choice', () => {
  // `2840|en|any` can never EQUAL `2840|en|desktop`. Compared literally the
  // Labs reading is dropped and the goal never fills; compared not at all, the
  // newest Labs row wins and a US goal gets UK search volumes.
  const picked = pickDfs(US);
  assert.equal(picked.get('keyword_metrics').latest.variant, US_MARKET);
  assert.notEqual(picked.get('keyword_metrics').latest.variant, UK_MARKET);

  const uk = pickDfs(UK);
  assert.equal(uk.get('keyword_metrics').latest.variant, UK_MARKET);
});

test('the daily kind is filtered too, and it never was before', () => {
  // `movement` is `(location, language, device)`-scoped exactly like the census
  // beside it, and the UK row is NEWER than the US one — so the old rule, which
  // only named `positions`, handed a US goal the UK daily rank.
  const picked = pickDfs(US);
  assert.equal(picked.get('movement').latest.variant, US);
  assert.equal(picked.get('positions').latest.variant, US);
});

test('a domain-scoped kind answers for any market, because it has only one', () => {
  // A backlink profile and a website's HTML have no US-desktop version. Compared
  // on the market, `0|any|any` would never match `2840|en|…` and both screens'
  // worth of fields would be permanently unbindable.
  const picked = pickDfs(US);
  assert.equal(picked.get('backlinks_summary').latest.variant, WHOLE_DOMAIN);
  assert.equal(picked.get('site_audit').latest.variant, WHOLE_DOMAIN);
});

test('with no choice on the link, each kind reads its own newest series', () => {
  // And NOT a mixture: resolving one variant globally from the rank rows would
  // be the same hardcode wearing a different hat.
  const picked = selectSnapshots(dfsRows, { ...WINDOW, sameVariant: dataforseo.sameVariant });
  assert.equal(picked.get('positions').latest.variant, US);
  assert.equal(picked.get('movement').latest.variant, UK);
  assert.equal(picked.get('keyword_metrics').latest.variant, UK_MARKET);
});

test('a variant the project never produced still falls back rather than emptying the row', () => {
  const picked = pickDfs('2250|fr|mobile');
  assert.equal(picked.get('positions').latest.variant, US);
  assert.ok(picked.get('keyword_metrics').latest);
});

test('a provider that declares no rule gets exactly what it had before', () => {
  // Ubersuggest has one variant shape and declares nothing, so the fallback in
  // `selectSnapshots` is the literal comparison that was there — `positions`
  // filtered, everything else untouched.
  assert.equal(ubersuggest.sameVariant, undefined);
  const rows = [
    row('positions', '2026-09-20', 'desktop|en|2840'),
    row('positions', '2026-09-19', 'desktop|en|2826'),
    row('keyword_metrics', '2026-09-18', 'desktop|en|2826'),
  ];
  const picked = selectSnapshots(rows, { ...WINDOW, variant: 'desktop|en|2826' });
  assert.equal(picked.get('positions').latest.variant, 'desktop|en|2826');
  assert.equal(picked.get('keyword_metrics').latest.variant, 'desktop|en|2826');
});

// ---------------------------------------------------------------------------
// planGoalWrites — the guard on the pair
// ---------------------------------------------------------------------------

const SCORE_COLUMN = '6b466b99ea3ab35ff1379001';

/** `onpage_score` into BOTH ends of a graded goal — the shape the guard is for. */
const MAPPINGS = [
  {
    provider: 'dataforseo',
    sourceField: 'onpage_score',
    target: { kind: 'goalBuiltin', builtin: 'actual', columnId: null },
    autoFill: true,
    targetCapability: 'goal.track',
    targetPeriod: 'latest',
    targetLabel: 'Result',
  },
  {
    provider: 'dataforseo',
    sourceField: 'onpage_score',
    target: { kind: 'goalBuiltin', builtin: 'config.baseline', columnId: null },
    autoFill: true,
    targetCapability: 'goal.manage',
    targetPeriod: 'monthStart',
    targetLabel: 'Starting point',
  },
];

const snapshotsFor = (previousOver) =>
  new Map([
    [
      'site_audit',
      {
        latest: { periodKey: '2026-09-28', collectedAt: null, data: crawl({ totals: { onpageScore: 91 } }) },
        monthStart: {
          periodKey: '2026-08-30',
          collectedAt: null,
          data: crawl({ totals: { onpageScore: 62 }, ...previousOver }),
        },
      },
    ],
  ]);

const planAudit = (previousOver = {}) =>
  planGoalWrites({
    goal: { type: 'numeric', config: {}, actual: null, columnValues: {} },
    link: { claimedAt: null, autoFill: true, applied: {}, keyword: null },
    mappings: MAPPINGS,
    fieldFor: (key) => dataforseo.fields.find((f) => f.key === key) || null,
    readField: dataforseo.readField,
    snapshots: snapshotsFor(previousOver),
    // A person pressed the button, so the promise half is writable. That is the
    // case the guard has to hold in — the unattended run cannot write a baseline
    // at all, and a guard that only worked there would be untested in practice.
    canWrite: () => true,
    comparability: dataforseo.comparability,
    now: new Date('2026-09-30T00:00:00.000Z'),
  });

const byTarget = (writes) =>
  Object.fromEntries(writes.map((w) => [w.target.builtin || w.targetId, w.value]));

test('two comparable crawls fill both ends of the goal', () => {
  const plan = planAudit();
  const writes = byTarget(plan.writes);
  assert.equal(writes.actual, 91);
  assert.equal(writes['config.baseline'], 62);
  assert.equal(plan.skipped, 0);
});

test('an incomparable pair leaves the starting point EMPTY and says why', () => {
  /**
   * The trap phase 8 exists to stop, arriving through a goal cell. `62 → 91` off
   * two crawls of different sizes reads as a 29-point improvement and is a chart
   * of `max_crawl_pages`.
   *
   * The RESULT still writes: the newest reading is a true reading of this month,
   * and only the pair is unsound. Refusing both would blank a cell over a
   * comparison nobody had asked for yet.
   */
  const plan = planAudit({ configHash: 'ffffffffffffffff', config: { max_crawl_pages: 100 } });
  const writes = byTarget(plan.writes);
  assert.equal(writes.actual, 91);
  assert.equal('config.baseline' in writes, false);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.suggestions.length, 0);
  assert.match(plan.notes.join(' '), /different settings/);
});

test('a crawl that stopped early is refused through the same door', () => {
  const plan = planAudit({ crawl: { pagesCrawled: 500, stopReason: 'limit_exceeded' } });
  assert.equal('config.baseline' in byTarget(plan.writes), false);
  assert.match(plan.notes.join(' '), /stopped early/);
});

test('the guard is optional, and without it the baseline fills as it always did', () => {
  // A provider that declares no rule must behave exactly as it did before this
  // existed — otherwise the hook is a behaviour change for everybody.
  const plan = planGoalWrites({
    goal: { type: 'numeric', config: {}, actual: null, columnValues: {} },
    link: { claimedAt: null, autoFill: true, applied: {}, keyword: null },
    mappings: MAPPINGS,
    fieldFor: (key) => dataforseo.fields.find((f) => f.key === key) || null,
    readField: dataforseo.readField,
    snapshots: snapshotsFor({ configHash: 'ffffffffffffffff' }),
    canWrite: () => true,
    now: new Date('2026-09-30T00:00:00.000Z'),
  });
  assert.equal(byTarget(plan.writes)['config.baseline'], 62);
});

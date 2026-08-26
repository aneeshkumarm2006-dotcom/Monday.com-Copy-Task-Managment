const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const {
  planProjectWork,
  periodKeyFrom,
  isFresh,
} = require('./snapshotService');
const { resolveKinds, getKind } = require('./ubersuggest/kinds');

/**
 * The quota decisions, isolated from the network and the database.
 *
 * ---- Why these are the tests worth having ----------------------------------
 *
 * Everything in `snapshotService.js` that can be got wrong expensively is
 * decided in `planProjectWork` before a single call is made, and every one of
 * those decisions is somebody's bill:
 *
 *   - re-fetching data that has not moved. Ubersuggest collects rankings ONCE A
 *     WEEK on every plan, so a runner that polls daily gets byte-identical rows
 *     and spends a quota shared by the whole workspace seven times over to get
 *     them.
 *   - calling a domain tool for a project with no domain. None of the audit or
 *     domain tools accepts a project id, so that call can only ever be a fatal
 *     error — and a fatal error costs the same report as a successful call.
 *   - never coming back for a half-finished crawl, which would leave a section
 *     showing "47 of 150 pages" forever.
 *
 * And one that is not about money at all: a FINISHED reading must never be
 * replaced by a partial one for the same period. See the write path's filter.
 */

const HOUR = 3_600_000;
const WEEKLY = 168;

const project = (overrides = {}) => ({
  _id: 'p1',
  externalId: '5512',
  domain: 'acme.com',
  locations: [{ locId: 2840, lang: 'en' }],
  ...overrides,
});

/** The real Ubersuggest variant planner — this is a test of the pair. */
const variantsFor = require('./ubersuggest/fetchers').variantsFor;

const snapshot = (overrides = {}) => ({
  kind: 'positions',
  variant: 'desktop|en|2840',
  status: 'ok',
  fetchedAt: new Date(),
  ...overrides,
});

const plan = (args = {}) =>
  planProjectWork({
    project: project(),
    kinds: resolveKinds([]),
    variantsFor,
    latest: new Map(),
    intervalHours: WEEKLY,
    now: new Date('2026-08-27T12:00:00Z'),
    ...args,
  });

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test('a reading inside the provider’s own cadence is not re-fetched', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const twoDaysAgo = new Date(now.getTime() - 48 * HOUR);
  assert.equal(isFresh(snapshot({ fetchedAt: twoDaysAgo }), WEEKLY, now), true);
});

test('a reading older than the cadence is stale', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const nineDaysAgo = new Date(now.getTime() - 9 * 24 * HOUR);
  assert.equal(isFresh(snapshot({ fetchedAt: nineDaysAgo }), WEEKLY, now), false);
});

test('a PARTIAL reading is never fresh, however recent', () => {
  // It is a crawl that had not finished or a report that timed out. The whole
  // reason to come back is that there is more of it now — treating it as
  // current would freeze the section at "47 of 150 pages" for a week.
  const now = new Date();
  assert.equal(isFresh(snapshot({ status: 'partial', fetchedAt: now }), WEEKLY, now), false);
});

test('nothing at all is never fresh', () => {
  assert.equal(isFresh(null, WEEKLY, new Date()), false);
  assert.equal(isFresh(snapshot({ fetchedAt: null }), WEEKLY, new Date()), false);
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test('a first run fetches every kind, positions once per tracked locale', () => {
  const { todo } = plan({
    project: project({
      locations: [
        { locId: 2840, lang: 'en' },
        { locId: 2826, lang: 'en' },
      ],
    }),
  });
  const positions = todo.filter((t) => t.kind.key === 'positions');
  assert.equal(positions.length, 2);
  assert.deepEqual(
    positions.map((t) => t.variant.key),
    ['desktop|en|2840', 'desktop|en|2826']
  );
  // Five kinds, one of which has two variants.
  assert.equal(todo.length, 6);
});

test('a kind already current is SKIPPED, and that is the whole quota story', () => {
  const latest = new Map([['positions|desktop|en|2840', snapshot()]]);
  const { todo, skipped } = plan({ latest });

  assert.ok(!todo.some((t) => t.kind.key === 'positions'));
  assert.ok(skipped.some((s) => s.kind === 'positions' && s.reason === 'already current'));
  // Everything else still runs — freshness is per (kind, variant), not per
  // project. One current reading must not hold up four stale ones.
  assert.equal(todo.length, 4);
});

test('force ignores freshness, because a person pressing Refresh has decided', () => {
  const latest = new Map([['positions|desktop|en|2840', snapshot()]]);
  const { todo } = plan({ latest, force: true });
  assert.ok(todo.some((t) => t.kind.key === 'positions'));
});

test('a domain kind is skipped BEFORE the call when the project has no domain', () => {
  // The audit and domain tools take a domain and know nothing about projects, so
  // this call could only ever be a fatal error — at the price of a real one.
  const { todo, skipped } = plan({ project: project({ domain: null }) });

  const domainKinds = ['site_audit', 'domain_overview', 'backlinks'];
  for (const key of domainKinds) {
    assert.ok(!todo.some((t) => t.kind.key === key), `${key} should not be planned`);
    assert.ok(
      skipped.some((s) => s.kind === key && /needs a domain/.test(s.reason)),
      `${key} should say why`
    );
  }
  // The two project-subject kinds are unaffected.
  assert.deepEqual(todo.map((t) => t.kind.key), ['positions', 'keyword_metrics']);
});

test('a locale cap is recorded in the plan, not swallowed', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ locId: 2000 + i, lang: 'en' }));
  const { skipped } = plan({ project: project({ locations: many }) });
  assert.ok(skipped.some((s) => /further location/.test(s.reason)));
});

test('a narrowed board still gets the dependency it needs', () => {
  const { todo } = plan({ kinds: resolveKinds(['keyword_metrics']) });
  assert.deepEqual(todo.map((t) => t.kind.key), ['positions', 'keyword_metrics']);
});

test('the plan preserves dependency order, so the runner can walk it once', () => {
  const { todo } = plan();
  const keys = todo.map((t) => t.kind.key);
  assert.ok(keys.indexOf('positions') < keys.indexOf('keyword_metrics'));
});

test('a kind whose dependency is already current is still planned', () => {
  // The runner is what decides to skip a dependant whose dependency did not RUN
  // this pass. Planning it is correct — the alternative would silently drop
  // keyword metrics every week after the first.
  const latest = new Map([['positions|desktop|en|2840', snapshot()]]);
  const { todo } = plan({ latest });
  assert.ok(todo.some((t) => t.kind.key === 'keyword_metrics'));
});

// ---------------------------------------------------------------------------
// periodKey
// ---------------------------------------------------------------------------

test('the period comes from the PROVIDER’s collection time when it gives one', () => {
  // This is what makes a second poll in the same week land on the same row
  // instead of drawing a second point on every chart.
  const now = new Date('2026-08-27T12:00:00Z');
  assert.equal(periodKeyFrom('2026-08-24T06:12:00.000Z', now), '2026-08-24');
  // Polled again three days later, same collection time, same period.
  assert.equal(
    periodKeyFrom('2026-08-24T06:12:00.000Z', new Date('2026-08-30T12:00:00Z')),
    '2026-08-24'
  );
});

test('our clock is the fallback, not the default', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  assert.equal(periodKeyFrom(null, now), '2026-08-27');
  assert.equal(periodKeyFrom(undefined, now), '2026-08-27');
});

test('an unparseable provider timestamp falls back rather than throwing', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  assert.equal(periodKeyFrom('last tuesday', now), '2026-08-27');
});

// ---------------------------------------------------------------------------
// The kind catalog's contract with the planner
// ---------------------------------------------------------------------------

test('every domain-subject kind declares `requires: domain`', () => {
  // The planner's skip is driven by `requires`, so a domain kind that forgot to
  // declare it would go straight to a fatal call for every project with no
  // domain in the pool.
  for (const kind of resolveKinds([])) {
    if (kind.subject === 'domain') {
      assert.equal(kind.requires, 'domain', `${kind.key} must require a domain`);
    }
  }
});

test('no kind depends on itself or on something that does not exist', () => {
  for (const kind of resolveKinds([])) {
    for (const dep of kind.dependsOn) {
      assert.notEqual(dep, kind.key, `${kind.key} depends on itself`);
      assert.ok(getKind(dep), `${kind.key} depends on unknown "${dep}"`);
    }
  }
});

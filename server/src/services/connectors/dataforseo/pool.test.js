const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./constants');
const {
  DB_BACKED_PREFIXES,
  isDbBackedEndpoint,
  withDbBackedSlot,
  poolStats,
  resetPool,
} = require('./pool');

/**
 * ONE ceiling, three APIs — the property phases 7 and 8 inherit or lose.
 *
 * DataForSEO caps SIMULTANEOUS requests at THIRTY across its database-backed
 * families, and Labs, Backlinks and OnPage all draw on that same thirty. The
 * mistake this file exists to make impossible is the natural one: a limiter per
 * API, each sized at the published ceiling, which is ninety in flight against a
 * limit of thirty and a storm of `40209`s spread across a shared credential.
 *
 * So the tests below assert the pool is SHARED — a Backlinks call and an OnPage
 * call take slots from the same counter a Labs call does — rather than merely
 * that a Labs limiter works.
 */

/** A promise plus its resolver, so a test can hold a call open deliberately. */
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// ---------------------------------------------------------------------------
// What counts against the ceiling
// ---------------------------------------------------------------------------

test('the three families that share the ceiling are all in the pool', () => {
  // Phase 6's own.
  assert.equal(isDbBackedEndpoint(C.ENDPOINT_LABS_KEYWORD_OVERVIEW), true);
  assert.equal(isDbBackedEndpoint(C.ENDPOINT_LABS_STATUS), true);

  /**
   * PHASE 7 AND PHASE 8, listed before they exist.
   *
   * The list is the contract, and a contract written after the fact is a
   * contract somebody has to remember on the day it matters. A prefix here that
   * nothing calls costs nothing; a prefix missing the day `backlinks/summary`
   * ships costs a ceiling with no error to announce its absence.
   */
  assert.equal(isDbBackedEndpoint('backlinks/summary/live'), true);
  assert.equal(isDbBackedEndpoint('on_page/summary/abc-123'), true);
  assert.equal(isDbBackedEndpoint('content_analysis/summary/live'), true);
  assert.equal(isDbBackedEndpoint('domain_analytics/whois/overview/live'), true);
});

test('the QUEUED SERP family is deliberately outside the pool', () => {
  /**
   * `serp/` is not DB-backed and its `task_get` polls are free and outside this
   * ceiling. Putting them in would make two hundred free polls queue behind the
   * calls that cost money — the exact inversion of what the pool is for.
   */
  assert.equal(isDbBackedEndpoint(C.ENDPOINT_SERP_TASK_POST), false);
  assert.equal(isDbBackedEndpoint(C.ENDPOINT_SERP_TASK_GET), false);
  assert.equal(isDbBackedEndpoint(C.ENDPOINT_SERP_TASKS_READY), false);
  assert.equal(isDbBackedEndpoint(C.ENDPOINT_USER_DATA), false);
  assert.equal(isDbBackedEndpoint(''), false);
  assert.equal(isDbBackedEndpoint(null), false);
});

test('our limit sits UNDER their ceiling, and the margin is real', () => {
  assert.ok(
    C.DB_BACKED_POOL_LIMIT < C.DB_BACKED_SIMULTANEOUS_CEILING,
    'a pool sized at the provider ceiling leaves no room for a second instance'
  );
  assert.equal(C.DB_BACKED_SIMULTANEOUS_CEILING, 30);
  assert.equal(poolStats().ceiling, C.DB_BACKED_SIMULTANEOUS_CEILING);
});

// ---------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------

test('the bound holds across families — Labs, Backlinks and OnPage share it', async () => {
  resetPool({ limit: 2 });

  const gates = [];
  const endpoints = [
    C.ENDPOINT_LABS_KEYWORD_OVERVIEW,
    'backlinks/summary/live',
    'on_page/summary/x',
    C.ENDPOINT_LABS_COMPETITORS_DOMAIN,
    'backlinks/anchors/live',
    'on_page/links',
  ];

  const runs = endpoints.map((endpoint) => {
    const gate = deferred();
    gates.push(gate);
    return withDbBackedSlot(endpoint, () => gate.promise);
  });

  // Let the pool admit whatever it is going to admit.
  await new Promise((r) => setImmediate(r));

  assert.equal(poolStats().inFlight, 2, 'three families must not get two slots each');
  assert.equal(poolStats().waiting, 4);

  // Drain, releasing one at a time, and watch the ceiling hold throughout.
  for (const gate of gates) {
    gate.resolve('ok');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
    assert.ok(poolStats().inFlight <= 2, 'the pool over-admitted while draining');
  }

  assert.deepEqual(await Promise.all(runs), new Array(6).fill('ok'));
  assert.equal(poolStats().peakInFlight, 2);
  assert.equal(poolStats().inFlight, 0, 'every slot must come back');
});

test('a REJECTION gives its slot back — a bad afternoon must not wind the pool to zero', async () => {
  resetPool({ limit: 1 });

  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      withDbBackedSlot(C.ENDPOINT_LABS_STATUS, async () => {
        throw new Error('40209');
      }),
      /40209/
    );
  }

  assert.equal(poolStats().inFlight, 0);

  // And the pool still works afterwards, which is the whole point: a leak of one
  // slot per failure is invisible until every call hangs forever with no error.
  assert.equal(await withDbBackedSlot(C.ENDPOINT_LABS_STATUS, async () => 'alive'), 'alive');
});

test('waiters are served FIFO, so a shared account cannot starve one workspace', async () => {
  resetPool({ limit: 1 });

  const order = [];
  const gate = deferred();

  const first = withDbBackedSlot('backlinks/summary/live', async () => {
    order.push('first');
    return gate.promise;
  });
  await new Promise((r) => setImmediate(r));

  const rest = ['a', 'b', 'c'].map((name) =>
    withDbBackedSlot(C.ENDPOINT_LABS_STATUS, async () => {
      order.push(name);
    })
  );

  gate.resolve();
  await Promise.all([first, ...rest]);

  assert.deepEqual(order, ['first', 'a', 'b', 'c']);
});

test('a non-pooled endpoint runs without ever taking a slot', async () => {
  resetPool({ limit: 1 });

  let sawInFlight = null;
  await withDbBackedSlot(C.ENDPOINT_SERP_TASK_GET, async () => {
    sawInFlight = poolStats().inFlight;
  });

  assert.equal(sawInFlight, 0, 'a free SERP poll must not consume a Labs slot');
  assert.equal(poolStats().admitted, 0);
});

test('the prefix list is data, so phases 7 and 8 are one line each', () => {
  assert.ok(DB_BACKED_PREFIXES.includes('dataforseo_labs/'));
  assert.ok(DB_BACKED_PREFIXES.includes('backlinks/'));
  assert.ok(DB_BACKED_PREFIXES.includes('on_page/'));
  // Restore the shipped limit for anything that runs after this file.
  resetPool();
  assert.equal(poolStats().limit, C.DB_BACKED_POOL_LIMIT);
});

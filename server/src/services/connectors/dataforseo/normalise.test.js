/**
 * TZ is set BEFORE anything else, because the bug under test is a timezone bug.
 *
 * Node re-reads `process.env.TZ` on every `Date` construction, so this is enough
 * — and it has to be a zone AHEAD of UTC for the interesting half: a bare
 * DataForSEO timestamp just after midnight, read as server-local in Asia/Kolkata
 * (+05:30), lands on the PREVIOUS UTC day. Production on Render runs UTC and
 * would mask every assertion below, which is the whole reason they are pinned to
 * a zone rather than left to the machine.
 */
process.env.TZ = 'Asia/Kolkata';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDfsTime, normaliseUserData } = require('./normalise');
const { periodKeyFrom } = require('../snapshotService');

/**
 * DataForSEO timestamps, and the silent wrong answer they produce untouched.
 *
 * A snapshot is IDENTIFIED by its day. `periodKeyFrom` takes
 * `collectedAt.toISOString().slice(0, 10)` and falls back to today for anything
 * it cannot read — so both failure modes here are silent and both produce a
 * plausible, authoritative-looking, wrong period:
 *
 *   a bare string read as local time files the reading under the wrong DAY,
 *   where it collides with that day's real reading on the unique index and is
 *   dropped as "the row we already had was better";
 *
 *   an unparseable string files it under TODAY, squatting in the slot the real
 *   reading needs.
 *
 * Neither reports a fault anywhere. That is why parsing is explicit and why an
 * unreadable value throws.
 */

// ---------------------------------------------------------------------------
// 1. The trap itself
// ---------------------------------------------------------------------------

test('the bug is real: V8 reads a bare DataForSEO timestamp as SERVER-LOCAL', () => {
  // Not a test of our code — a test that the thing we are defending against
  // actually happens on this runtime. If this ever stops being true, the
  // defence below can be reconsidered rather than cargo-culted.
  const bare = '2026-09-01 00:03:12';
  assert.equal(new Date(bare).toISOString(), '2026-08-31T18:33:12.000Z');
  // The previous day. And that is what a period key would have been built from.
  assert.equal(periodKeyFrom(new Date(bare)), '2026-08-31');
});

test('a bare timestamp is UTC, so it keeps the day the provider meant', () => {
  const parsed = parseDfsTime('2026-09-01 00:03:12');
  assert.equal(parsed.toISOString(), '2026-09-01T00:03:12.000Z');
  assert.equal(periodKeyFrom(parsed), '2026-09-01');
});

test('the same instant survives every spelling DataForSEO uses', () => {
  const forms = [
    '2026-09-01 00:03:12 +00:00',
    '2026-09-01 00:03:12+00:00',
    '2026-09-01T00:03:12Z',
    '2026-09-01 00:03:12',
    '2026-09-01T00:03:12+0000',
  ];
  for (const form of forms) {
    assert.equal(
      parseDfsTime(form).toISOString(),
      '2026-09-01T00:03:12.000Z',
      `"${form}" did not parse to the same instant`
    );
  }
});

test('a real offset is applied rather than ignored', () => {
  // The other direction of the same bug: a string that DOES carry an offset must
  // not be re-read as UTC either.
  assert.equal(
    parseDfsTime('2026-09-01 05:30:00 +05:30').toISOString(),
    '2026-09-01T00:00:00.000Z'
  );
  assert.equal(
    parseDfsTime('2026-08-31 20:00:00 -04:00').toISOString(),
    '2026-09-01T00:00:00.000Z'
  );
});

test('fractional seconds are kept to milliseconds and never rounded up a day', () => {
  assert.equal(
    parseDfsTime('2026-09-01 00:03:12.123456').toISOString(),
    '2026-09-01T00:03:12.123Z'
  );
  assert.equal(
    parseDfsTime('2026-12-31 23:59:59.999').toISOString(),
    '2026-12-31T23:59:59.999Z'
  );
});

test('a Date passes through as a COPY', () => {
  const original = new Date('2026-09-01T00:03:12.000Z');
  const parsed = parseDfsTime(original);
  assert.equal(parsed.getTime(), original.getTime());
  parsed.setUTCFullYear(1999);
  assert.equal(original.getUTCFullYear(), 2026);
});

// ---------------------------------------------------------------------------
// 2. It THROWS rather than guessing
// ---------------------------------------------------------------------------

test('anything unreadable throws, because the fallback is a plausible wrong day', () => {
  const bad = [
    'yesterday',
    '',
    '   ',
    null,
    undefined,
    42,
    // A date with no time is not a DataForSEO timestamp. Accepting it would mean
    // deciding what o'clock it was, which is a guess.
    '2026-09-01',
    '01/09/2026 00:03:12',
    '2026-09-01 00:03',
    new Date('nope'),
  ];
  for (const value of bad) {
    assert.throws(
      () => parseDfsTime(value),
      (err) => err.name === 'DfsError',
      `${JSON.stringify(value)} should not have parsed`
    );
  }
});

test('an impossible date is refused rather than rolled into the next month', () => {
  // `Date.UTC(2026, 12, 45)` is happy to become 2027-01-14. A snapshot keyed on
  // a rolled date is exactly the failure this function exists to prevent.
  assert.throws(() => parseDfsTime('2026-13-45 00:00:00'), /impossible/);
  assert.throws(() => parseDfsTime('2026-02-30 00:00:00'), /impossible/);
});

test('the failure names the field, so a log line says what was unreadable', () => {
  assert.throws(
    () => parseDfsTime('nope', 'crawl finish time'),
    /crawl finish time/
  );
});

// ---------------------------------------------------------------------------
// 3. /v3/appendix/user_data
// ---------------------------------------------------------------------------

const USER_DATA = {
  login: 'ops@example.com',
  timezone: 'Europe/Kiev',
  rates: { limits: { minute: 2000 } },
  money: {
    total: 100,
    balance: 55.5,
    limits: { minute: 20, day: 100 },
  },
  price: { serp: { google: { organic: { task_post: 0.0006 } } } },
};

test('identity and money are split, because they go to different fields', () => {
  const now = new Date('2026-09-01T00:00:00.000Z');
  const { identity, quota } = normaliseUserData(USER_DATA, { now });

  // Identity goes to `recordIdentity`, which fills the fields the account list
  // already renders.
  assert.equal(identity.externalEmail, 'ops@example.com');
  assert.equal(identity.externalAccountId, null);
  // DataForSEO has no plans at all. Saying so beats a null, which reads as "we
  // could not find out".
  assert.equal(identity.tier, 'pay-as-you-go');

  // Money goes to `lastSeenQuota`, which has never had a writer until now.
  assert.equal(quota.balanceUsd, 55.5);
  assert.equal(quota.totalUsd, 100);
  assert.deepEqual(quota.moneyLimits, { minute: 20, day: 100 });
  assert.equal(quota.observedAt, now);
  // The price book whole, for the same reason `raw` is kept: phase 3 will want a
  // price we did not anticipate, and re-syncing every account to get it is not a
  // thing anybody should have to do.
  assert.equal(quota.price.serp.google.organic.task_post, 0.0006);
});

test('a shape we did not expect degrades to nulls instead of throwing', () => {
  // This endpoint is free and runs on every pass. A shape change must cost us a
  // display value, never a sync.
  for (const payload of [null, undefined, 'nope', [], {}, { money: 'none' }]) {
    const { identity, quota } = normaliseUserData(payload);
    assert.equal(identity.externalEmail, null);
    assert.equal(quota.balanceUsd, null);
    assert.equal(quota.price, null);
  }
});

test('a balance of zero is zero, not "unknown"', () => {
  // The one number an alarm actually watches. Coercing it to null through a
  // falsy check would silence the alarm at the exact moment it matters.
  const { quota } = normaliseUserData({ money: { balance: 0, total: 0 } });
  assert.equal(quota.balanceUsd, 0);
  assert.equal(quota.totalUsd, 0);
});

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * The exchange-rate HISTORY policy: what the browser is sent, what a backfill
 * asks for, when the runner decides history is too thin, and when a backfill
 * gives up.
 *
 * Almost all of it is pure, and tested as such — no provider, no network. The
 * one database block at the end checks the two things only a real collection
 * can: that `snapshotsFor` still hands back full rate tables in the same shape
 * after becoming two reads, and that a monthly workspace's opening-day fetch is
 * skipped when the month is already answered.
 *
 * `e2e/fxRates.e2e.js` is where the LIVE provider is exercised.
 */

const {
  thinSnapshotDays,
  isShallowHistory,
  daysToFetch,
  backfillPlan,
  backfillHistory,
  shiftDayKey,
  RECENT_SNAPSHOTS,
  PUBLICATION_SLACK_DAYS,
} = require('./rateService');
const { FxError } = require('./errors');
const { bootBackfillDays, BACKFILL_MONTHS } = require('../fxRateRunner');

/** Every day from `from` to `to` inclusive, as day keys, oldest first. */
const daysBetween = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = shiftDayKey(d, 1)) out.push(d);
  return out;
};

/** The first of each month, for `n` months ending with `lastMonth` ('YYYY-MM'). */
const monthFirsts = (lastMonth, n) => {
  const [y, m] = lastMonth.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 10));
  }
  return out;
};

const NOW = new Date('2026-09-25T10:00:00Z');

describe('thinSnapshotDays — what the browser is sent', () => {
  test('a short history is sent whole, newest first', () => {
    const keys = ['2026-09-01', '2026-09-03', '2026-09-02'];
    assert.deepEqual(thinSnapshotDays(keys), ['2026-09-03', '2026-09-02', '2026-09-01']);
  });

  test('the newest N in full, then the EARLIEST of each month further back', () => {
    const keys = [
      '2026-09-20', '2026-09-19', '2026-09-18',
      '2026-08-30', '2026-08-02', '2026-08-01',
      '2026-07-31', '2026-07-05',
      '2025-12-01',
    ];
    assert.deepEqual(thinSnapshotDays(keys, { recent: 2 }), [
      '2026-09-20', '2026-09-19',
      // September is the month the dense window starts in: its older days
      // still get a row, or the 1st–17th would fall through to August.
      '2026-09-18',
      '2026-08-01',
      '2026-07-05',
      '2025-12-01',
    ]);
  });

  test('a daily history older than the dense window is no longer cut off', () => {
    // Two years of daily snapshots: the old hard cap of 120 left the browser
    // with four months, and every older invoice unconverted.
    const keys = daysBetween('2024-09-26', '2026-09-25');
    const sent = thinSnapshotDays(keys);
    assert.equal(sent.slice(0, RECENT_SNAPSHOTS).length, RECENT_SNAPSHOTS);
    assert.equal(sent[0], '2026-09-25');
    assert.equal(sent[sent.length - 1], '2024-09-26', 'the oldest month is still represented');
    const tail = sent.slice(RECENT_SNAPSHOTS);
    const months = tail.map((k) => k.slice(0, 7));
    assert.equal(new Set(months).size, months.length, 'one row per month past the dense window');
    for (const k of tail.slice(1, -1)) assert.equal(k.slice(8), '01', `${k} is not its month's earliest`);
    assert.ok(sent.length < RECENT_SNAPSHOTS + 30, `sent ${sent.length} rows`);
  });

  test('duplicates and anything that is not a day key are ignored', () => {
    assert.deepEqual(thinSnapshotDays(['2026-09-01', '2026-09-01', 'nope', null, '2026-13-01']), ['2026-09-01']);
    assert.deepEqual(thinSnapshotDays(null), []);
  });

  test('recent: 0 thins everything to month openings', () => {
    assert.deepEqual(thinSnapshotDays(['2026-09-02', '2026-09-01', '2026-08-15'], { recent: 0 }), [
      '2026-09-01',
      '2026-08-15',
    ]);
  });
});

describe('isShallowHistory — when the runner backfills', () => {
  test('nothing held is shallow', () => {
    assert.equal(isShallowHistory([], { today: '2026-09-25' }), true);
    assert.equal(isShallowHistory(null, { today: '2026-09-25' }), true);
  });

  test('three weeks of daily rows is shallow, however many rows that is', () => {
    assert.equal(isShallowHistory(daysBetween('2026-09-04', '2026-09-25'), { today: '2026-09-25' }), true);
  });

  test('fewer than twelve months is shallow even when some are old', () => {
    assert.equal(isShallowHistory(monthFirsts('2026-09', 11), { today: '2026-09-25' }), true);
  });

  test('two years of month openings is not', () => {
    assert.equal(isShallowHistory(monthFirsts('2026-09', 24), { today: '2026-09-25' }), false);
  });

  test('the age rule on its own: enough months, but nothing 60 days old, is shallow', () => {
    // With the month count relaxed, only the age rule can answer — and two
    // months of daily rows is still not a history an old invoice can use.
    const lastTwoMonths = daysBetween('2026-08-01', '2026-09-25');
    assert.equal(isShallowHistory(lastTwoMonths, { today: '2026-09-25', minMonths: 1 }), true);
    assert.equal(
      isShallowHistory(['2026-07-01', ...lastTwoMonths], { today: '2026-09-25', minMonths: 1 }),
      false,
      'one row from 86 days ago is enough to satisfy it'
    );
  });
});

describe('daysToFetch — what a backfill asks about', () => {
  test('monthly: the first of each month, oldest first, including this month once it is past', () => {
    assert.deepEqual(daysToFetch({ months: 3, now: NOW }), [
      '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01',
    ]);
  });

  test('on the 1st itself, today is left to the latest fetch', () => {
    const first = new Date('2026-09-01T08:00:00Z');
    assert.deepEqual(daysToFetch({ months: 2, now: first }), ['2026-07-01', '2026-08-01']);
    assert.deepEqual(daysToFetch({ months: 0, now: first }), []);
  });

  test('months: 0 is just this month\'s opening', () => {
    assert.deepEqual(daysToFetch({ months: 0, now: NOW }), ['2026-09-01']);
  });

  test('a year boundary is crossed in UTC, not local time', () => {
    const jan = new Date('2027-01-10T00:30:00Z');
    assert.deepEqual(daysToFetch({ months: 2, now: jan }), ['2026-11-01', '2026-12-01', '2027-01-01']);
  });

  test('daily: every day before today, oldest first', () => {
    const days = daysToFetch({ months: 1, daily: true, now: NOW });
    assert.equal(days.length, 30);
    assert.equal(days[days.length - 1], '2026-09-24');
    assert.ok(!days.includes('2026-09-25'));
  });
});

describe('backfillPlan — what is already answered', () => {
  test('a day held exactly is skipped', () => {
    assert.deepEqual(backfillPlan(['2026-07-01', '2026-08-01'], ['2026-08-01']), ['2026-07-01']);
  });

  test('a Sunday the 1st answered by Friday the 30th is not asked again', () => {
    // 2026-11-01 is a Sunday; Frankfurter answers it with Friday 2026-10-30,
    // and `fetchAndStore` files the answer, not the question.
    assert.deepEqual(
      backfillPlan(['2026-11-01'], ['2026-10-30'], { slack: PUBLICATION_SLACK_DAYS }),
      []
    );
  });

  test('a snapshot outside the slack does not count', () => {
    assert.deepEqual(
      backfillPlan(['2026-11-01'], ['2026-10-20'], { slack: PUBLICATION_SLACK_DAYS }),
      ['2026-11-01']
    );
  });

  test('a snapshot AFTER the day never counts — a rate cannot answer for its past', () => {
    assert.deepEqual(
      backfillPlan(['2026-11-01'], ['2026-11-02'], { slack: PUBLICATION_SLACK_DAYS }),
      ['2026-11-01']
    );
  });

  test('daily (no slack): yesterday is a different answer', () => {
    assert.deepEqual(backfillPlan(['2026-09-23', '2026-09-24'], ['2026-09-23']), ['2026-09-24']);
  });
});

describe('bootBackfillDays — the runner\'s one-time pass', () => {
  test('a fresh install asks for two years of month openings, once each', () => {
    const { shallow, days } = bootBackfillDays(['2026-09-25'], { now: NOW });
    assert.equal(shallow, true);
    assert.equal(days.length, BACKFILL_MONTHS + 1);
    assert.equal(days[0], '2024-09-01');
    assert.equal(days[days.length - 1], '2026-09-01');
  });

  test('what a partial earlier backfill already stored is not asked again', () => {
    const held = [...monthFirsts('2026-03', 6), '2026-09-25'];
    const { days } = bootBackfillDays(held, { now: NOW });
    for (const k of monthFirsts('2026-03', 6)) assert.ok(!days.includes(k), `${k} asked again`);
    assert.ok(days.includes('2026-09-01'));
  });

  test('a deep history asks only for this month\'s opening, and only when it is missing', () => {
    const deep = [...monthFirsts('2026-08', 24), '2026-09-25'];
    assert.deepEqual(bootBackfillDays(deep, { now: NOW }), { shallow: false, days: ['2026-09-01'] });
    assert.deepEqual(bootBackfillDays([...deep, '2026-09-01'], { now: NOW }), { shallow: false, days: [] });
  });
});

describe('backfillHistory — when a backfill gives up', () => {
  const ok = async ({ dayKey }) => ({ dayKey, count: 170 });
  const down = async () => {
    throw new FxError('Frankfurter is not responding.', { retryable: true });
  };

  test('stores every day it is given, in order', async () => {
    const asked = [];
    const fetchOne = async (a) => {
      asked.push(a.dayKey);
      return ok(a);
    };
    const r = await backfillHistory({ orgId: 'o', days: ['2026-07-01', '2026-08-01'], fetchOne });
    assert.deepEqual(asked, ['2026-07-01', '2026-08-01']);
    assert.deepEqual(r, { stored: 2, failed: 0, stopped: null, lastError: null });
  });

  test('a missing credential stops at the first day', async () => {
    let calls = 0;
    const fetchOne = async () => {
      calls += 1;
      throw new FxError('needs an API key', { needsConfig: true });
    };
    const r = await backfillHistory({ orgId: 'o', days: ['2026-07-01', '2026-08-01', '2026-09-01'], fetchOne });
    assert.equal(calls, 1);
    assert.equal(r.stopped, 'needs-config');
    assert.equal(r.lastError, 'needs an API key');
  });

  test('a provider that keeps failing is abandoned after N in a row', async () => {
    let calls = 0;
    const fetchOne = async (a) => {
      calls += 1;
      return down(a);
    };
    const days = monthFirsts('2026-09', 10);
    const r = await backfillHistory({ orgId: 'o', days, fetchOne, maxConsecutiveFailures: 3 });
    assert.equal(calls, 3);
    assert.equal(r.stopped, 'failing');
    assert.equal(r.failed, 3);
  });

  test('a success in between resets the count', async () => {
    const script = [down, down, ok, down, down, ok];
    let i = 0;
    const fetchOne = (a) => script[i++](a);
    const r = await backfillHistory({
      orgId: 'o', days: monthFirsts('2026-09', 6), fetchOne, maxConsecutiveFailures: 3,
    });
    assert.equal(r.stopped, null);
    assert.equal(r.stored, 2);
    assert.equal(r.failed, 4);
  });

  test('without a limit it ploughs on, as the script always has', async () => {
    const r = await backfillHistory({ orgId: 'o', days: monthFirsts('2026-09', 5), fetchOne: down });
    assert.equal(r.failed, 5);
    assert.equal(r.stopped, null);
  });

  test('a dry run asks nothing', async () => {
    const fetchOne = async () => assert.fail('a dry run fetched');
    const r = await backfillHistory({ orgId: 'o', days: ['2026-07-01'], dryRun: true, fetchOne });
    assert.equal(r.stored, 1);
  });
});

describe('against a real collection', () => {
  const mongoose = require('mongoose');
  let mem;
  let FxSnapshot;
  let rateService;

  before(async () => {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    require('../../models');
    FxSnapshot = mongoose.model('FxSnapshot');
    await FxSnapshot.init();
    rateService = require('./rateService');
  });

  after(async () => {
    await mongoose.disconnect();
    if (mem) await mem.stop();
  });

  test('snapshotsFor sends the dense window plus one per older month, with full tables', async () => {
    const keys = daysBetween('2025-01-01', '2026-09-25');
    await FxSnapshot.insertMany(
      keys.map((dayKey, i) => ({ base: 'USD', dayKey, rates: { USD: 1, INR: 80 + i / 100 }, provider: 'frankfurter' }))
    );

    const sent = await rateService.snapshotsFor();
    assert.deepEqual(
      sent.map((s) => s.dayKey),
      thinSnapshotDays(keys),
      'the collection and the pure policy disagree'
    );
    assert.equal(sent[0].dayKey, '2026-09-25');
    assert.equal(sent[sent.length - 1].dayKey, '2025-01-01');
    // Same wire shape as before: a plain object of rates, and the provider.
    assert.equal(sent[0].rates.USD, 1);
    assert.equal(typeof sent[0].rates.INR, 'number');
    assert.equal(sent[0].provider, 'frankfurter');
    assert.deepEqual(Object.keys(sent[0]).sort(), ['dayKey', 'provider', 'rates']);
  });

  test('a month already opened is not fetched again, and today is never "history"', async () => {
    // The collection above holds 2026-09-01, so September's opening is answered.
    assert.equal(
      await rateService.ensurePeriodOpening({ orgId: new mongoose.Types.ObjectId(), period: '2026-09', today: '2026-09-25' }),
      null
    );
    // On the 1st itself the latest fetch has just answered it.
    assert.equal(
      await rateService.ensurePeriodOpening({ orgId: new mongoose.Types.ObjectId(), period: '2026-10', today: '2026-10-01' }),
      null
    );
  });

  test('an opening that cannot be fetched is reported, never thrown', async () => {
    // No such workspace, so no provider to ask: the fetch fails before any
    // network, which is exactly the failure this must swallow.
    const r = await rateService.ensurePeriodOpening({
      orgId: new mongoose.Types.ObjectId(),
      period: '2026-12',
      today: '2026-12-15',
    });
    assert.equal(r.requested, '2026-12-01');
    assert.equal(typeof r.error, 'string');
  });
});

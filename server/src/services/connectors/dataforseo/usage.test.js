const test = require('node:test');
const assert = require('node:assert/strict');

const DfsTask = require('../../../models/DfsTask');
const { describeUsage, monthKeys, moneyMonthOf } = require('./usage');
const { SCREENS, SCREEN_KEYS, resolveScreens, RUNNERS } = require('./screens');
const { rebuyGuard, runTaskKind } = require('./fetchers');
const { KINDS, getKind } = require('./kinds');
const C = require('./constants');

/**
 * Phase 5's three server-side properties, none of which have a UI to reveal them
 * if they are wrong.
 *
 *   1. THE SPEND LEDGER FILES MONEY UNDER THE MONTH IT WAS CHARGED, which is
 *      `postedAt` and never the collection. Get this wrong and the screen
 *      disagrees with `ConnectorBudget` on exactly the days a month rolls over —
 *      the days somebody is most likely to be looking at it.
 *   2. A "LAST COLLECTED" TIME IS NOT A CHARGE. `readyAt` is when the free
 *      ten-minute sweep observed a result. Reporting it as spend would credit
 *      the one runner that cannot spend with the money.
 *   3. THE PROVIDER'S REBUY FLOOR HOLDS UNDER A BOARD-CONFIGURED CADENCE. Phase
 *      5 put `intervalHours` on `BoardConnector` and it is resolved as a min
 *      across boards, so a single board typing `1` would otherwise buy a
 *      depth-100 census every hour on a provider that bills at post.
 */

const PROJECT_A = '6a466b99ea3ab35ff1378f01';
const PROJECT_B = '6a466b99ea3ab35ff1378f02';

const NOW = new Date('2026-09-03T10:00:00Z');

const projects = [
  { _id: PROJECT_A, name: 'Acme', domain: 'acme.com' },
  { _id: PROJECT_B, name: '', domain: 'beta.com' },
];

/** A thenable answering `.select().sort().limit().lean()` in any order. */
const chain = (value) => {
  const self = {
    select: () => self,
    sort: () => self,
    limit: () => self,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return self;
};

const stubTasks = (rows) => {
  const original = DfsTask.find;
  const seen = [];
  DfsTask.find = (filter) => {
    seen.push(filter);
    return chain(rows);
  };
  return { filters: seen, restore: () => { DfsTask.find = original; } };
};

const task = (overrides = {}) => ({
  project: PROJECT_A,
  kind: 'positions',
  variant: 'desktop|en|2840',
  state: 'done',
  budgetState: 'settled',
  attempt: 1,
  keywords: ['a', 'b', 'c'],
  estimateUsd: 0.18,
  costUsd: 0.18,
  postedAt: new Date('2026-09-01T04:17:00Z'),
  readyAt: new Date('2026-09-01T04:29:00Z'),
  expiresAt: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Month keys
// ---------------------------------------------------------------------------

test('monthKeys walks backwards from the current month, newest first', () => {
  assert.deepEqual(monthKeys(4, new Date('2026-01-15T00:00:00Z')), [
    '2026-01',
    '2025-12',
    '2025-11',
    '2025-10',
  ]);
});

test('monthKeys is UTC, so a late-evening local date does not skip a month', () => {
  // 2026-03-01T00:30Z is still February in every timezone west of London. The
  // budget documents are keyed in UTC, so this must be too or the newest column
  // names a month `ConnectorBudget` has no row for.
  assert.equal(monthKeys(1, new Date('2026-03-01T00:30:00Z'))[0], '2026-03');
});

// ---------------------------------------------------------------------------
// Which month the money belongs to
// ---------------------------------------------------------------------------

test('money is filed under the month it was POSTED, not collected', () => {
  // The case this exists for: bought at 23:50 on the last day of August,
  // collected the next morning. DataForSEO charged in August.
  const row = task({
    postedAt: new Date('2026-08-31T23:50:00Z'),
    readyAt: new Date('2026-09-01T00:05:00Z'),
  });
  assert.equal(moneyMonthOf(row), '2026-08');
});

test('a claim that never posted has no month and therefore no cost', () => {
  assert.equal(moneyMonthOf(task({ postedAt: null })), null);
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test('describeUsage answers a full shell for a board with no projects', async () => {
  const stub = stubTasks([]);
  try {
    const out = await describeUsage({ projects: [], now: NOW });
    // No database read at all — nothing to aggregate.
    assert.equal(stub.filters.length, 0);
    assert.equal(out.queued, 0);
    assert.equal(out.months.length, 6);
    assert.equal(out.months[0].periodKey, '2026-09');
    assert.equal(out.months[0].spentUsd, 0);
    assert.deepEqual(out.byKind, []);
    assert.equal(out.sandbox, C.IS_SANDBOX);
    // The two clocks travel with the payload so the screen cannot invent them.
    assert.equal(out.runners.length, 2);
    assert.equal(out.runners.filter((r) => r.spends).length, 1);
  } finally {
    stub.restore();
  }
});

test('spend rolls up per month and per kind, and open jobs are counted apart', async () => {
  const stub = stubTasks([
    task({ costUsd: 0.12 }),
    task({ kind: 'movement', costUsd: 0.012, keywords: ['a'] }),
    // Last month.
    task({ costUsd: 0.2, postedAt: new Date('2026-08-25T04:17:00Z') }),
    // In flight: bought, not delivered.
    task({
      project: PROJECT_B,
      state: 'open',
      costUsd: 0.06,
      postedAt: new Date('2026-09-03T09:17:00Z'),
      readyAt: null,
      expiresAt: new Date('2026-09-03T21:17:00Z'),
    }),
    // Given up on. Never bought again automatically.
    task({ state: 'dead', costUsd: 0.06, postedAt: new Date('2026-09-02T04:17:00Z') }),
  ]);
  try {
    const out = await describeUsage({ projects, now: NOW });

    const sept = out.months.find((m) => m.periodKey === '2026-09');
    const aug = out.months.find((m) => m.periodKey === '2026-08');
    assert.equal(sept.spentUsd, 0.252);
    assert.equal(sept.tasks, 4);
    assert.equal(aug.spentUsd, 0.2);

    const positions = out.byKind.find((k) => k.kind === 'positions');
    const movement = out.byKind.find((k) => k.kind === 'movement');
    assert.equal(positions.tasks, 4);
    assert.equal(movement.spentUsd, 0.012);
    // Sorted by spend, so the expensive kind is the one a reader sees first.
    assert.equal(out.byKind[0].kind, 'positions');

    assert.equal(out.queued, 1);
    assert.equal(out.dead, 1);
    assert.equal(out.inFlight.length, 1);
    // A Site with no name falls back to its domain rather than showing an id.
    assert.equal(out.inFlight[0].projectName, 'beta.com');
    assert.equal(out.inFlight[0].observedAt, null);
  } finally {
    stub.restore();
  }
});

test('a held reservation is reported as held, never as spent', async () => {
  // A pass that died between reserving and settling. The money is recoverable —
  // `reconcileReservations` gives it back — so reporting it as spend would show
  // a purchase that un-happens ten minutes later.
  const stub = stubTasks([
    task({ state: 'open', budgetState: 'reserving', costUsd: 0, estimateUsd: 0.18 }),
  ]);
  try {
    const out = await describeUsage({ projects, now: NOW });
    const sept = out.months.find((m) => m.periodKey === '2026-09');
    assert.equal(sept.spentUsd, 0);
    assert.equal(sept.reservedUsd, 0.18);
  } finally {
    stub.restore();
  }
});

test('the observation time is carried separately from the charge', async () => {
  const stub = stubTasks([
    task({
      postedAt: new Date('2026-09-01T04:17:00Z'),
      readyAt: new Date('2026-09-03T09:40:00Z'),
    }),
  ]);
  try {
    const out = await describeUsage({ projects, now: NOW });
    // Two different fields, two different meanings. A screen that captioned
    // `lastObservedAt` as "last charged" would credit the free ten-minute sweep
    // with the money.
    assert.equal(out.lastPostedAt.toISOString(), '2026-09-01T04:17:00.000Z');
    assert.equal(out.lastObservedAt.toISOString(), '2026-09-03T09:40:00.000Z');
    assert.notEqual(String(out.lastPostedAt), String(out.lastObservedAt));
  } finally {
    stub.restore();
  }
});

test('the read is scoped to this board’s projects and includes every open job', async () => {
  const stub = stubTasks([]);
  try {
    await describeUsage({ projects, months: 3, now: NOW });
    const filter = stub.filters[0];
    assert.deepEqual(filter.project.$in, [PROJECT_A, PROJECT_B]);
    // An open job posted BEFORE the window is exactly the row the in-flight
    // panel exists to show, so it is unioned in rather than filtered out by the
    // date bound.
    assert.ok(filter.$or.some((c) => c.state === 'open'));
    assert.ok(filter.$or.some((c) => c.postedAt));
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// The screen catalog
// ---------------------------------------------------------------------------

test('every screen draws only kinds this provider actually collects', () => {
  // The same rule `validateDescriptor` enforces, asserted here too because the
  // failure it prevents is a permanently empty panel that looks like a broken
  // collection rather than a misconfiguration.
  const kindKeys = new Set(KINDS.map((k) => k.key));
  for (const screen of SCREENS) {
    for (const kind of screen.kinds) {
      assert.ok(kindKeys.has(kind), `${screen.key} draws unknown kind ${kind}`);
    }
  }
});

test('an empty selection means every screen', () => {
  assert.deepEqual(resolveScreens([]).map((s) => s.key), SCREEN_KEYS);
  assert.deepEqual(resolveScreens(undefined).map((s) => s.key), SCREEN_KEYS);
});

test('the money screen cannot be switched off', () => {
  // A board able to hide Usage & Spend could spend against a shared account with
  // the meter out of sight, which is the arrangement the budget exists to stop.
  const keys = resolveScreens(['overview']).map((s) => s.key);
  assert.deepEqual(keys, ['overview', 'usage']);
  assert.ok(resolveScreens(['rank_tracking']).some((s) => s.key === 'usage'));
});

test('an unknown screen key is ignored rather than rendered', () => {
  // `backlinks` was the placeholder here until phase 7 declared it. The point of
  // the test is a key NO phase declares, so it has to be one nobody will ship —
  // a stored string that outlived the screen it named is the real case, and it
  // must not become a rendered nav entry when a similar name arrives later.
  assert.deepEqual(resolveScreens(['overview', 'astrology']).map((s) => s.key), [
    'overview',
    'usage',
  ]);
});

test('exactly one runner can spend, and the free one is the faster one', () => {
  const spends = RUNNERS.filter((r) => r.spends);
  assert.equal(spends.length, 1);
  assert.equal(spends[0].cron, '17 * * * *');
  const free = RUNNERS.find((r) => !r.spends);
  assert.equal(free.cron, C.COLLECT_CRON_EXPRESSION);
});

test('the screen quotes the crons the runners ACTUALLY use', () => {
  /**
   * The catalog states the two schedules as data so the screen need not
   * hardcode them, which moves the drift one level up rather than removing it:
   * a screen confidently printing "hourly" for a runner somebody moved to every
   * six hours is worse than printing nothing, because it will be believed.
   *
   * Asserted here rather than imported into `screens.js`, which would invert the
   * layering — a provider descriptor is not allowed to depend on the generic
   * runners that drive it.
   */
  const sync = require('../../connectorSyncRunner');
  const collect = require('../../connectorCollectRunner');

  assert.equal(RUNNERS.find((r) => r.key === 'sync').cron, sync.CRON_EXPRESSION);
  assert.equal(RUNNERS.find((r) => r.key === 'collect').cron, collect.CRON_EXPRESSION);
  // And the constant the provider documents the collector's cadence with agrees
  // with the runner that reads nothing from it.
  assert.equal(collect.CRON_EXPRESSION, C.COLLECT_CRON_EXPRESSION);
});

// ---------------------------------------------------------------------------
// The rebuy floor
// ---------------------------------------------------------------------------

test('every kind carries a floor, and it sits UNDER its own cadence', () => {
  for (const kind of KINDS) {
    assert.ok(
      Number.isFinite(kind.minRebuyHours) && kind.minRebuyHours > 0,
      `${kind.key} has no rebuy floor`
    );
    // Equal would refuse the normal scheduled buy: a snapshot's `fetchedAt` is
    // when the POLL that collected it ran, minutes to hours after the post, so
    // a floor on the cadence walks the collection later every cycle.
    assert.ok(
      kind.minRebuyHours < kind.intervalHours,
      `${kind.key} floor must be below its cadence`
    );
  }
});

test('a reading younger than the floor is refused, with the wait in the note', () => {
  const kind = getKind('positions');
  const existing = { fetchedAt: new Date('2026-09-03T07:00:00Z') };
  const out = rebuyGuard(kind, existing, NOW);
  assert.equal(out.refuse, true);
  // 3 hours old against a 144-hour floor.
  assert.equal(out.hours, 141);
  assert.match(out.note, /available again in 141h/);
});

test('the floor lets the normal weekly buy through', () => {
  const kind = getKind('positions');
  // Collected a week ago, ten minutes after the post that bought it.
  const existing = { fetchedAt: new Date('2026-08-27T04:27:00Z') };
  assert.equal(rebuyGuard(kind, existing, NOW).refuse, false);
});

test('nothing stored means nothing to refuse', () => {
  assert.equal(rebuyGuard(getKind('positions'), null, NOW).refuse, false);
  assert.equal(rebuyGuard(getKind('positions'), {}, NOW).refuse, false);
});

test('a kind with no floor is never refused', () => {
  assert.equal(
    rebuyGuard({ key: 'x', label: 'X' }, { fetchedAt: NOW }, NOW).refuse,
    false
  );
});

// ---------------------------------------------------------------------------
// The floor, wired
// ---------------------------------------------------------------------------

/**
 * The unit test above proves the arithmetic. These two prove the WIRING, which
 * is the half that actually costs money.
 *
 * The stub answers the FIRST `DfsTask.findOne` with null — that is
 * `findOpenJob`, and it must always run: polling an open job is free and is the
 * whole point of the design, so a guard placed in front of it would strand paid
 * work. Every call after that belongs to the purchase branch and throws, which
 * is a stronger assertion than counting posts because it fails on any database
 * round trip at all, not only on a charge.
 */
const stubPurchaseExplodes = () => {
  const original = DfsTask.findOne;
  let called = 0;
  const nullQuery = {
    sort: () => nullQuery,
    lean: () => Promise.resolve(null),
    then: (resolve, reject) => Promise.resolve(null).then(resolve, reject),
  };
  DfsTask.findOne = () => {
    called += 1;
    if (called === 1) return nullQuery;
    throw new Error('the purchase branch was reached');
  };
  return {
    calls: () => called,
    restore: () => {
      DfsTask.findOne = original;
    },
  };
};

test('a too-recent reading is refused BEFORE the purchase branch does anything', async () => {
  const stub = stubPurchaseExplodes();
  try {
    const out = await runTaskKind(getKind('positions'), {
      project: {
        _id: PROJECT_A,
        organisation: 'org',
        domain: 'acme.com',
        trackedKeywords: ['alpha', 'beta'],
      },
      variant: { key: 'desktop|en|2840', locationCode: 2840, languageCode: 'en', device: 'desktop' },
      // Bought three hours ago. The planner let this through because a board set
      // `intervalHours: 1`; the provider refuses because it bills at post.
      existing: { fetchedAt: new Date('2026-09-03T07:00:00Z') },
      force: false,
      now: NOW,
    });

    assert.equal(out.status, 'pending');
    assert.match(out.note, /available again in 141h/);
    // Nothing was stored, so nothing is counted as collected and nothing is fed
    // to a dependant. That is the pending sentinel doing its job.
    assert.equal(out.data, null);
    assert.equal(out.collectedAt, null);
    assert.equal(stub.calls(), 1, 'only the open-job lookup should have run');
  } finally {
    stub.restore();
  }
});

test('an explicit force gets past the floor', async () => {
  // A person who has read the note and asked anyway is the escape hatch the note
  // points at. On this provider `force` never arrives from a plain Refresh —
  // the descriptor declares `forceRefetchIsFree: false` — so reaching here means
  // somebody confirmed a purchase.
  const stub = stubPurchaseExplodes();
  try {
    await assert.rejects(
      runTaskKind(getKind('positions'), {
        project: {
          _id: PROJECT_A,
          organisation: 'org',
          domain: 'acme.com',
          trackedKeywords: ['alpha'],
        },
        variant: { key: 'desktop|en|2840', locationCode: 2840, languageCode: 'en', device: 'desktop' },
        existing: { fetchedAt: new Date('2026-09-03T07:00:00Z') },
        force: true,
        now: NOW,
      }),
      /the purchase branch was reached/
    );
  } finally {
    stub.restore();
  }
});

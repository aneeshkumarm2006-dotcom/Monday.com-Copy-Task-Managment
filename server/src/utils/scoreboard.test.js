const { test } = require('node:test');
const assert = require('node:assert');

const { foldDeliveryByGroup, buildScoreboard, compareDefault } = require('./scoreboard');
const { scoreGroup } = require('./goalTypes');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const GHOST = 'cccccccccccccccccccccccc';

const USERS = new Map([
  [ALICE, { _id: ALICE, name: 'Alice', email: 'a@x.com', profilePic: null }],
  [BOB, { _id: BOB, name: 'Bob', email: 'b@x.com', profilePic: null }],
]);

const groups = (...names) => names.map((n) => ({ _id: n, name: n.toUpperCase() }));

const owners = (map) =>
  new Map(Object.entries(map).map(([g, u]) => [g, { userId: u, inherited: true }]));

/** A numeric goal that lands exactly on `pct` of the way to target. */
const goal = (actual) => ({
  type: 'numeric', config: { baseline: 0, target: 100 }, actual, weight: 1,
});

const summaries = (map) =>
  new Map(Object.entries(map).map(([g, gs]) => [g, scoreGroup(gs)]));

const delivery = (map) =>
  new Map(Object.entries(map).map(([g, d]) => [g, {
    met: 0, partial: 0, missed: 0, pending: 0, excused: 0, required: 0,
    keptPct: null, byTracker: [], ...d,
  }]));

// ---------------------------------------------------------------------------
// foldDeliveryByGroup
// ---------------------------------------------------------------------------

const cells = (...states) => states.map((s, i) => ({ p: `d:2026-08-${String(i + 1).padStart(2, '0')}`, s }));
const periods = (n) => Array.from({ length: n }, (_, i) => ({
  key: `d:2026-08-${String(i + 1).padStart(2, '0')}`,
  startDayKey: `2026-08-${String(i + 1).padStart(2, '0')}`,
}));

test('required counts only scoreable states; off/na/pending never inflate it', () => {
  const results = [{
    tracker: { _id: 't1', name: 'Daily', enabled: true },
    periods: periods(7),
    rows: [{ groupId: 'g1', cells: cells('met', 'met', 'missed', 'partial', 'pending', 'off', 'na') }],
  }];

  const g1 = foldDeliveryByGroup(results).get('g1');
  assert.strictEqual(g1.met, 2);
  assert.strictEqual(g1.missed, 1);
  assert.strictEqual(g1.partial, 1);
  assert.strictEqual(g1.pending, 1);
  // met + partial + missed. 'pending' is not yet due and 'off'/'na' were never
  // commitments — none of them may drag the rate.
  assert.strictEqual(g1.required, 4);
  assert.strictEqual(g1.keptPct, 50);
});

test('keepPeriod is what stops a straddling period being counted in two months', () => {
  const results = [{
    tracker: { _id: 't1', name: 'Weekly', enabled: true },
    periods: [
      { key: 'w:2026-07-28', startDayKey: '2026-07-28' }, // belongs to JULY
      { key: 'w:2026-08-04', startDayKey: '2026-08-04' },
      { key: 'w:2026-08-11', startDayKey: '2026-08-11' },
    ],
    rows: [{ groupId: 'g1', cells: cells('missed', 'met', 'met') }],
  }];

  const all = foldDeliveryByGroup(results).get('g1');
  assert.strictEqual(all.required, 3);

  const august = foldDeliveryByGroup(results, {
    keepPeriod: (p) => p.startDayKey.slice(0, 7) === '2026-08',
  }).get('g1');
  assert.strictEqual(august.required, 2, 'the July-starting week is excluded');
  assert.strictEqual(august.missed, 0);
  assert.strictEqual(august.keptPct, 100);
});

test('a disabled tracker contributes nothing', () => {
  const results = [{
    tracker: { _id: 't1', name: 'Off', enabled: false },
    periods: periods(2),
    rows: [{ groupId: 'g1', cells: cells('missed', 'missed') }],
  }];
  assert.strictEqual(foldDeliveryByGroup(results).size, 0);
});

test('counts accumulate across trackers, and byTracker keeps them separable', () => {
  const results = [
    {
      tracker: { _id: 't1', name: 'Daily', enabled: true },
      periods: periods(2),
      rows: [{ groupId: 'g1', cells: cells('missed', 'met') }],
    },
    {
      tracker: { _id: 't2', name: 'Weekly', enabled: true },
      periods: periods(2),
      rows: [{ groupId: 'g1', cells: cells('missed', 'missed') }],
    },
  ];

  const g1 = foldDeliveryByGroup(results).get('g1');
  assert.strictEqual(g1.missed, 3);
  assert.strictEqual(g1.required, 4);
  assert.deepStrictEqual(
    g1.byTracker.map((t) => `${t.trackerName}:${t.missed}/${t.required}`),
    ['Daily:1/2', 'Weekly:2/2']
  );
});

test('keptPct is null rather than 0 when nothing was required', () => {
  const results = [{
    tracker: { _id: 't1', name: 'Daily', enabled: true },
    periods: periods(2),
    rows: [{ groupId: 'g1', cells: cells('pending', 'off') }],
  }];
  const g1 = foldDeliveryByGroup(results).get('g1');
  assert.strictEqual(g1.required, 0);
  assert.strictEqual(g1.keptPct, null, 'no commitments kept is not the same as 0% kept');
});

// ---------------------------------------------------------------------------
// buildScoreboard — goals
// ---------------------------------------------------------------------------

test('a person score is scoreBoard over their groups, never a second formula', () => {
  const sb = buildScoreboard({
    groups: groups('g1', 'g2'),
    ownerByGroupId: owners({ g1: ALICE, g2: ALICE }),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [goal(100)], g2: [goal(50)] }),
  });

  assert.strictEqual(sb.people.length, 1);
  assert.strictEqual(sb.people[0].goals.pct, 75);
  assert.strictEqual(sb.people[0].goals.counts.achieved, 1);
  assert.strictEqual(sb.people[0].goals.counts.partial, 1);
  assert.strictEqual(sb.people[0].groupCount, 2);
});

test('an unreported goal is excluded, not scored as zero, and `reported` says so', () => {
  const sb = buildScoreboard({
    groups: groups('g1'),
    ownerByGroupId: owners({ g1: ALICE }),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [goal(100), goal(null), goal(null)] }),
  });

  const row = sb.people[0];
  assert.strictEqual(row.goals.pct, 100, 'the one reported goal was achieved');
  assert.strictEqual(row.goals.totalGoals, 3);
  assert.strictEqual(row.goals.reported, 1, 'rendered next to pct so 100% cannot read as final');
  assert.strictEqual(row.goals.counts.untracked, 2);
});

test('a person whose groups scored nothing gets pct null and no rank, and sorts last', () => {
  const sb = buildScoreboard({
    groups: groups('g1', 'g2'),
    ownerByGroupId: owners({ g1: ALICE, g2: BOB }),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [], g2: [goal(40)] }),
  });

  const alice = sb.people.find((p) => p.user.name === 'Alice');
  const bob = sb.people.find((p) => p.user.name === 'Bob');

  assert.strictEqual(alice.goals.pct, null, 'never coerced to 0');
  assert.strictEqual(alice.goals.state, 'empty');
  assert.strictEqual(alice.rank, null);
  assert.strictEqual(alice.flags.noGoals, true);
  assert.strictEqual(bob.rank, 1);
  assert.strictEqual(sb.people[sb.people.length - 1].user.name, 'Alice');
});

test('the board total is over EVERY group, not a mean of the people means', () => {
  // Alice owns 2 groups at 100 and 0; Bob owns 1 at 50.
  // Mean of people  = (50 + 50) / 2 = 50   <- wrong
  // Mean of groups  = (100 + 0 + 50) / 3 = 50 ... choose values that differ:
  // Alice 100 and 80 (mean 90), Bob 20. People-mean = 55; group-mean = 66.7.
  const sb = buildScoreboard({
    groups: groups('g1', 'g2', 'g3'),
    ownerByGroupId: owners({ g1: ALICE, g2: ALICE, g3: BOB }),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [goal(100)], g2: [goal(80)], g3: [goal(20)] }),
  });

  const alice = sb.people.find((p) => p.user.name === 'Alice');
  const bob = sb.people.find((p) => p.user.name === 'Bob');
  assert.strictEqual(alice.goals.pct, 90);
  assert.strictEqual(bob.goals.pct, 20);

  // This number must equal the Goals tab's board score for the same month.
  assert.strictEqual(sb.totals.goalPct, 66.7);
  assert.notStrictEqual(sb.totals.goalPct, 55, 'a mean of means would be wrong');
});

// ---------------------------------------------------------------------------
// buildScoreboard — the unassigned bucket and departed members
// ---------------------------------------------------------------------------

test('ownerless groups roll into one Unassigned row, outside peopleCount', () => {
  const sb = buildScoreboard({
    groups: groups('g1', 'g2', 'g3'),
    ownerByGroupId: owners({ g1: ALICE, g2: null, g3: null }),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [goal(100)], g2: [goal(0)], g3: [goal(0)] }),
  });

  assert.strictEqual(sb.people.length, 1);
  assert.strictEqual(sb.totals.peopleCount, 1);
  assert.strictEqual(sb.totals.groupsWithoutOwner, 2);
  assert.strictEqual(sb.unassigned.user, null);
  assert.strictEqual(sb.unassigned.groupCount, 2);
  assert.strictEqual(sb.unassigned.rank, null);
});

test('no Unassigned row at all when every group has an owner', () => {
  const sb = buildScoreboard({
    groups: groups('g1'),
    ownerByGroupId: owners({ g1: ALICE }),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [goal(100)] }),
  });
  assert.strictEqual(sb.unassigned, null);
  assert.strictEqual(sb.totals.groupsWithoutOwner, 0);
});

test('an owner who has left the org keeps their row, flagged', () => {
  // Dropping them would silently move their groups into Unassigned and change
  // what a past month reports.
  const sb = buildScoreboard({
    groups: groups('g1'),
    ownerByGroupId: owners({ g1: GHOST }),
    usersById: USERS, // GHOST is absent
    goalSummaryByGroupId: summaries({ g1: [goal(100)] }),
  });

  assert.strictEqual(sb.people.length, 1);
  assert.strictEqual(sb.people[0].inOrg, false);
  assert.strictEqual(sb.people[0].user.name, 'Former member');
  assert.strictEqual(sb.people[0].goals.pct, 100, 'their numbers still count');
});

test('an org member who owns nothing is not a row', () => {
  const sb = buildScoreboard({
    groups: groups('g1'),
    ownerByGroupId: owners({ g1: ALICE }),
    usersById: USERS, // Bob exists but owns nothing
    goalSummaryByGroupId: summaries({ g1: [goal(100)] }),
  });
  assert.deepStrictEqual(sb.people.map((p) => p.user.name), ['Alice']);
});

// ---------------------------------------------------------------------------
// buildScoreboard — delivery
// ---------------------------------------------------------------------------

test('delivery sums across a person groups and reports both count and rate', () => {
  const sb = buildScoreboard({
    groups: groups('g1', 'g2'),
    ownerByGroupId: owners({ g1: ALICE, g2: ALICE }),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [goal(100)], g2: [goal(100)] }),
    deliveryByGroupId: delivery({
      g1: { met: 8, missed: 2, required: 10, byTracker: [{ trackerId: 't1', trackerName: 'Daily', missed: 2, required: 10 }] },
      g2: { met: 18, missed: 4, required: 22, byTracker: [{ trackerId: 't1', trackerName: 'Daily', missed: 4, required: 22 }] },
    }),
  });

  const d = sb.people[0].delivery;
  assert.strictEqual(d.missed, 6, 'the "most overdue" number');
  assert.strictEqual(d.required, 32);
  assert.strictEqual(d.keptPct, 81, '26 of 32');
  assert.strictEqual(d.atRiskGroups, 1, 'only g2 cleared the 3-miss bar; g1 at 2 did not');
  assert.deepStrictEqual(
    { g: d.worst.groupName, n: d.worst.missed },
    { g: 'G2', n: 4 },
    'the worst pair is what to actually go fix'
  );
});

test('withheld delivery is null everywhere — never fabricated zeros', () => {
  const sb = buildScoreboard({
    groups: groups('g1'),
    ownerByGroupId: owners({ g1: ALICE }),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [goal(100)] }),
    deliveryByGroupId: null,
  });

  // "Zero missed" and "we are not telling you" are different facts.
  assert.strictEqual(sb.people[0].delivery, null);
  assert.strictEqual(sb.totals.delivery, null);
  assert.strictEqual(sb.people[0].flags.noDelivery, false);
});

test('a group no tracker covers contributes nothing and drags nothing', () => {
  const sb = buildScoreboard({
    groups: groups('g1', 'g2'),
    ownerByGroupId: owners({ g1: ALICE, g2: ALICE }),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [goal(100)], g2: [goal(100)] }),
    deliveryByGroupId: delivery({ g1: { met: 5, required: 5 } }), // g2 absent
  });

  const d = sb.people[0].delivery;
  assert.strictEqual(d.required, 5);
  assert.strictEqual(d.keptPct, 100, 'the uncovered group did not dilute it');
});

test('a person with no delivery commitments at all is flagged, not scored 0%', () => {
  const sb = buildScoreboard({
    groups: groups('g1'),
    ownerByGroupId: owners({ g1: ALICE }),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [goal(100)] }),
    deliveryByGroupId: delivery({}),
  });

  assert.strictEqual(sb.people[0].delivery.keptPct, null);
  assert.strictEqual(sb.people[0].flags.noDelivery, true);
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test('rank is dense competition ranking and skips unscored rows', () => {
  const rows = [
    { goals: { pct: 90, counts: {} } },
    { goals: { pct: 70, counts: {} } },
    { goals: { pct: 70, counts: {} } },
    { goals: { pct: 40, counts: {} } },
  ];
  const sb = buildScoreboard({
    groups: groups('g1', 'g2', 'g3', 'g4'),
    ownerByGroupId: new Map([
      ['g1', { userId: 'u1' }], ['g2', { userId: 'u2' }],
      ['g3', { userId: 'u3' }], ['g4', { userId: 'u4' }],
    ]),
    usersById: new Map(['u1', 'u2', 'u3', 'u4'].map((u) => [u, { _id: u, name: u }])),
    goalSummaryByGroupId: summaries({
      g1: [goal(90)], g2: [goal(70)], g3: [goal(70)], g4: [goal(40)],
    }),
  });
  void rows;

  assert.deepStrictEqual(sb.people.map((p) => p.rank), [1, 2, 2, 4]);
});

test('compareDefault falls through score, then wins, then misses, then name', () => {
  const row = (name, pct, achieved, missed) => ({
    user: { name },
    goals: { pct, counts: { achieved, exceeded: 0 } },
    delivery: { missed },
  });

  // Same score: more achieved wins.
  assert.ok(compareDefault(row('A', 80, 5, 0), row('B', 80, 2, 0)) < 0);
  // Same score and wins: fewer misses wins.
  assert.ok(compareDefault(row('A', 80, 2, 1), row('B', 80, 2, 9)) < 0);
  // All equal: alphabetical, so the order is at least stable and explicable.
  assert.ok(compareDefault(row('Ann', 80, 2, 1), row('Bea', 80, 2, 1)) < 0);
  // A null score sorts last even against a terrible one.
  assert.ok(compareDefault(row('A', null, 0, 0), row('B', 1, 0, 0)) > 0);
});

test('tookOverThisMonth marks a handover rather than a carried-forward month', () => {
  const sb = buildScoreboard({
    groups: groups('g1', 'g2'),
    ownerByGroupId: new Map([
      ['g1', { userId: ALICE, inherited: true }],
      ['g2', { userId: BOB, inherited: false }],
    ]),
    usersById: USERS,
    goalSummaryByGroupId: summaries({ g1: [goal(100)], g2: [goal(100)] }),
  });

  assert.strictEqual(sb.people.find((p) => p.user.name === 'Alice').flags.tookOverThisMonth, false);
  assert.strictEqual(sb.people.find((p) => p.user.name === 'Bob').flags.tookOverThisMonth, true);
});

test('an empty board produces an empty, non-throwing scoreboard', () => {
  const sb = buildScoreboard({});
  assert.deepStrictEqual(sb.people, []);
  assert.strictEqual(sb.unassigned, null);
  assert.strictEqual(sb.totals.goalPct, null);
  assert.strictEqual(sb.totals.peopleCount, 0);
});

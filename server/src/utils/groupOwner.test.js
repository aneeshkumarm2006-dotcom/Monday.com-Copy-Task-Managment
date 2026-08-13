const { test } = require('node:test');
const assert = require('node:assert');

const {
  OWNER_TIMELINE_LIMIT,
  normaliseTimeline,
  ownerForMonth,
  setOwnerForMonth,
  clearOwnerForMonth,
} = require('./groupOwner');

const ALICE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ADMIN = 'cccccccccccccccccccccccc';

const group = (ownerTimeline) => ({ ownerTimeline });

// ---------------------------------------------------------------------------
// Tolerance — a bad row must never 500 a board load
// ---------------------------------------------------------------------------

test('a missing timeline resolves to nobody, and never throws', () => {
  const none = { userId: null, fromMonth: null, inherited: false, explicit: false };

  // `undefined` is the COMMON case, not an edge one: every group written before
  // the field existed reads back without the key at all under .lean().
  assert.deepStrictEqual(ownerForMonth({}, '2026-08'), none);
  assert.deepStrictEqual(ownerForMonth(group(undefined), '2026-08'), none);
  assert.deepStrictEqual(ownerForMonth(group(null), '2026-08'), none);
  assert.deepStrictEqual(ownerForMonth(group([]), '2026-08'), none);
  assert.deepStrictEqual(ownerForMonth(undefined, '2026-08'), none);
  assert.deepStrictEqual(ownerForMonth(null, '2026-08'), none);
});

test('garbage entries are dropped individually, not fatally', () => {
  const messy = group([
    null,
    'not an object',
    { user: ALICE },                         // no fromMonth
    { fromMonth: '2026-13', user: ALICE },   // month 13
    { fromMonth: '2026', user: ALICE },      // not a month key
    { fromMonth: '', user: ALICE },
    { fromMonth: 202603, user: ALICE },      // not a string
    { fromMonth: '2026-03', user: BOB },     // the one good row
  ]);

  assert.strictEqual(normaliseTimeline(messy.ownerTimeline).length, 1);
  assert.strictEqual(ownerForMonth(messy, '2026-08').userId, BOB);
});

test('a malformed monthKey resolves to nobody rather than guessing', () => {
  // The util deliberately has no notion of "now" — that needs the board's
  // timezone and belongs to the controller.
  const g = group([{ fromMonth: '2026-03', user: ALICE }]);
  assert.strictEqual(ownerForMonth(g, 'nonsense').userId, null);
  assert.strictEqual(ownerForMonth(g, null).userId, null);
  assert.strictEqual(ownerForMonth(g, '2026-13').userId, null);
});

// ---------------------------------------------------------------------------
// Resolution — the carry-forward rule
// ---------------------------------------------------------------------------

test('an owner carries forward until a later entry exists', () => {
  const g = group([{ fromMonth: '2026-03', user: ALICE }]);

  assert.deepStrictEqual(ownerForMonth(g, '2026-03'), {
    userId: ALICE, fromMonth: '2026-03', inherited: false, explicit: true,
  });
  assert.deepStrictEqual(ownerForMonth(g, '2026-04'), {
    userId: ALICE, fromMonth: '2026-03', inherited: true, explicit: false,
  });
  // Still Alice years later. Carry-forward is structural, not scheduled.
  assert.strictEqual(ownerForMonth(g, '2029-11').userId, ALICE);
});

test('a month before the first entry resolves to nobody — no implicit backfill', () => {
  // Reaching an assignment back to a group's birth month is the WRITER's policy,
  // applied once. Reading must never invent an owner who was never recorded.
  const g = group([{ fromMonth: '2026-03', user: ALICE }]);
  assert.deepStrictEqual(ownerForMonth(g, '2026-02'), {
    userId: null, fromMonth: null, inherited: false, explicit: false,
  });
});

test('a handover changes the future without rewriting the past', () => {
  // This is the entire reason ownership is a timeline and not one field.
  const g = group([
    { fromMonth: '2026-03', user: ALICE },
    { fromMonth: '2026-08', user: BOB },
  ]);

  assert.strictEqual(ownerForMonth(g, '2026-07').userId, ALICE);
  assert.strictEqual(ownerForMonth(g, '2026-08').userId, BOB);
  assert.strictEqual(ownerForMonth(g, '2026-09').userId, BOB);
});

test('storage order is never trusted', () => {
  // A $push without $sort, a hand edit, or a restored backup all produce this.
  const g = group([
    { fromMonth: '2026-09', user: BOB },
    { fromMonth: '2026-03', user: ALICE },
    { fromMonth: '2026-06', user: ADMIN },
  ]);

  assert.strictEqual(ownerForMonth(g, '2026-04').userId, ALICE);
  assert.strictEqual(ownerForMonth(g, '2026-07').userId, ADMIN);
  assert.strictEqual(ownerForMonth(g, '2026-10').userId, BOB);
});

test('duplicate months break the tie deterministically', () => {
  // updateGroup is a read-modify-write, so two interleaved saves can both land
  // an entry at the same month. There must be exactly one answer.
  const byTime = group([
    { fromMonth: '2026-03', user: ALICE, setAt: new Date('2026-03-01T10:00:00Z') },
    { fromMonth: '2026-03', user: BOB, setAt: new Date('2026-03-01T11:00:00Z') },
  ]);
  assert.strictEqual(ownerForMonth(byTime, '2026-03').userId, BOB, 'later setAt wins');
  assert.strictEqual(normaliseTimeline(byTime.ownerTimeline).length, 1);

  // Reversed storage order, same timestamps — same answer.
  const reversed = group([byTime.ownerTimeline[1], byTime.ownerTimeline[0]]);
  assert.strictEqual(ownerForMonth(reversed, '2026-03').userId, BOB);

  // No timestamps to compare: later array position wins.
  const byIndex = group([
    { fromMonth: '2026-03', user: ALICE },
    { fromMonth: '2026-03', user: BOB },
  ]);
  assert.strictEqual(ownerForMonth(byIndex, '2026-03').userId, BOB);
});

test('ids resolve the same whether stored as objects, strings or populated docs', () => {
  // Ids arrive as ObjectIds from mongoose, strings from JSON, and occasionally
  // as populated documents. Comparing them unnormalised is the classic
  // works-in-dev-fails-in-prod bug.
  const asObjectId = { toString: () => ALICE };
  const populated = { _id: ALICE, name: 'Alice' };

  assert.strictEqual(ownerForMonth(group([{ fromMonth: '2026-03', user: asObjectId }]), '2026-03').userId, ALICE);
  assert.strictEqual(ownerForMonth(group([{ fromMonth: '2026-03', user: populated }]), '2026-03').userId, ALICE);
  assert.strictEqual(ownerForMonth(group([{ fromMonth: '2026-03', user: ALICE }]), '2026-03').userId, ALICE);
});

// ---------------------------------------------------------------------------
// Tombstones — "deliberately unassigned", which is not the same as "never set"
// ---------------------------------------------------------------------------

test('a tombstone unassigns forward and is distinguishable from never-set', () => {
  const g = group([
    { fromMonth: '2026-03', user: ALICE },
    { fromMonth: '2026-06', user: null },
  ]);

  assert.strictEqual(ownerForMonth(g, '2026-05').userId, ALICE);

  // Both of these have userId null. Only `fromMonth` separates "we took the
  // owner off in June" from "nobody has ever owned this".
  assert.deepStrictEqual(ownerForMonth(g, '2026-06'), {
    userId: null, fromMonth: '2026-06', inherited: false, explicit: true,
  });
  assert.deepStrictEqual(ownerForMonth(g, '2026-09'), {
    userId: null, fromMonth: '2026-06', inherited: true, explicit: false,
  });
  assert.strictEqual(ownerForMonth(g, '2026-02').fromMonth, null);
});

test('an owner can be reinstated after a tombstone', () => {
  const g = group([
    { fromMonth: '2026-03', user: ALICE },
    { fromMonth: '2026-06', user: null },
    { fromMonth: '2026-09', user: BOB },
  ]);

  assert.strictEqual(ownerForMonth(g, '2026-08').userId, null);
  assert.strictEqual(ownerForMonth(g, '2026-09').userId, BOB);
});

// ---------------------------------------------------------------------------
// setOwnerForMonth
// ---------------------------------------------------------------------------

test('setOwnerForMonth never mutates its input', () => {
  const before = [{ fromMonth: '2026-03', user: ALICE }];
  const snapshot = JSON.parse(JSON.stringify(before));

  setOwnerForMonth(before, '2026-08', BOB, ADMIN);

  assert.deepStrictEqual(JSON.parse(JSON.stringify(before)), snapshot);
});

test('setOwnerForMonth is idempotent, so a repeat click is a real no-op', () => {
  const { timeline } = setOwnerForMonth([], '2026-03', ALICE, ADMIN);

  const again = setOwnerForMonth(timeline, '2026-03', ALICE, ADMIN);
  assert.strictEqual(again.changed, false, 'the controller can skip the save');
  assert.strictEqual(again.timeline.length, 1);

  // Re-pinning the person who is merely INHERITED into this month is a real
  // change — it converts an inherited month into a pinned one.
  const pinned = setOwnerForMonth(timeline, '2026-08', ALICE, ADMIN);
  assert.strictEqual(pinned.changed, true);
  assert.strictEqual(pinned.timeline.length, 2);
});

test('setOwnerForMonth overwrites the month rather than appending beside it', () => {
  let { timeline } = setOwnerForMonth([], '2026-03', ALICE, ADMIN);
  ({ timeline } = setOwnerForMonth(timeline, '2026-03', BOB, ADMIN));

  assert.strictEqual(timeline.length, 1);
  assert.strictEqual(timeline[0].user, BOB);
  assert.strictEqual(timeline[0].setBy, ADMIN);
});

test('setOwnerForMonth writes a tombstone for a null user', () => {
  let { timeline } = setOwnerForMonth([], '2026-03', ALICE, ADMIN);
  ({ timeline } = setOwnerForMonth(timeline, '2026-06', null, ADMIN));

  assert.strictEqual(timeline.length, 2);
  assert.strictEqual(ownerForMonth(group(timeline), '2026-07').userId, null);
});

test('the result stays sorted however it was written', () => {
  let timeline = [];
  for (const month of ['2026-09', '2026-03', '2026-06']) {
    ({ timeline } = setOwnerForMonth(timeline, month, ALICE, ADMIN));
  }
  assert.deepStrictEqual(timeline.map((e) => e.fromMonth), ['2026-03', '2026-06', '2026-09']);
});

test('a redundant pin is KEPT, never optimised away', () => {
  // March says Alice; pinning June to Alice changes nothing today. It is still
  // kept, because it means a later correction to March must NOT propagate
  // through June. Pruning it would make future behaviour depend on invisible
  // history. If someone "optimises" this, they break that guarantee — hence the
  // test.
  let { timeline } = setOwnerForMonth([], '2026-03', ALICE, ADMIN);
  ({ timeline } = setOwnerForMonth(timeline, '2026-06', ALICE, ADMIN));
  assert.strictEqual(timeline.length, 2);

  ({ timeline } = setOwnerForMonth(timeline, '2026-03', BOB, ADMIN));
  assert.strictEqual(ownerForMonth(group(timeline), '2026-04').userId, BOB);
  assert.strictEqual(ownerForMonth(group(timeline), '2026-06').userId, ALICE, 'June stayed pinned');
});

test('the cap trims the oldest and never the entry just written', () => {
  let timeline = [];
  // 250 consecutive months, comfortably past the 240 limit.
  for (let i = 0; i < 250; i++) {
    const year = 2000 + Math.floor(i / 12);
    const month = String((i % 12) + 1).padStart(2, '0');
    ({ timeline } = setOwnerForMonth(timeline, `${year}-${month}`, ALICE, ADMIN));
  }

  assert.strictEqual(timeline.length, OWNER_TIMELINE_LIMIT);
  assert.strictEqual(timeline[timeline.length - 1].fromMonth, '2020-10');
  assert.strictEqual(timeline[0].fromMonth, '2000-11', 'the oldest ten were dropped');
});

test('setOwnerForMonth refuses a malformed month without corrupting the timeline', () => {
  const { timeline } = setOwnerForMonth([{ fromMonth: '2026-03', user: ALICE }], 'nope', BOB, ADMIN);
  assert.strictEqual(timeline.length, 1);
  assert.strictEqual(timeline[0].user, ALICE);
});

// ---------------------------------------------------------------------------
// clearOwnerForMonth — unpinning, which is NOT tombstoning
// ---------------------------------------------------------------------------

test('clearOwnerForMonth un-pins a month so it inherits again', () => {
  const timeline = [
    { fromMonth: '2026-03', user: ALICE },
    { fromMonth: '2026-06', user: BOB },
  ];

  const cleared = clearOwnerForMonth(timeline, '2026-06');
  assert.strictEqual(cleared.changed, true);
  assert.strictEqual(ownerForMonth(group(cleared.timeline), '2026-06').userId, ALICE);

  // Contrast with a tombstone at the same month, which pins "unassigned".
  const tombstoned = setOwnerForMonth(timeline, '2026-06', null, ADMIN);
  assert.strictEqual(ownerForMonth(group(tombstoned.timeline), '2026-06').userId, null);
});

test('clearOwnerForMonth on a month with no pin reports no change', () => {
  const timeline = [{ fromMonth: '2026-03', user: ALICE }];
  assert.strictEqual(clearOwnerForMonth(timeline, '2026-08').changed, false);
});

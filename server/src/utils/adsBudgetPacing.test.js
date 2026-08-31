const { test } = require('node:test');
const assert = require('node:assert');

const { DRIFT, STATES, monthWindow, paceOf, rollUp } = require('./adsBudgetPacing');

/** Mid-August 2026: 14 of 31 days elapsed, 17 remaining. The brief's example. */
const AUG = () => monthWindow('2026-08', 'UTC', new Date('2026-08-14T12:00:00Z'));

// ---------------------------------------------------------------------------
// monthWindow — the calendar half, which is where timezone bugs live
// ---------------------------------------------------------------------------

test('the brief’s own window: 14 of 31 elapsed, 17 remaining', () => {
  const w = AUG();
  assert.strictEqual(w.totalDays, 31);
  assert.strictEqual(w.elapsedDays, 14);
  assert.strictEqual(w.remainingDays, 17);
});

test('the 1st counts as one elapsed day, not zero', () => {
  // Money can be spent on the day being counted. Starting from 0 would make
  // every 1st of the month project an infinite overspend.
  const w = monthWindow('2026-08', 'UTC', new Date('2026-08-01T00:30:00Z'));
  assert.strictEqual(w.elapsedDays, 1);
  assert.strictEqual(w.remainingDays, 30);
});

test('elapsed days follow the BOARD’s timezone, not UTC', () => {
  // 2026-08-31T20:00Z is still 31 August in London but already 1 September in
  // Auckland. Read as the UTC day, an Auckland board spends the first hours of
  // every month reporting the previous one — and the pacing verdict flips with
  // it. This is the assertion that stops `.toISOString().slice(0, 10)` coming
  // back; see the header of utils/tzDay.js.
  const instant = new Date('2026-08-31T20:00:00Z');

  const london = monthWindow('2026-08', 'Europe/London', instant);
  assert.strictEqual(london.elapsedDays, 31, 'still the last day of August');

  const auckland = monthWindow('2026-08', 'Pacific/Auckland', instant);
  assert.strictEqual(auckland.elapsedDays, 31, 'September there — August is over');

  // And the month Auckland has actually moved into has begun.
  const sept = monthWindow('2026-09', 'Pacific/Auckland', instant);
  assert.strictEqual(sept.elapsedDays, 1);
});

test('a past month is fully elapsed', () => {
  const w = monthWindow('2026-06', 'UTC', new Date('2026-08-14T12:00:00Z'));
  assert.strictEqual(w.totalDays, 30);
  assert.strictEqual(w.elapsedDays, 30);
  assert.strictEqual(w.remainingDays, 0);
  assert.strictEqual(w.elapsedPct, 1);
});

test('a future month has not started, and never goes negative', () => {
  const w = monthWindow('2027-03', 'UTC', new Date('2026-08-14T12:00:00Z'));
  assert.strictEqual(w.elapsedDays, 0);
  assert.strictEqual(w.remainingDays, 31);
  assert.strictEqual(w.elapsedPct, 0);
});

test('February is 28 or 29 days, not a hardcoded 30', () => {
  assert.strictEqual(monthWindow('2026-02', 'UTC', new Date('2026-02-10T00:00:00Z')).totalDays, 28);
  assert.strictEqual(monthWindow('2028-02', 'UTC', new Date('2028-02-10T00:00:00Z')).totalDays, 29);
});

test('a malformed month key is null rather than a guess', () => {
  assert.strictEqual(monthWindow('2026-13', 'UTC'), null);
  assert.strictEqual(monthWindow('August', 'UTC'), null);
  assert.strictEqual(monthWindow(null, 'UTC'), null);
});

// ---------------------------------------------------------------------------
// paceOf — the state ladder
// ---------------------------------------------------------------------------

test('the brief’s Budget Overview reads as Healthy pacing', () => {
  // $14,280 of $25,000 with 17 of 31 days left. This is the ONE verdict the
  // brief states for a computed total, so it is the number that pins DRIFT.
  const r = paceOf({ allocated: 25000, spent: 14280 }, AUG());
  assert.strictEqual(r.state, 'on_track');
  assert.strictEqual(r.verdict, 'Healthy pacing');
  assert.ok(Math.abs(r.usedPct - 0.5712) < 0.0001);
  assert.strictEqual(r.remaining, 10720);
});

test('daily average is spend over ELAPSED days, not total days', () => {
  const r = paceOf({ allocated: 25000, spent: 14280 }, AUG());
  assert.strictEqual(Math.round(r.dailyAverage), 1020); // 14280 / 14
});

test('overspend beats everything below it', () => {
  // Even a row that is behind the calendar is Over Budget once spend passes
  // allocation — it cannot be "Low Spend" and overspent at the same time.
  const r = paceOf({ allocated: 1000, spent: 1200 }, AUG());
  assert.strictEqual(r.state, 'over');
  assert.strictEqual(r.remaining, -200);
});

test('the drift band is exclusive at both edges', () => {
  const w = { totalDays: 100, elapsedDays: 50, remainingDays: 50, elapsedPct: 0.5 };

  // Exactly DRIFT ahead — inside the band, so still on track.
  assert.strictEqual(paceOf({ allocated: 100, spent: 50 + DRIFT * 100 }, w).state, 'on_track');
  // A hair past it.
  assert.strictEqual(paceOf({ allocated: 100, spent: 50 + DRIFT * 100 + 0.1 }, w).state, 'ahead');

  // And symmetrically, behind.
  assert.strictEqual(paceOf({ allocated: 100, spent: 50 - DRIFT * 100 }, w).state, 'on_track');
  assert.strictEqual(paceOf({ allocated: 100, spent: 50 - DRIFT * 100 - 0.1 }, w).state, 'behind');
});

test('at_risk is the severe half of ahead, at twice the band', () => {
  const w = { totalDays: 100, elapsedDays: 50, remainingDays: 50, elapsedPct: 0.5 };
  assert.strictEqual(paceOf({ allocated: 100, spent: 79 }, w).state, 'ahead');
  assert.strictEqual(paceOf({ allocated: 100, spent: 81 }, w).state, 'at_risk');
});

test('a linear projection does NOT drive the state', () => {
  // The brief's Healthy-pacing example projects $31,620 against a $25,000
  // budget. Triggering on that would flag it — and would flag nearly every
  // active row, since any spend ahead of the calendar projects over.
  const r = paceOf({ allocated: 25000, spent: 14280 }, AUG());
  assert.ok(r.projected > r.allocated, 'the projection really does exceed budget');
  assert.strictEqual(r.state, 'on_track', 'and is deliberately ignored by the ladder');
});

test('a future month projects null rather than Infinity', () => {
  // Zero elapsed days. Dividing by it would give Infinity, which compares as
  // greater than any budget and would paint every future month red.
  const w = monthWindow('2027-03', 'UTC', new Date('2026-08-14T12:00:00Z'));
  const r = paceOf({ allocated: 5000, spent: 0 }, w);
  assert.strictEqual(r.projected, null);
  assert.strictEqual(r.dailyAverage, null);
  assert.notStrictEqual(r.state, 'over');
});

test('nothing allocated and nothing spent is "unset", not on track', () => {
  // The roster leans on this to answer "which clients has nobody set up yet",
  // which is most of its value in the first week of a month.
  const r = paceOf({ allocated: 0, spent: 0 }, AUG());
  assert.strictEqual(r.state, 'unset');
  assert.strictEqual(r.usedPct, null, 'no percentage of nothing');
});

test('spend against a zero allocation is over budget, not unset', () => {
  const r = paceOf({ allocated: 0, spent: 40 }, AUG());
  assert.strictEqual(r.state, 'over');
});

test('lifecycle wins over pacing, so a parked row is not scolded', () => {
  // A paused campaign is not spending BECAUSE it was switched off. Calling that
  // "Low Spend" is true and useless.
  const behind = { allocated: 1000, spent: 0 };
  assert.strictEqual(paceOf(behind, AUG()).state, 'behind');
  assert.strictEqual(paceOf({ ...behind, lifecycle: 'paused' }, AUG()).state, 'paused');
  assert.strictEqual(paceOf({ ...behind, lifecycle: 'draft' }, AUG()).state, 'draft');
});

test('every state carries a label, a verdict and a tone', () => {
  // The client renders `label` in a chip and looks a colour up from `tone`; a
  // state missing either renders as blank.
  for (const [key, meta] of Object.entries(STATES)) {
    assert.ok(meta.label, `${key} has a label`);
    assert.ok(meta.verdict, `${key} has a verdict`);
    assert.ok(['positive', 'warning', 'danger', 'neutral'].includes(meta.tone), `${key} tone`);
  }
});

test('red is reserved for over budget alone', () => {
  const danger = Object.entries(STATES).filter(([, m]) => m.tone === 'danger');
  assert.deepStrictEqual(danger.map(([k]) => k), ['over']);
});

test('missing and non-numeric money reads as zero, never NaN', () => {
  const r = paceOf({ allocated: undefined, spent: 'lots' }, AUG());
  assert.strictEqual(r.allocated, 0);
  assert.strictEqual(r.spent, 0);
  assert.strictEqual(r.state, 'unset');
});

// ---------------------------------------------------------------------------
// rollUp — the roster and KPI totals
// ---------------------------------------------------------------------------

test('draft rows stay out of the totals; paused rows stay in', () => {
  // Draft money has not been committed, the way an unsent invoice is not
  // revenue. Paused money HAS been — dropping it would make a client's
  // remaining balance jump the moment somebody parked a campaign.
  const r = rollUp(
    [
      { allocated: 100, spent: 50 },
      { allocated: 900, spent: 0, lifecycle: 'draft' },
      { allocated: 100, spent: 20, lifecycle: 'paused' },
    ],
    AUG()
  );
  assert.strictEqual(r.allocated, 200);
  assert.strictEqual(r.spent, 70);
});

test('a rollup is paced as active, so one parked row cannot grey out a client', () => {
  const r = rollUp([{ allocated: 1000, spent: 500, lifecycle: 'paused' }], AUG());
  assert.notStrictEqual(r.state, 'paused');
});

test('rolling up nothing is "unset" rather than a crash', () => {
  assert.strictEqual(rollUp([], AUG()).state, 'unset');
  assert.strictEqual(rollUp(null, AUG()).state, 'unset');
});

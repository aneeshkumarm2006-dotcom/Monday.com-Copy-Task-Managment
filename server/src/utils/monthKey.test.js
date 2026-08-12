const { test } = require('node:test');
const assert = require('node:assert');

const {
  isMonthKey,
  parseMonthKey,
  monthKeyOf,
  monthKeyOfDayKey,
  firstDayKeyOf,
  lastDayKeyOf,
  monthKeyToUtcRange,
  addMonths,
  monthsBetween,
  compareMonthKeys,
  monthKeysBetween,
  formatMonth,
  monthKeyToPeriodKey,
  periodKeyToMonthKey,
} = require('./monthKey');

const { periodKeyFor } = require('./trackerPeriods');

// ---------------------------------------------------------------------------
// The wall-clock month — the whole reason this module exists
// ---------------------------------------------------------------------------

test('monthKeyOf uses the wall clock, NOT the UTC month', () => {
  // 2026-07-31 20:30 UTC is already 1 August in Kolkata (+05:30). A task created
  // then is an AUGUST task, and the tempting toISOString().slice(0,7) says July.
  const lateJuly = new Date('2026-07-31T20:30:00Z');
  assert.strictEqual(monthKeyOf(lateJuly, 'Asia/Kolkata'), '2026-08');
  assert.strictEqual(lateJuly.toISOString().slice(0, 7), '2026-07');
  assert.notStrictEqual(monthKeyOf(lateJuly, 'Asia/Kolkata'), lateJuly.toISOString().slice(0, 7));

  // The mirror case: 1 August 02:00 UTC is still 31 July in Los Angeles.
  const earlyAugust = new Date('2026-08-01T02:00:00Z');
  assert.strictEqual(monthKeyOf(earlyAugust, 'America/Los_Angeles'), '2026-07');
  assert.strictEqual(monthKeyOf(earlyAugust, 'UTC'), '2026-08');
  assert.strictEqual(monthKeyOf(earlyAugust, 'Asia/Kolkata'), '2026-08');
});

test('monthKeyOf returns null for an unparseable instant', () => {
  assert.strictEqual(monthKeyOf(new Date('nonsense'), 'UTC'), null);
  assert.strictEqual(monthKeyOf(null, 'UTC'), null);
});

test('monthKeyToUtcRange spans exactly one wall-clock month', () => {
  const HOUR = 60 * 60 * 1000;

  // August has 31 days and no DST transition in New York.
  const aug = monthKeyToUtcRange('2026-08', 'America/New_York');
  assert.strictEqual(aug.end - aug.start, 31 * 24 * HOUR);

  // March 2026 contains the US spring-forward (8 March), so the month is one
  // hour SHORT of 31 days. 23:59:59-style end bounds get this wrong.
  const mar = monthKeyToUtcRange('2026-03', 'America/New_York');
  assert.strictEqual(mar.end - mar.start, 31 * 24 * HOUR - HOUR);

  // November 2026 contains the fall-back, so it is one hour LONG.
  const nov = monthKeyToUtcRange('2026-11', 'America/New_York');
  assert.strictEqual(nov.end - nov.start, 30 * 24 * HOUR + HOUR);

  // The end bound is the start of the next month, exclusive — so consecutive
  // months tile with no gap and no overlap. A task at the boundary instant
  // belongs to exactly one of them.
  const sep = monthKeyToUtcRange('2026-09', 'America/New_York');
  assert.strictEqual(aug.end.getTime(), sep.start.getTime());
});

test('monthKeyToUtcRange handles the December boundary', () => {
  const dec = monthKeyToUtcRange('2026-12', 'Asia/Kolkata');
  const jan = monthKeyToUtcRange('2027-01', 'Asia/Kolkata');
  assert.strictEqual(dec.end.getTime(), jan.start.getTime());
  // Kolkata is +05:30, so the month starts at 18:30 UTC on the last day of the
  // previous month — not at midnight UTC.
  assert.strictEqual(dec.start.toISOString(), '2026-11-30T18:30:00.000Z');
});

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

test('isMonthKey rejects everything that is not YYYY-MM', () => {
  assert.ok(isMonthKey('2026-08'));
  assert.ok(isMonthKey('2026-01'));
  assert.ok(isMonthKey('2026-12'));

  assert.ok(!isMonthKey('2026-00'), 'month 0 does not exist');
  assert.ok(!isMonthKey('2026-13'), 'month 13 does not exist');
  assert.ok(!isMonthKey('2026-8'), 'month must be zero-padded');
  assert.ok(!isMonthKey('2026-08-01'), 'that is a day key');
  assert.ok(!isMonthKey('m:2026-08-01'), 'that is a period key');
  assert.ok(!isMonthKey(''));
  assert.ok(!isMonthKey(null));
  assert.ok(!isMonthKey(202608));
});

test('parseMonthKey gives 1-based months', () => {
  assert.deepStrictEqual(parseMonthKey('2026-08'), { year: 2026, month: 8 });
  assert.deepStrictEqual(parseMonthKey('2026-01'), { year: 2026, month: 1 });
  assert.strictEqual(parseMonthKey('2026-13'), null);
});

test('monthKeyOfDayKey slices only a valid day key', () => {
  assert.strictEqual(monthKeyOfDayKey('2026-08-11'), '2026-08');
  assert.strictEqual(monthKeyOfDayKey('2026-02-30'), null, 'impossible date');
  assert.strictEqual(monthKeyOfDayKey('2026-08'), null, 'not a day key');
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

test('firstDayKeyOf / lastDayKeyOf are leap-year safe', () => {
  assert.strictEqual(firstDayKeyOf('2026-08'), '2026-08-01');
  assert.strictEqual(lastDayKeyOf('2026-08'), '2026-08-31');
  assert.strictEqual(lastDayKeyOf('2026-04'), '2026-04-30');

  assert.strictEqual(lastDayKeyOf('2026-02'), '2026-02-28');
  assert.strictEqual(lastDayKeyOf('2028-02'), '2028-02-29', 'leap year');
  assert.strictEqual(lastDayKeyOf('2100-02'), '2100-02-28', 'century, not a leap year');
  assert.strictEqual(lastDayKeyOf('2000-02'), '2000-02-29', 'divisible by 400, is a leap year');

  assert.strictEqual(firstDayKeyOf('nope'), null);
  assert.strictEqual(lastDayKeyOf('nope'), null);
});

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

test('addMonths rolls over the year in both directions', () => {
  assert.strictEqual(addMonths('2026-08', 1), '2026-09');
  assert.strictEqual(addMonths('2026-12', 1), '2027-01');
  assert.strictEqual(addMonths('2026-01', -1), '2025-12');
  assert.strictEqual(addMonths('2026-08', 0), '2026-08');
  assert.strictEqual(addMonths('2026-08', 12), '2027-08');
  assert.strictEqual(addMonths('2026-08', -20), '2024-12');
});

test('addMonths on a 31st has no "31 February" problem', () => {
  // The bug this type exists to avoid: day-based month arithmetic on 31 Jan
  // silently lands on 3 March. A month key has no day component at all.
  assert.strictEqual(addMonths('2026-01', 1), '2026-02');
  assert.strictEqual(lastDayKeyOf(addMonths('2026-01', 1)), '2026-02-28');
});

test('monthsBetween is signed and inverse to addMonths', () => {
  assert.strictEqual(monthsBetween('2026-01', '2026-08'), 7);
  assert.strictEqual(monthsBetween('2026-08', '2026-01'), -7);
  assert.strictEqual(monthsBetween('2026-08', '2026-08'), 0);
  assert.strictEqual(monthsBetween('2025-11', '2026-02'), 3);
  assert.strictEqual(addMonths('2025-11', monthsBetween('2025-11', '2026-02')), '2026-02');
  assert.strictEqual(monthsBetween('2026-08', 'nope'), null);
});

test('compareMonthKeys orders chronologically', () => {
  assert.strictEqual(compareMonthKeys('2026-07', '2026-08'), -1);
  assert.strictEqual(compareMonthKeys('2026-08', '2026-08'), 0);
  assert.strictEqual(compareMonthKeys('2027-01', '2026-12'), 1);
  // Lexical sort is chronological sort — the property the whole format relies on.
  const shuffled = ['2026-12', '2025-01', '2026-02', '2027-01'];
  assert.deepStrictEqual(
    [...shuffled].sort(compareMonthKeys),
    ['2025-01', '2026-02', '2026-12', '2027-01']
  );
});

test('monthKeysBetween is inclusive and ascending', () => {
  assert.deepStrictEqual(monthKeysBetween('2026-06', '2026-09'), [
    '2026-06', '2026-07', '2026-08', '2026-09',
  ]);
  assert.deepStrictEqual(monthKeysBetween('2026-08', '2026-08'), ['2026-08']);
  assert.deepStrictEqual(monthKeysBetween('2026-11', '2027-01'), [
    '2026-11', '2026-12', '2027-01',
  ]);
  assert.deepStrictEqual(monthKeysBetween('2026-09', '2026-06'), [], 'backwards → empty');
});

// ---------------------------------------------------------------------------
// Formatting and the tracker bridge
// ---------------------------------------------------------------------------

test('formatMonth uses the same month names as the Delivery grid', () => {
  assert.strictEqual(formatMonth('2026-08'), 'Aug 2026');
  assert.strictEqual(formatMonth('2026-08', { long: true }), 'August 2026');
  assert.strictEqual(formatMonth('2026-01'), 'Jan 2026');
  assert.strictEqual(formatMonth('2026-12', { long: true }), 'December 2026');
  assert.strictEqual(formatMonth('garbage'), '');
});

test('month keys and tracker monthly period keys round-trip', () => {
  assert.strictEqual(monthKeyToPeriodKey('2026-08'), 'm:2026-08-01');
  assert.strictEqual(periodKeyToMonthKey('m:2026-08-01'), '2026-08');
  assert.strictEqual(periodKeyToMonthKey(monthKeyToPeriodKey('2026-12')), '2026-12');

  // Other cadences are not months and must not be silently coerced into one.
  assert.strictEqual(periodKeyToMonthKey('w:2026-08-10'), null);
  assert.strictEqual(periodKeyToMonthKey('d:2026-08-11'), null);
  assert.strictEqual(periodKeyToMonthKey(null), null);
});

test('monthKeyToPeriodKey agrees with trackerPeriods.periodKeyFor', () => {
  // The bridge is only useful if both sides land on the same string for the
  // same month. Any day in August must produce the key August's month key maps to.
  for (const dayKey of ['2026-08-01', '2026-08-11', '2026-08-31']) {
    assert.strictEqual(
      periodKeyFor(dayKey, { type: 'monthly' }),
      monthKeyToPeriodKey('2026-08')
    );
  }
});

const { test } = require('node:test');
const assert = require('node:assert');

const {
  dayKeyOf,
  dayKeyToUtcRange,
  addDays,
  daysBetween,
  weekdayOfDayKey,
  parseDayKey,
} = require('./tzDay');

const {
  validateCadence,
  periodKeyFor,
  periodStartFor,
  periodsBetween,
  isOffPeriod,
  isWorkingDay,
} = require('./trackerPeriods');

const keysOf = (periods) => periods.map((p) => p.key);

// ---------------------------------------------------------------------------
// tzDay — the wall-clock day, which is the thing everything else is built on
// ---------------------------------------------------------------------------

test('dayKeyOf uses the wall clock, NOT the UTC day', () => {
  // 20:30 UTC is already tomorrow in Kolkata (+05:30). The naive
  // toISOString().slice(0,10) one-liner gets this wrong, which is exactly why
  // it is banned in tzDay's header comment.
  const evening = new Date('2026-08-11T20:30:00Z');
  assert.strictEqual(dayKeyOf(evening, 'Asia/Kolkata'), '2026-08-12');
  assert.strictEqual(evening.toISOString().slice(0, 10), '2026-08-11');
  assert.notStrictEqual(dayKeyOf(evening, 'Asia/Kolkata'), evening.toISOString().slice(0, 10));

  // 02:00 UTC is still yesterday in Los Angeles (-07:00 in August).
  const earlyMorning = new Date('2026-08-11T02:00:00Z');
  assert.strictEqual(dayKeyOf(earlyMorning, 'America/Los_Angeles'), '2026-08-10');
  assert.strictEqual(dayKeyOf(earlyMorning, 'UTC'), '2026-08-11');
});

test('dayKeyToUtcRange spans exactly one wall-clock day, including DST days', () => {
  const HOUR = 60 * 60 * 1000;

  const normal = dayKeyToUtcRange('2026-08-11', 'America/New_York');
  assert.strictEqual(normal.end - normal.start, 24 * HOUR);

  // US spring forward 2026: 8 March. That local day is 23 hours long.
  const springForward = dayKeyToUtcRange('2026-03-08', 'America/New_York');
  assert.strictEqual(springForward.end - springForward.start, 23 * HOUR);

  // US fall back 2026: 1 November. That local day is 25 hours long.
  const fallBack = dayKeyToUtcRange('2026-11-01', 'America/New_York');
  assert.strictEqual(fallBack.end - fallBack.start, 25 * HOUR);

  // UK spring forward 2026: 29 March.
  const london = dayKeyToUtcRange('2026-03-29', 'Europe/London');
  assert.strictEqual(london.end - london.start, 23 * HOUR);
});

test('addDays and daysBetween are exact across month, leap and year boundaries', () => {
  assert.strictEqual(addDays('2026-02-28', 1), '2026-03-01');
  assert.strictEqual(addDays('2024-02-28', 1), '2024-02-29'); // leap year
  assert.strictEqual(addDays('2024-02-29', 1), '2024-03-01');
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(addDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(daysBetween('2026-07-25', '2026-08-11'), 17);
  assert.strictEqual(daysBetween('2026-08-11', '2026-07-25'), -17);
  assert.strictEqual(daysBetween('2026-08-11', '2026-08-11'), 0);
});

test('parseDayKey rejects dates that do not exist instead of rolling over', () => {
  assert.strictEqual(parseDayKey('2026-02-30'), null);
  assert.strictEqual(parseDayKey('2026-13-01'), null);
  assert.strictEqual(parseDayKey('2026-00-10'), null);
  assert.strictEqual(parseDayKey('not-a-date'), null);
  assert.deepStrictEqual(parseDayKey('2026-08-11'), { year: 2026, month: 8, day: 11 });
});

// ---------------------------------------------------------------------------
// INVARIANT 1 — periods never depend on holidays
// ---------------------------------------------------------------------------

test('INVARIANT: period keys are identical under different skipDates', () => {
  // If holidays could shift bucket boundaries, adding one retroactively would
  // renumber every later period and orphan every TrackerEntry after it. This is
  // the regression guard on the whole design.
  const cadence = { type: 'everyNDays', n: 2, anchorDate: '2026-08-01', weekdays: [1, 2, 3, 4, 5, 6] };

  const none = periodsBetween(cadence, '2026-08-01', '2026-08-31', { skipDates: [] });
  const many = periodsBetween(cadence, '2026-08-01', '2026-08-31', {
    skipDates: ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-15', '2026-08-16'],
  });

  assert.deepStrictEqual(keysOf(none), keysOf(many));
  assert.deepStrictEqual(
    none.map((p) => p.startDayKey),
    many.map((p) => p.startDayKey)
  );

  // Holidays change scoring, not identity — that is the whole point.
  assert.notDeepStrictEqual(none.map((p) => p.isOff), many.map((p) => p.isOff));

  // periodKeyFor takes no skipDates argument at all, by design.
  assert.strictEqual(periodKeyFor('2026-08-15', cadence), 'd:2026-08-15');
});

// ---------------------------------------------------------------------------
// everyNDays
// ---------------------------------------------------------------------------

test('everyNDays n=1 gives one period per calendar day', () => {
  const cadence = { type: 'everyNDays', n: 1, weekdays: [1, 2, 3, 4, 5, 6] };
  const periods = periodsBetween(cadence, '2026-08-10', '2026-08-16');

  assert.strictEqual(periods.length, 7);
  assert.strictEqual(periods[0].key, 'd:2026-08-10');
  assert.strictEqual(periods[6].key, 'd:2026-08-16');
  assert.strictEqual(periods[0].startDayKey, periods[0].endDayKey);

  // 16 Aug 2026 is a Sunday, and Sunday is not a working weekday here.
  assert.strictEqual(weekdayOfDayKey('2026-08-16'), 0);
  assert.strictEqual(periods[6].isOff, true);
  assert.strictEqual(periods[0].isOff, false);
});

test('everyNDays n=2 buckets from its anchor and strides across a month boundary', () => {
  const cadence = { type: 'everyNDays', n: 2, anchorDate: '2026-08-28' };
  const periods = periodsBetween(cadence, '2026-08-28', '2026-09-04');

  assert.deepStrictEqual(keysOf(periods), [
    'd:2026-08-28',
    'd:2026-08-30',
    'd:2026-09-01',
    'd:2026-09-03',
  ]);

  // Every day in a bucket maps back to that bucket's key.
  assert.strictEqual(periodKeyFor('2026-08-28', cadence), 'd:2026-08-28');
  assert.strictEqual(periodKeyFor('2026-08-29', cadence), 'd:2026-08-28');
  assert.strictEqual(periodKeyFor('2026-08-30', cadence), 'd:2026-08-30');
  assert.strictEqual(periodKeyFor('2026-09-01', cadence), 'd:2026-09-01');

  // Each bucket spans exactly n days.
  assert.strictEqual(periods[0].startDayKey, '2026-08-28');
  assert.strictEqual(periods[0].endDayKey, '2026-08-29');
});

test('everyNDays: days before the anchor belong to no period', () => {
  const cadence = { type: 'everyNDays', n: 3, anchorDate: '2026-08-10' };
  assert.strictEqual(periodKeyFor('2026-08-09', cadence), null);
  assert.strictEqual(periodStartFor('2026-08-01', cadence), null);

  // And a window starting before the anchor is clamped rather than back-filled.
  const periods = periodsBetween(cadence, '2026-08-01', '2026-08-16');
  assert.deepStrictEqual(keysOf(periods), ['d:2026-08-10', 'd:2026-08-13', 'd:2026-08-16']);
});

// ---------------------------------------------------------------------------
// weekly
// ---------------------------------------------------------------------------

test('weekly respects weekStartsOn across a YEAR boundary', () => {
  // The ISO-week trap: 2027-W01 begins on 4 Jan 2027, but the week containing
  // 1 Jan 2027 (a Friday) begins 28 Dec 2026. Keying on the first day's date
  // rather than a week number sidesteps this entirely.
  const monday = { type: 'weekly', weekStartsOn: 1 };
  const sunday = { type: 'weekly', weekStartsOn: 0 };

  assert.strictEqual(weekdayOfDayKey('2027-01-01'), 5); // Friday
  assert.strictEqual(periodKeyFor('2027-01-01', monday), 'w:2026-12-28');
  assert.strictEqual(periodKeyFor('2027-01-01', sunday), 'w:2026-12-27');

  const periods = periodsBetween(monday, '2026-12-28', '2027-01-11');
  assert.deepStrictEqual(keysOf(periods), ['w:2026-12-28', 'w:2027-01-04', 'w:2027-01-11']);
  assert.strictEqual(periods[0].endDayKey, '2027-01-03');
});

// ---------------------------------------------------------------------------
// monthly
// ---------------------------------------------------------------------------

test('monthly buckets whole calendar months, leap February included', () => {
  const cadence = { type: 'monthly' };
  const periods = periodsBetween(cadence, '2024-01-15', '2024-03-02');

  assert.deepStrictEqual(keysOf(periods), ['m:2024-01-01', 'm:2024-02-01', 'm:2024-03-01']);
  assert.strictEqual(periods[0].endDayKey, '2024-01-31');
  assert.strictEqual(periods[1].endDayKey, '2024-02-29'); // leap
  assert.strictEqual(periods[2].endDayKey, '2024-03-31');

  const nonLeap = periodsBetween(cadence, '2026-02-01', '2026-02-28');
  assert.strictEqual(nonLeap[0].endDayKey, '2026-02-28');
});

test('monthly December rolls into the next January', () => {
  const periods = periodsBetween({ type: 'monthly' }, '2026-11-01', '2027-01-31');
  assert.deepStrictEqual(keysOf(periods), ['m:2026-11-01', 'm:2026-12-01', 'm:2027-01-01']);
});

test('graceDays extends the due day past the period end', () => {
  // "The August report is fine if it goes out by 5 September."
  const periods = periodsBetween({ type: 'monthly', graceDays: 5 }, '2026-08-01', '2026-08-31');
  assert.strictEqual(periods[0].endDayKey, '2026-08-31');
  assert.strictEqual(periods[0].dueDayKey, '2026-09-05');

  const noGrace = periodsBetween({ type: 'monthly' }, '2026-08-01', '2026-08-31');
  assert.strictEqual(noGrace[0].dueDayKey, noGrace[0].endDayKey);
});

// ---------------------------------------------------------------------------
// off days
// ---------------------------------------------------------------------------

test('a period is off only when every day in it is non-working', () => {
  const cadence = { type: 'everyNDays', n: 2, anchorDate: '2026-08-15', weekdays: [1, 2, 3, 4, 5, 6] };
  // 15 Aug 2026 is a Saturday, 16 Aug a Sunday — the bucket has one working day.
  const [saturdaySunday] = periodsBetween(cadence, '2026-08-15', '2026-08-16');
  assert.strictEqual(saturdaySunday.isOff, false);
  assert.strictEqual(saturdaySunday.workingDayCount, 1);

  // A single Sunday on its own is off.
  const daily = { type: 'everyNDays', n: 1, weekdays: [1, 2, 3, 4, 5, 6] };
  const [sunday] = periodsBetween(daily, '2026-08-16', '2026-08-16');
  assert.strictEqual(sunday.isOff, true);

  // A holiday on a working day takes it out too.
  const [holiday] = periodsBetween(daily, '2026-08-15', '2026-08-15', {
    skipDates: ['2026-08-15'],
  });
  assert.strictEqual(holiday.isOff, true);

  assert.strictEqual(isWorkingDay('2026-08-16', daily, new Set()), false);
  assert.strictEqual(isWorkingDay('2026-08-15', daily, new Set()), true);
  assert.strictEqual(isWorkingDay('2026-08-15', daily, new Set(['2026-08-15'])), false);
  assert.strictEqual(isOffPeriod(sunday, daily, []), true);
});

test('weekdays omitted means every day is a working day', () => {
  const [sunday] = periodsBetween({ type: 'everyNDays', n: 1 }, '2026-08-16', '2026-08-16');
  assert.strictEqual(sunday.isOff, false);
});

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

test('column labels differ by cadence but come from one function', () => {
  const [day] = periodsBetween({ type: 'everyNDays', n: 1 }, '2026-08-11', '2026-08-11');
  assert.strictEqual(day.label, '11');
  assert.strictEqual(day.sublabel, 'Tu');
  assert.strictEqual(day.band, 'Aug');
  assert.strictEqual(day.ariaLabel, 'Tuesday 11 August 2026');

  const [week] = periodsBetween({ type: 'weekly', weekStartsOn: 1 }, '2026-08-10', '2026-08-10');
  assert.strictEqual(week.label, '10');
  assert.strictEqual(week.sublabel, 'Wk');
  assert.strictEqual(week.ariaLabel, 'Week of Monday 10 August 2026');

  const [month] = periodsBetween({ type: 'monthly' }, '2026-08-01', '2026-08-01');
  assert.strictEqual(month.label, 'Aug');
  assert.strictEqual(month.sublabel, null);
  assert.strictEqual(month.band, '2026');
  assert.strictEqual(month.ariaLabel, 'August 2026');
});

// ---------------------------------------------------------------------------
// validateCadence
// ---------------------------------------------------------------------------

test('validateCadence accepts the three shipped shapes', () => {
  assert.strictEqual(
    validateCadence({ type: 'everyNDays', n: 1, weekdays: [1, 2, 3, 4, 5, 6] }).valid,
    true
  );
  assert.strictEqual(
    validateCadence({ type: 'everyNDays', n: 2, anchorDate: '2026-08-01' }).valid,
    true
  );
  assert.strictEqual(validateCadence({ type: 'weekly', weekStartsOn: 1 }).valid, true);
  assert.strictEqual(validateCadence({ type: 'monthly', graceDays: 5 }).valid, true);
});

test('validateCadence rejects the ways this can go wrong', () => {
  assert.strictEqual(validateCadence(null).valid, false);
  assert.strictEqual(validateCadence({ type: 'yearly' }).valid, false);
  assert.strictEqual(validateCadence({ type: 'everyNDays', n: 0 }).valid, false);
  assert.strictEqual(validateCadence({ type: 'everyNDays', n: 366 }).valid, false);
  assert.strictEqual(validateCadence({ type: 'everyNDays', n: 1.5 }).valid, false);

  // n > 1 without an anchor is ambiguous: "every 2 days" from WHEN?
  assert.strictEqual(validateCadence({ type: 'everyNDays', n: 2 }).valid, false);
  assert.strictEqual(
    validateCadence({ type: 'everyNDays', n: 2, anchorDate: '2026-02-30' }).valid,
    false
  );

  // Every weekday switched off leaves nothing to ever be due.
  assert.strictEqual(validateCadence({ type: 'monthly', weekdays: [] }).valid, false);
  assert.strictEqual(validateCadence({ type: 'monthly', weekdays: [7] }).valid, false);

  assert.strictEqual(validateCadence({ type: 'weekly', weekStartsOn: 3 }).valid, false);
  assert.strictEqual(validateCadence({ type: 'monthly', graceDays: -1 }).valid, false);
  assert.strictEqual(validateCadence({ type: 'monthly', graceDays: 91 }).valid, false);
});

test('periodsBetween returns nothing for an invalid cadence or a reversed window', () => {
  assert.deepStrictEqual(periodsBetween({ type: 'nope' }, '2026-08-01', '2026-08-31'), []);
  assert.deepStrictEqual(periodsBetween({ type: 'monthly' }, '2026-08-31', '2026-08-01'), []);
  assert.deepStrictEqual(periodsBetween({ type: 'monthly' }, 'garbage', '2026-08-01'), []);
});

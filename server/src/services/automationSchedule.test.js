const test = require('node:test');
const assert = require('node:assert/strict');

const { computeNextRunAt, validateSchedule } = require('./automationSchedule');

const TZ = 'Asia/Kolkata';

// 14 Aug 2026 is a Friday; 15 Aug a Saturday; 17 Aug the Monday.
const FRIDAY_NOON = new Date('2026-08-14T12:00:00Z');

/** The schedule's local day, for assertions that do not care about the hour. */
const localDay = (date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

test('a schedule with no flag pauses on a holiday', () => {
  // `!== false`. Telling someone their automations will pause and then firing
  // anyway, because each one had to opt in separately, is a broken promise —
  // the decision lives on the holiday and this is the default side of it.
  const schedule = { frequency: 'daily', hour: 9, timezone: TZ };

  assert.strictEqual(
    localDay(computeNextRunAt(schedule, FRIDAY_NOON, new Set(['2026-08-15']))),
    '2026-08-16'
  );
});

test('an automation that must never pause opts out explicitly', () => {
  const schedule = { frequency: 'daily', hour: 9, timezone: TZ, skipHolidays: false };

  assert.strictEqual(
    localDay(computeNextRunAt(schedule, FRIDAY_NOON, new Set(['2026-08-15']))),
    '2026-08-15'
  );
});

test('a daily automation rolls forward off a holiday', () => {
  const schedule = { frequency: 'daily', hour: 9, timezone: TZ, skipHolidays: true };

  assert.strictEqual(
    localDay(computeNextRunAt(schedule, FRIDAY_NOON, new Set(['2026-08-15']))),
    '2026-08-16'
  );
});

test('consecutive holidays roll forward together rather than stopping at the first', () => {
  const schedule = { frequency: 'daily', hour: 9, timezone: TZ, skipHolidays: true };
  const holidays = new Set(['2026-08-15', '2026-08-16']);

  assert.strictEqual(
    localDay(computeNextRunAt(schedule, FRIDAY_NOON, holidays)),
    '2026-08-17'
  );
});

test('a weekly automation whose only day is a holiday rolls a full week', () => {
  // Saturdays only. 15 Aug is the Saturday, so the next run is 22 Aug — the
  // point being that skipping does not silently promote it to a Sunday.
  const schedule = {
    frequency: 'weekly',
    daysOfWeek: [6],
    hour: 9,
    timezone: TZ,
    skipHolidays: true,
  };

  assert.strictEqual(
    localDay(computeNextRunAt(schedule, FRIDAY_NOON, new Set(['2026-08-15']))),
    '2026-08-22'
  );
});

test('a monthly automation rolls to the next matching month, not the next day', () => {
  const schedule = {
    frequency: 'monthly',
    dayOfMonth: 15,
    hour: 9,
    timezone: TZ,
    skipHolidays: true,
  };

  assert.strictEqual(
    localDay(computeNextRunAt(schedule, FRIDAY_NOON, new Set(['2026-08-15']))),
    '2026-09-15'
  );
});

test('an empty or absent holiday set changes nothing', () => {
  const schedule = { frequency: 'daily', hour: 9, timezone: TZ, skipHolidays: true };

  for (const holidays of [null, undefined, new Set()]) {
    assert.strictEqual(
      localDay(computeNextRunAt(schedule, FRIDAY_NOON, holidays)),
      '2026-08-15'
    );
  }
});

test('a holiday that is not a candidate day is simply irrelevant', () => {
  const schedule = { frequency: 'daily', hour: 9, timezone: TZ, skipHolidays: true };

  assert.strictEqual(
    localDay(computeNextRunAt(schedule, FRIDAY_NOON, new Set(['2026-12-25']))),
    '2026-08-15'
  );
});

test('holidays are matched in the SCHEDULE timezone, not UTC', () => {
  // 15 Aug 00:30 IST is still 14 Aug in UTC. A scheduler comparing
  // `.toISOString().slice(0,10)` would look up the wrong day and fire anyway;
  // makeDayKey over the tz parts is what makes this land.
  const schedule = {
    frequency: 'daily',
    hour: 0,
    timezone: TZ,
    skipHolidays: true,
  };
  const from = new Date('2026-08-14T10:00:00Z'); // 15:30 IST on the 14th

  const next = computeNextRunAt(schedule, from, new Set(['2026-08-15']));
  assert.strictEqual(localDay(next), '2026-08-16');
});

test('validateSchedule is untouched by the new field', () => {
  assert.deepStrictEqual(
    validateSchedule({ frequency: 'daily', hour: 9, timezone: TZ, skipHolidays: true }),
    { valid: true }
  );
  assert.strictEqual(
    validateSchedule({ frequency: 'nope', skipHolidays: true }).valid,
    false
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_HOLIDAYS,
  MAX_HOLIDAY_NAME,
  normaliseAffects,
  withProvenance,
  mergeProvenance,
  deliveryHolidaysOf,
  automationHolidayKeySetOf,
  sanitizeHoliday,
  sanitizeHolidays,
  sanitizeYear,
  holidayListOf,
  holidayIndex,
  holidayDayKeysOf,
  holidaysInYear,
} = require('./orgHolidays');

// ---------------------------------------------------------------------------
// Sanitizing one
// ---------------------------------------------------------------------------

test('a holiday keeps its date and trimmed name', () => {
  const { value } = sanitizeHoliday({ date: '2026-08-15', name: '  Independence Day  ' });
  assert.deepStrictEqual(value, {
    date: '2026-08-15',
    name: 'Independence Day',
    affects: { delivery: true, automations: true },
  });
});

test('a blank name is allowed — an unnamed day off still beats nothing', () => {
  assert.deepStrictEqual(sanitizeHoliday({ date: '2026-08-15' }).value, {
    date: '2026-08-15',
    name: '',
    affects: { delivery: true, automations: true },
  });
});

// ---------------------------------------------------------------------------
// What a day stops
// ---------------------------------------------------------------------------

test('affects defaults to stopping everything', () => {
  // An unqualified "holiday" means the office is shut. A row written before
  // these flags existed, or by a client that does not send them, must read that
  // way rather than silently stopping nothing.
  for (const raw of [undefined, null, {}, 'nonsense']) {
    assert.deepStrictEqual(normaliseAffects(raw), {
      delivery: true,
      automations: true,
    });
  }
});

test('only an explicit false turns a consequence off', () => {
  assert.deepStrictEqual(normaliseAffects({ delivery: false }), {
    delivery: false,
    automations: true,
  });
  assert.deepStrictEqual(normaliseAffects({ automations: false }), {
    delivery: true,
    automations: false,
  });
});

test('each consumer sees only the holidays that stop its own thing', () => {
  const list = [
    { date: '2026-08-15', name: 'Independence Day' },
    { date: '2026-09-10', name: 'Offsite', affects: { delivery: true, automations: false } },
    { date: '2026-10-20', name: 'Server day', affects: { delivery: false, automations: true } },
  ];

  assert.deepStrictEqual(
    deliveryHolidaysOf(list).map((h) => h.date),
    ['2026-08-15', '2026-09-10']
  );
  assert.deepStrictEqual(
    [...automationHolidayKeySetOf(list)].sort(),
    ['2026-08-15', '2026-10-20']
  );
});

test('a day that stops nothing is still stored, and stops nothing', () => {
  // Worth keeping: it is a note on the calendar. It just owes no consequences.
  const list = [
    { date: '2026-11-01', name: 'Founders day', affects: { delivery: false, automations: false } },
  ];
  assert.strictEqual(holidayListOf(list).length, 1);
  assert.deepStrictEqual(deliveryHolidaysOf(list), []);
  assert.deepStrictEqual([...automationHolidayKeySetOf(list)], []);
});

test('an impossible date is rejected, not silently rolled over', () => {
  // 2026-02-30 passes the regex; parseDayKey's round-trip probe is what catches it.
  assert.strictEqual(sanitizeHoliday({ date: '2026-02-30' }).error, 'Invalid date');
  assert.strictEqual(sanitizeHoliday({ date: '15-08-2026' }).error, 'Invalid date');
  assert.strictEqual(sanitizeHoliday({ date: null }).error, 'Invalid date');
  assert.strictEqual(sanitizeHoliday(null).error, 'Invalid date');
});

test('a name longer than the cap is truncated, not rejected', () => {
  const { value } = sanitizeHoliday({ date: '2026-08-15', name: 'x'.repeat(200) });
  assert.strictEqual(value.name.length, MAX_HOLIDAY_NAME);
});

// ---------------------------------------------------------------------------
// Sanitizing a list
// ---------------------------------------------------------------------------

test('holidays are de-duplicated by date (last wins) and sorted', () => {
  const { value } = sanitizeHolidays([
    { date: '2026-12-25', name: 'Christmas' },
    { date: '2026-08-15', name: 'First' },
    { date: '2026-08-15', name: 'Wins' },
  ]);

  assert.deepStrictEqual(value.map((h) => h.date), ['2026-08-15', '2026-12-25']);
  assert.strictEqual(value[0].name, 'Wins');
});

test('an empty or absent list is an empty list, not an error', () => {
  assert.deepStrictEqual(sanitizeHolidays(undefined).value, []);
  assert.deepStrictEqual(sanitizeHolidays(null).value, []);
  assert.deepStrictEqual(sanitizeHolidays([]).value, []);
});

test('a non-list is an error', () => {
  assert.strictEqual(sanitizeHolidays('2026-08-15').error, 'Holidays must be a list');
  assert.strictEqual(sanitizeHolidays({ date: '2026-08-15' }).error, 'Holidays must be a list');
});

test('one bad entry rejects the whole list rather than dropping it quietly', () => {
  const out = sanitizeHolidays([
    { date: '2026-08-15', name: 'Fine' },
    { date: 'nonsense', name: 'Bad' },
  ]);
  assert.strictEqual(out.error, 'Invalid date');
  assert.strictEqual(out.value, undefined);
});

test('the list is capped', () => {
  const tooMany = Array.from({ length: MAX_HOLIDAYS + 1 }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    name: String(i),
  }));
  assert.match(sanitizeHolidays(tooMany).error, /At most/);
});

// ---------------------------------------------------------------------------
// Years
// ---------------------------------------------------------------------------

test('a year must be four digits', () => {
  assert.strictEqual(sanitizeYear('2026').value, '2026');
  assert.strictEqual(sanitizeYear(2026).value, '2026');
  assert.strictEqual(sanitizeYear('26').error, 'Invalid year');
  assert.strictEqual(sanitizeYear('20266').error, 'Invalid year');
  assert.strictEqual(sanitizeYear('').error, 'Invalid year');
  assert.strictEqual(sanitizeYear(undefined).error, 'Invalid year');
});

test('holidaysInYear does not leak the neighbouring years', () => {
  const org = {
    holidays: [
      { date: '2025-12-31', name: 'NYE' },
      { date: '2026-01-01', name: 'New Year' },
      { date: '2026-12-25', name: 'Christmas' },
      { date: '2027-01-01', name: 'Next New Year' },
    ],
  };

  assert.deepStrictEqual(
    holidaysInYear(org, 2026).map((h) => h.date),
    ['2026-01-01', '2026-12-25']
  );
  assert.deepStrictEqual(holidaysInYear(org, '2027').map((h) => h.date), ['2027-01-01']);
  assert.deepStrictEqual(holidaysInYear(org, 'nope'), []);
});

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

test('the readers take an org document or a bare list interchangeably', () => {
  const list = [{ date: '2026-08-15', name: 'Independence Day' }];

  assert.deepStrictEqual(holidayListOf(list), holidayListOf({ holidays: list }));
  assert.deepStrictEqual(holidayDayKeysOf(list), ['2026-08-15']);
  assert.strictEqual(holidayIndex(list).get('2026-08-15').name, 'Independence Day');
});

test('the readers survive junk rows rather than throwing', () => {
  const list = [
    { date: '2026-08-15', name: 'Good' },
    { date: 'nonsense' },
    null,
    {},
  ];
  assert.deepStrictEqual(holidayDayKeysOf(list), ['2026-08-15']);
});

test('an org with no holidays reads as empty everywhere', () => {
  for (const empty of [{}, { holidays: [] }, { holidays: null }, []]) {
    assert.deepStrictEqual(holidayListOf(empty), []);
    assert.deepStrictEqual(holidayDayKeysOf(empty), []);
    assert.strictEqual(holidayIndex(empty).size, 0);
  }
});

test('a missing name reads as an empty string, never undefined', () => {
  assert.strictEqual(holidayListOf([{ date: '2026-08-15' }])[0].name, '');
});

// ---------------------------------------------------------------------------
// Provenance
//
// Lives here rather than in the controller because it is pure: the controller
// writes through atomic `updateOne` calls that need a real database, and the
// HTTP-level behaviour is covered by src/e2e/holidays.e2e.js.
// ---------------------------------------------------------------------------

const OLD = new Date('2020-01-01T00:00:00Z');
const NOW = new Date('2030-06-01T00:00:00Z');

test('an untouched row keeps its original author and timestamp', () => {
  // Resending a whole year must not rewrite "marked by Ali in January" into
  // "marked by Sam just now" for every day Sam did not touch.
  const previous = [
    { date: '2026-08-15', name: 'Independence Day', affects: { delivery: true, automations: true }, by: 'ali', at: OLD },
    { date: '2026-12-25', name: 'Christmas', affects: { delivery: true, automations: true }, by: 'ali', at: OLD },
  ];
  const next = [
    { date: '2026-08-15', name: 'Independence Day' },
    { date: '2026-12-25', name: 'Christmas Day' },
  ];

  const out = mergeProvenance(next, previous, 'sam', NOW);

  assert.strictEqual(out[0].by, 'ali');
  assert.strictEqual(out[0].at, OLD);
  assert.strictEqual(out[1].by, 'sam');
  assert.strictEqual(out[1].at, NOW);
});

test('changing only what a day STOPS also re-stamps it', () => {
  const previous = [
    { date: '2026-08-15', name: 'Offsite', affects: { delivery: true, automations: true }, by: 'ali', at: OLD },
  ];
  const next = [
    { date: '2026-08-15', name: 'Offsite', affects: { delivery: true, automations: false } },
  ];

  assert.strictEqual(mergeProvenance(next, previous, 'sam', NOW)[0].by, 'sam');
});

test('a brand new row is stamped to the person adding it', () => {
  const out = mergeProvenance([{ date: '2026-01-26', name: 'Republic Day' }], [], 'sam', NOW);
  assert.strictEqual(out[0].by, 'sam');
  assert.deepStrictEqual(out[0].affects, { delivery: true, automations: true });
});

test('withProvenance normalises the effects it stores', () => {
  const out = withProvenance({ date: '2026-08-15', name: 'X' }, 'sam');
  assert.deepStrictEqual(out.affects, { delivery: true, automations: true });
  assert.strictEqual(out.by, 'sam');
});

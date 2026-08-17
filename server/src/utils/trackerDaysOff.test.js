const test = require('node:test');
const assert = require('node:assert/strict');

const { periodsBetween } = require('./trackerPeriods');
const {
  sanitizeDaysOff,
  skipDayKeysOf,
  annotateDaysOff,
} = require('./trackerDaysOff');

const DAILY = { type: 'everyNDays', n: 1, weekdays: [1, 2, 3, 4, 5, 6], graceDays: 0 };
const MONTHLY = { type: 'monthly', weekdays: [0, 1, 2, 3, 4, 5, 6], graceDays: 5 };

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

test('a day off keeps its tag and label, and unknown tags fall back to other', () => {
  const { value } = sanitizeDaysOff([
    { date: '2026-08-14', tag: 'event', label: '  Client shoot  ' },
    { date: '2026-08-15', tag: 'nonsense', label: '' },
  ]);

  assert.deepStrictEqual(value, [
    { date: '2026-08-14', tag: 'event', label: 'Client shoot' },
    { date: '2026-08-15', tag: 'other', label: '' },
  ]);
});

test('days off are de-duplicated by date and sorted', () => {
  const { value } = sanitizeDaysOff([
    { date: '2026-08-20', tag: 'holiday', label: 'Second' },
    { date: '2026-08-10', tag: 'holiday', label: 'First' },
    { date: '2026-08-20', tag: 'event', label: 'Wins' },
  ]);

  assert.deepStrictEqual(value.map((d) => d.date), ['2026-08-10', '2026-08-20']);
  assert.strictEqual(value[1].label, 'Wins');
});

test('a bad date is rejected rather than silently dropped', () => {
  assert.ok(sanitizeDaysOff([{ date: '2026-13-01' }]).error);
  assert.ok(sanitizeDaysOff([{ date: 'yesterday' }]).error);
  assert.ok(sanitizeDaysOff('nope').error);
});

// ---------------------------------------------------------------------------
// The two sources of dates
// ---------------------------------------------------------------------------

test('skipDayKeysOf unions legacy skipDates with labelled daysOff', () => {
  // skipDates predates daysOff and never had a UI. Unioning is what stops an old
  // row from silently starting to count as a miss the day this ships.
  const keys = skipDayKeysOf({
    skipDates: ['2026-08-03', '2026-08-14'],
    daysOff: [
      { date: '2026-08-14', tag: 'event', label: 'Counted once' },
      { date: '2026-08-01', tag: 'holiday', label: '' },
    ],
  });

  assert.deepStrictEqual(keys, ['2026-08-01', '2026-08-03', '2026-08-14']);
});

test('a day off takes its day out of the working set, and a daily period with it', () => {
  const tracker = {
    daysOff: [{ date: '2026-08-14', tag: 'holiday', label: 'Independence Day' }],
  };
  const periods = periodsBetween(DAILY, '2026-08-13', '2026-08-15', {
    skipDates: skipDayKeysOf(tracker),
  });

  assert.deepStrictEqual(periods.map((p) => p.isOff), [false, true, false]);
});

// ---------------------------------------------------------------------------
// Annotation — what the grid header actually renders
// ---------------------------------------------------------------------------

test('annotateDaysOff hangs the labelled entry off its own period only', () => {
  const tracker = {
    daysOff: [{ date: '2026-08-14', tag: 'event', label: 'Client shoot' }],
  };
  const periods = annotateDaysOff(
    periodsBetween(DAILY, '2026-08-13', '2026-08-15', { skipDates: skipDayKeysOf(tracker) }),
    tracker
  );

  assert.strictEqual(periods[0].daysOff, undefined);
  assert.deepStrictEqual(periods[1].daysOff, [
    { date: '2026-08-14', tag: 'event', label: 'Client shoot' },
  ]);
  assert.strictEqual(periods[2].daysOff, undefined);
});

test('a monthly period collects every day off inside it, in date order', () => {
  const tracker = {
    daysOff: [
      { date: '2026-08-20', tag: 'event', label: 'Offsite' },
      { date: '2026-08-15', tag: 'holiday', label: 'Independence Day' },
      { date: '2026-09-02', tag: 'other', label: 'Not this month' },
    ],
  };
  const periods = annotateDaysOff(
    periodsBetween(MONTHLY, '2026-08-01', '2026-09-30', { skipDates: skipDayKeysOf(tracker) }),
    tracker
  );

  assert.deepStrictEqual(periods[0].daysOff.map((d) => d.date), ['2026-08-15', '2026-08-20']);
  assert.deepStrictEqual(periods[1].daysOff.map((d) => d.date), ['2026-09-02']);

  // Two days off do not make August off — the month is still owed. Only a period
  // with NO working day left in it drops out.
  assert.strictEqual(periods[0].isOff, false);
});

test('INVARIANT: days off never move a period boundary', () => {
  // The same guard trackerPeriods.test.js puts on skipDates, restated for the
  // labelled path — a holiday added retroactively must not renumber later
  // periods and orphan the TrackerEntry rows keyed to them.
  const none = periodsBetween(DAILY, '2026-08-01', '2026-08-31', { skipDates: [] });
  const many = periodsBetween(DAILY, '2026-08-01', '2026-08-31', {
    skipDates: skipDayKeysOf({
      daysOff: [
        { date: '2026-08-14', tag: 'holiday', label: 'a' },
        { date: '2026-08-15', tag: 'event', label: 'b' },
      ],
    }),
  });

  assert.deepStrictEqual(none.map((p) => p.key), many.map((p) => p.key));
});

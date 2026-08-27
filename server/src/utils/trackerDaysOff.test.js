const test = require('node:test');
const assert = require('node:assert/strict');

const { periodsBetween } = require('./trackerPeriods');
const {
  sanitizeDaysOff,
  skipDayKeysOf,
  annotateDaysOff,
  observesOrgHolidays,
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
    { date: '2026-08-14', tag: 'event', label: 'Client shoot', source: 'tracker' },
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

// ---------------------------------------------------------------------------
// The workspace holiday calendar — the second layer
// ---------------------------------------------------------------------------

const ORG_HOLIDAYS = [
  { date: '2026-08-15', name: 'Independence Day' },
  { date: '2026-08-20', name: '' },
];

test('org holidays join the skip set alongside the tracker own days off', () => {
  const tracker = { daysOff: [{ date: '2026-08-14', tag: 'event', label: 'Client shoot' }] };

  assert.deepStrictEqual(skipDayKeysOf(tracker, ORG_HOLIDAYS), [
    '2026-08-14',
    '2026-08-15',
    '2026-08-20',
  ]);
});

test('a tracker that opts out sees only its own days off', () => {
  const tracker = {
    observesOrgHolidays: false,
    daysOff: [{ date: '2026-08-14', tag: 'event', label: 'Client shoot' }],
  };

  assert.deepStrictEqual(skipDayKeysOf(tracker, ORG_HOLIDAYS), ['2026-08-14']);
});

test('a tracker with no flag observes — absence is not opting out', () => {
  // Every tracker written before the calendar existed has no field. Reading it
  // as "off" would ship the feature switched off for everyone who already had
  // trackers, which is exactly the population it is for.
  assert.deepStrictEqual(skipDayKeysOf({}, ORG_HOLIDAYS), ['2026-08-15', '2026-08-20']);
  assert.strictEqual(observesOrgHolidays({}), true);
  assert.strictEqual(observesOrgHolidays({ observesOrgHolidays: undefined }), true);
  assert.strictEqual(observesOrgHolidays({ observesOrgHolidays: false }), false);
});

test('an org holiday surfaces as a holiday-tagged day off carrying its name', () => {
  const periods = annotateDaysOff(
    periodsBetween(DAILY, '2026-08-15', '2026-08-15', {
      skipDates: skipDayKeysOf({}, ORG_HOLIDAYS),
    }),
    {},
    ORG_HOLIDAYS
  );

  assert.deepStrictEqual(periods[0].daysOff, [
    { date: '2026-08-15', tag: 'holiday', label: 'Independence Day', source: 'org' },
  ]);
});

test('the tracker own reason beats the org holiday on the same date', () => {
  // Somebody typed "Client shoot" on that day on purpose. "Public holiday" is
  // the less specific of the two and loses.
  const tracker = {
    daysOff: [{ date: '2026-08-15', tag: 'event', label: 'Client shoot' }],
  };
  const periods = annotateDaysOff(
    periodsBetween(DAILY, '2026-08-15', '2026-08-15', {
      skipDates: skipDayKeysOf(tracker, ORG_HOLIDAYS),
    }),
    tracker,
    ORG_HOLIDAYS
  );

  // …and it is reported as the tracker's own, so the grid offers Undo rather
  // than pointing at Settings.
  assert.deepStrictEqual(periods[0].daysOff, [
    { date: '2026-08-15', tag: 'event', label: 'Client shoot', source: 'tracker' },
  ]);
});

test('an unnamed org holiday still marks the day, with a blank label', () => {
  const periods = annotateDaysOff(
    periodsBetween(DAILY, '2026-08-20', '2026-08-20', {
      skipDates: skipDayKeysOf({}, ORG_HOLIDAYS),
    }),
    {},
    ORG_HOLIDAYS
  );

  assert.deepStrictEqual(periods[0].daysOff, [
    { date: '2026-08-20', tag: 'holiday', label: '', source: 'org' },
  ]);
});

test('one org holiday does not excuse the month it falls in', () => {
  // The whole argument for widening the scope: a shared calendar is safe
  // BECAUSE isOff is `workingDayCount === 0`. A holiday empties a one-day
  // period and leaves a monthly one holding thirty other working days.
  const daily = periodsBetween(DAILY, '2026-08-15', '2026-08-15', {
    skipDates: skipDayKeysOf({}, ORG_HOLIDAYS),
  });
  const monthly = periodsBetween(MONTHLY, '2026-08-01', '2026-08-31', {
    skipDates: skipDayKeysOf({}, ORG_HOLIDAYS),
  });

  assert.strictEqual(daily[0].isOff, true);
  assert.strictEqual(monthly[0].isOff, false);
});

test('org holidays are ignored when absent, and junk rows do not throw', () => {
  assert.deepStrictEqual(skipDayKeysOf({}), []);
  assert.deepStrictEqual(skipDayKeysOf({}, []), []);
  assert.deepStrictEqual(skipDayKeysOf({}, null), []);
  assert.deepStrictEqual(
    skipDayKeysOf({}, [{ date: 'nonsense' }, null, {}, { date: '2026-08-15' }]),
    ['2026-08-15']
  );
});

test('INVARIANT: org holidays never move a period boundary either', () => {
  // The guard that makes the whole two-layer design safe. If a holiday could
  // shift a bucket, then an admin marking Diwali in Settings would renumber
  // every later period on every tracker in the workspace at once, orphaning
  // every TrackerEntry after it.
  const none = periodsBetween(DAILY, '2026-08-01', '2026-08-31', { skipDates: [] });
  const many = periodsBetween(DAILY, '2026-08-01', '2026-08-31', {
    skipDates: skipDayKeysOf({}, ORG_HOLIDAYS),
  });

  assert.deepStrictEqual(none.map((p) => p.key), many.map((p) => p.key));
  // …and they really did differ, so the assertion above is not vacuous.
  assert.notDeepStrictEqual(none.map((p) => p.isOff), many.map((p) => p.isOff));
});

test('source tells the grid which layer a day off came from', () => {
  // The grid uses this to decide whether to offer Undo. An org holiday has no
  // per-tracker row for Undo to remove, so a button offering it would do
  // nothing at all.
  const tracker = {
    daysOff: [{ date: '2026-08-14', tag: 'event', label: 'Client shoot' }],
  };
  const periods = annotateDaysOff(
    periodsBetween(DAILY, '2026-08-14', '2026-08-15', {
      skipDates: skipDayKeysOf(tracker, ORG_HOLIDAYS),
    }),
    tracker,
    ORG_HOLIDAYS
  );

  assert.strictEqual(periods[0].daysOff[0].source, 'tracker');
  assert.strictEqual(periods[1].daysOff[0].source, 'org');
});

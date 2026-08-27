const test = require('node:test');
const assert = require('node:assert/strict');

const {
  saveHolidays,
  setHoliday,
  deleteHoliday,
} = require('./orgController');

/**
 * The holiday handlers, exercised without Mongo.
 *
 * `requireCapability` hands the handler a loaded `req.org`, so everything below
 * the gate is reachable with a plain object that answers `markModified` and
 * `save`. That is the whole reason these are worth testing here: the bulk save
 * is the one endpoint in this feature that can DESTROY data, and its rule —
 * "replace this year, carry every other year through untouched" — is exactly
 * the kind of thing that survives review and then quietly breaks.
 */
const makeOrg = (holidays = []) => ({
  holidays: holidays.map((h) => ({ ...h })),
  markModified() {},
  async save() {},
});

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

const call = async (handler, req) => {
  const res = makeRes();
  await handler(req, res);
  return res;
};

const USER = '000000000000000000000001';
const datesOf = (list) => list.map((h) => h.date);

// ---------------------------------------------------------------------------
// The bulk save — one year at a time
// ---------------------------------------------------------------------------

test('saving a year replaces only that year', async () => {
  const org = makeOrg([
    { date: '2025-12-25', name: 'Christmas 25' },
    { date: '2026-01-01', name: 'Old New Year' },
    { date: '2026-08-15', name: 'Independence Day' },
    { date: '2027-01-01', name: 'New Year 27' },
  ]);

  const res = await call(saveHolidays, {
    org,
    user: { userId: USER },
    body: { year: '2026', holidays: [{ date: '2026-10-20', name: 'Diwali' }] },
  });

  assert.deepStrictEqual(datesOf(res.body.holidays), [
    '2025-12-25',
    '2026-10-20',
    '2027-01-01',
  ]);
});

test('emptying a year leaves the neighbouring years alone', async () => {
  const org = makeOrg([
    { date: '2025-12-25', name: 'Christmas 25' },
    { date: '2026-08-15', name: 'Independence Day' },
    { date: '2027-01-01', name: 'New Year 27' },
  ]);

  const res = await call(saveHolidays, {
    org,
    user: { userId: USER },
    body: { year: '2026', holidays: [] },
  });

  assert.deepStrictEqual(datesOf(res.body.holidays), ['2025-12-25', '2027-01-01']);
});

test('a date outside the year is rejected rather than filed', async () => {
  // Without this, a stale tab showing 2026 could post a 2027 date, which the
  // next save of 2027 would then silently wipe.
  const org = makeOrg([{ date: '2027-01-01', name: 'New Year 27' }]);

  const res = await call(saveHolidays, {
    org,
    user: { userId: USER },
    body: { year: '2026', holidays: [{ date: '2027-05-01', name: 'Smuggled' }] },
  });

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, '2027-05-01 is not in 2026');
  assert.deepStrictEqual(datesOf(org.holidays), ['2027-01-01']);
});

test('a bad year and a bad date are both 400s', async () => {
  const org = makeOrg([]);

  const badYear = await call(saveHolidays, {
    org,
    user: { userId: USER },
    body: { year: '26', holidays: [] },
  });
  assert.strictEqual(badYear.statusCode, 400);
  assert.strictEqual(badYear.body.error, 'Invalid year');

  const badDate = await call(saveHolidays, {
    org,
    user: { userId: USER },
    body: { year: '2026', holidays: [{ date: '2026-02-30' }] },
  });
  assert.strictEqual(badDate.statusCode, 400);
  assert.strictEqual(badDate.body.error, 'Invalid date');
});

test('the stored list stays sorted across years', async () => {
  const org = makeOrg([{ date: '2027-06-01', name: 'Later year' }]);

  await call(saveHolidays, {
    org,
    user: { userId: USER },
    body: {
      year: '2026',
      holidays: [
        { date: '2026-12-25', name: 'Christmas' },
        { date: '2026-01-26', name: 'Republic Day' },
      ],
    },
  });

  assert.deepStrictEqual(datesOf(org.holidays), [
    '2026-01-26',
    '2026-12-25',
    '2027-06-01',
  ]);
});

test('an untouched row keeps its original author and timestamp', async () => {
  // Resending a whole year must not rewrite "marked by Ali in January" into
  // "marked by Sam just now" for every day Sam did not touch.
  const stamp = new Date('2020-01-01T00:00:00Z');
  const org = makeOrg([
    { date: '2026-08-15', name: 'Independence Day', by: 'ali', at: stamp },
    { date: '2026-12-25', name: 'Christmas', by: 'ali', at: stamp },
  ]);

  await call(saveHolidays, {
    org,
    user: { userId: 'sam' },
    body: {
      year: '2026',
      holidays: [
        { date: '2026-08-15', name: 'Independence Day' },
        { date: '2026-12-25', name: 'Christmas Day' },
      ],
    },
  });

  assert.strictEqual(org.holidays[0].by, 'ali');
  assert.strictEqual(org.holidays[0].at, stamp);
  assert.strictEqual(org.holidays[1].by, 'sam');
  assert.notStrictEqual(org.holidays[1].at, stamp);
});

// ---------------------------------------------------------------------------
// The single-date quick path
// ---------------------------------------------------------------------------

test('quick-mark adds a day, then upserts rather than duplicating it', async () => {
  const org = makeOrg([]);

  await call(setHoliday, {
    org,
    user: { userId: USER },
    params: { id: 'org', date: '2026-08-15' },
    body: { name: 'Independence Day' },
  });
  assert.deepStrictEqual(datesOf(org.holidays), ['2026-08-15']);

  await call(setHoliday, {
    org,
    user: { userId: USER },
    params: { id: 'org', date: '2026-08-15' },
    body: { name: 'Renamed' },
  });
  assert.deepStrictEqual(org.holidays.map((h) => h.name), ['Renamed']);
});

test('quick-mark keeps the list sorted', async () => {
  const org = makeOrg([{ date: '2026-12-25', name: 'Christmas' }]);

  const res = await call(setHoliday, {
    org,
    user: { userId: USER },
    params: { id: 'org', date: '2026-08-15' },
    body: { name: 'Independence Day' },
  });

  assert.deepStrictEqual(datesOf(res.body.holidays), ['2026-08-15', '2026-12-25']);
});

test('an impossible date is a 400 on the quick path too', async () => {
  const org = makeOrg([]);

  const res = await call(setHoliday, {
    org,
    user: { userId: USER },
    params: { id: 'org', date: '2026-02-30' },
    body: {},
  });

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'Invalid date');
  assert.deepStrictEqual(org.holidays, []);
});

test('delete removes one day and leaves the rest', async () => {
  const org = makeOrg([
    { date: '2026-08-15', name: 'Independence Day' },
    { date: '2026-12-25', name: 'Christmas' },
  ]);

  const res = await call(deleteHoliday, {
    org,
    user: { userId: USER },
    params: { id: 'org', date: '2026-08-15' },
  });

  assert.deepStrictEqual(datesOf(res.body.holidays), ['2026-12-25']);
});

test('deleting a day that was never marked is a no-op, not an error', async () => {
  const org = makeOrg([{ date: '2026-12-25', name: 'Christmas' }]);

  const res = await call(deleteHoliday, {
    org,
    user: { userId: USER },
    params: { id: 'org', date: '2026-08-15' },
  });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(datesOf(res.body.holidays), ['2026-12-25']);
});

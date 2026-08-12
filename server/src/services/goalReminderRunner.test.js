const { test } = require('node:test');
const assert = require('node:assert');

const { dueKind } = require('./goalReminderRunner');

const board = (tz) => ({ monthTimezone: tz });

// All of these are UTC instants; what matters is the wall clock in the board's
// own zone, which is the whole reason this function is worth testing.

test('nothing fires before the reminder hour, whatever the date', () => {
  // 1 Aug 2026, 03:00 UTC = 03:00 in London (BST is +1, so 04:00 — still early)
  assert.strictEqual(dueKind(board('UTC'), new Date('2026-08-01T03:00:00Z')), null);
  assert.strictEqual(dueKind(board('UTC'), new Date('2026-07-31T08:59:00Z')), null);
});

test('the LAST day of the month fires for that month', () => {
  const due = dueKind(board('UTC'), new Date('2026-07-31T09:00:00Z'));
  assert.deepStrictEqual(due, { kind: 'monthEnd', monthKey: '2026-07' });
});

test('the 1st fires for the month that just ended', () => {
  const due = dueKind(board('UTC'), new Date('2026-08-01T09:30:00Z'));
  assert.deepStrictEqual(due, { kind: 'monthStart', monthKey: '2026-07' });
});

test('a mid-month day fires nothing', () => {
  assert.strictEqual(dueKind(board('UTC'), new Date('2026-08-15T12:00:00Z')), null);
  assert.strictEqual(dueKind(board('UTC'), new Date('2026-08-30T12:00:00Z')), null);
});

test('"last day" respects month length, including February', () => {
  assert.ok(dueKind(board('UTC'), new Date('2026-02-28T10:00:00Z')), '28 Feb 2026 is the last');
  assert.strictEqual(dueKind(board('UTC'), new Date('2026-02-27T10:00:00Z')), null);

  // 2028 is a leap year, so the 28th is NOT the last day.
  assert.strictEqual(dueKind(board('UTC'), new Date('2028-02-28T10:00:00Z')), null);
  assert.ok(dueKind(board('UTC'), new Date('2028-02-29T10:00:00Z')), '29 Feb 2028 is the last');
});

test('the year boundary rolls the month back correctly', () => {
  const dec = dueKind(board('UTC'), new Date('2026-12-31T10:00:00Z'));
  assert.deepStrictEqual(dec, { kind: 'monthEnd', monthKey: '2026-12' });

  const jan = dueKind(board('UTC'), new Date('2027-01-01T10:00:00Z'));
  assert.deepStrictEqual(jan, { kind: 'monthStart', monthKey: '2026-12' });
});

test('it fires on the BOARD’s wall clock, not the server’s', () => {
  // 31 Jul 2026 22:00 UTC is already 1 Aug, 03:30 in Kolkata — too early there,
  // so nothing fires, even though it is late on the 31st in UTC.
  const instant = new Date('2026-07-31T22:00:00Z');
  assert.strictEqual(dueKind(board('Asia/Kolkata'), instant), null, 'still the small hours in IST');
  assert.deepStrictEqual(
    dueKind(board('UTC'), instant),
    { kind: 'monthEnd', monthKey: '2026-07' },
    'but it is 22:00 on the 31st in UTC'
  );

  // Four hours later it is 07:30 IST on 1 Aug — still before 09:00 local.
  assert.strictEqual(dueKind(board('Asia/Kolkata'), new Date('2026-08-01T02:00:00Z')), null);
  // At 04:00 UTC it is 09:30 IST on the 1st, so the month-start nag is due.
  assert.deepStrictEqual(
    dueKind(board('Asia/Kolkata'), new Date('2026-08-01T04:00:00Z')),
    { kind: 'monthStart', monthKey: '2026-07' }
  );
});

test('a board with no timezone falls back to UTC rather than crashing', () => {
  assert.deepStrictEqual(
    dueKind({}, new Date('2026-07-31T09:00:00Z')),
    { kind: 'monthEnd', monthKey: '2026-07' }
  );
});

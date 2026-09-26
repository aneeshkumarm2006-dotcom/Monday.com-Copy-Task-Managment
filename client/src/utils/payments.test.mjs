import test from 'node:test';
import assert from 'node:assert';

import { paymentsOf, paymentsTotal, makePayment, todayKey, addDaysKey } from './payments.js';

/**
 * A payments cell is a list of receipts whose NUMBER is their total. These pin
 * the two ways that goes quietly wrong: a cell that is not a clean array, and
 * a date that lands on the wrong day.
 */

test('paymentsOf always hands back an array', () => {
  assert.deepEqual(paymentsOf(undefined), []);
  assert.deepEqual(paymentsOf(null), []);
  assert.deepEqual(paymentsOf(1500), [], 'a stray number is not a list of receipts');
  assert.deepEqual(paymentsOf({ amount: 5 }), []);
  const one = { id: 'a', amount: 5, date: '2026-09-01' };
  assert.deepEqual(paymentsOf([one, null, 'junk']), [one], 'holes are dropped, receipts kept');
});

test('paymentsTotal adds the receipts, and an empty cell is 0 not null', () => {
  const cell = [
    { id: 'a', amount: 500, date: '2026-09-01' },
    { id: 'b', amount: 250.5, date: '2026-09-10' },
  ];
  assert.equal(paymentsTotal(cell), 750.5);
  // Zero, so "Outstanding = Amount - Paid" reads the full amount before the
  // first payment rather than going blank.
  assert.equal(paymentsTotal([]), 0);
  assert.equal(paymentsTotal(undefined), 0);
});

test('paymentsTotal skips an amount that is not a number', () => {
  const cell = [
    { id: 'a', amount: 100 },
    { id: 'b', amount: 'abc' },
    { id: 'c', amount: '50' },
    { id: 'd', amount: Infinity },
    { id: 'e' },
  ];
  assert.equal(paymentsTotal(cell), 150);
});

test('makePayment builds a complete receipt with a server-shaped id', () => {
  const before = Date.now();
  const p = makePayment({ amount: '500', date: '2026-09-01', method: ' Wire ', by: 'u1' });
  assert.match(p.id, /^[0-9a-f]{12}$/);
  assert.equal(p.amount, 500, 'a typed string becomes a number');
  assert.equal(p.date, '2026-09-01');
  assert.equal(p.method, 'Wire');
  assert.equal(p.note, '');
  assert.equal(p.by, 'u1');
  assert.ok(Date.parse(p.at) >= before - 1000, 'at is an ISO timestamp for now');
  assert.notEqual(makePayment({ amount: 1, date: '2026-09-01' }).id, p.id);
  assert.equal(makePayment({ amount: 1, date: '2026-09-01' }).by, null);
});

test('todayKey is the LOCAL day, not the UTC one', () => {
  // 00:30 local on 1 September is still 31 August in UTC anywhere east of
  // Greenwich — the payment arrived on the 1st.
  assert.equal(todayKey(new Date(2026, 8, 1, 0, 30)), '2026-09-01');
  assert.equal(todayKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('addDaysKey moves across month and year ends', () => {
  assert.equal(addDaysKey('2026-09-01', 30), '2026-10-01');
  assert.equal(addDaysKey('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysKey('2026-03-01', -1), '2026-02-28');
  assert.equal(addDaysKey('2028-02-28', 1), '2028-02-29', 'leap day');
  assert.equal(addDaysKey('2026-09-01', 0), '2026-09-01');
});

test('addDaysKey refuses what is not a day key', () => {
  assert.equal(addDaysKey('not a date', 1), null);
  assert.equal(addDaysKey('2026-09-01T00:00:00Z', 1), null);
  assert.equal(addDaysKey(null, 1), null);
});

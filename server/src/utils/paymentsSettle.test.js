/**
 * paymentsSettle.test.js — when payments cover the amount, the row is done.
 *
 * Run from server/:   node --test src/utils/paymentsSettle.test.js
 *
 * Pure: boards and tasks are hand-built in the shapes the controller hands the
 * resolver — a Mongoose Map of cells on a hydrated task, a plain object on a
 * lean one. The end-to-end path (status written, activity logged, audience
 * notified) is pinned in controllers/taskWritePath.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  settledStatusFor,
  touchesSettleColumns,
  settleColumns,
  paymentsTotal,
} = require('./paymentsSettle');

const DRAFT = { _id: 's-draft', key: 'not_started', name: 'Draft' };
const SENT = { _id: 's-sent', key: 'working_on_it', name: 'Sent' };
const PAID = { _id: 's-paid', key: 'done', name: 'Paid' };

const AMOUNT = { _id: 'c-amount', key: 'amount', type: 'number', settings: { format: 'currency', currency: 'CAD' } };
const PAYMENTS = { _id: 'c-pay', key: 'payments', type: 'payments', settings: { format: 'currency' } };

const board = (extra = {}) => ({
  statuses: [DRAFT, SENT, PAID],
  columns: [{ _id: 'c-title', key: 'invoice', type: 'text', isPrimary: true }, AMOUNT, PAYMENTS],
  ...extra,
});

const pay = (amount, id = `p${amount}`) => ({ id, amount, date: '2026-09-01' });

/** A task whose cells are a real Map, the way a hydrated document holds them. */
const task = (amount, payments, status = SENT._id) => ({
  status,
  columnValues: new Map([
    ['c-amount', amount],
    ['c-pay', payments],
  ]),
});

test('payments that exactly cover the amount settle the row', () => {
  assert.equal(settledStatusFor(board(), task(1000, [pay(400), pay(600)])), PAID._id);
});

test('a part-paid row is left alone', () => {
  assert.equal(settledStatusFor(board(), task(1000, [pay(400)])), null);
});

test('overpaying settles it too', () => {
  assert.equal(settledStatusFor(board(), task(1000, [pay(1200)])), PAID._id);
});

test('cents that floating point would lose still settle', () => {
  // 33.37 + 33.37 + 33.36 is 100.09999999999999 in binary floating point.
  assert.equal(
    settledStatusFor(board(), task(100.1, [pay(33.37, 'a'), pay(33.37, 'b'), pay(33.36, 'c')])),
    PAID._id
  );
  assert.equal(settledStatusFor(board(), task(100.1, [pay(100.09)])), null, 'a cent short is short');
});

test('no amount, a zero amount or a non-number never settles', () => {
  assert.equal(settledStatusFor(board(), task(null, [pay(500)])), null);
  assert.equal(settledStatusFor(board(), task(undefined, [pay(500)])), null);
  assert.equal(settledStatusFor(board(), task(0, [pay(500)])), null);
  assert.equal(settledStatusFor(board(), task('abc', [pay(500)])), null);
});

test('no payments recorded never settles', () => {
  assert.equal(settledStatusFor(board(), task(1000, [])), null);
  assert.equal(settledStatusFor(board(), task(1000, undefined)), null);
});

test('a row already done is not settled again', () => {
  assert.equal(settledStatusFor(board(), task(1000, [pay(1000)], PAID._id)), null);
  // A pre-migration row still storing the legacy string.
  assert.equal(settledStatusFor(board(), task(1000, [pay(1000)], 'done')), null);
});

test('a mirror of somebody else\'s money is never the amount', () => {
  const mirrored = {
    _id: 'c-mirror',
    key: 'amount',
    type: 'mirror',
    settings: { format: 'currency', currency: 'CAD' },
  };
  const b = board({ columns: [mirrored, PAYMENTS] });
  const t = { status: SENT._id, columnValues: new Map([['c-mirror', 500], ['c-pay', [pay(500)]]]) };
  assert.equal(settleColumns(b).amount, null);
  assert.equal(settledStatusFor(b, t), null);
});

test('the amount is the column keyed amount, else the first currency number', () => {
  const fee = { _id: 'c-fee', key: 'fee', type: 'number', settings: { format: 'currency' } };
  const hours = { _id: 'c-hours', key: 'hours', type: 'number', settings: {} };
  assert.equal(settleColumns(board({ columns: [fee, AMOUNT, PAYMENTS] })).amount, AMOUNT);
  assert.equal(settleColumns(board({ columns: [hours, fee, PAYMENTS] })).amount, fee);
  // A plain number column is a count, not money.
  assert.equal(settleColumns(board({ columns: [hours, PAYMENTS] })).amount, null);
});

test('a board with no done status, or without both columns, never settles', () => {
  assert.equal(settledStatusFor(board({ statuses: [DRAFT, SENT] }), task(1000, [pay(1000)])), null);
  assert.equal(settledStatusFor(board({ columns: [AMOUNT] }), task(1000, [pay(1000)])), null);
  assert.equal(settledStatusFor(board({ columns: [PAYMENTS] }), task(1000, [pay(1000)])), null);
});

test('receipts in one currency never settle a bill in another', () => {
  /**
   * THE BUG: settling compared raw numbers, so on a board whose Payments were
   * relabelled INR from the Table header, a ₹1,000 receipt (about CA$16)
   * closed a CA$1,000 invoice — and told the client it was paid.
   */
  const inr = { ...PAYMENTS, settings: { format: 'currency', currency: 'INR' } };
  const b = board({ columns: [AMOUNT, inr] });
  const t = { status: SENT._id, columnValues: new Map([['c-amount', 1000], ['c-pay', [pay(1000)]]]) };
  assert.equal(settledStatusFor(b, t), null);

  // The same code on both sides settles as before…
  const cad = { ...PAYMENTS, settings: { format: 'currency', currency: 'cad' } };
  assert.equal(settledStatusFor(board({ columns: [AMOUNT, cad] }), t), PAID._id);
  // …and a payments column naming no code reads in the board's unit.
  assert.equal(settledStatusFor(board({ currency: 'CAD' }), task(1000, [pay(1000)])), PAID._id);
  assert.equal(settledStatusFor(board({ currency: 'INR' }), task(1000, [pay(1000)])), null);
});

test('a lean task with plain-object cells reads the same', () => {
  const lean = { status: SENT._id, columnValues: { 'c-amount': 250, 'c-pay': [pay(250)] } };
  assert.equal(settledStatusFor(board(), lean), PAID._id);
});

test('a malformed receipt is skipped, not fatal', () => {
  assert.equal(paymentsTotal([pay(100), null, { amount: 'x' }, { amount: '50' }]), 150);
  assert.equal(paymentsTotal('nonsense'), 0);
});

test('only a write that moved the amount or the payments may settle', () => {
  const b = board();
  const title = b.columns[0];
  assert.equal(touchesSettleColumns(b, [{ column: PAYMENTS }]), true);
  assert.equal(touchesSettleColumns(b, [{ column: AMOUNT }]), true);
  assert.equal(touchesSettleColumns(b, [{ column: title }]), false);
  assert.equal(touchesSettleColumns(b, []), false);
  assert.equal(touchesSettleColumns(board({ columns: [AMOUNT] }), [{ column: AMOUNT }]), false);
});

import test from 'node:test';
import assert from 'node:assert';

import { computeSummary, groupSummaries, summaryLabel } from './columnSummary.js';
import { columnValue } from './columnValues.js';

/**
 * THE BUG THIS FILE EXISTS FOR.
 *
 * `computeSummary` read `row.columnValues[column.key]`. Values are stored under
 * the column's `_id`. So every total on every template board — the group header
 * AND the table footer — read `undefined` on every row: sums printed ₹0, counts
 * printed 0, and a Billing board with six invoices on it looked like a board
 * nobody had typed anything into yet.
 *
 * Nothing failed. That is the whole problem with it, and why these assertions
 * use REAL numbers rather than checking the function merely returns something.
 */

const RUPEES = { format: 'currency', currency: 'INR', decimals: 0 };

const col = (id, key, extra = {}) => ({
  _id: id,
  key,
  name: key,
  type: 'number',
  settings: { ...RUPEES, summary: 'sum', ...(extra.settings || {}) },
  ...extra,
});

/** A row as the server hands it over after a `.lean()` read: a plain object. */
const row = (values) => ({ columnValues: { ...values } });
/** A row as a hydrated mongoose document hands it over: a real Map. */
const mapRow = (values) => ({ columnValues: new Map(Object.entries(values)) });

const AMOUNT = col('64a000000000000000000001', 'amount');

test('a sum adds up the actual values', () => {
  const rows = [
    row({ '64a000000000000000000001': 125000 }),
    row({ '64a000000000000000000001': 140000 }),
    row({ '64a000000000000000000001': 95000 }),
  ];
  const out = computeSummary(rows, AMOUNT);
  assert.equal(out.value, 360000, 'three invoices should total ₹3,60,000');
  assert.equal(out.count, 3);
});

test('the key is the column _id, never the column key', () => {
  // The exact shape of the shipped bug: values filed under the stable name.
  // These must NOT be found — reading them would mean the accessor is guessing,
  // and a board whose column key collides with another column's id would then
  // total the wrong column.
  const rows = [row({ amount: 125000 }), row({ amount: 140000 })];
  assert.equal(columnValue(rows[0], AMOUNT), undefined);
  assert.equal(computeSummary(rows, AMOUNT).value, 0);
});

test('a Map-shaped row reads exactly like a plain one', () => {
  const plain = [row({ '64a000000000000000000001': 60000 })];
  const mapped = [mapRow({ '64a000000000000000000001': 60000 })];
  assert.deepEqual(computeSummary(plain, AMOUNT), computeSummary(mapped, AMOUNT));
  assert.equal(computeSummary(mapped, AMOUNT).value, 60000);
});

test('empty cells are excluded from a sum, not counted as zero', () => {
  // A budget line with no amount typed is not a line worth ₹0.
  const rows = [
    row({ '64a000000000000000000001': 40000 }),
    row({}),
    row({ '64a000000000000000000001': null }),
  ];
  const out = computeSummary(rows, AMOUNT);
  assert.equal(out.value, 40000);
  assert.equal(out.count, 1, 'only the filled row contributed');
});

test('an average says how many rows it actually averaged', () => {
  const rating = col('64a000000000000000000002', 'rating', {
    type: 'rating',
    settings: { max: 5, summary: 'avg' },
  });
  const rows = [
    row({ '64a000000000000000000002': 4 }),
    row({ '64a000000000000000000002': 3 }),
    row({}),
  ];
  assert.equal(computeSummary(rows, rating).value, 3.5);
  assert.equal(summaryLabel(rows, rating), 'Average of 2');
});

test('empty counts the blanks — the missing-receipt number', () => {
  const receipt = col('64a000000000000000000003', 'receipt', {
    type: 'file',
    settings: { summary: 'empty' },
  });
  const rows = [
    row({ '64a000000000000000000003': [{ url: 'a' }] }),
    row({}),
    row({}),
  ];
  const out = computeSummary(rows, receipt);
  assert.equal(out.value, 2, 'two claims are missing a receipt');
  assert.ok(out.raw, 'a count of rows is not money and must not be formatted as it');
});

test('checked counts the ticked boxes', () => {
  const approved = col('64a000000000000000000004', 'approved', {
    type: 'checkbox',
    settings: { summary: 'checked' },
  });
  const rows = [
    row({ '64a000000000000000000004': true }),
    row({ '64a000000000000000000004': false }),
    row({ '64a000000000000000000004': true }),
  ];
  assert.equal(computeSummary(rows, approved).value, 2);
});

test('an empty group still totals zero, but has no lowest', () => {
  assert.deepEqual(computeSummary([], AMOUNT), { value: 0, count: 0 });
  const lowest = col('64a000000000000000000005', 'amount', {
    settings: { summary: 'min' },
  });
  assert.equal(computeSummary([], lowest), null, 'the smallest of no numbers does not exist');
});

test('groupSummaries formats money as money and counts as counts', () => {
  const board = {
    useFlexibleColumns: true,
    columns: [
      AMOUNT,
      col('64a000000000000000000003', 'receipt', {
        type: 'file',
        settings: { summary: 'empty' },
      }),
    ],
  };
  const rows = [
    row({ '64a000000000000000000001': 125000, '64a000000000000000000003': [{ url: 'a' }] }),
    row({ '64a000000000000000000001': 95000 }),
  ];
  const out = groupSummaries(board, rows);
  assert.equal(out.length, 2);
  assert.match(out[0].display, /2,20,000|220,000/, 'the amount should be a real total');
  assert.equal(out[1].display, '1', 'one missing receipt, not ₹1');
});

test('a board with no flexible columns reports nothing at all', () => {
  // Every board that predates templates. The header slot must render nothing
  // rather than an empty row of labels.
  assert.deepEqual(groupSummaries({ useFlexibleColumns: false, columns: [AMOUNT] }, []), []);
  assert.deepEqual(groupSummaries(null, []), []);
});

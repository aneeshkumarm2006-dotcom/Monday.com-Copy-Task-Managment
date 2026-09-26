import test from 'node:test';
import assert from 'node:assert';

import { computeSummary, groupSummaries, summaryLabel } from './columnSummary.js';
import { columnValue } from './columnValues.js';
import { makeMoneyFormatter } from './money.js';
import { formatColumnValue } from './numberFormat.js';

/**
 * `useMoney()`'s `column`, without React: the same pure core, a reader on "As
 * entered", and a workspace currency of INR — the default every workspace
 * starts on, and the one that used to leak onto plain numbers.
 */
const STUB_FMT = makeMoneyFormatter({ display: null, snapshots: [] });
const STUB_MONEY = {
  column: (value, settings, on = null, fallbackCurrency = null) =>
    formatColumnValue(STUB_FMT, value, settings, { on, fallbackCurrency: fallbackCurrency || 'INR' }),
};

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

test('a plain Sum renders without a currency symbol', () => {
  // The regression: every total went through the money formatter, so a Sum of
  // hours read "₹36.00" in the group header and the footer.
  const hours = {
    _id: '64a000000000000000000006',
    key: 'hours',
    name: 'Hours',
    type: 'number',
    settings: { summary: 'sum' },
  };
  const board = { useFlexibleColumns: true, currency: 'INR', columns: [hours] };
  const rows = [row({ [hours._id]: 12 }), row({ [hours._id]: 24 })];

  const bare = groupSummaries(board, rows);
  assert.equal(bare[0].display, '36');

  // Through a reader's formatter too — the stub stands in for useMoney() and
  // uses the same pure core it does.
  const out = groupSummaries(board, rows, STUB_MONEY);
  assert.equal(out[0].display, '36');
  assert.ok(!/[₹$]/.test(out[0].display), `no symbol expected, got ${out[0].display}`);
});

test('a percent Average renders as a percent', () => {
  const done = {
    _id: '64a000000000000000000007',
    key: 'done',
    name: 'Done',
    type: 'number',
    settings: { format: 'percent', currency: 'INR', summary: 'avg' },
  };
  const board = { useFlexibleColumns: true, columns: [done] };
  const rows = [row({ [done._id]: 80 }), row({ [done._id]: 90 })];
  assert.equal(groupSummaries(board, rows, STUB_MONEY)[0].display, '85%');
});

test('a code-less money column totals in the BOARD currency', () => {
  const amount = {
    _id: '64a000000000000000000008',
    key: 'amount',
    name: 'Amount',
    type: 'number',
    settings: { format: 'currency', summary: 'sum' },
  };
  const board = { useFlexibleColumns: true, currency: 'CAD', columns: [amount] };
  const rows = [row({ [amount._id]: 1000 }), row({ [amount._id]: 234 })];
  assert.equal(groupSummaries(board, rows)[0].display, 'CA$1,234');
  assert.equal(groupSummaries(board, rows, STUB_MONEY)[0].display, 'CA$1,234');
  // An explicit fallback overrides the board's.
  assert.equal(groupSummaries(board, rows, STUB_MONEY, 'USD')[0].display, '$1,234');
});

test('a payments column sums its receipts', () => {
  const paid = {
    _id: '64a000000000000000000009',
    key: 'payments',
    name: 'Payments',
    type: 'payments',
    settings: { format: 'currency', currency: 'CAD', summary: 'sum' },
  };
  const rows = [
    row({ [paid._id]: [{ id: 'a', amount: 500 }, { id: 'b', amount: 250 }] }),
    row({ [paid._id]: [{ id: 'c', amount: 100 }] }),
    row({}),
  ];
  assert.equal(computeSummary(rows, paid).value, 850);
  const board = { useFlexibleColumns: true, columns: [paid] };
  assert.equal(groupSummaries(board, rows, STUB_MONEY)[0].display, 'CA$850');
});

test('a payments list with no receipts counts as empty', () => {
  const paid = {
    _id: '64a000000000000000000010',
    key: 'payments',
    type: 'payments',
    settings: { summary: 'empty' },
  };
  const rows = [row({ [paid._id]: [] }), row({ [paid._id]: [{ id: 'a', amount: 5 }] }), row({})];
  assert.equal(computeSummary(rows, paid).value, 2);
});

test('an unpaid row is blank for average, lowest and highest — but still sums', () => {
  // `numericValue` reads a receipt-less cell as 0 so "Amount − Paid" works on
  // an unpaid invoice. Averaged in, those zeros made "Average paid" over two
  // real receipts and three unpaid invoices read as a fifth of the truth, and
  // "Lowest paid" read ₹0 on any group with a single unpaid row.
  const id = '64a000000000000000000011';
  const paidCol = (summary) => ({
    _id: id,
    key: 'payments',
    type: 'payments',
    settings: { format: 'currency', currency: 'CAD', summary },
  });
  const rows = [
    row({ [id]: [{ id: 'a', amount: 300 }, { id: 'b', amount: 100 }] }),
    row({ [id]: [] }),
    row({ [id]: [{ id: 'c', amount: 200 }] }),
    row({}),
    mapRow({ [id]: [] }),
  ];

  const avg = computeSummary(rows, paidCol('avg'));
  assert.equal(avg.value, 300, '(400 + 200) / 2, not / 5');
  assert.equal(avg.count, 2);
  assert.equal(summaryLabel(rows, paidCol('avg')), 'Average of 2');
  assert.equal(computeSummary(rows, paidCol('min')).value, 200, 'lowest RECEIVED, never ₹0');
  assert.equal(computeSummary(rows, paidCol('max')).value, 400);

  // A sum is untouched — the zeros add nothing, and the unpaid rows still count.
  const sum = computeSummary(rows, paidCol('sum'));
  assert.equal(sum.value, 600);
  assert.equal(sum.count, 5);

  // A group where nobody has paid: no lowest/average to show, a sum of zero.
  const unpaid = [row({ [id]: [] }), row({})];
  assert.equal(computeSummary(unpaid, paidCol('avg')), null);
  assert.equal(computeSummary(unpaid, paidCol('min')), null);
  assert.deepEqual(computeSummary(unpaid, paidCol('sum')), { value: 0, count: 2 });
});

test('a formula Remaining = allocated - spent sums correctly', () => {
  // A formula stores nothing, so summing its stored cells gave ₹0 however
  // much budget was left.
  const allocated = col('64a000000000000000000011', 'allocated');
  const spent = col('64a000000000000000000012', 'spent');
  const remaining = {
    _id: '64a000000000000000000013',
    key: 'remaining',
    name: 'Remaining',
    type: 'formula',
    settings: { expression: 'column.allocated - column.spent', ...RUPEES, summary: 'sum' },
  };
  const columns = [allocated, spent, remaining];
  const rows = [
    row({ [allocated._id]: 50000, [spent._id]: 20000 }),
    row({ [allocated._id]: 30000, [spent._id]: 35000 }),
    row({ [allocated._id]: 10000 }), // nothing spent yet: no Remaining to add
  ];
  assert.equal(computeSummary(rows, remaining, columns).value, 25000);
  assert.equal(computeSummary(rows, remaining, columns).count, 2);

  const board = { useFlexibleColumns: true, columns };
  const out = groupSummaries(board, rows);
  const rem = out.find((s) => s.key === remaining._id);
  assert.equal(rem.display, '₹25,000');
});

test('filled / empty on a formula count whether it computes', () => {
  const a = col('64a000000000000000000014', 'a');
  const f = {
    _id: '64a000000000000000000015',
    key: 'f',
    type: 'formula',
    settings: { expression: 'column.a * 2', summary: 'filled' },
  };
  const rows = [row({ [a._id]: 1 }), row({})];
  assert.equal(computeSummary(rows, f, [a, f]).value, 1);
});

test('a board with no flexible columns reports nothing at all', () => {
  // Every board that predates templates. The header slot must render nothing
  // rather than an empty row of labels.
  assert.deepEqual(groupSummaries({ useFlexibleColumns: false, columns: [AMOUNT] }, []), []);
  assert.deepEqual(groupSummaries(null, []), []);
});

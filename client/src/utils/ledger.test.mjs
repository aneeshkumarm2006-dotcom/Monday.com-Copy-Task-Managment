import test from 'node:test';
import assert from 'node:assert';

import {
  statusOf,
  invoiceState,
  ledgerTotals,
  titleFromFilename,
  ledgerColumns,
  notified,
} from './ledger.js';

/**
 * The two things a billing board must never get wrong: what is overdue, and
 * what the totals add up to. Both are silent when wrong — an invoice that has
 * stopped being chased still renders perfectly.
 */

const AMOUNT = '64c000000000000000000001';
const DUE = '64c000000000000000000002';
const ISSUED = '64c000000000000000000003';
const PDF = '64c000000000000000000004';

const STATUSES = [
  { _id: '64d000000000000000000001', key: 'not_started', name: 'Draft' },
  { _id: '64d000000000000000000002', key: 'working_on_it', name: 'Sent' },
  { _id: '64d000000000000000000003', key: 'done', name: 'Paid' },
  { _id: '64d000000000000000000004', key: 'stuck', name: 'Overdue' },
];

const BOARD = {
  statuses: STATUSES,
  columns: [
    { _id: '64c000000000000000000000', key: 'invoice', type: 'text', isPrimary: true },
    { _id: PDF, key: 'pdf', type: 'file' },
    { _id: AMOUNT, key: 'amount', type: 'number', settings: { format: 'currency', currency: 'INR' } },
    { _id: ISSUED, key: 'issued', type: 'date' },
    { _id: DUE, key: 'due', type: 'date' },
  ],
};

const COLS = ledgerColumns(BOARD);
const NOW = new Date('2026-09-09T12:00:00.000Z').getTime();
const byKey = (k) => STATUSES.find((s) => s.key === k)._id;

const invoice = ({ amount, due, status = 'not_started' }) => ({
  status: byKey(status),
  columnValues: {
    ...(amount != null ? { [AMOUNT]: amount } : {}),
    ...(due ? { [DUE]: due } : {}),
  },
});

test('the due column is found by key, not by being the first date', () => {
  // Billing has TWO date columns. Picking the first one by role would make
  // every invoice overdue the day after it was raised.
  assert.equal(COLS.due._id, DUE);
  assert.notEqual(COLS.due._id, ISSUED);
  assert.equal(COLS.amount._id, AMOUNT);
  assert.equal(COLS.file._id, PDF);
});

test('a paid invoice is never overdue, however late it is', () => {
  // The ordering that matters most. Paid wins over the date, always — an
  // invoice settled a month after it was due is not an outstanding problem.
  const t = invoice({ amount: 60000, due: '2026-08-01', status: 'done' });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'paid');
  assert.equal(state.daysLate, 0);
});

test('overdue is derived from the date, not from the stored status', () => {
  // The row still says "Sent". Nothing has flipped it, and nothing needs to.
  const t = invoice({ amount: 60000, due: '2026-08-01', status: 'working_on_it' });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'overdue');
  assert.equal(state.daysLate, 39, 'due 1 Aug, read on 9 Sep');
});

test('an invoice due later today is not yet late', () => {
  const t = invoice({ amount: 1000, due: '2026-09-30', status: 'working_on_it' });
  assert.equal(invoiceState(t, BOARD, COLS, NOW).key, 'sent');
});

test('an invoice with no due date is never overdue', () => {
  // A draft with nothing filled in must not shout. This is the common state of
  // a row created by dropping a PDF a second ago.
  const t = invoice({ amount: null, due: null, status: 'not_started' });
  assert.equal(invoiceState(t, BOARD, COLS, NOW).key, 'draft');
});

test('a hand-set Overdue status is still honoured', () => {
  const t = invoice({ amount: 5000, due: null, status: 'stuck' });
  assert.equal(invoiceState(t, BOARD, COLS, NOW).key, 'overdue');
});

test('the four figures always reconcile', () => {
  const rows = [
    invoice({ amount: 125000, due: '2026-08-31', status: 'done' }),
    invoice({ amount: 140000, due: '2026-09-03', status: 'done' }),
    invoice({ amount: 95000, due: '2026-09-21', status: 'working_on_it' }),
    invoice({ amount: 60000, due: '2026-08-01', status: 'working_on_it' }),
    invoice({ amount: 60000, due: null, status: 'not_started' }),
  ];
  const t = ledgerTotals(rows, BOARD, COLS, NOW);

  assert.equal(t.billed, 480000, 'every row counts toward billed, drafts included');
  assert.equal(t.paid, 265000);
  assert.equal(
    t.outstanding,
    t.billed - t.paid,
    'outstanding is derived, so the strip can never disagree with itself'
  );
  assert.equal(t.outstanding, 215000);
  assert.equal(t.overdue, 60000, 'only the one past its date and unpaid');
  assert.equal(t.overdueCount, 1);
  assert.equal(t.count, 5);
});

test('overdue is a subset of outstanding, never an extra slice', () => {
  const rows = [invoice({ amount: 60000, due: '2026-08-01', status: 'working_on_it' })];
  const t = ledgerTotals(rows, BOARD, COLS, NOW);
  assert.ok(t.overdue <= t.outstanding, 'overdue money is outstanding money');
});

test('a row with no amount does not break the totals', () => {
  const rows = [invoice({ amount: null, due: null }), invoice({ amount: 1000, due: null })];
  assert.equal(ledgerTotals(rows, BOARD, COLS, NOW).billed, 1000);
  assert.equal(ledgerTotals([], BOARD, COLS, NOW).billed, 0);
});

test('an amount typed as a string still counts', () => {
  const rows = [{ status: byKey('not_started'), columnValues: { [AMOUNT]: '2500' } }];
  assert.equal(ledgerTotals(rows, BOARD, COLS, NOW).billed, 2500);
});

test('a filename becomes a title you could have predicted', () => {
  assert.equal(titleFromFilename('INV-2026-014.pdf'), 'INV-2026-014');
  assert.equal(titleFromFilename('INV-2026-012_Kredoo_final.pdf'), 'INV-2026-012 Kredoo final');
  assert.equal(titleFromFilename('  spaced   out .pdf'), 'spaced out');
  assert.equal(titleFromFilename('/Users/prem/Desktop/INV-9.pdf'), 'INV-9');
  // Only the LAST extension goes — a dotted invoice number survives.
  assert.equal(titleFromFilename('INV.2026.011.pdf'), 'INV.2026.011');
  // A file with no extension keeps its whole name.
  assert.equal(titleFromFilename('scan'), 'scan');
  // Never empty: an untitled row is still clickable, a blank one is not.
  assert.equal(titleFromFilename('.pdf'), 'Untitled');
  assert.equal(titleFromFilename(''), 'Untitled');
  assert.equal(titleFromFilename(null), 'Untitled');
});

test('statusOf reads an id, and tolerates a legacy key string', () => {
  assert.equal(statusOf({ status: byKey('done') }, BOARD).name, 'Paid');
  assert.equal(statusOf({ status: 'done' }, BOARD).name, 'Paid');
  assert.equal(statusOf({ status: null }, BOARD), null);
  assert.equal(statusOf({ status: byKey('done') }, { statuses: [] }), null);
});

test('told and not-told are different states', () => {
  // The distinction the ledger exists to show. An empty list is not "unknown",
  // it is "nobody has been handed this".
  assert.equal(notified({ notifiedUsers: [], notifiedAt: null }).told, false);
  assert.equal(notified({}).told, false);
  const t = notified({ notifiedUsers: [{ _id: 'u1', name: 'Aneesh' }], notifiedAt: '2026-09-04' });
  assert.equal(t.told, true);
  assert.equal(t.people.length, 1);
});

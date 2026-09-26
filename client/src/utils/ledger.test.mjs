import test from 'node:test';
import assert from 'node:assert';

import {
  statusOf,
  invoiceState,
  statePill,
  ledgerTotals,
  titleFromFilename,
  ledgerColumns,
  issuedDayOf,
  amountOf,
  nextInvoiceNumber,
  sortInvoices,
  notified,
  clientOf,
} from './ledger.js';

/**
 * The things a billing board must never get wrong: what is overdue, what has
 * been received, and what the totals add up to. All of them are silent when
 * wrong — an invoice that has stopped being chased still renders perfectly.
 */

const AMOUNT = '64c000000000000000000001';
const DUE = '64c000000000000000000002';
const ISSUED = '64c000000000000000000003';
const PDF = '64c000000000000000000004';
const PAYMENTS = '64c000000000000000000005';
const OWNER = '64c000000000000000000006';

const STATUSES = [
  { _id: '64d000000000000000000001', key: 'not_started', name: 'Draft' },
  { _id: '64d000000000000000000002', key: 'working_on_it', name: 'Sent' },
  { _id: '64d000000000000000000003', key: 'done', name: 'Paid' },
  { _id: '64d000000000000000000004', key: 'stuck', name: 'Overdue' },
];

const BOARD = {
  templateKey: 'billing',
  statuses: STATUSES,
  columns: [
    { _id: '64c000000000000000000000', key: 'invoice', type: 'text', isPrimary: true },
    { _id: PDF, key: 'pdf', type: 'file' },
    { _id: AMOUNT, key: 'amount', type: 'number', settings: { format: 'currency', currency: 'INR' } },
    { _id: PAYMENTS, key: 'payments', type: 'payments', settings: { format: 'currency', currency: 'INR' } },
    { _id: ISSUED, key: 'issued', type: 'date' },
    { _id: DUE, key: 'due', type: 'date' },
    { _id: OWNER, key: 'owner', type: 'person' },
  ],
};

const COLS = ledgerColumns(BOARD);
/**
 * NOON on 9 September, LOCAL time — never a UTC instant.
 *
 * "Today" is the reader's local day (`toDayKey`), so a fixture written as
 * `…T12:00:00Z` is 10 September in Kiribati (UTC+14) and 9 September only by
 * luck elsewhere; the test then asserted 39 days late and got 40. Local noon is
 * the same calendar day in every zone from UTC−12 to UTC+14, which is what makes
 * every "N days late" below mean the same thing wherever the suite runs.
 */
const NOW = new Date(2026, 8, 9, 12, 0, 0).getTime();
const byKey = (k) => STATUSES.find((s) => s.key === k)._id;

/** The LOCAL midnight of a day, serialised the way a date cell stores it. */
const localMidnight = (y, m, d) => new Date(y, m - 1, d).toISOString();
/** NOW's own local day, `offset` days away, as a stored date cell. */
const localDayFromNow = (offset) => {
  const n = new Date(NOW);
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + offset).toISOString();
};

const pay = (amount, date = '2026-09-01') => ({ id: `p${amount}${date}`, amount, date });

const invoice = ({ amount, due, status = 'not_started', payments, issued, name, createdAt }) => ({
  ...(name ? { name } : {}),
  ...(createdAt ? { createdAt } : {}),
  status: byKey(status),
  columnValues: {
    ...(amount != null ? { [AMOUNT]: amount } : {}),
    ...(due ? { [DUE]: due } : {}),
    ...(issued ? { [ISSUED]: issued } : {}),
    ...(payments ? { [PAYMENTS]: payments } : {}),
  },
});

test('the due column is found by key, not by being the first date', () => {
  // Billing has TWO date columns. Picking the first one by role would make
  // every invoice overdue the day after it was raised.
  assert.equal(COLS.due._id, DUE);
  assert.notEqual(COLS.due._id, ISSUED);
  assert.equal(COLS.amount._id, AMOUNT);
  assert.equal(COLS.file._id, PDF);
  assert.equal(COLS.payments._id, PAYMENTS);
  assert.equal(COLS.owner._id, OWNER);
});

test('amount is the `amount` column, never a payments or formula column', () => {
  const board = {
    columns: [
      // Both money, both BEFORE the invoice amount — neither may become it.
      { _id: 'p', key: 'received', type: 'payments', settings: { format: 'currency' } },
      { _id: 'f', key: 'remaining', type: 'formula', settings: { format: 'currency' } },
      { _id: 'x', key: 'fee', type: 'number', settings: { format: 'currency' } },
      { _id: 'a', key: 'amount', type: 'number', settings: { format: 'currency' } },
    ],
  };
  assert.equal(ledgerColumns(board).amount._id, 'a', 'the key wins over column order');
  const noKey = { columns: board.columns.filter((c) => c.key !== 'amount') };
  assert.equal(ledgerColumns(noKey).amount._id, 'x', 'else the first NUMBER money column');
});

test('the due column follows the role, so a renamed or re-keyed one still counts', () => {
  const board = {
    templateKey: null,
    columns: [
      { _id: 'i', key: 'issued', type: 'date' },
      { _id: 'd', key: 'payBy', type: 'date', settings: { role: 'dueDate' } },
    ],
  };
  assert.equal(ledgerColumns(board).due._id, 'd');
});

test('a paid invoice is never overdue, however late it is', () => {
  // The ordering that matters most. Paid wins over the date, always — an
  // invoice settled a month after it was due is not an outstanding problem.
  const t = invoice({ amount: 60000, due: '2026-08-01', status: 'done' });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'paid');
  assert.equal(state.daysLate, 0);
  assert.equal(state.label, 'Paid');
});

test('overdue is derived from the date, not from the stored status', () => {
  // The row still says "Sent". Nothing has flipped it, and nothing needs to.
  const t = invoice({ amount: 60000, due: '2026-08-01', status: 'working_on_it' });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'overdue');
  assert.equal(state.daysLate, 39, 'due 1 Aug, read on 9 Sep');
  assert.equal(statePill(state), '39 days late');
});

test('a due date stored the way a date cell stores it counts the same in every zone', () => {
  // The real shape: LOCAL midnight of the picked day, serialised as UTC. Read
  // back in local parts it is 1 August wherever the suite runs.
  const t = invoice({ amount: 60000, due: localMidnight(2026, 8, 1), status: 'working_on_it' });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'overdue');
  assert.equal(state.daysLate, 39);
});

test('an invoice due later today is not yet late', () => {
  // The cell holds TODAY's local midnight, which is already in the past as an
  // instant. Compared as days, it is due today — not overdue.
  const t = invoice({ amount: 1000, due: localDayFromNow(0), status: 'working_on_it' });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'sent');
  assert.equal(state.daysUntilDue, 0);
  assert.equal(statePill(state), 'Due today');
});

test('an invoice due yesterday is exactly one day late', () => {
  const t = invoice({ amount: 1000, due: localDayFromNow(-1), status: 'working_on_it' });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'overdue');
  assert.equal(state.daysLate, 1);
  assert.equal(statePill(state), '1 day late');
});

test('days late count calendar days across a daylight-saving change', () => {
  const prev = process.env.TZ;
  process.env.TZ = 'America/Toronto';
  try {
    // DST began on 8 March 2026 in Toronto: that "day" is 23 hours long.
    const now = new Date(2026, 2, 9, 12, 0).getTime();
    const t = invoice({ amount: 1000, due: localMidnight(2026, 3, 7), status: 'working_on_it' });
    assert.equal(invoiceState(t, BOARD, COLS, now).daysLate, 2);
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test('an invoice with no due date is never overdue', () => {
  // A draft with nothing filled in must not shout. This is the common state of
  // a row created by dropping a PDF a second ago.
  const t = invoice({ amount: null, due: null, status: 'not_started' });
  assert.equal(invoiceState(t, BOARD, COLS, NOW).key, 'draft');
});

test('a draft past its due date is not overdue, and not outstanding', () => {
  // Nobody was sent it, so nobody is late paying it.
  const t = invoice({ amount: 5000, due: '2026-08-01', status: 'not_started' });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'draft');
  assert.equal(state.pastDue, true);
  assert.equal(state.daysLate, 0);
  assert.equal(statePill(state), 'Not sent · due date passed');

  const totals = ledgerTotals([t], BOARD, COLS, { now: NOW });
  assert.equal(totals.overdue, 0);
  assert.equal(totals.overdueCount, 0);
  assert.equal(totals.outstanding, 0);
  assert.equal(totals.billed, 0);
  assert.deepEqual(totals.drafts, { count: 1, amount: 5000 });
});

test('a hand-set Overdue status is still honoured', () => {
  const t = invoice({ amount: 5000, due: null, status: 'stuck' });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'overdue');
  assert.equal(state.label, 'Overdue');
  assert.equal(statePill(state), 'Overdue');
});

test('a part-paid invoice before its due date is partial', () => {
  const t = invoice({
    amount: 100000,
    due: '2026-09-30',
    status: 'working_on_it',
    payments: [pay(30000)],
  });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'partial');
  assert.equal(state.label, 'Part-paid');
  assert.equal(state.received, 30000);
  assert.equal(state.balance, 70000);

  const totals = ledgerTotals([t], BOARD, COLS, { now: NOW });
  assert.equal(totals.billed, 100000);
  assert.equal(totals.received, 30000);
  assert.equal(totals.outstanding, 70000);
  assert.equal(totals.partialCount, 1);
  assert.equal(totals.overdue, 0);
});

test('a part-paid invoice past its due date is overdue for its BALANCE', () => {
  const t = invoice({
    amount: 100000,
    due: '2026-08-31',
    status: 'working_on_it',
    payments: [pay(30000), pay(10000, '2026-09-05')],
  });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'overdue');
  assert.equal(state.received, 40000);
  assert.equal(state.balance, 60000);

  const totals = ledgerTotals([t], BOARD, COLS, { now: NOW });
  assert.equal(totals.overdue, 60000, 'only what is still owed is overdue');
  assert.equal(totals.outstanding, 60000);
});

test('receipts that cover the amount make an invoice paid, whatever its status', () => {
  const t = invoice({ amount: 1000, status: 'working_on_it', payments: [pay(600), pay(400)] });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'paid');
  assert.equal(state.label, 'Paid', "the board's own name for its done status");
  assert.equal(state.balance, 0);
});

test('an overpayment is reported, and never counted as income', () => {
  const t = invoice({ amount: 1000, status: 'working_on_it', payments: [pay(1200)] });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'paid');
  assert.equal(state.overpaid, 200);
  assert.equal(state.balance, 0);

  const totals = ledgerTotals([t], BOARD, COLS, { now: NOW });
  assert.equal(totals.received, 1000, 'capped at the invoice amount');
  assert.equal(totals.overpaid, 200);
  assert.equal(totals.outstanding, 0);
});

test('marked Paid with part of it recorded counts as fully received', () => {
  const t = invoice({ amount: 1000, status: 'done', payments: [pay(400)] });
  const state = invoiceState(t, BOARD, COLS, NOW);
  assert.equal(state.key, 'paid');
  assert.equal(state.markedPaid, true);
  assert.equal(state.recorded, 400);
  assert.equal(state.received, 1000);
  assert.equal(state.balance, 0);
  assert.equal(ledgerTotals([t], BOARD, COLS, { now: NOW }).received, 1000);
});

test('a draft with money against it is no longer a draft', () => {
  // Money came in, so it was sent — whatever the status still says.
  const t = invoice({ amount: 1000, status: 'not_started', payments: [pay(250)] });
  assert.equal(invoiceState(t, BOARD, COLS, NOW).key, 'partial');
});

test('the figures always reconcile: billed = received + outstanding', () => {
  const rows = [
    invoice({ amount: 125000, due: '2026-08-31', status: 'done' }),
    invoice({ amount: 140000, due: '2026-09-03', status: 'done' }),
    invoice({ amount: 95000, due: '2026-09-21', status: 'working_on_it' }),
    invoice({ amount: 60000, due: '2026-08-01', status: 'working_on_it' }),
    invoice({ amount: 50000, due: '2026-08-15', status: 'working_on_it', payments: [pay(20000)] }),
    invoice({ amount: 30000, due: '2026-10-15', status: 'working_on_it', payments: [pay(5000)] }),
    invoice({ amount: 60000, due: null, status: 'not_started' }),
  ];
  const t = ledgerTotals(rows, BOARD, COLS, NOW);

  assert.equal(t.billed, 500000, 'drafts are not billed');
  assert.equal(t.received, 290000);
  assert.equal(t.paid, t.received, '`paid` stays as an alias');
  assert.equal(t.outstanding, t.billed - t.received, 'derived, so it cannot disagree');
  assert.equal(t.outstanding, 210000);
  assert.equal(t.overdue, 90000, '60,000 unpaid + the 30,000 balance of a part-paid one');
  assert.equal(t.overdueCount, 2);
  assert.equal(t.partialCount, 1);
  assert.deepEqual(t.drafts, { count: 1, amount: 60000 });
  assert.equal(t.count, 7);
});

test('converted totals still reconcile, row by row', () => {
  const rows = [
    invoice({ amount: 1000, status: 'working_on_it', payments: [pay(300)] }),
    invoice({ amount: 2000, status: 'done' }),
    invoice({ amount: 700, due: '2026-08-01', status: 'working_on_it' }),
  ];
  // A different "rate" per row, as dated rates would give.
  const rates = [0.011, 0.012, 0.013];
  const convert = (n, task) => n * rates[rows.indexOf(task)];
  const t = ledgerTotals(rows, BOARD, COLS, { now: NOW, convert });
  assert.ok(Math.abs(t.billed - (1000 * 0.011 + 2000 * 0.012 + 700 * 0.013)) < 1e-9);
  assert.ok(Math.abs(t.received - (300 * 0.011 + 2000 * 0.012)) < 1e-9);
  assert.ok(Math.abs(t.billed - t.received - t.outstanding) < 1e-9);
  assert.ok(t.overdue <= t.outstanding + 1e-9);
});

test('overdue is a subset of outstanding, never an extra slice', () => {
  const rows = [invoice({ amount: 60000, due: '2026-08-01', status: 'working_on_it' })];
  const t = ledgerTotals(rows, BOARD, COLS, NOW);
  assert.ok(t.overdue <= t.outstanding, 'overdue money is outstanding money');
});

test('a row with no amount does not break the totals', () => {
  const rows = [
    invoice({ amount: null, due: null, status: 'working_on_it' }),
    invoice({ amount: 1000, due: null, status: 'working_on_it' }),
  ];
  assert.equal(ledgerTotals(rows, BOARD, COLS, NOW).billed, 1000);
  assert.equal(ledgerTotals([], BOARD, COLS, NOW).billed, 0);
});

test('money in against an invoice with NO amount reaches Received, and Outstanding stays put', () => {
  /**
   * A dropped PDF has no amount until somebody types one, and the client's
   * transfer can be recorded first. Capping it at the (zero) amount made it
   * vanish from the strip while the sheet said "Received 500".
   */
  const unpriced = invoice({ amount: null, status: 'working_on_it', payments: [pay(500)] });
  const state = invoiceState(unpriced, BOARD, COLS, NOW);
  assert.equal(state.received, 500, 'the sheet already said so');
  assert.equal(state.overpaid, 0, 'nothing to be over');

  const alone = ledgerTotals([unpriced], BOARD, COLS, { now: NOW });
  assert.equal(alone.received, 500, 'counted, not capped away');
  assert.equal(alone.billed, 500, 'billed at what came in — the least it can have been for');
  assert.equal(alone.outstanding, 0, 'never negative');
  assert.deepEqual(alone.noAmount, { count: 1, received: 500 });

  // Beside a priced invoice the identity still holds, and the priced one is
  // untouched by the rule.
  const priced = invoice({ amount: 1000, status: 'working_on_it', payments: [pay(300)] });
  const both = ledgerTotals([unpriced, priced], BOARD, COLS, { now: NOW });
  assert.equal(both.billed, 1500);
  assert.equal(both.received, 800);
  assert.equal(both.outstanding, 700, 'only the priced invoice is owed anything');
  assert.equal(both.billed - both.received, both.outstanding);
  assert.deepEqual(both.noAmount, { count: 1, received: 500 });
});

test('an invoice with no amount and nothing received is counted as unpriced, for nothing', () => {
  const t = invoice({ amount: null, status: 'working_on_it' });
  const totals = ledgerTotals([t], BOARD, COLS, { now: NOW });
  assert.equal(totals.billed, 0);
  assert.equal(totals.received, 0);
  assert.deepEqual(totals.noAmount, { count: 1, received: 0 });
  // A draft is a draft, not an unpriced invoice.
  const draft = ledgerTotals([invoice({ amount: null })], BOARD, COLS, { now: NOW });
  assert.deepEqual(draft.noAmount, { count: 0, received: 0 });
  assert.equal(draft.drafts.count, 1);
});

test('an unpriced invoice marked Paid counts its receipts once, converted by its own rate', () => {
  const t = invoice({ amount: null, status: 'done', payments: [pay(400)] });
  assert.equal(invoiceState(t, BOARD, COLS, NOW).key, 'paid');
  const totals = ledgerTotals([t], BOARD, COLS, { now: NOW, convert: (n) => n / 100 });
  assert.equal(totals.received, 4);
  assert.equal(totals.billed, 4);
  assert.equal(totals.outstanding, 0);
  assert.deepEqual(totals.noAmount, { count: 1, received: 4 });
});

test('a credit note (negative amount) is a real figure, not an unpriced invoice', () => {
  const t = invoice({ amount: -500, status: 'working_on_it' });
  const totals = ledgerTotals([t], BOARD, COLS, { now: NOW });
  assert.equal(totals.billed, -500);
  assert.equal(totals.noAmount.count, 0);
});

test('an amount typed as a string still counts', () => {
  const rows = [{ status: byKey('working_on_it'), columnValues: { [AMOUNT]: '2500' } }];
  assert.equal(ledgerTotals(rows, BOARD, COLS, NOW).billed, 2500);
  assert.equal(amountOf(rows[0], COLS), 2500);
  assert.equal(amountOf({ columnValues: { [AMOUNT]: '' } }, COLS), 0);
});

test('the issued day is the LOCAL day somebody picked, not the UTC one', () => {
  const prev = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata';
  try {
    // Picked 1 March in India; stored as 28 Feb 18:30Z. Slicing that string
    // dated the invoice in February and gave it February's exchange rate.
    const stored = localMidnight(2026, 3, 1);
    assert.equal(stored.slice(0, 10), '2026-02-28', 'the trap this test is about');
    const t = invoice({ amount: 1000, issued: stored });
    assert.equal(issuedDayOf(t, COLS), '2026-03-01');
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
  assert.equal(issuedDayOf(invoice({ amount: 1 }), COLS), null);
  assert.equal(issuedDayOf({ columnValues: { [ISSUED]: '2026-05-04' } }, COLS), '2026-05-04');
});

test('the next invoice number continues the newest series', () => {
  assert.equal(
    nextInvoiceNumber([{ name: 'INV-2026-003' }, { name: 'INV-2026-012' }, { name: 'INV-2026-007' }]),
    'INV-2026-013',
    'largest in the series, prefix and padding kept'
  );
  assert.equal(
    nextInvoiceNumber([{ name: 'INV-2026-012 Kredoo final' }]),
    'INV-2026-013',
    "a dropped file's title is read by its first word"
  );
  assert.equal(
    nextInvoiceNumber([
      { name: 'INV-2026-044', createdAt: '2026-12-20T10:00:00Z' },
      { name: 'INV-2027-001', createdAt: '2027-01-02T10:00:00Z' },
      { name: 'INV-2026-045', createdAt: '2026-12-28T10:00:00Z' },
    ]),
    'INV-2027-002',
    'the most recently created series wins, so a new year is followed'
  );
  assert.equal(nextInvoiceNumber([{ name: 'INV-099' }]), 'INV-100');
  assert.equal(nextInvoiceNumber([{ name: 'Retainer' }, { name: '' }]), 'INV-001');
  assert.equal(nextInvoiceNumber([]), 'INV-001');
  assert.equal(nextInvoiceNumber(null), 'INV-001');
});

test('invoices sort by due, issued, balance and lateness — stably', () => {
  const a = { ...invoice({ amount: 100, due: '2026-09-20', issued: '2026-09-01', status: 'working_on_it' }), _id: 'a' };
  const b = { ...invoice({ amount: 900, due: '2026-08-01', issued: '2026-07-01', status: 'working_on_it' }), _id: 'b' };
  const c = { ...invoice({ amount: 500, due: null, issued: null, status: 'working_on_it' }), _id: 'c' };
  const d = { ...invoice({ amount: 300, due: '2026-08-20', issued: '2026-08-01', status: 'working_on_it' }), _id: 'd' };
  const e = { ...invoice({ amount: 800, due: '2026-09-15', issued: '2026-08-15', status: 'done' }), _id: 'e' };
  const rows = [a, b, c, d, e];
  const ids = (list) => list.map((t) => t._id).join('');

  assert.equal(ids(sortInvoices(rows, 'board', BOARD, COLS, NOW)), 'abcde');
  assert.equal(ids(sortInvoices(rows, 'due', BOARD, COLS, NOW)), 'bdeac', 'soonest first, no due last');
  assert.equal(ids(sortInvoices(rows, 'issued', BOARD, COLS, NOW)), 'aedbc', 'newest first, none last');
  assert.equal(ids(sortInvoices(rows, 'balance', BOARD, COLS, NOW)), 'bcdae', 'paid has no balance');
  assert.equal(ids(sortInvoices(rows, 'overdue', BOARD, COLS, NOW)), 'bdeac', 'most days late first');
  assert.equal(ids(rows), 'abcde', 'never mutates its input');
  assert.equal(ids(sortInvoices(rows, 'nonsense', BOARD, COLS, NOW)), 'abcde');
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

/* ---------------------------------------------------------------- client */

const CLIENT = '64c000000000000000000007';
const LINK = '64c000000000000000000008';
const CLIENT_BOARD = '64e000000000000000000001';

test('the client column is the `client` type, whatever its position', () => {
  const board = {
    columns: [
      { _id: LINK, key: 'project', type: 'connect_boards' },
      { _id: CLIENT, key: 'billTo', type: 'client' },
    ],
  };
  assert.equal(ledgerColumns(board).client._id, CLIENT, 'a client column beats an earlier connect column');
});

test('a board older than the client type falls back to its first connect column', () => {
  const board = { columns: [{ _id: LINK, key: 'client', type: 'connect_boards' }] };
  assert.equal(ledgerColumns(board).client._id, LINK);
  assert.equal(ledgerColumns({ columns: [{ _id: 'x', key: 'client', type: 'text' }] }).client, null,
    'found by type, never by key');
  assert.equal(ledgerColumns(null).client, null);
});

test('clientOf reads a client cell as { boardId, name }', () => {
  const cols = ledgerColumns({ columns: [{ _id: CLIENT, key: 'client', type: 'client' }] });
  const row = (value) => ({ columnValues: { [CLIENT]: value } });

  assert.deepEqual(clientOf(row({ boardId: CLIENT_BOARD, name: 'Kredoo' }), cols), {
    boardId: CLIENT_BOARD,
    name: 'Kredoo',
  });
  // A name typed by hand: a client with no portal board.
  assert.deepEqual(clientOf(row({ boardId: null, name: '  Acme Ltd ' }), cols), { boardId: null, name: 'Acme Ltd' });
  // A linked board whose name snapshot has not landed yet is still a client.
  assert.deepEqual(clientOf(row({ boardId: CLIENT_BOARD, name: '' }), cols), { boardId: CLIENT_BOARD, name: '' });
  // A populated id and a bare string are read, not rejected.
  assert.deepEqual(clientOf(row({ boardId: { _id: CLIENT_BOARD }, name: 'Kredoo' }), cols), {
    boardId: CLIENT_BOARD,
    name: 'Kredoo',
  });
  assert.deepEqual(clientOf(row('Walk-in'), cols), { boardId: null, name: 'Walk-in' });
});

test('clientOf is null for nothing — never an empty client', () => {
  const cols = ledgerColumns({ columns: [{ _id: CLIENT, key: 'client', type: 'client' }] });
  const row = (value) => ({ columnValues: { [CLIENT]: value } });
  for (const value of [undefined, null, '', '   ', { boardId: null, name: '' }, { boardId: '', name: '  ' }, [], 42]) {
    assert.equal(clientOf(row(value), cols), null, `for ${JSON.stringify(value)}`);
  }
  assert.equal(clientOf({}, cols), null);
  assert.equal(clientOf(row({ boardId: CLIENT_BOARD, name: 'X' }), {}), null, 'no client column');
});

test('clientOf never reads a legacy connect column as a client', () => {
  // Its value is a list of linked ROWS, not a client — the view renders it.
  const cols = ledgerColumns({ columns: [{ _id: LINK, key: 'client', type: 'connect_boards' }] });
  const t = { columnValues: { [LINK]: { links: [{ taskId: 't1', boardId: CLIENT_BOARD }] } } };
  assert.equal(clientOf(t, cols), null);
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

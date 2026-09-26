import test from 'node:test';
import assert from 'node:assert';

import {
  buildLedgerCsv,
  ledgerCsvFilename,
  LEDGER_CSV_HEADERS,
  LEDGER_PERIODS,
  LEDGER_QUICK_FILTERS,
  inLedgerPeriod,
  isPartPaid,
  periodBounds,
} from './ledgerExport.js';
import { invoiceState, ledgerColumns } from './ledger.js';

/**
 * The Ledger's spreadsheet is reconciled against a bank statement by somebody
 * who never saw the screen it came from. Everything here is silent when wrong:
 * a grouped number that lands in Excel as text, a date a day early, a draft's
 * blank amount exported as a 0 that sums.
 *
 * Every date is built as a LOCAL midnight and NOW is LOCAL noon, so the suite
 * reads the same in Kolkata, Toronto and UTC+14.
 */

const AMOUNT = '64c000000000000000000001';
const DUE = '64c000000000000000000002';
const ISSUED = '64c000000000000000000003';
const PDF = '64c000000000000000000004';
const PAYMENTS = '64c000000000000000000005';
const CLIENT = '64c000000000000000000007';
const CLIENT_BOARD = '65a000000000000000000001';

const STATUSES = [
  { _id: '64d000000000000000000001', key: 'not_started', name: 'Draft' },
  { _id: '64d000000000000000000002', key: 'working_on_it', name: 'Sent' },
  { _id: '64d000000000000000000003', key: 'done', name: 'Paid' },
  { _id: '64d000000000000000000004', key: 'stuck', name: 'Overdue' },
];

const columns = (amountSettings = { format: 'currency', currency: 'CAD' }) => [
  { _id: '64c000000000000000000000', key: 'invoice', type: 'text', isPrimary: true },
  { _id: PDF, key: 'pdf', type: 'file' },
  { _id: CLIENT, key: 'client', type: 'client' },
  { _id: AMOUNT, key: 'amount', type: 'number', settings: amountSettings },
  { _id: PAYMENTS, key: 'payments', type: 'payments', settings: { format: 'currency' } },
  { _id: ISSUED, key: 'issued', type: 'date' },
  { _id: DUE, key: 'due', type: 'date' },
];

const BOARD = { name: 'Billing & Invoices', statuses: STATUSES, columns: columns() };
const COLS = ledgerColumns(BOARD);

/** Local noon on 9 Sep 2026 — the middle of the reader's own day. */
const NOW = new Date(2026, 8, 9, 12, 0, 0).getTime();
/** The LOCAL midnight of a day, serialised the way a date cell stores it. */
const localMidnight = (y, m, d) => new Date(y, m - 1, d).toISOString();
const statusId = (key) => STATUSES.find((s) => s.key === key)._id;

const invoice = ({ name, amount, issued, due, status = 'working_on_it', payments, client } = {}) => ({
  _id: `t-${name}`,
  name,
  status: status ? statusId(status) : null,
  columnValues: {
    ...(amount !== undefined ? { [AMOUNT]: amount } : {}),
    ...(issued ? { [ISSUED]: issued } : {}),
    ...(due ? { [DUE]: due } : {}),
    ...(payments ? { [PAYMENTS]: payments } : {}),
    ...(client !== undefined ? { [CLIENT]: client } : {}),
  },
});

/** The CSV as rows of raw fields — good enough for fixtures with no embedded line breaks. */
const parse = (csv) => {
  assert.ok(csv.startsWith('﻿'), 'the file starts with a BOM');
  assert.ok(csv.endsWith('\r\n'), 'the file ends with CRLF');
  return csv
    .slice(1)
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) => {
      const out = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quoted) {
          if (ch === '"' && line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else if (ch === '"') quoted = false;
          else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      out.push(cur);
      return out;
    });
};

const rowOf = (csv, index = 1) => {
  const rows = parse(csv);
  return Object.fromEntries(LEDGER_CSV_HEADERS.map((h, i) => [h, rows[index][i]]));
};

test('the header names the nine columns, in order', () => {
  const [header] = parse(buildLedgerCsv([], BOARD, COLS, { now: NOW }));
  assert.deepStrictEqual(header, [
    'Invoice',
    'Client',
    'Issued',
    'Due',
    'Amount',
    'Received',
    'Balance',
    'Status',
    'Currency',
  ]);
});

test('a part-paid invoice: bare numbers, local day keys, the derived status', () => {
  const csv = buildLedgerCsv(
    [
      invoice({
        name: 'INV-2026-013',
        amount: 180000.5,
        issued: localMidnight(2026, 9, 1),
        due: localMidnight(2026, 10, 1),
        payments: [{ id: 'p1', amount: 40000, date: '2026-09-05' }],
        client: { boardId: null, name: 'Kredoo' },
      }),
    ],
    BOARD,
    COLS,
    { now: NOW }
  );
  assert.deepStrictEqual(rowOf(csv), {
    Invoice: 'INV-2026-013',
    Client: 'Kredoo',
    // The LOCAL day picked, never the UTC slice of local midnight.
    Issued: '2026-09-01',
    Due: '2026-10-01',
    // Never "1,80,000.50" — a quoted, grouped figure lands in Excel as text.
    Amount: '180000.5',
    Received: '40000',
    Balance: '140000.5',
    Status: 'Part-paid',
    Currency: 'CAD',
  });
});

test('an invoice past its due date exports as overdue, with only its balance owed', () => {
  const row = rowOf(
    buildLedgerCsv(
      [
        invoice({
          name: 'INV-7',
          amount: 1000,
          due: localMidnight(2026, 9, 1),
          payments: [{ id: 'p', amount: 250, date: '2026-08-20' }],
        }),
      ],
      BOARD,
      COLS,
      { now: NOW }
    )
  );
  assert.strictEqual(row.Status, 'Overdue');
  assert.strictEqual(row.Received, '250');
  assert.strictEqual(row.Balance, '750');
  assert.strictEqual(row.Issued, '');
});

test('marked Paid with no receipts counts as fully received', () => {
  const row = rowOf(
    buildLedgerCsv([invoice({ name: 'INV-8', amount: 500, status: 'done' })], BOARD, COLS, { now: NOW })
  );
  assert.strictEqual(row.Status, 'Paid');
  assert.strictEqual(row.Received, '500');
  assert.strictEqual(row.Balance, '0');
});

test('an unpriced draft leaves the money cells EMPTY, not 0', () => {
  const row = rowOf(
    buildLedgerCsv([invoice({ name: 'scan.pdf', status: 'not_started' })], BOARD, COLS, { now: NOW })
  );
  assert.strictEqual(row.Amount, '');
  assert.strictEqual(row.Received, '');
  assert.strictEqual(row.Balance, '');
  assert.strictEqual(row.Status, 'Draft');
  assert.strictEqual(row.Currency, 'CAD');
});

test('receipts on an unpriced row still say what came in', () => {
  const row = rowOf(
    buildLedgerCsv(
      [invoice({ name: 'INV-9', payments: [{ id: 'p', amount: 75.25, date: '2026-09-02' }] })],
      BOARD,
      COLS,
      { now: NOW }
    )
  );
  assert.strictEqual(row.Amount, '');
  assert.strictEqual(row.Received, '75.25');
});

test('amounts are rounded to the cent, never grouped', () => {
  const row = rowOf(
    buildLedgerCsv([invoice({ name: 'INV-10', amount: 1234.5678 })], BOARD, COLS, { now: NOW })
  );
  assert.strictEqual(row.Amount, '1234.57');
});

test('RFC 4180: commas, quotes and line breaks are quoted and doubled', () => {
  const csv = buildLedgerCsv(
    [invoice({ name: 'INV "12", final', amount: 10, client: { boardId: null, name: 'Acme,\nInc' } })],
    BOARD,
    COLS,
    { now: NOW }
  );
  assert.ok(csv.includes('"INV ""12"", final"'));
  assert.ok(csv.includes('"Acme,\nInc"'));
});

test('a text cell that looks like a formula is defused; a negative amount stays a number', () => {
  const row = rowOf(
    buildLedgerCsv(
      [invoice({ name: '=HYPERLINK("x")', amount: -50, client: { boardId: null, name: '@evil' } })],
      BOARD,
      COLS,
      { now: NOW }
    )
  );
  assert.strictEqual(row.Invoice, `'=HYPERLINK("x")`);
  assert.strictEqual(row.Client, `'@evil`);
  assert.strictEqual(row.Amount, '-50');
});

test('a client board is named by the resolver the view passes, else by the snapshot', () => {
  const task = invoice({ name: 'INV-11', amount: 1, client: { boardId: CLIENT_BOARD, name: 'Old name' } });
  const snapshot = rowOf(buildLedgerCsv([task], BOARD, COLS, { now: NOW }));
  assert.strictEqual(snapshot.Client, 'Old name');

  const live = rowOf(
    buildLedgerCsv([task], BOARD, COLS, {
      now: NOW,
      clientName: (c) => (c.boardId === CLIENT_BOARD ? 'Kredoo Pvt Ltd' : c.name),
    })
  );
  assert.strictEqual(live.Client, 'Kredoo Pvt Ltd');
});

test('a legacy connect_boards client column exports no client rather than a list of ids', () => {
  const board = {
    ...BOARD,
    columns: BOARD.columns.map((c) => (c._id === CLIENT ? { ...c, type: 'connect_boards' } : c)),
  };
  const cols = ledgerColumns(board);
  const task = invoice({ name: 'INV-12', amount: 1, client: { links: ['65b000000000000000000001'] } });
  assert.strictEqual(rowOf(buildLedgerCsv([task], board, cols, { now: NOW })).Client, '');
});

test('the Currency column: the caller\'s code (canonical), else the Amount column\'s, else the board\'s', () => {
  const task = invoice({ name: 'INV-13', amount: 1 });
  assert.strictEqual(rowOf(buildLedgerCsv([task], BOARD, COLS, { now: NOW, currency: 'inr ' })).Currency, 'INR');
  assert.strictEqual(rowOf(buildLedgerCsv([task], BOARD, COLS, { now: NOW })).Currency, 'CAD');

  const uncoded = { ...BOARD, currency: 'AUD', columns: columns({ format: 'currency' }) };
  assert.strictEqual(
    rowOf(buildLedgerCsv([task], uncoded, ledgerColumns(uncoded), { now: NOW })).Currency,
    'AUD'
  );
});

test('cols are derived when the caller does not pass them', () => {
  const task = invoice({ name: 'INV-14', amount: 42 });
  assert.strictEqual(rowOf(buildLedgerCsv([task], BOARD, null, { now: NOW })).Amount, '42');
});

test('rows keep the order they were given in', () => {
  const rows = parse(
    buildLedgerCsv(
      [invoice({ name: 'B', amount: 1 }), invoice({ name: 'A', amount: 2 }), invoice({ name: 'C', amount: 3 })],
      BOARD,
      COLS,
      { now: NOW }
    )
  );
  assert.deepStrictEqual(
    rows.slice(1).map((r) => r[0]),
    ['B', 'A', 'C']
  );
});

test('no invoices is one explanatory row that still carries the currency', () => {
  const rows = parse(buildLedgerCsv([], BOARD, COLS, { now: NOW }));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1][0], 'No invoices.');
  assert.strictEqual(rows[1][8], 'CAD');
});

test('the filename names the board, the period and the day', () => {
  assert.strictEqual(
    ledgerCsvFilename(BOARD, { period: 'this_quarter', now: NOW }),
    'billing-invoices-ledger-this-quarter-2026-09-09.csv'
  );
  assert.strictEqual(ledgerCsvFilename({ name: 'Q3 fees' }, { now: NOW }), 'q3-fees-ledger-2026-09-09.csv');
  assert.strictEqual(ledgerCsvFilename(null, { period: 'nonsense', now: NOW }), 'billing-ledger-2026-09-09.csv');
});

// ---- periods -----------------------------------------------------------------

test('the period list is the five the select offers, All time first', () => {
  assert.deepStrictEqual(
    LEDGER_PERIODS.map((p) => p.value),
    ['all', 'this_month', 'last_month', 'this_quarter', 'this_year']
  );
});

test('period bounds count from the local day key', () => {
  assert.deepStrictEqual(periodBounds('this_month', '2026-09-09'), { from: '2026-09-01', to: '2026-09-31' });
  assert.deepStrictEqual(periodBounds('last_month', '2026-09-09'), { from: '2026-08-01', to: '2026-08-31' });
  // January's last month is the previous December.
  assert.deepStrictEqual(periodBounds('last_month', '2027-01-15'), { from: '2026-12-01', to: '2026-12-31' });
  assert.deepStrictEqual(periodBounds('this_quarter', '2026-09-09'), { from: '2026-07-01', to: '2026-09-31' });
  assert.deepStrictEqual(periodBounds('this_quarter', '2026-01-01'), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepStrictEqual(periodBounds('this_year', '2026-09-09'), { from: '2026-01-01', to: '2026-12-31' });
  assert.strictEqual(periodBounds('all', '2026-09-09'), null);
  assert.strictEqual(periodBounds('this_month', 'not a day'), null);
});

test('an invoice is in a period by its issued day; an undated one only in All time', () => {
  const today = '2026-09-09';
  assert.strictEqual(inLedgerPeriod('2026-09-30', 'this_month', today), true);
  assert.strictEqual(inLedgerPeriod('2026-08-31', 'this_month', today), false);
  assert.strictEqual(inLedgerPeriod('2026-08-31', 'last_month', today), true);
  assert.strictEqual(inLedgerPeriod('2026-07-01', 'this_quarter', today), true);
  assert.strictEqual(inLedgerPeriod('2026-06-30', 'this_quarter', today), false);
  assert.strictEqual(inLedgerPeriod('2025-12-31', 'this_year', today), false);
  assert.strictEqual(inLedgerPeriod(null, 'this_year', today), false);
  assert.strictEqual(inLedgerPeriod(null, 'all', today), true);
  assert.strictEqual(inLedgerPeriod('2020-01-01', 'all', today), true);
});

// ---- quick chips ---------------------------------------------------------------

test('part-paid includes a part-paid invoice that has gone overdue', () => {
  const late = invoiceState(
    invoice({ name: 'x', amount: 100, due: localMidnight(2026, 9, 1), payments: [{ id: 'p', amount: 40, date: '2026-08-01' }] }),
    BOARD,
    COLS,
    NOW
  );
  assert.strictEqual(late.key, 'overdue');
  assert.strictEqual(isPartPaid(late), true);

  const settled = invoiceState(
    invoice({ name: 'y', amount: 100, payments: [{ id: 'p', amount: 100, date: '2026-08-01' }] }),
    BOARD,
    COLS,
    NOW
  );
  assert.strictEqual(isPartPaid(settled), false);
});

test('the chips split the ledger the way the strip does: drafts are never "unpaid"', () => {
  const test_ = (value, state) => LEDGER_QUICK_FILTERS.find((f) => f.value === value).test(state);
  const draft = invoiceState(invoice({ name: 'd', amount: 10, status: 'not_started' }), BOARD, COLS, NOW);
  const sent = invoiceState(invoice({ name: 's', amount: 10 }), BOARD, COLS, NOW);
  const paid = invoiceState(invoice({ name: 'p', amount: 10, status: 'done' }), BOARD, COLS, NOW);

  assert.strictEqual(test_('unpaid', draft), false);
  assert.strictEqual(test_('drafts', draft), true);
  assert.strictEqual(test_('unpaid', sent), true);
  assert.strictEqual(test_('unpaid', paid), false);
  assert.strictEqual(test_('paid', paid), true);
  assert.strictEqual(test_('all', draft), true);
  assert.deepStrictEqual(
    LEDGER_QUICK_FILTERS.map((f) => f.value),
    ['all', 'unpaid', 'overdue', 'partial', 'paid', 'drafts']
  );
});

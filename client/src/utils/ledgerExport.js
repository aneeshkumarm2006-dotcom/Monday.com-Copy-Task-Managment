import { saveBlob } from './fileUrl.js';
import { columnValue } from './columnValues.js';
import { boardCurrencyOf, canonicalCurrency } from './money.js';
import { todayKey } from './payments.js';
import {
  clientOf,
  dueDayOf,
  invoiceState,
  issuedDayOf,
  ledgerColumns,
} from './ledger.js';

/**
 * THE LEDGER AS A SPREADSHEET — and the one definition of "the invoices shown".
 *
 * The Ledger's Export button hands an accountant the invoices on screen, and a
 * file like that is reconciled against a bank statement long after the screen
 * that made it is closed. So this file follows `adsBudgetExport.js`'s rules
 * rather than inventing its own:
 *
 *   THE BOM IS NOT DECORATION. Without it Excel on Windows opens the file as
 *   cp1252 and mangles every non-ASCII client name.
 *
 *   NUMBERS ARE BARE. `1,234.50` has to be quoted under RFC 4180 and lands in
 *   Excel as TEXT, and a ledger whose Amount column cannot be summed is useless
 *   for the thing people export it to do. No symbol either: the Currency
 *   column says which unit, once per row, so the sheet survives being filtered.
 *
 *   AS ENTERED, NEVER CONVERTED. The screen may be showing dollars converted at
 *   each invoice's issue-date rate; the file carries the amounts as they were
 *   typed, in the board's own currency. Figures converted at one afternoon's
 *   rates, in a file that does not say which afternoon, are a liability.
 *
 *   DATES ARE LOCAL DAY KEYS (YYYY-MM-DD). A date cell stores the local
 *   midnight of the day somebody picked, as UTC; slicing that string dates an
 *   Indian invoice a day early. `issuedDayOf` / `dueDayOf` read the LOCAL day —
 *   the one the person picked — and ISO order is what a spreadsheet sorts.
 *
 * ---- Why the view's filters live here too ------------------------------------
 *
 * The button exports exactly what the Ledger is showing — the period, the quick
 * chip, the client. If the view defined "Overdue" or "This quarter" in its own
 * component and the file named its period from a second list, the two would
 * agree the day they were written and drift the first time either changed. So
 * the period vocabulary and the chip predicates are defined ONCE, below, as pure
 * functions the view filters with and the export names itself after — and,
 * being pure, they are tested with the CSV (`ledgerExport.test.mjs`).
 */

// ---------------------------------------------------------------------------
// What "the invoices shown" means
// ---------------------------------------------------------------------------

/** The issued-period choices, in the order the Ledger's select lists them. */
export const LEDGER_PERIODS = [
  { value: 'all', label: 'All time' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'this_year', label: 'This year' },
];

/**
 * The inclusive `{ from, to }` day keys `period` covers, counted from `today`
 * (a LOCAL 'YYYY-MM-DD'), or null for "All time" and anything unrecognised.
 *
 * `to` is always day 31 of the last month, whatever that month's length: day
 * keys compare as strings, and no real day in a month sorts after "-31". That
 * is simpler, and harder to get wrong, than asking a Date how long February is.
 */
export const periodBounds = (period, today) => {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(typeof today === 'string' ? today : '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const ym = (y, mo) => `${y}-${String(mo).padStart(2, '0')}`;
  const span = (y, fromMonth, toMonth) => ({ from: `${ym(y, fromMonth)}-01`, to: `${ym(y, toMonth)}-31` });

  switch (period) {
    case 'this_month':
      return span(year, month, month);
    case 'last_month':
      return month === 1 ? span(year - 1, 12, 12) : span(year, month - 1, month - 1);
    case 'this_quarter': {
      const first = Math.floor((month - 1) / 3) * 3 + 1;
      return span(year, first, first + 2);
    }
    case 'this_year':
      return span(year, 1, 12);
    default:
      return null;
  }
};

/**
 * Was an invoice issued on `dayKey` inside `period`?
 *
 * "All time" includes everything, an invoice with no issue date too. Any real
 * period EXCLUDES an undated invoice rather than guessing a month for it —
 * the view says how many it left out, so nothing vanishes without a word.
 */
export const inLedgerPeriod = (dayKey, period, today) => {
  if (!period || period === 'all') return true;
  const bounds = periodBounds(period, today);
  if (!bounds) return true;
  if (typeof dayKey !== 'string' || !dayKey) return false;
  return dayKey >= bounds.from && dayKey <= bounds.to;
};

/**
 * Money has come in, and some is still owed.
 *
 * Wider than `invoiceState`'s `partial` key on purpose: a part-paid invoice
 * whose due date has passed is keyed `overdue`, and it is still part-paid —
 * somebody filtering for "who has paid us something" expects to see it.
 */
export const isPartPaid = (state) =>
  !!state && state.key !== 'paid' && state.received > 0 && state.balance > 0;

/**
 * The Ledger's quick chips, in order, each with the test that decides whether
 * an invoice's state (`invoiceState`) belongs under it.
 *
 * "Unpaid" is what has been SENT and not settled — drafts are nobody's debt yet
 * and have their own chip, the same split the strip makes.
 */
export const LEDGER_QUICK_FILTERS = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'unpaid', label: 'Unpaid', test: (s) => !!s && s.key !== 'paid' && s.key !== 'draft' },
  { value: 'overdue', label: 'Overdue', test: (s) => !!s && s.key === 'overdue' },
  { value: 'partial', label: 'Part-paid', test: isPartPaid },
  { value: 'paid', label: 'Paid', test: (s) => !!s && s.key === 'paid' },
  { value: 'drafts', label: 'Drafts', test: (s) => !!s && s.key === 'draft' },
];

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Filename-safe slug — the same rule `adsBudgetExport.js` names its files by. */
const slug = (name) =>
  String(name || 'board')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'board';

/** A money figure as a spreadsheet wants it: bare, to the cent, or empty. */
const plain = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '';

/**
 * RFC 4180 field escaping: quote anything holding a comma, a quote or a line
 * break, and double any embedded quote. Invoice titles come from filenames and
 * client names are typed by hand — both really can contain all three.
 */
const csvField = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * A TEXT cell that a spreadsheet will not run.
 *
 * A cell starting with `=`, `+`, `-` or `@` is a formula to Excel and Sheets,
 * and both of this file's text sources are typed by people — an invoice named
 * after an uploaded file, a client name typed into the picker. A leading
 * apostrophe is the standard defuse: the cell displays as typed and never
 * evaluates. Numbers are never passed through here, so a credit note's
 * negative amount stays a number.
 */
const safeText = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

const BOM = '﻿';

export const LEDGER_CSV_HEADERS = [
  'Invoice',
  'Client',
  'Issued',
  'Due',
  'Amount',
  'Received',
  'Balance',
  'Status',
  'Currency',
];

/**
 * The invoices as CSV text, one row each, in the order given — the view passes
 * them already filtered and sorted, so the file reads like the screen.
 *
 *   tasks    the invoice rows
 *   board    their board (statuses, columns, currency)
 *   cols     `ledgerColumns(board)`; derived when omitted
 *   options
 *     currency    the unit the amounts are IN — the Amount column's own code,
 *                 else the board's. Defaults to exactly that resolution.
 *     now         the instant "overdue" is judged at (default: now)
 *     clientName  `(client) => string` — lets the view name a client board by
 *                 its CURRENT name; defaults to the cell's own snapshot
 *
 * Amount, Received and Balance are blank, not 0, on an invoice nobody has
 * priced yet: an empty cell in a sheet means "not set", which is what it is,
 * and a 0 would sum as if somebody had billed nothing.
 */
export const buildLedgerCsv = (tasks, board, cols = null, options = {}) => {
  const c = cols || ledgerColumns(board);
  const { currency = null, now = Date.now(), clientName = null } = options || {};
  const unit =
    canonicalCurrency(currency) ||
    canonicalCurrency(c.amount?.settings?.currency) ||
    boardCurrencyOf(board) ||
    '';

  const lines = [LEDGER_CSV_HEADERS.map(csvField).join(',')];
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [];

  if (list.length === 0) {
    // One row rather than a header stranded above nothing, so the file still
    // opens as a single table. "No invoices" is a finding.
    const blank = LEDGER_CSV_HEADERS.map(() => '');
    blank[0] = 'No invoices.';
    blank[LEDGER_CSV_HEADERS.length - 1] = unit;
    lines.push(blank.map(csvField).join(','));
    return `${BOM}${lines.join('\r\n')}\r\n`;
  }

  for (const task of list) {
    const state = invoiceState(task, board, c, now);
    const raw = c.amount ? columnValue(task, c.amount) : null;
    const priced = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw));
    const client = clientOf(task, c);
    const named = client ? (typeof clientName === 'function' ? clientName(client) : client.name) : '';

    const cells = [
      safeText(task.name || ''),
      safeText(named || ''),
      issuedDayOf(task, c) || '',
      dueDayOf(task, c) || '',
      priced ? plain(state.amount) : '',
      priced || state.recorded > 0 ? plain(state.received) : '',
      priced ? plain(state.balance) : '',
      safeText(state.label || ''),
      unit,
    ];
    lines.push(cells.map(csvField).join(','));
  }

  // Written as an escape rather than the literal character, which is invisible
  // in a diff and gets deleted by the next person tidying the file.
  return `${BOM}${lines.join('\r\n')}\r\n`;
};

/**
 * "billing-ledger-this-quarter-2026-09-25.csv" — the board, the period when
 * one is chosen, and the day it was taken, so two exports never overwrite each
 * other in a Downloads folder and each still says what it holds.
 */
export const ledgerCsvFilename = (board, { period = 'all', now = Date.now() } = {}) => {
  const day = todayKey(new Date(now));
  const scope = period && period !== 'all' && LEDGER_PERIODS.some((p) => p.value === period)
    ? `-${slug(period)}`
    : '';
  return `${slug(board?.name || 'billing')}-ledger${scope}-${day}.csv`;
};

/** Build the CSV and hand it to the browser as a download. Returns the filename. */
export const downloadLedgerCsv = (tasks, board, cols = null, options = {}) => {
  const csv = buildLedgerCsv(tasks, board, cols, options);
  const name = ledgerCsvFilename(board, options || {});
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  saveBlob(blob, name);
  return name;
};

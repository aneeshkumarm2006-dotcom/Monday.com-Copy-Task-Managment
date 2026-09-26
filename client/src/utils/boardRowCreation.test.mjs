import test from 'node:test';
import assert from 'node:assert';

import {
  DEFAULT_NET_DAYS,
  addedRowsMessage,
  currentMonthGroupNames,
  isAllowedBoardUpload,
  isLedgerBoard,
  newRowGroupFor,
  newRowPlan,
  refusedUploadsMessage,
  splitBoardUploads,
  uploadedRowCells,
} from './boardRowCreation.js';

/**
 * The rules behind every new row on a flexible board: which group it lands in,
 * what it is called, and which cells it is born with. Each one is silent when
 * wrong — an invoice filed under January, or born without an issued date, looks
 * perfectly fine until somebody filters by month and it is not there.
 */

const PRIMARY = '64c000000000000000000000';
const AMOUNT = '64c000000000000000000001';
const DUE = '64c000000000000000000002';
const ISSUED = '64c000000000000000000003';
const PDF = '64c000000000000000000004';
const OWNER = '64c000000000000000000006';
const ME = '65a000000000000000000001';

const BILLING = {
  _id: '64b000000000000000000001',
  templateKey: 'billing',
  useFlexibleColumns: true,
  columns: [
    { _id: PRIMARY, key: 'invoice', type: 'text', isPrimary: true },
    { _id: PDF, key: 'pdf', type: 'file' },
    { _id: AMOUNT, key: 'amount', type: 'number', settings: { format: 'currency', currency: 'CAD' } },
    { _id: ISSUED, key: 'issued', type: 'date' },
    { _id: DUE, key: 'due', type: 'date' },
    { _id: OWNER, key: 'owner', type: 'person' },
  ],
};

const PIPELINE = {
  _id: '64b000000000000000000002',
  templateKey: 'pipeline',
  useFlexibleColumns: true,
  columns: [
    { _id: PRIMARY, key: 'deal', type: 'text', isPrimary: true },
    { _id: OWNER, key: 'owner', type: 'person', settings: { role: 'assignee' } },
    { _id: DUE, key: 'close', type: 'date' },
  ],
};

/** Local noon on 9 September 2026 — the same calendar day in every timezone. */
const NOW = new Date(2026, 8, 9, 12);

/** The ISO a date cell stores for a picked day: that day's LOCAL midnight. */
const localMidnight = (y, m, d) => new Date(y, m - 1, d).toISOString();

// ---- isLedgerBoard -----------------------------------------------------------

test('a board that offers the Ledger view and has an amount keeps a ledger', () => {
  assert.equal(isLedgerBoard(BILLING), true);
});

test('without an amount column it is a list of documents, not a ledger', () => {
  const noAmount = { ...BILLING, columns: BILLING.columns.filter((c) => c._id !== AMOUNT) };
  assert.equal(isLedgerBoard(noAmount), false);
});

test('a board that does not offer the Ledger view is not one, whatever it holds', () => {
  const plain = { ...BILLING, templateKey: null };
  assert.equal(isLedgerBoard(plain), false);
  assert.equal(isLedgerBoard(PIPELINE), false);
  assert.equal(isLedgerBoard(null), false);
});

// ---- newRowGroupFor ----------------------------------------------------------

test('a group named after the current month wins over the first group', () => {
  const groups = [{ _id: 'a', name: 'August' }, { _id: 'b', name: 'September' }, { _id: 'c', name: 'October' }];
  assert.equal(newRowGroupFor(groups, NOW)._id, 'b');
});

test('month names are matched in the shapes people actually type', () => {
  for (const name of ['september', 'SEPTEMBER 2026', 'Sep 2026', 'Sept', 'Sep-26', '2026-09', '09/2026']) {
    const groups = [{ _id: 'first', name: 'Invoices' }, { _id: 'month', name }];
    assert.equal(newRowGroupFor(groups, NOW)._id, 'month', `"${name}" should count as September`);
  }
});

test("another year's month is still this month's group only when the year is left off", () => {
  const groups = [{ _id: 'first', name: 'Invoices' }, { _id: 'old', name: 'September 2025' }];
  assert.equal(newRowGroupFor(groups, NOW)._id, 'first');
});

test('with no month-named group the first group in board order is used', () => {
  const groups = [{ _id: 'x', name: 'Invoices' }, { _id: 'y', name: 'Archive' }];
  assert.equal(newRowGroupFor(groups, NOW)._id, 'x');
});

test('no groups means nowhere to put a row', () => {
  assert.equal(newRowGroupFor([], NOW), null);
  assert.equal(newRowGroupFor(null, NOW), null);
});

test('the month names cover the long, short and numeric forms', () => {
  const names = currentMonthGroupNames(NOW);
  for (const n of ['september', 'sep', 'september 2026', 'sep 26', '2026 09', '09 2026']) {
    assert.ok(names.has(n), `missing ${n}`);
  }
});

// ---- newRowPlan ----------------------------------------------------------------

test('a new invoice is numbered after the board, issued today, due in 30 days, owned by its maker', () => {
  const tasks = [{ name: 'INV-2026-011' }, { name: 'INV-2026-012' }];
  const plan = newRowPlan(BILLING, { tasks, meId: ME, now: NOW });
  assert.equal(plan.ledger, true);
  assert.equal(plan.name, 'INV-2026-013');
  assert.equal(plan.columnValues[ISSUED], localMidnight(2026, 9, 9));
  assert.equal(DEFAULT_NET_DAYS, 30);
  assert.equal(plan.columnValues[DUE], localMidnight(2026, 10, 9));
  assert.deepEqual(plan.columnValues[OWNER], [ME]);
});

test('due = issued + 30 crosses a month end on the calendar, not in hours', () => {
  const plan = newRowPlan(BILLING, { tasks: [], meId: ME, now: new Date(2026, 0, 31, 12) });
  assert.equal(plan.columnValues[ISSUED], localMidnight(2026, 1, 31));
  assert.equal(plan.columnValues[DUE], localMidnight(2026, 3, 2));
});

test('the first invoice on an empty board is INV-001', () => {
  assert.equal(newRowPlan(BILLING, { tasks: [], now: NOW }).name, 'INV-001');
});

test('no signed-in id means no owner cell rather than an empty one', () => {
  const plan = newRowPlan(BILLING, { tasks: [], meId: null, now: NOW });
  assert.equal(OWNER in plan.columnValues, false);
});

test('another flexible board gets its own noun and an owner, but no invoice dates', () => {
  const plan = newRowPlan(PIPELINE, { tasks: [{ name: 'INV-001' }], meId: ME, now: NOW });
  assert.equal(plan.ledger, false);
  assert.equal(plan.name, 'New deal');
  assert.deepEqual(plan.columnValues, { [OWNER]: [ME] });
});

test('a board with no assignee column is created with no cells at all', () => {
  const bare = { templateKey: null, useFlexibleColumns: true, columns: [{ _id: PRIMARY, key: 'name', type: 'text', isPrimary: true }] };
  const plan = newRowPlan(bare, { meId: ME, now: NOW });
  assert.equal(plan.name, 'New item');
  assert.deepEqual(plan.columnValues, {});
});

// ---- uploadedRowCells -------------------------------------------------------------

test('a dropped file is born holding the document and issued today', () => {
  const stored = { url: 'https://example.test/a.pdf', name: 'a.pdf', publicId: 'macan/board-files/x/a' };
  const cells = uploadedRowCells(BILLING, stored, NOW);
  assert.deepEqual(cells[PDF], [stored]);
  assert.equal(cells[ISSUED], localMidnight(2026, 9, 9));
  assert.equal(Object.keys(cells).length, 2);
});

test('without an issued column the file is the only cell', () => {
  const noIssued = { ...BILLING, columns: BILLING.columns.filter((c) => c._id !== ISSUED) };
  const cells = uploadedRowCells(noIssued, { url: 'https://example.test/a.pdf' }, NOW);
  assert.deepEqual(Object.keys(cells), [PDF]);
});

test('a board with no file column gets no cells, so the caller can refuse the drop', () => {
  const noFile = { ...BILLING, columns: BILLING.columns.filter((c) => c._id !== PDF) };
  assert.deepEqual(uploadedRowCells(noFile, { url: 'https://example.test/a.pdf' }, NOW), {});
});

// ---- the upload allowlist ------------------------------------------------------------

test('PDFs, images and office files are accepted; archives and executables are not', () => {
  const ok = [
    { name: 'a.pdf', type: 'application/pdf' },
    { name: 'scan.heic', type: 'image/heic' },
    { name: 'b.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { name: 'c.xls', type: 'application/vnd.ms-excel' },
    { name: 'd.csv', type: 'text/csv' },
    { name: 'e.txt', type: 'text/plain; charset=utf-8' },
  ];
  for (const f of ok) assert.equal(isAllowedBoardUpload(f), true, f.name);
  for (const f of [
    { name: 'x.zip', type: 'application/zip' },
    { name: 'x.exe', type: 'application/x-msdownload' },
    { name: 'x.html', type: 'text/html' },
  ]) {
    assert.equal(isAllowedBoardUpload(f), false, f.name);
  }
});

test('an unnamed type falls back to the extension, as the server does', () => {
  assert.equal(isAllowedBoardUpload({ name: 'export.CSV', type: '' }), true);
  assert.equal(isAllowedBoardUpload({ name: 'invoice.pdf', type: 'application/octet-stream' }), true);
  assert.equal(isAllowedBoardUpload({ name: 'bundle.zip', type: 'application/octet-stream' }), false);
  assert.equal(isAllowedBoardUpload({ name: 'noextension', type: '' }), false);
});

test('a drop is split into what the board takes and what it refuses, in order', () => {
  const files = [
    { name: '1.pdf', type: 'application/pdf' },
    { name: '2.zip', type: 'application/zip' },
    { name: '3.png', type: 'image/png' },
  ];
  const { allowed, refused } = splitBoardUploads(files);
  assert.deepEqual(allowed.map((f) => f.name), ['1.pdf', '3.png']);
  assert.deepEqual(refused.map((f) => f.name), ['2.zip']);
});

test('the refusal names one file, or counts several', () => {
  assert.equal(refusedUploadsMessage([]), null);
  assert.match(refusedUploadsMessage([{ name: 'x.zip' }]), /^“x\.zip” wasn't added\./);
  assert.match(refusedUploadsMessage([{ name: 'a' }, { name: 'b' }]), /^2 files weren't added\./);
});

// ---- the batch summary ---------------------------------------------------------------

test('a batch ends in ONE sentence, in the board’s own noun', () => {
  assert.equal(addedRowsMessage(BILLING, 3), '3 invoices added — add their amounts.');
  assert.equal(addedRowsMessage(BILLING, 1), '1 invoice added — add its amount.');
  assert.equal(
    addedRowsMessage(BILLING, 2, 1),
    '2 invoices added — add their amounts. 1 upload failed — retry from its card.'
  );
  assert.equal(addedRowsMessage(BILLING, 0, 2), null);
});

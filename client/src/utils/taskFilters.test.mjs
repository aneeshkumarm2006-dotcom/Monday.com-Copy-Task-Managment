import test from 'node:test';
import assert from 'node:assert';

import taskMatchesFilters, {
  filterFieldsOf,
  taskDueValue,
  taskOwnerIds,
  ownerOptionsFor,
} from './taskFilters.js';
import { invoiceState, ledgerColumns } from './ledger.js';

/**
 * The board filter bar on a flexible board.
 *
 * A Billing board keeps its due date and owner in COLUMNS (`due`, `owner`),
 * not in `task.dueDate` / `task.assignedTo`. The filter read the legacy fields,
 * so "Overdue" matched nothing, "No due date" matched everything, and the Owner
 * list offered only "Unassigned". These pin the column-aware reads, the ledger's
 * Overdue rule, and — just as important — that a legacy board is untouched.
 */

const PRIMARY = '64c000000000000000000000';
const AMOUNT = '64c000000000000000000001';
const DUE = '64c000000000000000000002';
const ISSUED = '64c000000000000000000003';
const OWNER = '64c000000000000000000005';

const PRIYA = '65a000000000000000000001';
const ARJUN = '65a000000000000000000002';

const STATUSES = [
  { _id: '64d000000000000000000001', key: 'not_started', name: 'Draft', isDefault: true },
  { _id: '64d000000000000000000002', key: 'working_on_it', name: 'Sent' },
  { _id: '64d000000000000000000003', key: 'done', name: 'Paid' },
  { _id: '64d000000000000000000004', key: 'stuck', name: 'Overdue' },
];
const statusId = (k) => STATUSES.find((s) => s.key === k)._id;

// A billing board made BEFORE columns carried `settings.role` — the role comes
// from the template table, which is the case every existing board is in.
const BILLING = {
  templateKey: 'billing',
  useFlexibleColumns: true,
  statuses: STATUSES,
  columns: [
    { _id: PRIMARY, key: 'invoice', type: 'text', isPrimary: true },
    { _id: AMOUNT, key: 'amount', type: 'number', settings: { format: 'currency', currency: 'CAD' } },
    { _id: ISSUED, key: 'issued', type: 'date' },
    { _id: DUE, key: 'due', type: 'date' },
    { _id: OWNER, key: 'owner', type: 'person' },
  ],
};

// A plain board with no columns. Filters must read the legacy fields exactly
// as they always did.
const LEGACY = { statuses: STATUSES, labels: [] };

// Local-day instants, like DateCell writes, so no test depends on the TZ.
const NOW = new Date(2026, 8, 9, 12, 0, 0);
const day = (y, m, d) => new Date(y, m - 1, d).toISOString();

const invoice = ({ due, owner, status = 'working_on_it', amount = 1000, legacy = {} } = {}) => ({
  _id: Math.random().toString(16).slice(2),
  name: 'INV',
  status: statusId(status),
  columnValues: {
    [AMOUNT]: amount,
    ...(due !== undefined ? { [DUE]: due } : {}),
    ...(owner !== undefined ? { [OWNER]: owner } : {}),
  },
  ...legacy,
});

const matches = (task, filters, board = BILLING) =>
  taskMatchesFilters(task, filters, NOW, board);

/* ---------------------------------------------------------------- fields */

test('a flexible board resolves its due / owner columns by role', () => {
  const f = filterFieldsOf(BILLING);
  assert.equal(f.due?._id, DUE, 'the due column, not the issued one');
  assert.equal(f.owner?._id, OWNER);
  assert.ok(f.ledger, 'amount + due = a ledger');
  assert.equal(f.ledger.due._id, DUE);
});

test('a legacy board has no filter columns at all', () => {
  const f = filterFieldsOf(LEGACY);
  assert.deepEqual([f.due, f.owner, f.ledger], [null, null, null]);
  // Even if a stray columns array is present, the flag decides.
  const f2 = filterFieldsOf({ ...LEGACY, columns: BILLING.columns });
  assert.deepEqual([f2.due, f2.owner, f2.ledger], [null, null, null]);
});

test('a column that states its own role is found without any template', () => {
  const board = {
    useFlexibleColumns: true,
    statuses: STATUSES,
    columns: [
      { _id: PRIMARY, key: 'deal', type: 'text', isPrimary: true },
      { _id: DUE, key: 'shipBy', type: 'date', settings: { role: 'dueDate' } },
      { _id: OWNER, key: 'rep', type: 'person', settings: { role: 'assignee' } },
    ],
  };
  const f = filterFieldsOf(board);
  assert.equal(f.due?._id, DUE);
  assert.equal(f.owner?._id, OWNER);
  assert.equal(f.ledger, null, 'no amount column, so no ledger');
});

/* -------------------------------------------------------------- due date */

test('the due value is the due-role cell, falling back to task.dueDate', () => {
  const inCell = invoice({ due: day(2026, 9, 20), legacy: { dueDate: day(2026, 1, 1) } });
  assert.equal(taskDueValue(inCell, BILLING), day(2026, 9, 20), 'the cell wins');

  const noCell = invoice({ legacy: { dueDate: day(2026, 9, 12) } });
  assert.equal(taskDueValue(noCell, BILLING), day(2026, 9, 12), 'an unwritten cell falls back');

  // On a legacy board the columnValues are not consulted at all.
  assert.equal(taskDueValue(inCell, LEGACY), day(2026, 1, 1));
});

test('"No due date" and "Due this week" read the due column', () => {
  const dueSoon = invoice({ due: day(2026, 9, 12) });
  const noDue = invoice({});

  assert.equal(matches(dueSoon, { due: ['none'] }), false, 'a filled Due cell has a due date');
  assert.equal(matches(noDue, { due: ['none'] }), true);

  assert.equal(matches(dueSoon, { due: ['week'] }), true);
  assert.equal(matches(noDue, { due: ['week'] }), false);
});

test('on a ledger, "Overdue" is exactly the tile stamp', () => {
  const cols = ledgerColumns(BILLING);
  const rows = [
    invoice({ due: day(2026, 8, 1), status: 'working_on_it' }), // sent, 39 days late
    invoice({ due: day(2026, 8, 1), status: 'done' }), // paid late — never overdue
    invoice({ due: day(2026, 8, 1), status: 'not_started' }), // a draft past its date
    invoice({ status: 'stuck' }), // hand-set Overdue, no date
    invoice({ due: day(2026, 9, 30), status: 'working_on_it' }), // not due yet
    invoice({ status: 'working_on_it' }), // no date at all
  ];
  for (const row of rows) {
    const stamp = invoiceState(row, BILLING, cols, NOW.getTime()).key === 'overdue';
    assert.equal(
      matches(row, { due: ['overdue'] }),
      stamp,
      `filter and stamp disagree for status ${row.status} due ${row.columnValues[DUE]}`,
    );
  }
  // And the cases that do not depend on how drafts are treated:
  assert.equal(matches(rows[0], { due: ['overdue'] }), true, 'a late Sent invoice is overdue');
  assert.equal(matches(rows[1], { due: ['overdue'] }), false, 'a paid invoice never is');
  assert.equal(matches(rows[4], { due: ['overdue'] }), false);
});

test('overdue still ORs with the other buckets', () => {
  const late = invoice({ due: day(2026, 8, 1) });
  const soon = invoice({ due: day(2026, 9, 12) });
  const filters = { due: ['overdue', 'week'] };
  assert.equal(matches(late, filters), true);
  assert.equal(matches(soon, filters), true);
  assert.equal(matches(invoice({}), filters), false);
});

test('a legacy board keeps the plain date rule for Overdue', () => {
  const late = { status: statusId('working_on_it'), dueDate: day(2026, 8, 1) };
  const lateDone = { status: statusId('done'), dueDate: day(2026, 8, 1) };
  assert.equal(matches(late, { due: ['overdue'] }, LEGACY), true);
  assert.equal(matches(lateDone, { due: ['overdue'] }, LEGACY), false);
  assert.equal(matches({ status: statusId('stuck') }, { due: ['overdue'] }, LEGACY), false,
    'without a ledger, a status alone does not make a row overdue');
});

/* ------------------------------------------- status: the Overdue status */

test('on a ledger, the Overdue STATUS also matches invoices the stamp calls overdue', () => {
  // Overdue is never stored on an invoice: a late Sent invoice still says Sent.
  // Picking "Overdue" in the status filter used to find only the rows somebody
  // had flipped by hand.
  const overdue = { statuses: [statusId('stuck')] };
  const lateSent = invoice({ due: day(2026, 8, 1), status: 'working_on_it' });
  const handSet = invoice({ status: 'stuck' });
  const notYet = invoice({ due: day(2026, 9, 30), status: 'working_on_it' });
  const paidLate = invoice({ due: day(2026, 8, 1), status: 'done' });
  const lateDraft = invoice({ due: day(2026, 8, 1), status: 'not_started' });

  assert.equal(matches(lateSent, overdue), true, 'derived overdue matches');
  assert.equal(matches(handSet, overdue), true, 'the stored status still matches on its own');
  assert.equal(matches(notYet, overdue), false);
  assert.equal(matches(paidLate, overdue), false, 'paid is never overdue');
  assert.equal(matches(lateDraft, overdue), false, 'a draft was never sent, so it is not late');
});

test('the Overdue status filter agrees with the tile stamp row for row', () => {
  const cols = ledgerColumns(BILLING);
  const rows = [
    invoice({ due: day(2026, 8, 1), status: 'working_on_it' }),
    invoice({ due: day(2026, 8, 1), status: 'done' }),
    invoice({ due: day(2026, 8, 1), status: 'not_started' }),
    invoice({ due: day(2026, 9, 8), status: 'working_on_it' }), // one day late
    invoice({ due: day(2026, 9, 9), status: 'working_on_it' }), // due today
    invoice({ status: 'working_on_it' }),
  ];
  for (const row of rows) {
    const stamp = invoiceState(row, BILLING, cols, NOW.getTime()).key === 'overdue';
    assert.equal(matches(row, { statuses: [statusId('stuck')] }), stamp, `status ${row.status} due ${row.columnValues[DUE]}`);
  }
});

test('the Overdue status ORs with the other selected statuses', () => {
  const filters = { statuses: [statusId('stuck'), statusId('done')] };
  assert.equal(matches(invoice({ due: day(2026, 8, 1), status: 'working_on_it' }), filters), true);
  assert.equal(matches(invoice({ status: 'done' }), filters), true);
  assert.equal(matches(invoice({ due: day(2026, 9, 30), status: 'working_on_it' }), filters), false);
  // Picking only Sent does not drag late invoices in or out: they ARE Sent.
  const sent = { statuses: [statusId('working_on_it')] };
  assert.equal(matches(invoice({ due: day(2026, 8, 1), status: 'working_on_it' }), sent), true);
  assert.equal(matches(invoice({ due: day(2026, 8, 1), status: 'done' }), sent), false);
});

test('the Overdue status may be selected by its key, as legacy rows carry it', () => {
  assert.equal(matches(invoice({ due: day(2026, 8, 1), status: 'working_on_it' }), { statuses: ['stuck'] }), true);
});

test('without a ledger, the Overdue status is the stored status and nothing more', () => {
  const late = { status: statusId('working_on_it'), dueDate: day(2026, 8, 1) };
  assert.equal(matches(late, { statuses: [statusId('stuck')] }, LEGACY), false, 'a legacy board');

  // A flexible board with a due date but no amount keeps no ledger.
  const noAmount = {
    ...BILLING,
    columns: BILLING.columns.filter((c) => c.key !== 'amount'),
  };
  const row = invoice({ due: day(2026, 8, 1), status: 'working_on_it' });
  assert.equal(matches(row, { statuses: [statusId('stuck')] }, noAmount), false);
  assert.equal(matches(invoice({ status: 'stuck' }), { statuses: [statusId('stuck')] }, noAmount), true);
});

/* ------------------------------ boards that are NOT a ledger stay plain */

// A pipeline: a currency "Deal value" and a close date playing the due role —
// money and a date, but not a list of invoices. It offers no Ledger view.
const PIPELINE = {
  templateKey: 'pipeline',
  useFlexibleColumns: true,
  statuses: STATUSES,
  columns: [
    { _id: PRIMARY, key: 'deal', type: 'text', isPrimary: true },
    { _id: AMOUNT, key: 'value', type: 'number', settings: { format: 'currency', currency: 'CAD' } },
    { _id: DUE, key: 'closeDate', type: 'date', settings: { role: 'dueDate' } },
    { _id: OWNER, key: 'owner', type: 'person', settings: { role: 'assignee' } },
  ],
};
// A blank task board somebody added a money column to, with the legacy slug.
const BLANK = {
  useFlexibleColumns: true,
  statuses: STATUSES,
  columns: [
    { _id: PRIMARY, key: 'name', type: 'text', isPrimary: true },
    { _id: AMOUNT, key: 'budget', type: 'number', settings: { format: 'currency', currency: 'INR' } },
    { _id: DUE, key: 'due_date', type: 'date' },
  ],
};

test('a board with money and a due date but no Ledger view keeps no ledger', () => {
  assert.equal(filterFieldsOf(PIPELINE).ledger, null, 'pipeline');
  assert.equal(filterFieldsOf(BLANK).ledger, null, 'blank board');
  // …while the due column is still read by role.
  assert.equal(filterFieldsOf(PIPELINE).due.key, 'closeDate');
});

test('on those boards Stuck and Overdue keep their plain meanings', () => {
  for (const board of [PIPELINE, BLANK]) {
    // Status = Stuck is the stored status, not "late by the date".
    const lateWorking = invoice({ due: day(2026, 8, 1), status: 'working_on_it' });
    assert.equal(matches(lateWorking, { statuses: [statusId('stuck')] }, board), false);
    // Due = Overdue is the calendar: a Not Started row past its date is late…
    const lateNew = invoice({ due: day(2026, 8, 1), status: 'not_started' });
    assert.equal(matches(lateNew, { due: ['overdue'] }, board), true);
    // …and a Stuck row with no date is not.
    assert.equal(matches(invoice({ status: 'stuck' }), { due: ['overdue'] }, board), false);
  }
});

/* ----------------------------------------------------------------- owner */

test('the owner filter reads the owner column’s bare ids', () => {
  const priyas = invoice({ owner: [PRIYA] });
  const both = invoice({ owner: [ARJUN, PRIYA] });
  const nobody = invoice({ owner: [] });

  assert.deepEqual(taskOwnerIds(both, BILLING), [ARJUN, PRIYA]);
  assert.equal(matches(priyas, { assignees: [PRIYA] }), true);
  assert.equal(matches(both, { assignees: [PRIYA] }), true);
  assert.equal(matches(nobody, { assignees: [PRIYA] }), false);
  assert.equal(matches(nobody, { assignees: ['unassigned'] }), true);
  assert.equal(matches(priyas, { assignees: ['unassigned'] }), false);
});

test('an emptied owner cell means unassigned, even over a legacy list', () => {
  const cleared = invoice({ owner: [], legacy: { assignedTo: [{ _id: PRIYA, name: 'Priya' }] } });
  assert.deepEqual(taskOwnerIds(cleared, BILLING), []);
  assert.equal(matches(cleared, { assignees: ['unassigned'] }), true);
});

test('an unwritten owner cell falls back to task.assignedTo', () => {
  const old = invoice({ legacy: { assignedTo: [{ _id: ARJUN, name: 'Arjun' }] } });
  assert.deepEqual(taskOwnerIds(old, BILLING), [ARJUN]);
  assert.equal(matches(old, { assignees: [ARJUN] }), true);
});

test('a legacy board reads task.assignedTo and ignores columnValues', () => {
  const t = {
    assignedTo: [{ _id: ARJUN, name: 'Arjun' }],
    columnValues: { [OWNER]: [PRIYA] },
  };
  assert.deepEqual(taskOwnerIds(t, LEGACY), [ARJUN]);
  assert.equal(matches(t, { assignees: [PRIYA] }, LEGACY), false);
  assert.equal(matches(t, { assignees: [ARJUN] }, LEGACY), true);
});

/* --------------------------------------------------------- owner options */

test('owner options on a flexible board are named from the board roster', () => {
  const tasks = [
    invoice({ owner: [PRIYA] }),
    invoice({ owner: [PRIYA, ARJUN] }),
    invoice({ owner: ['65a0000000000000000000ff'] }), // left the board
    invoice({ owner: [] }),
  ];
  const members = [
    { _id: PRIYA, name: 'Priya', profilePic: 'p.png' },
    { _id: ARJUN, name: 'Arjun' },
  ];
  const opts = ownerOptionsFor(tasks, BILLING, members);
  assert.deepEqual(
    opts.map((o) => [o.id, o.name]),
    [
      [ARJUN, 'Arjun'],
      ['65a0000000000000000000ff', 'Member'],
      [PRIYA, 'Priya'],
    ],
  );
  assert.equal(opts.find((o) => o.id === PRIYA).profilePic, 'p.png');
});

test('owner options before the roster lands still list every owner', () => {
  const opts = ownerOptionsFor([invoice({ owner: [PRIYA] })], BILLING, []);
  assert.deepEqual(opts, [{ id: PRIYA, name: 'Member', profilePic: undefined }]);
});

test('owner options on a legacy board come from the populated assignees', () => {
  const tasks = [
    { assignedTo: [{ _id: PRIYA, name: 'Priya', profilePic: 'p.png' }] },
    { assignedTo: [{ _id: ARJUN, name: 'Arjun' }, { _id: PRIYA, name: 'Priya' }] },
    { assignedTo: [] },
    { columnValues: { [OWNER]: ['65a0000000000000000000ff'] } }, // never read here
  ];
  const opts = ownerOptionsFor(tasks, LEGACY, null);
  assert.deepEqual(
    opts.map((o) => [o.id, o.name, o.profilePic]),
    [
      [ARJUN, 'Arjun', undefined],
      [PRIYA, 'Priya', 'p.png'],
    ],
  );
});

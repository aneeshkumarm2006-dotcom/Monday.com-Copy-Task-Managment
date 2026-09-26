import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gridSlots,
  withFormat,
  withColumnFormat,
  withDecimals,
  decimalsChoiceOf,
  isMoneyColumn,
  formulaInputColumns,
  connectColumnsWithTargets,
  SELECT_TRACK,
  STATUS_TRACK,
  TRAILING_TRACK,
} from './dataGrid.js';

const billing = [
  { _id: 'c1', key: 'invoice', type: 'text', isPrimary: true, width: 200 },
  { _id: 'c2', key: 'pdf', type: 'file', width: 120 },
  { _id: 'c3', key: 'amount', type: 'number', settings: { format: 'currency', currency: 'CAD' } },
];

test('a plain grid: one track per column plus the trailing add-column slot', () => {
  const { slots, template, span } = gridSlots(billing);
  assert.deepEqual(
    slots.map((s) => s.kind),
    ['column', 'column', 'column', 'trailing']
  );
  assert.equal(template, `200px 120px 160px ${TRAILING_TRACK}px`);
  assert.equal(span, 4);
});

test('status goes right after the primary column, select first, trailing last', () => {
  const { slots, template, span } = gridSlots(billing, { selectable: true, showStatus: true });
  assert.deepEqual(
    slots.map((s) => (s.kind === 'column' ? s.column.key : s.kind)),
    ['select', 'invoice', 'status', 'pdf', 'amount', 'trailing']
  );
  assert.equal(template, `${SELECT_TRACK}px 200px ${STATUS_TRACK}px 120px 160px ${TRAILING_TRACK}px`);
  assert.equal(span, 6);
});

test('status follows the PRIMARY column even when it is not first', () => {
  const cols = [
    { _id: 'a', key: 'notes', type: 'text' },
    { _id: 'b', key: 'name', type: 'text', isPrimary: true },
  ];
  const { slots, primaryIndex } = gridSlots(cols, { showStatus: true });
  assert.equal(primaryIndex, 1);
  assert.deepEqual(
    slots.map((s) => (s.kind === 'column' ? s.column.key : s.kind)),
    ['notes', 'name', 'status', 'trailing']
  );
  assert.equal(slots[1].primary, true);
});

test('no flagged primary: the first column is treated as primary', () => {
  const { slots } = gridSlots([{ _id: 'x', key: 'x', type: 'text' }], { showStatus: true });
  assert.equal(slots[0].primary, true);
  assert.equal(slots[1].kind, 'status');
});

test('switching to Currency stamps the BOARD currency, not the workspace one', () => {
  assert.deepEqual(withFormat({ summary: 'sum' }, 'currency', 'CAD'), {
    summary: 'sum',
    format: 'currency',
    currency: 'CAD',
  });
  // A column that already names its unit keeps it.
  assert.equal(withFormat({ currency: 'USD' }, 'currency', 'CAD').currency, 'USD');
  // Nothing known: stamp nothing, the server resolves the same chain.
  assert.equal('currency' in withFormat({}, 'currency', null), false);
  // Leaving currency keeps the old code but it no longer matters.
  assert.equal(withFormat({ format: 'currency', currency: 'CAD' }, 'percent', 'CAD').format, 'percent');
});

test("switching a MIRROR to Currency never stamps this board's unit", () => {
  // Its figures are the SOURCE board's; the server inherits the source's code.
  const mirror = { type: 'mirror', settings: { aggregation: 'sum' } };
  assert.equal('currency' in withColumnFormat(mirror, 'currency', 'CAD'), false);
  assert.equal(withColumnFormat(mirror, 'currency', 'CAD').format, 'currency');
  // Every other column still takes the board's.
  assert.equal(withColumnFormat({ type: 'number', settings: {} }, 'currency', 'CAD').currency, 'CAD');
});

test("Decimals: 'auto' removes the key, 0 and 2 store a number", () => {
  const s = { format: 'currency', currency: 'CAD', decimals: 0 };
  assert.deepEqual(withDecimals(s, 'auto'), { format: 'currency', currency: 'CAD' });
  assert.equal(withDecimals(s, '2').decimals, 2);
  assert.equal(withDecimals({}, '0').decimals, 0);
  assert.equal(decimalsChoiceOf({ decimals: 0 }), '0');
  assert.equal(decimalsChoiceOf({ decimals: 2 }), '2');
  assert.equal(decimalsChoiceOf({}), 'auto');
  assert.equal(decimalsChoiceOf(null), 'auto');
});

test('isMoneyColumn: currency-format numbers, and payments always', () => {
  assert.equal(isMoneyColumn(billing[2]), true);
  assert.equal(isMoneyColumn({ type: 'number', settings: { format: 'percent' } }), false);
  assert.equal(isMoneyColumn({ type: 'payments', settings: {} }), true);
  assert.equal(isMoneyColumn({ type: 'rating', settings: { format: 'currency' } }), false);
});

test('formula inputs: numeric columns only, never the formula itself', () => {
  const cols = [
    ...billing,
    { _id: 'c4', key: 'paid', type: 'payments' },
    { _id: 'c5', key: 'balance', type: 'formula' },
  ];
  assert.deepEqual(
    formulaInputColumns(cols, 'balance').map((c) => c.key),
    ['amount', 'paid']
  );
});

test('a Mirror needs a connect column that points somewhere', () => {
  const unset = { _id: 'k', key: 'client', type: 'connect_boards', settings: {} };
  const set = { _id: 'k2', key: 'vendor', type: 'connect_boards', settings: { targetBoardIds: ['b1'] } };
  assert.deepEqual(connectColumnsWithTargets([unset]), []);
  assert.deepEqual(connectColumnsWithTargets([unset, set]).map((c) => c.key), ['vendor']);
});

test('checkFormula mirrors the server: unknown, non-numeric and self references are refused', async () => {
  const { checkFormula } = await import('./dataGrid.js');
  const cols = [
    ...billing,
    { _id: 'c4', key: 'paid', type: 'payments', name: 'Paid' },
    { _id: 'c5', key: 'balance', type: 'formula', name: 'Balance' },
  ];
  assert.equal(checkFormula('column.amount - column.paid', cols).ok, true);
  assert.match(checkFormula('', cols).error, /needs an expression/);
  assert.match(checkFormula('column.nope + 1', cols).error, /not a column on this board/);
  assert.match(checkFormula('column.invoice * 2', cols).error, /not a number column/);
  assert.match(checkFormula('column.balance + 1', cols, 'balance').error, /itself/);
  assert.match(checkFormula('column.amount +', cols).error, /not valid/);
  assert.match(checkFormula('alert(1)', cols).error, /not valid/);
  // Sound, even though it divides by zero when every input is equal.
  assert.equal(checkFormula('column.amount / (column.paid - column.amount)', cols).ok, true);
});

test('formulaSettingsFrom: expression trimmed, currency only for currency, decimals mapped', async () => {
  const { formulaSettingsFrom } = await import('./dataGrid.js');
  assert.deepEqual(
    formulaSettingsFrom({ summary: 'sum' }, { expression: ' column.a - column.b ', format: 'currency', currency: 'CAD', decimals: '2' }),
    { summary: 'sum', expression: 'column.a - column.b', format: 'currency', currency: 'CAD', decimals: 2 }
  );
  const plain = formulaSettingsFrom({ decimals: 0 }, { expression: 'column.a', format: 'plain', currency: 'CAD', decimals: 'auto' });
  assert.equal(plain.format, 'plain');
  assert.equal('currency' in plain, false);
  assert.equal('decimals' in plain, false);
});

test('gridPermissions: readOnly alone keeps the old grid (nothing writes)', async () => {
  const { gridPermissions } = await import('./dataGrid.js');
  assert.deepEqual(gridPermissions({ readOnly: true }), {
    edit: false,
    create: false,
    manageColumns: false,
    changeStatus: false,
  });
  assert.deepEqual(gridPermissions({}), {
    edit: true,
    create: true,
    manageColumns: true,
    changeStatus: true,
  });
  assert.deepEqual(gridPermissions(), gridPermissions({}));
});

test('gridPermissions: a given capability wins over readOnly (the contribute rung)', async () => {
  const { gridPermissions } = await import('./dataGrid.js');
  // A contributor: may add rows and change status, may not edit cells or
  // restructure the board — and the page still passes readOnly={!canEdit}.
  const p = gridPermissions({
    readOnly: true,
    canEdit: false,
    canCreate: true,
    canManageColumns: false,
    canChangeStatus: true,
  });
  assert.deepEqual(p, { edit: false, create: true, manageColumns: false, changeStatus: true });
  // Column rights are their own bit: an editor without column.manage.
  assert.equal(gridPermissions({ canEdit: true, canManageColumns: false }).manageColumns, false);
  // Unset create / status follow edit; null counts as unset.
  assert.equal(gridPermissions({ canEdit: false, canCreate: null }).create, false);
  assert.equal(gridPermissions({ canEdit: true }).changeStatus, true);
});

test('wantsStatusTrack: needs board statuses AND a handler', async () => {
  const { wantsStatusTrack } = await import('./dataGrid.js');
  const board = { statuses: [{ _id: 's1', key: 'done', name: 'Paid' }] };
  const click = () => {};
  assert.equal(wantsStatusTrack(board, click), true);
  assert.equal(wantsStatusTrack(board, undefined), false);
  assert.equal(wantsStatusTrack({ statuses: [] }, click), false);
  assert.equal(wantsStatusTrack(null, click), false);
});

test('gridNouns: the template names the row, a plain board says item', async () => {
  const { gridNouns } = await import('./dataGrid.js');
  assert.deepEqual(gridNouns({ templateKey: 'billing' }), {
    one: 'invoice',
    many: 'invoices',
    empty: 'No invoices yet',
    add: 'Add invoice',
  });
  assert.equal(gridNouns({}).empty, 'No items yet');
  assert.equal(gridNouns({ templateKey: 'retired-template' }).add, 'Add item');
  assert.equal(gridNouns(null).add, 'Add item');
});

test('hasOwnMoney: a mirrored money column is not this board\'s money', async () => {
  const { hasOwnMoney } = await import('./dataGrid.js');
  assert.equal(hasOwnMoney(billing), true);
  assert.equal(hasOwnMoney([{ type: 'payments', settings: {} }]), true);
  assert.equal(hasOwnMoney([{ type: 'mirror', settings: { format: 'currency', currency: 'USD' } }]), false);
  assert.equal(hasOwnMoney([{ type: 'number', settings: { format: 'plain' } }]), false);
  assert.equal(hasOwnMoney(null), false);
});

test('cellDisplayValue: an empty primary text cell shows the task name', async () => {
  const { cellDisplayValue } = await import('./dataGrid.js');
  const task = { name: 'INV-004' };
  const title = billing[0];
  assert.equal(cellDisplayValue(task, title, null, true), 'INV-004');
  assert.equal(cellDisplayValue(task, title, '  ', true), 'INV-004');
  // A filled cell is the truth; the server keeps it in step with the name.
  assert.equal(cellDisplayValue(task, title, 'INV-005', true), 'INV-005');
  // Not the primary, or not text: untouched.
  assert.equal(cellDisplayValue(task, { type: 'text', key: 'notes' }, null, false), null);
  assert.equal(cellDisplayValue(task, billing[2], null, true), null);
  // The legacy CRM title column keeps its name-first rule.
  assert.equal(cellDisplayValue({ name: 'Acme' }, { key: 'lead_name', type: 'text' }, 'Old', false), 'Acme');
  assert.equal(cellDisplayValue({}, { key: 'lead_name', type: 'text' }, 'Old', false), 'Old');
});

test('columnMenuControls: each type gets the controls it can use', async () => {
  const { columnMenuControls } = await import('./dataGrid.js');
  assert.deepEqual(columnMenuControls(billing[2]), {
    format: true,
    currency: true,
    decimals: true,
    formula: false,
    connect: false,
  });
  // A plain number can be formatted but has no unit to pick yet.
  const plain = columnMenuControls({ type: 'number', settings: { format: 'plain' } });
  assert.equal(plain.format, true);
  assert.equal(plain.currency, false);
  // Payments: money by definition — unit and decimals, no format picker.
  const pay = columnMenuControls({ type: 'payments', settings: {} });
  assert.deepEqual([pay.format, pay.currency, pay.decimals], [false, true, true]);
  assert.equal(columnMenuControls({ type: 'formula', settings: {} }).formula, true);
  assert.equal(columnMenuControls({ type: 'connect_boards', settings: {} }).connect, true);
  // Stars are not currency.
  assert.equal(columnMenuControls({ type: 'rating', settings: { format: 'currency' } }).format, false);
  assert.equal(columnMenuControls(null).format, false);
});

test('gridSlots with a status track: header, rows and footer share one span', () => {
  // The footer renders one cell per slot; a status track that the footer
  // forgot would put every total one column left of its column.
  const withStatus = gridSlots(billing, { showStatus: true });
  const without = gridSlots(billing);
  assert.equal(withStatus.span, without.span + 1);
  assert.equal(withStatus.slots.filter((s) => s.kind === 'status').length, 1);
  assert.equal(withStatus.slots.at(-1).kind, 'trailing');
});

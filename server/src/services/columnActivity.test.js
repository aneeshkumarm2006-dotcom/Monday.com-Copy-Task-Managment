const { test } = require('node:test');
const assert = require('node:assert');

const {
  describeActivity,
  resolveFieldValue,
  collectUserIds,
  formatMoney,
} = require('./activityFormat');

/**
 * Flexible-column edits in the activity feed and the exported report.
 *
 * These used to read 'updated "a column"' in the panel and 'updated amount.' in
 * the export, whatever changed — the writer stamped only `taskName`. It now
 * stamps `columnLabel`, `columnType` and (for money) the `currency` the figure
 * was entered in, and the sentences below are what that buys. The JSX mirror is
 * client/src/components/board/ActivityEntry.jsx; the two must say the same
 * thing.
 *
 * Pure: rows are hand-built in the shape activityController / the export hand
 * to `describeActivity` after `resolveFieldValue` has run.
 */

const row = (field, oldValue, newValue, metadata) => ({
  type: 'task.field_changed',
  field,
  oldValue,
  newValue,
  metadata: { taskName: 'INV-12', ...metadata },
  actor: { name: 'Aneesh' },
});

test('money uses the catalog symbol and the locale position', () => {
  assert.equal(formatMoney(1234, 'CAD'), 'CA$1,234');
  assert.equal(formatMoney(1234, 'USD'), '$1,234');
  assert.equal(formatMoney(1234, 'AUD'), 'A$1,234');
  assert.equal(formatMoney(1234, 'SGD'), 'S$1,234');
  assert.equal(formatMoney(180000, 'INR'), '₹1,80,000');
  assert.match(formatMoney(1234, 'EUR'), /^1\.234\s€$/);
  assert.equal(formatMoney(12.5, 'CAD'), 'CA$12.50');
  assert.equal(formatMoney(1234, 'JPY'), 'JPY 1,234');
});

test('a money column shows both amounts in the currency recorded in the row', () => {
  const text = describeActivity(
    row('column:amount', 12000, 15000, { columnLabel: 'Amount', columnType: 'number', currency: 'CAD' })
  );
  assert.equal(text, 'Aneesh changed Amount from CA$12,000 to CA$15,000.');
});

test('a plain number column prints no symbol', () => {
  const text = describeActivity(
    row('column:hours', 3, 4.5, { columnLabel: 'Hours', columnType: 'number' })
  );
  assert.equal(text, 'Aneesh changed Hours from 3 to 4.5.');
});

test('filling and clearing read as set and cleared', () => {
  assert.equal(
    describeActivity(row('column:amount', null, 500, { columnLabel: 'Amount', columnType: 'number', currency: 'USD' })),
    'Aneesh set Amount to $500.'
  );
  assert.equal(
    describeActivity(row('column:notes', 'Call back', null, { columnLabel: 'Notes', columnType: 'text' })),
    'Aneesh cleared Notes (was "Call back").'
  );
});

test('a date column shows both dates', () => {
  const text = describeActivity(
    row('column:due', '2026-09-01T12:00:00.000Z', '2026-09-15T12:00:00.000Z', { columnLabel: 'Due', columnType: 'date' })
  );
  assert.equal(text, 'Aneesh changed Due from Sep 1, 2026 to Sep 15, 2026.');
});

test('a file column says what was attached and what was removed', () => {
  const a = { url: 'https://x/raw/upload/v1/a', name: 'INV-12.pdf' };
  const b = { url: 'https://x/raw/upload/v1/b', name: 'INV-12-v2.pdf' };
  assert.equal(
    describeActivity(row('column:pdf', null, [a], { columnLabel: 'PDF', columnType: 'file' })),
    'Aneesh attached "INV-12.pdf" to PDF.'
  );
  assert.equal(
    describeActivity(row('column:pdf', [a], [b], { columnLabel: 'PDF', columnType: 'file' })),
    'Aneesh attached "INV-12-v2.pdf" to PDF and removed "INV-12.pdf" from PDF.'
  );
  assert.equal(
    describeActivity(row('column:pdf', [a], [], { columnLabel: 'PDF', columnType: 'file' })),
    'Aneesh removed "INV-12.pdf" from PDF.'
  );
});

test('payments are compared by id: recorded, removed, changed', () => {
  const p1 = { id: 'aaa', amount: 500, date: '2026-09-01' };
  const p2 = { id: 'bbb', amount: 200, date: '2026-08-01' };
  const meta = { columnLabel: 'Payments', columnType: 'payments', currency: 'CAD' };
  assert.equal(
    describeActivity(row('column:payments', [], [p1], meta)),
    'Aneesh recorded a payment of CA$500.'
  );
  // p2 is OLDER, so it sorts first — a positional diff would call p1 changed.
  assert.equal(
    describeActivity(row('column:payments', [p1], [p2, p1], meta)),
    'Aneesh recorded a payment of CA$200.'
  );
  assert.equal(
    describeActivity(row('column:payments', [p2, p1], [p1], meta)),
    'Aneesh removed a payment of CA$200.'
  );
  assert.equal(
    describeActivity(row('column:payments', [p1], [{ ...p1, amount: 450 }], meta)),
    'Aneesh changed a payment from CA$500 to CA$450.'
  );
});

test('a person column is resolved to names and diffed', () => {
  const meta = { columnLabel: 'Owner', columnType: 'person' };
  const raw = row('column:owner', ['u1'], ['u2'], meta);
  // The ids are collected for the one user lookup (off the RAW row, whose
  // actor is still an id)…
  assert.deepStrictEqual(collectUserIds([{ ...raw, actor: 'me' }]).sort(), ['me', 'u1', 'u2']);
  // …and resolved before the sentence is built, as the feed and export do.
  const userMap = new Map([
    ['u1', { name: 'Priya' }],
    ['u2', { name: 'Omar' }],
  ]);
  const hydrated = {
    ...raw,
    oldValue: resolveFieldValue(raw.field, raw.oldValue, null, userMap, raw),
    newValue: resolveFieldValue(raw.field, raw.newValue, null, userMap, raw),
  };
  assert.equal(describeActivity(hydrated), 'Aneesh assigned Omar and unassigned Priya in Owner.');
});

test('status and dropdown choices read as their labels, even once deleted', () => {
  const meta = {
    columnLabel: 'Stage',
    columnType: 'dropdown',
    optionLabels: { o1: 'Lead', o2: 'Won' },
  };
  assert.equal(
    describeActivity(row('column:stage', 'o1', 'o2', meta)),
    'Aneesh changed Stage from Lead to Won.'
  );
  assert.equal(
    describeActivity(row('column:stage', 'o1', 'gone', meta)),
    'Aneesh changed Stage from Lead to a removed choice.'
  );
});

test('a checkbox reads as checked or unchecked', () => {
  const meta = { columnLabel: 'Approved', columnType: 'checkbox' };
  assert.equal(describeActivity(row('column:approved', false, true, meta)), 'Aneesh checked Approved.');
  assert.equal(describeActivity(row('column:approved', true, false, meta)), 'Aneesh unchecked Approved.');
});

test('rows written before the type was stamped keep the old wording', () => {
  // No columnType: the pre-fix shape, and linkController's link rows.
  assert.equal(
    describeActivity(row('column:amount', 12000, 15000, {})),
    'Aneesh updated amount.'
  );
  assert.equal(
    describeActivity(row('column:client', [], ['t1'], { columnLabel: 'Client' })),
    'Aneesh linked 1 item in Client.'
  );
});

test('a typed row with nothing to say falls back to "updated"', () => {
  assert.equal(
    describeActivity(row('column:where', { lat: 1 }, { lat: 2 }, { columnLabel: 'Where', columnType: 'location' })),
    'Aneesh updated Where.'
  );
});

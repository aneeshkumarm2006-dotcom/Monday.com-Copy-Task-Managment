import test from 'node:test';
import assert from 'node:assert';

import { columnRole, roleColumn, TEMPLATE_COLUMN_ROLES, COLUMN_ROLES, NO_ROLE } from './columnRoles.js';

/**
 * Which column means "due date" and which means "owner". Billing is the case
 * that makes this non-trivial: it has two date columns, and picking the first
 * would make every invoice due the day it was issued.
 */

const billingColumns = [
  { _id: '1', key: 'invoice', type: 'text' },
  { _id: '2', key: 'issued', type: 'date' },
  { _id: '3', key: 'due', type: 'date' },
  { _id: '4', key: 'owner', type: 'person' },
];

test('a template board finds its roles by the template, with no stamped settings', () => {
  const board = { templateKey: 'billing', columns: billingColumns };
  assert.equal(roleColumn(board, 'dueDate')?.key, 'due', 'due, not the first date column');
  assert.equal(roleColumn(board, 'assignee')?.key, 'owner');
  assert.equal(columnRole(board, billingColumns[1]), null, 'issued is not the due date');
});

test("a column's own role wins over the template's", () => {
  const cols = [
    { _id: '1', key: 'issued', type: 'date', settings: { role: 'dueDate' } },
    { _id: '2', key: 'due', type: 'date', settings: { role: null } },
  ];
  const board = { templateKey: 'billing', columns: cols };
  assert.equal(columnRole(board, cols[0]), 'dueDate');
  assert.equal(roleColumn(board, 'dueDate')?._id, '1', 'first match in array order');
});

test("a column's OWN role beats an earlier column the template vouches for", () => {
  // The case the role setting exists for: someone adds a new date column to an
  // old billing board and marks IT as the due date. The template's `due` comes
  // first in the array — it must still lose to the explicit choice.
  const cols = [
    { _id: '1', key: 'issued', type: 'date' },
    { _id: '2', key: 'due', type: 'date' },
    { _id: '3', key: 'paymentDue', type: 'date', settings: { role: 'dueDate' } },
    { _id: '4', key: 'owner', type: 'person' },
    { _id: '5', key: 'accountManager', type: 'person', settings: { role: 'assignee' } },
  ];
  const board = { templateKey: 'billing', columns: cols };
  assert.equal(roleColumn(board, 'dueDate')?._id, '3', 'own role over template, despite array order');
  assert.equal(roleColumn(board, 'assignee')?._id, '5');
});

test('the template beats a legacy key, whatever the array order', () => {
  const cols = [
    { _id: '1', key: 'due_date', type: 'date' },
    { _id: '2', key: 'closeDate', type: 'date' },
    { _id: '3', key: 'assignees', type: 'person' },
    { _id: '4', key: 'owner', type: 'person' },
  ];
  const board = { templateKey: 'pipeline', columns: cols };
  assert.equal(roleColumn(board, 'dueDate')?._id, '2');
  assert.equal(roleColumn(board, 'assignee')?._id, '4');
  // With no template to vouch for anything, the legacy keys are what is left.
  assert.equal(roleColumn({ templateKey: null, columns: cols }, 'dueDate')?._id, '1');
});

test('an own role of the wrong type does not qualify, and does not block the next rank', () => {
  const cols = [
    { _id: '1', key: 'dueNote', type: 'text', settings: { role: 'dueDate' } },
    { _id: '2', key: 'due', type: 'date' },
  ];
  const board = { templateKey: 'billing', columns: cols };
  assert.equal(roleColumn(board, 'dueDate')?._id, '2', 'a text column is never the due date');
});

test('a column stating a DIFFERENT role is not also the template role for its key', () => {
  const cols = [
    { _id: '1', key: 'due', type: 'date', settings: { role: 'assignee' } },
    { _id: '2', key: 'issued', type: 'date' },
  ];
  const board = { templateKey: 'billing', columns: cols };
  assert.equal(columnRole(board, cols[0]), 'assignee');
  assert.equal(roleColumn(board, 'dueDate'), null, 'its own word wins; nothing else is the due date');
});

test('every template in the table maps to a real role', () => {
  for (const [tpl, map] of Object.entries(TEMPLATE_COLUMN_ROLES)) {
    for (const [key, role] of Object.entries(map)) {
      assert.ok(COLUMN_ROLES.includes(role), `${tpl}.${key} → ${role} is not a role`);
    }
  }
  assert.deepEqual(TEMPLATE_COLUMN_ROLES.pipeline, { closeDate: 'dueDate', owner: 'assignee' });
  assert.deepEqual(TEMPLATE_COLUMN_ROLES.recruitment, { nextRound: 'dueDate', interviewer: 'assignee' });
  assert.deepEqual(TEMPLATE_COLUMN_ROLES.expenses, { who: 'assignee' });
  assert.deepEqual(TEMPLATE_COLUMN_ROLES.content, { publishDate: 'dueDate', writer: 'assignee' });
});

test('legacy keys still resolve on a board with no template', () => {
  const cols = [
    { _id: '1', key: 'due_date', type: 'date' },
    { _id: '2', key: 'assignees', type: 'person' },
  ];
  const board = { templateKey: null, columns: cols };
  assert.equal(roleColumn(board, 'dueDate')?._id, '1');
  assert.equal(roleColumn(board, 'assignee')?._id, '2');
});

test('a role on a column of the wrong type is not the role column', () => {
  const cols = [{ _id: '1', key: 'due', type: 'text' }];
  const board = { templateKey: 'billing', columns: cols };
  assert.equal(columnRole(board, cols[0]), 'dueDate', 'the role is still reported…');
  assert.equal(roleColumn(board, 'dueDate'), null, '…but a text column is not a due date');
});

/* ------------------------------------------------ role: 'none' (explicit) */

test("role 'none' takes a template role away", () => {
  // Clearing the role used to store nothing, so the template vouched for `due`
  // again on the very next read and the setting visibly did nothing.
  assert.equal(NO_ROLE, 'none');
  const cols = [
    { _id: '1', key: 'issued', type: 'date' },
    { _id: '2', key: 'due', type: 'date', settings: { role: 'none' } },
    { _id: '3', key: 'owner', type: 'person', settings: { role: 'none' } },
  ];
  const board = { templateKey: 'billing', columns: cols };
  assert.equal(columnRole(board, cols[1]), null, 'the column says it has no role');
  assert.equal(columnRole(board, cols[2]), null);
  assert.equal(roleColumn(board, 'dueDate'), null, 'and nothing else becomes the due date');
  assert.equal(roleColumn(board, 'assignee'), null);
});

test("role 'none' also silences a legacy key", () => {
  const cols = [
    { _id: '1', key: 'due_date', type: 'date', settings: { role: 'none' } },
    { _id: '2', key: 'assignees', type: 'person', settings: { role: NO_ROLE } },
  ];
  const board = { templateKey: null, columns: cols };
  assert.equal(roleColumn(board, 'dueDate'), null);
  assert.equal(roleColumn(board, 'assignee'), null);
});

test("with the template's column opted out, another column's own claim still wins", () => {
  // The move the role setting exists for, done the explicit way: `due` says
  // "none", a new column says "dueDate".
  const cols = [
    { _id: '1', key: 'due', type: 'date', settings: { role: 'none' } },
    { _id: '2', key: 'paymentDue', type: 'date', settings: { role: 'dueDate' } },
  ];
  const board = { templateKey: 'billing', columns: cols };
  assert.equal(roleColumn(board, 'dueDate')?._id, '2');
});

test("a missing or null role is NOT 'none' — the template still supplies one", () => {
  // Only the explicit value opts out; an unset role keeps the fallback, which
  // is what every board made before roles were stamped relies on.
  const cols = [
    { _id: '1', key: 'due', type: 'date', settings: { role: null } },
    { _id: '2', key: 'owner', type: 'person', settings: {} },
  ];
  const board = { templateKey: 'billing', columns: cols };
  assert.equal(roleColumn(board, 'dueDate')?._id, '1');
  assert.equal(roleColumn(board, 'assignee')?._id, '2');
  assert.equal(COLUMN_ROLES.includes(NO_ROLE), false, "'none' is a setting, never a role");
});

test('nothing to find is null, never a guess', () => {
  // A person column whose key its template does not name (expenses' is `who`).
  assert.equal(roleColumn({ templateKey: 'expenses', columns: [{ key: 'owner', type: 'person' }] }, 'assignee'), null);
  // Budget's Owner DOES play the assignee — found through the template table.
  assert.equal(roleColumn({ templateKey: 'budget', columns: [{ key: 'owner', type: 'person' }] }, 'assignee').key, 'owner');
  assert.equal(roleColumn(null, 'dueDate'), null);
  assert.equal(roleColumn({ columns: billingColumns }, 'nonsense'), null);
  assert.equal(columnRole({ templateKey: 'billing' }, null), null);
  assert.equal(columnRole({}, { key: 'x', settings: { role: 'bogus' } }), null);
});

const { test } = require('node:test');
const assert = require('node:assert');

const { columnRole, roleColumn, isRole, NO_ROLE } = require('./columnRoles');

/**
 * Which column means "due date" and which means "owner".
 *
 * Everything that reads the legacy fields — the Due/Owner filters, My Work, the
 * due digest — only agrees with a flexible board if the pre-save sync finds the
 * RIGHT column, and it used to find none on any template board because it
 * looked for the migration slugs `due_date` / `assignees`. These pin the order
 * the answer is found in: the column's own role, then its template's, then the
 * old slugs.
 *
 * Pure. Columns and boards are plain objects; the template fallback reads the
 * real registry in boardTemplates.js, which is the point — a template losing a
 * role would silently stop syncing every board created from it.
 */

const col = (key, type, settings = {}) => ({ _id: `c-${key}`, key, type, settings });

test('only the two roles are roles', () => {
  assert.equal(isRole('dueDate'), true);
  assert.equal(isRole('assignee'), true);
  assert.equal(isRole('owner'), false);
  assert.equal(isRole(''), false);
  assert.equal(isRole(null), false);
});

test("a column's own settings.role wins", () => {
  const board = { templateKey: null, columns: [] };
  assert.equal(columnRole(board, col('deadline', 'date', { role: 'dueDate' })), 'dueDate');
  assert.equal(columnRole(board, col('lead', 'person', { role: 'assignee' })), 'assignee');
});

test('a junk role on the column is ignored rather than trusted', () => {
  const board = { templateKey: null, columns: [] };
  assert.equal(columnRole(board, col('deadline', 'date', { role: 'whenever' })), null);
});

test('a billing column with no role of its own takes the template\'s', () => {
  // A board created before templates carried roles: its `due` and `owner`
  // columns say nothing, and must still resolve without a migration.
  const board = { templateKey: 'billing', columns: [] };
  assert.equal(columnRole(board, col('due', 'date')), 'dueDate');
  assert.equal(columnRole(board, col('owner', 'person')), 'assignee');
  // `issued` is a date on the same template and deliberately NOT the due date.
  assert.equal(columnRole(board, col('issued', 'date')), null);
});

test('every template names its due/owner columns as the contract lists them', () => {
  const expect = {
    billing: { due: 'dueDate', owner: 'assignee' },
    pipeline: { closeDate: 'dueDate', owner: 'assignee' },
    recruitment: { nextRound: 'dueDate', interviewer: 'assignee' },
    expenses: { who: 'assignee' },
    content: { publishDate: 'dueDate', writer: 'assignee' },
  };
  for (const [templateKey, keys] of Object.entries(expect)) {
    const board = { templateKey, columns: [] };
    for (const [key, role] of Object.entries(keys)) {
      assert.equal(
        columnRole(board, col(key, role === 'dueDate' ? 'date' : 'person')),
        role,
        `${templateKey}.${key} should be ${role}`
      );
    }
  }
});

test('the migration slugs still resolve, with or without a template', () => {
  assert.equal(columnRole({ columns: [] }, col('due_date', 'date')), 'dueDate');
  assert.equal(columnRole({ columns: [] }, col('assignees', 'person')), 'assignee');
  assert.equal(columnRole({ templateKey: 'billing', columns: [] }, col('due_date', 'date')), 'dueDate');
});

test('a template key the registry no longer has falls through to the slugs', () => {
  const board = { templateKey: 'retired-template', columns: [] };
  assert.equal(columnRole(board, col('due', 'date')), null);
  assert.equal(columnRole(board, col('due_date', 'date')), 'dueDate');
});

test('roleColumn finds the column of the right TYPE', () => {
  const due = col('due', 'date');
  const owner = col('owner', 'person');
  const board = { templateKey: 'billing', columns: [col('invoice', 'text'), due, owner] };
  assert.equal(roleColumn(board, 'dueDate'), due);
  assert.equal(roleColumn(board, 'assignee'), owner);
});

test('a mistyped column is not synced, however it is named', () => {
  // Somebody turned billing's Due into a text column. Copying free text into
  // `task.dueDate` would throw on the cast, so it must not be picked.
  const board = { templateKey: 'billing', columns: [col('due', 'text'), col('owner', 'text')] };
  assert.equal(roleColumn(board, 'dueDate'), null);
  assert.equal(roleColumn(board, 'assignee'), null);
});

test('among equally strong claims, the first in array order wins', () => {
  const first = col('deadline', 'date', { role: 'dueDate' });
  const second = col('cutoff', 'date', { role: 'dueDate' });
  assert.equal(roleColumn({ columns: [first, second] }, 'dueDate'), first);
  const a = col('due_date', 'date');
  const b = col('due_date_2', 'date', {});
  // Only `due_date` is a legacy slug; `due_date_2` plays nothing.
  assert.equal(roleColumn({ columns: [b, a] }, 'dueDate'), a);
});

test("a column's own role beats a legacy slug to its LEFT", () => {
  // A migrated board: its old `due_date` column sits first, and the owner has
  // since marked a new column as the due date. Array order alone kept syncing
  // the old one, so the setting visibly did nothing.
  const legacy = col('due_date', 'date');
  const marked = col('deadline', 'date', { role: 'dueDate' });
  assert.equal(roleColumn({ columns: [legacy, marked] }, 'dueDate'), marked);

  const legacyPeople = col('assignees', 'person');
  const lead = col('lead', 'person', { role: 'assignee' });
  assert.equal(roleColumn({ columns: [legacyPeople, lead] }, 'assignee'), lead);
});

test("a column's own role beats its template's role on another column", () => {
  // Billing's `due` is the due date by template; a column marked by hand wins.
  const due = col('due', 'date');
  const marked = col('chase_by', 'date', { role: 'dueDate' });
  const board = { templateKey: 'billing', columns: [due, marked] };
  assert.equal(roleColumn(board, 'dueDate'), marked);
});

test("a template's role beats a legacy slug to its left", () => {
  const legacy = col('due_date', 'date');
  const due = col('due', 'date');
  const board = { templateKey: 'billing', columns: [legacy, due] };
  assert.equal(roleColumn(board, 'dueDate'), due);
});

test('a column that states a DIFFERENT role of its own is never picked by its slug', () => {
  // `due_date` claiming nothing would be the due date; one whose own role says
  // otherwise is not, and a wrong-typed own role simply finds no column.
  const board = { columns: [col('due_date', 'date', { role: 'assignee' })] };
  assert.equal(roleColumn(board, 'dueDate'), null);
});

test('nothing to find answers null, never throws', () => {
  assert.equal(roleColumn(null, 'dueDate'), null);
  assert.equal(roleColumn({}, 'dueDate'), null);
  assert.equal(roleColumn({ columns: [] }, 'nonsense'), null);
  assert.equal(columnRole({ columns: [] }, null), null);
});

// ---------------------------------------------------------------------------
// Opting out — settings.role === 'none'
// ---------------------------------------------------------------------------

test("'none' is not a role, and nothing resolves a column by it", () => {
  assert.equal(isRole(NO_ROLE), false);
  assert.equal(NO_ROLE, 'none');
});

test("'none' stops the template fallback for that column", () => {
  /**
   * Clearing Billing's `due` used to hand it straight back to the template,
   * so "this is not the due date on this board" was unsayable. `'none'` says
   * it, and no other column is promoted in its place by accident.
   */
  const due = col('due', 'date', { role: NO_ROLE });
  const board = { templateKey: 'billing', columns: [col('issued', 'date'), due] };
  assert.equal(columnRole(board, due), null);
  assert.equal(roleColumn(board, 'dueDate'), null);
});

test("'none' stops the legacy slug fallback too", () => {
  const legacy = col('due_date', 'date', { role: NO_ROLE });
  assert.equal(columnRole({ columns: [legacy] }, legacy), null);
  assert.equal(roleColumn({ columns: [legacy] }, 'dueDate'), null);
});

test("an opted-out column never outranks, or blocks, one that claims the role", () => {
  const due = col('due', 'date', { role: NO_ROLE });
  const marked = col('chase_by', 'date', { role: 'dueDate' });
  const board = { templateKey: 'billing', columns: [due, marked] };
  assert.equal(roleColumn(board, 'dueDate'), marked);
  // …and the other role's template column is untouched by it.
  const owner = col('owner', 'person');
  assert.equal(roleColumn({ templateKey: 'billing', columns: [due, owner] }, 'assignee'), owner);
});

test('a deleted role (the default) is not an opt-out: the template applies again', () => {
  // `null`/'' is stored as NO key, which means "back to the default" — only
  // the literal 'none' suppresses the fallback.
  const board = { templateKey: 'billing', columns: [] };
  assert.equal(columnRole(board, col('due', 'date', {})), 'dueDate');
  assert.equal(columnRole(board, col('due', 'date', { role: null })), 'dueDate');
});

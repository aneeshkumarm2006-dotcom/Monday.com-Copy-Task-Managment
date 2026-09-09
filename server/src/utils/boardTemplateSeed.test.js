const test = require('node:test');
const assert = require('node:assert');

const { templateByKey } = require('./boardTemplates');

/**
 * WHAT EACH TEMPLATE ACTUALLY PRODUCES.
 *
 * `boardTemplates.test.js` checks the registry's shape is legal. This checks the
 * six boards are the ones that were designed — the columns a person was shown a
 * picture of, in the order they were shown them.
 *
 * It exists because of the bug that shipped: the picker worked, the selection
 * was stored on the form, and `handleCreateSubmit` built its payload field by
 * field and never named `template`. Every board came out blank, and nothing
 * anywhere failed. A test asserting "billing has an Amount column in rupees"
 * would not have caught that one either — but the class of bug it belongs to,
 * where a template silently is not what it says, is worth a tripwire on.
 */

/** The seed, exactly as `createBoard` builds it. Mirrors the controller. */
const seed = (key) => {
  const tpl = templateByKey(key);
  return {
    statuses: tpl.statuses.map((s) => ({ ...s })),
    columns: tpl.columns.map((c, i) => ({ ...c, order: i, settings: { ...(c.settings || {}) } })),
    useFlexibleColumns: tpl.columns.length > 0,
    groups: tpl.groups,
    defaultView: tpl.defaultView,
    dropColumn: tpl.dropColumn || null,
    visibility: tpl.forceVisibility || null,
  };
};

const colNames = (key) => seed(key).columns.map((c) => c.name);
const colByKey = (key, k) => seed(key).columns.find((c) => c.key === k);

test('a template with columns switches the flexible-columns engine on', () => {
  // The board page renders `DataGrid` only when `useFlexibleColumns` is true;
  // otherwise it draws the legacy Task / Priority / Status / Owner table. A
  // template that seeded columns without this flag would store all of them and
  // show none — which is exactly what a blank-looking billing board is.
  for (const key of ['billing', 'budget', 'pipeline', 'recruitment', 'expenses', 'content']) {
    assert.equal(seed(key).useFlexibleColumns, true, `${key} must use flexible columns`);
  }
  assert.equal(seed('blank').useFlexibleColumns, false, 'blank must stay on the legacy path');
});

test('columns are ordered as designed, not as the object happened to iterate', () => {
  // `order` is what the grid sorts by. Without it every board would render its
  // columns in insertion order, which is only right by accident.
  for (const key of ['billing', 'budget', 'pipeline', 'recruitment', 'expenses', 'content']) {
    const orders = seed(key).columns.map((c) => c.order);
    assert.deepEqual(orders, orders.map((_, i) => i), `${key} column order is not 0..n`);
  }
});

test('billing is the invoice board that was designed', () => {
  // PDF is SECOND. The document exists before the number is typed, the client
  // linked or the amount agreed, so it sits beside the number that names it.
  assert.deepEqual(colNames('billing'), [
    'Invoice', 'PDF', 'Client', 'Amount', 'Issued', 'Due', 'Owner',
  ]);
  // The four statuses were RENAMED, not replaced — the keys still carry the
  // meaning the rest of the app reads.
  assert.deepEqual(
    seed('billing').statuses.map((s) => s.name),
    ['Draft', 'Sent', 'Paid', 'Overdue']
  );
  const amount = colByKey('billing', 'amount');
  assert.equal(amount.settings.format, 'currency');
  assert.equal(amount.settings.currency, 'INR');
  assert.equal(amount.settings.summary, 'sum');
  /**
   * ONE group, not twelve months.
   *
   * The month is derived from `issued`; filing the row into March by hand as
   * well is how the board comes to disagree with itself. This assertion is the
   * guard against the months quietly coming back.
   */
  assert.deepEqual(seed('billing').groups, ['Invoices']);
  // A dropped PDF has somewhere to land, which is what makes the row creatable
  // from the document rather than the other way round.
  assert.equal(seed('billing').dropColumn, 'pdf');
  // The client is a LINK to the client's board, not its name retyped.
  assert.equal(colByKey('billing', 'client').type, 'connect_boards');
});

test('budget works remaining out rather than asking for it', () => {
  assert.deepEqual(colNames('budget'), [
    'Category', 'Allocated', 'Spent', 'Remaining', 'Owner', 'Notes',
  ]);
  const remaining = colByKey('budget', 'remaining');
  assert.equal(remaining.type, 'formula');
  assert.equal(remaining.settings.expression, 'column.allocated - column.spent');
  // A formula over currency columns is currency too, or it reads as a bare
  // number beside two ₹ columns.
  assert.equal(remaining.settings.format, 'currency');
  // All three money columns total in the footer and the group header.
  for (const k of ['allocated', 'spent', 'remaining']) {
    assert.equal(colByKey('budget', k).settings.summary, 'sum', `${k} should sum`);
  }
});

test('pipeline stages are groups, and the deal value totals per stage', () => {
  assert.deepEqual(seed('pipeline').groups, [
    'New lead', 'Qualified', 'Proposal sent', 'In negotiation', 'Won', 'Lost',
  ]);
  assert.equal(colByKey('pipeline', 'value').settings.summary, 'sum');
  // Real contact columns, not text fields pretending to be them.
  assert.equal(colByKey('pipeline', 'email').type, 'email');
  assert.equal(colByKey('pipeline', 'phone').type, 'phone');
});

test('recruitment is private, rated and holds the CV', () => {
  assert.equal(seed('recruitment').visibility, 'private');
  assert.equal(colByKey('recruitment', 'cv').type, 'file');
  const rating = colByKey('recruitment', 'rating');
  assert.equal(rating.type, 'rating');
  assert.equal(rating.settings.max, 5);
  // Averaged, not summed: five stars across four candidates is not twenty.
  assert.equal(rating.settings.summary, 'avg');
});

test('expenses keeps approved and paid back as separate facts', () => {
  const approved = colByKey('expenses', 'approved');
  const paidBack = colByKey('expenses', 'paidBack');
  assert.equal(approved.type, 'checkbox');
  assert.equal(paidBack.type, 'checkbox');
  // Two columns, because one can be true without the other and a single status
  // would force somebody to lie in the gap.
  assert.notEqual(approved.key, paidBack.key);
  assert.equal(approved.settings.summary, 'checked');
  // The receipt column counts what is MISSING — the whole reason anyone chases
  // an expense claim.
  assert.equal(colByKey('expenses', 'receipt').settings.summary, 'empty');
});

test('content carries the date a calendar will read', () => {
  assert.deepEqual(colNames('content'), [
    'Piece', 'Channel', 'Publish', 'Writer', 'Brief', 'Live link',
  ]);
  assert.equal(colByKey('content', 'publishDate').type, 'date');
  assert.equal(colByKey('content', 'link').type, 'link');
  assert.equal(seed('content').groups.length, 12);
});

test('every money column is rupees, and every currency column sums', () => {
  // The workspace this was built for bills in rupees; a template that quietly
  // defaulted to dollars is a board somebody has to fix on every column.
  for (const key of ['billing', 'budget', 'pipeline', 'expenses']) {
    const money = seed(key).columns.filter((c) => c.settings?.format === 'currency');
    assert.ok(money.length > 0, `${key} should have a money column`);
    for (const c of money) {
      assert.equal(c.settings.currency, 'INR', `${key}.${c.key} is not in rupees`);
      assert.equal(c.settings.summary, 'sum', `${key}.${c.key} should total`);
    }
  }
});

test('blank seeds nothing at all', () => {
  const s = seed('blank');
  assert.deepEqual(s.columns, []);
  assert.deepEqual(s.groups, []);
  assert.equal(s.visibility, null);
  assert.equal(s.useFlexibleColumns, false);
});

test('a document board says which column a dropped file lands in', () => {
  // Billing, Recruitment and Expenses are the three whose rows are documents
  // you already have. Without `dropColumn` there is nowhere for a dropped file
  // to go and the board silently accepts no drops.
  for (const [key, col] of [['billing', 'pdf'], ['recruitment', 'cv'], ['expenses', 'receipt']]) {
    assert.equal(seed(key).dropColumn, col, `${key} should drop into "${col}"`);
    const target = colByKey(key, col);
    assert.ok(target, `${key} names a dropColumn "${col}" it does not have`);
    assert.equal(target.type, 'file', `${key}.${col} must be a file column`);
  }
});

test('a board with no document column declares no drop target', () => {
  // Dropping a file on a budget or a pipeline should do nothing at all, rather
  // than land somewhere arbitrary.
  for (const key of ['blank', 'budget', 'pipeline', 'content']) {
    assert.equal(seed(key).dropColumn, null, `${key} should accept no drops`);
  }
});

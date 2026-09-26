const test = require('node:test');
const assert = require('node:assert');

const { templateByKey, seedTemplateColumns } = require('./boardTemplates');

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

/**
 * The seed, as `createBoard` builds it.
 *
 * The COLUMNS come from `seedTemplateColumns` — the very function the
 * controller calls. This file used to carry a hand-written copy of that logic,
 * and the copy is exactly what let the board-copy currency bug through: it
 * only ever modelled the built-in templates, so nothing exercised the
 * `board:<id>` branch that re-stamped a CAD board's columns into rupees.
 *
 * `currency` is the board's unit. Defaulted to rupees so every other assertion
 * in this file reads unchanged, since that is what an unconfigured workspace
 * still gets.
 */
const seed = (key, currency = 'INR') => {
  const tpl = templateByKey(key);
  return {
    statuses: tpl.statuses.map((s) => ({ ...s })),
    columns: seedTemplateColumns(tpl, { currency }),
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
    'Invoice', 'PDF', 'Client', 'Amount', 'Payments', 'Issued', 'Due', 'Owner',
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
  /**
   * The client is a pick among the workspace's CLIENT BOARDS (or a typed name
   * for one with no board) — a `client` column. It used to be a
   * `connect_boards` column with no targets, which nobody could ever fill: a
   * client board has no row that is "the client".
   */
  assert.equal(colByKey('billing', 'client').type, 'client');
  assert.deepEqual(colByKey('billing', 'client').settings, {});
  /**
   * What came in, as a LIST beside what was billed. Right after Amount, in the
   * same currency, and totalling — "outstanding" is Amount minus this, so the
   * two must share a unit or the subtraction is nonsense.
   */
  const payments = colByKey('billing', 'payments');
  assert.equal(payments.type, 'payments');
  assert.equal(payments.order, amount.order + 1);
  assert.equal(payments.settings.format, 'currency');
  assert.equal(payments.settings.currency, 'INR');
  assert.equal(payments.settings.summary, 'sum');
  // The columns that MEAN due date and owner say so, so the filters and the
  // overdue rule never have to guess from a key.
  assert.equal(colByKey('billing', 'due').settings.role, 'dueDate');
  assert.equal(colByKey('billing', 'owner').settings.role, 'assignee');
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

test('every money column takes the workspace currency, and every one of them sums', () => {
  /**
   * This used to assert rupees, full stop — "the workspace this was built for
   * bills in rupees". That was true and it was also the bug: an agency billing
   * in dollars had to fix every money column by hand on every board it made.
   *
   * Rupees are still the DEFAULT, so the first half of this is the old
   * assertion unchanged. What is new is the second half, which is the thing
   * worth protecting: a workspace set to something else gets boards in that
   * currency, and no template silently overrides it.
   */
  for (const key of ['billing', 'budget', 'pipeline', 'expenses']) {
    const money = seed(key).columns.filter((c) => c.settings?.format === 'currency');
    assert.ok(money.length > 0, `${key} should have a money column`);
    for (const c of money) {
      assert.equal(c.settings.currency, 'INR', `${key}.${c.key} is not in rupees by default`);
      assert.equal(c.settings.summary, 'sum', `${key}.${c.key} should total`);
    }

    const cad = seed(key, 'CAD').columns.filter((c) => c.settings?.format === 'currency');
    for (const c of cad) {
      assert.equal(c.settings.currency, 'CAD', `${key}.${c.key} ignored the workspace currency`);
      // The rest of the column's settings must survive the substitution — a
      // money column that stopped totalling would be a silent regression.
      assert.equal(c.settings.summary, 'sum', `${key}.${c.key} lost its summary`);
    }
  }
});

test('no money column pins its decimals', () => {
  /**
   * `decimals: 0` used to ride along on every template money column, which
   * rendered an invoice for 1,234.50 as 1,235 — a figure nobody billed. Left
   * unset, the client shows whole amounts whole and fractional ones to two
   * places.
   */
  for (const key of ['billing', 'budget', 'pipeline', 'expenses']) {
    for (const c of seed(key).columns.filter((col) => col.settings?.format === 'currency')) {
      assert.equal(c.settings.decimals, undefined, `${key}.${c.key} still pins decimals`);
    }
  }
});

test('a seeded board never shares a settings object with the registry', () => {
  // The template's settings are constants. A board holding the same object
  // would let one board's in-memory edit reach every board created after it.
  const tpl = templateByKey('recruitment');
  const a = seedTemplateColumns(tpl, { currency: 'INR' });
  const b = seedTemplateColumns(tpl, { currency: 'INR' });
  const roleCol = (cols) => cols.find((c) => c.key === 'role');
  assert.notStrictEqual(roleCol(a).settings, tpl.columns.find((c) => c.key === 'role').settings);
  assert.notStrictEqual(roleCol(a).settings.options, roleCol(b).settings.options);
});

// ---------------------------------------------------------------------------
// Copying a board — `template: 'board:<id>'`
// ---------------------------------------------------------------------------

/** A source board's columns, as createBoard's copy branch hands them over. */
const copied = (columns) => ({ columns });

test('a copy keeps the currency its source chose', () => {
  /**
   * THE BUG: a billing board switched to CAD in an INR workspace, copied, came
   * out with every money column re-stamped INR — so every amount typed into the
   * copy read as rupees. A copy's columns carry real, chosen currencies; the
   * board unit is only for columns that have none.
   */
  const cols = seedTemplateColumns(
    copied([
      { key: 'invoice', name: 'Invoice', type: 'text', isPrimary: true, settings: {} },
      { key: 'amount', name: 'Amount', type: 'number', settings: { format: 'currency', currency: 'CAD', summary: 'sum' } },
      {
        key: 'remaining',
        name: 'Remaining',
        type: 'formula',
        settings: { expression: 'column.amount - 1', format: 'currency', currency: 'CAD' },
      },
    ]),
    { currency: 'INR', fromBoard: true }
  );
  assert.equal(cols.find((c) => c.key === 'amount').settings.currency, 'CAD');
  assert.equal(cols.find((c) => c.key === 'remaining').settings.currency, 'CAD');
  assert.equal(cols.find((c) => c.key === 'amount').settings.summary, 'sum');
});

test('a copied money column with no usable code takes the board unit', () => {
  // Missing, empty, or a code we do not carry: there is nothing to keep, and
  // leaving it open would let it render in whatever the fallback is next week.
  const cols = seedTemplateColumns(
    copied([
      { key: 'a', name: 'A', type: 'number', settings: { format: 'currency' } },
      { key: 'b', name: 'B', type: 'number', settings: { format: 'currency', currency: '' } },
      { key: 'c', name: 'C', type: 'number', settings: { format: 'currency', currency: 'DOLLARS' } },
      { key: 'd', name: 'D', type: 'number', settings: { format: 'percent' } },
    ]),
    { currency: 'CAD', fromBoard: true }
  );
  assert.deepEqual(cols.map((c) => c.settings.currency), ['CAD', 'CAD', 'CAD', undefined]);
});

test('a copied column with a legacy unnormalised code keeps it, normalised', () => {
  // Written before codes were stored normalised: 'cad' and ' CAD ' ARE Canadian
  // dollars to every reader, so the copy must not re-stamp them into the new
  // board's unit — and it stores them the way the client's lookup expects.
  const cols = seedTemplateColumns(
    copied([
      { key: 'a', name: 'A', type: 'number', settings: { format: 'currency', currency: 'cad' } },
      { key: 'b', name: 'B', type: 'number', settings: { format: 'currency', currency: ' CAD ' } },
      { key: 'c', name: 'C', type: 'payments', settings: { format: 'currency', currency: 'usd ' } },
    ]),
    { currency: 'INR', fromBoard: true }
  );
  assert.deepEqual(cols.map((c) => c.settings.currency), ['CAD', 'CAD', 'USD']);
});

test('a built-in template is always re-stamped, placeholder or not', () => {
  // The template's INR is a placeholder, not a choice anybody made.
  const cols = seedTemplateColumns(templateByKey('billing'), { currency: 'CAD' });
  for (const c of cols.filter((col) => col.settings?.format === 'currency')) {
    assert.equal(c.settings.currency, 'CAD', `billing.${c.key}`);
  }
});

// ---------------------------------------------------------------------------
// Board.currency at birth — follow the workspace, or a currency of its own
// ---------------------------------------------------------------------------

const { planNewBoardCurrency, planCopiedBoardCurrency } = require('../services/boardCurrency');

test('a new board follows the workspace unless it asks for a DIFFERENT currency', () => {
  // No choice: follow, and every money column is born in the workspace's unit.
  assert.deepEqual(planNewBoardCurrency({ orgBase: 'CAD' }), { currency: null, stamp: 'CAD' });
  assert.deepEqual(planNewBoardCurrency({ chosen: '', orgBase: 'CAD' }), { currency: null, stamp: 'CAD' });
  // The workspace's own code is not an override — the board still moves with it.
  assert.deepEqual(planNewBoardCurrency({ chosen: 'cad', orgBase: 'CAD' }), { currency: null, stamp: 'CAD' });
  // Anything else is pinned, and the columns are born in it.
  assert.deepEqual(planNewBoardCurrency({ chosen: 'usd', orgBase: 'CAD' }), { currency: 'USD', stamp: 'USD' });
  // A workspace from before `baseCurrency`: rupees, as the templates always were.
  assert.deepEqual(planNewBoardCurrency({}), { currency: null, stamp: 'INR' });
});

test('the seeded columns of a following board are in the workspace unit', () => {
  const { currency, stamp } = planNewBoardCurrency({ orgBase: 'CAD' });
  assert.equal(currency, null);
  const cols = seedTemplateColumns(templateByKey('billing'), { currency: stamp });
  for (const c of cols.filter((col) => col.settings?.format === 'currency')) {
    assert.equal(c.settings.currency, 'CAD', `billing.${c.key}`);
  }
});

test('a copy follows only when its source did AND its columns are in the workspace unit', () => {
  const money = (code, type = 'number') => ({
    key: `k${code}${type}`, type, settings: { format: 'currency', ...(code ? { currency: code } : {}) },
  });
  const plan = (sourceCurrency, sourceEffective, columns, orgBase = 'INR') =>
    planCopiedBoardCurrency({ sourceCurrency, sourceEffective, columns, orgBase });

  assert.equal(plan(null, 'INR', [money('INR'), money('INR', 'payments')]), null);
  // No money at all: nothing to protect, so it follows like its source.
  assert.equal(plan(null, 'INR', []), null);
  // A mirror's unit is its source board's and does not decide this.
  assert.equal(plan(null, 'INR', [money('INR'), money('CAD', 'mirror')]), null);
  // A code-less column takes the source's unit — the workspace's here.
  assert.equal(plan(null, 'INR', [money(null)]), null);

  // The source followed but its columns are in something else: pinned to it.
  assert.equal(plan(null, 'USD', [money('USD')]), 'USD');
  // The source had a currency of its own: so does the copy, even the workspace's.
  assert.equal(plan('CAD', 'CAD', [money('CAD')]), 'CAD');
  assert.equal(plan('INR', 'INR', [money('INR')]), 'INR');
});

test('a non-money column is untouched by the workspace currency', () => {
  // Only `format: 'currency'` columns carry a unit. Stamping one onto a percent
  // or a plain number column would make the cell claim something false.
  for (const key of ['billing', 'budget', 'pipeline', 'expenses']) {
    for (const c of seed(key, 'CAD').columns) {
      if (c.settings?.format === 'currency') continue;
      assert.equal(c.settings?.currency, undefined, `${key}.${c.key} got a currency it has no use for`);
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

const test = require('node:test');
const assert = require('node:assert');

const { snapshotRow, diffRow, MONEY_FIELDS } = require('./adsBudgetActivity');
const { describeActivity, eventLabel } = require('./activityFormat');

/**
 * The diff is the whole feature — more so here than for goals. The Budget
 * Activity ledger IS this history, so a change the diff misses is not merely
 * unaudited: it never appears in the ledger the tab exists to show. No database
 * is involved in either half, so the rules are testable and therefore tested.
 */

const row = (over = {}) => ({
  platform: 'Meta Ads',
  account: '',
  name: '',
  objective: '',
  allocated: 8000,
  spent: 4850,
  dailyBudget: null,
  owner: null,
  lifecycle: 'active',
  notes: '',
  ...over,
});

const fieldsOf = (rows) => rows.map((r) => r.field).sort();
const find = (rows, field) => rows.find((r) => r.field === field);

// ---------------------------------------------------------------------------
// The money, which is what the ledger is made of
// ---------------------------------------------------------------------------

test('a budget increase carries its delta, so the ledger can show +2,000', () => {
  const rows = diffRow(row({ allocated: 8000 }), row({ allocated: 10000 }));
  const r = find(rows, 'allocated');
  assert.strictEqual(r.oldValue, 8000);
  assert.strictEqual(r.newValue, 10000);
  assert.strictEqual(r.metadata.delta, 2000);
});

test('a budget decrease carries a negative delta', () => {
  const rows = diffRow(row({ allocated: 8000 }), row({ allocated: 7500 }));
  assert.strictEqual(find(rows, 'allocated').metadata.delta, -500);
});

test('spend moving is its own ledger line', () => {
  const rows = diffRow(row({ spent: 4210 }), row({ spent: 4850 }));
  assert.strictEqual(find(rows, 'spent').metadata.delta, 640);
});

test('a blank previous value reads as zero in the delta, not NaN', () => {
  // A row created before `spent` was ever filled in has null, and null - 0 is
  // the arithmetic a person would do. NaN would render as an empty amount.
  const rows = diffRow(row({ spent: null }), row({ spent: 300 }));
  assert.strictEqual(find(rows, 'spent').metadata.delta, 300);
});

test('both money fields moving in one save write two separate lines', () => {
  // Topping the budget up AND recording the spend it paid for are two
  // movements, and the ledger must show both rather than netting them off.
  const rows = diffRow(row({ allocated: 8000, spent: 4850 }), row({ allocated: 9000, spent: 5200 }));
  assert.deepStrictEqual(fieldsOf(rows), ['allocated', 'spent']);
});

test('MONEY_FIELDS is exactly what the ledger reader expects', () => {
  // A third money field added to the diff but not here would be logged and then
  // never shown, because the client filters the ledger on this list.
  assert.deepStrictEqual(MONEY_FIELDS, ['allocated', 'spent']);
});

// ---------------------------------------------------------------------------
// Everything else about a row
// ---------------------------------------------------------------------------

test('a save that changed nothing logs nothing', () => {
  // The edit form re-sends every field on every save. Without this, opening a
  // row and pressing Save would post a fictional ledger entry.
  assert.deepStrictEqual(diffRow(row(), row()), []);
});

test('the identity and running fields are all covered', () => {
  const before = row();
  const after = row({
    platform: 'Google Ads',
    account: 'acme-main',
    name: 'Brand Search',
    objective: 'Search',
    dailyBudget: 250,
    lifecycle: 'paused',
    owner: '507f1f77bcf86cd799439011',
    notes: 'paused pending creative',
  });
  assert.deepStrictEqual(fieldsOf(diffRow(before, after)), [
    'account',
    'dailyBudget',
    'lifecycle',
    'name',
    'note',
    'objective',
    'owner',
    'platform',
  ]);
});

test('notes are logged under the shared `note` key, not `notes`', () => {
  // One key for one concept across tasks, goals and budgets — otherwise the
  // board activity export needs a per-subject translation table.
  const rows = diffRow(row({ notes: '' }), row({ notes: 'hello' }));
  assert.strictEqual(find(rows, 'note').newValue, 'hello');
  assert.strictEqual(find(rows, 'notes'), undefined);
});

test('clearing a field is a change, and stores null rather than an empty string', () => {
  const rows = diffRow(row({ objective: 'Search' }), row({ objective: '' }));
  const r = find(rows, 'objective');
  assert.strictEqual(r.oldValue, 'Search');
  assert.strictEqual(r.newValue, null);
});

test('zero is a value, not a blank', () => {
  // Dropping a budget to nothing is a real, and quite significant, movement.
  const rows = diffRow(row({ allocated: 8000 }), row({ allocated: 0 }));
  assert.strictEqual(find(rows, 'allocated').metadata.delta, -8000);
});

test('snapshotRow tolerates a lean document with fields missing', () => {
  const s = snapshotRow({ platform: 'Meta Ads' });
  assert.strictEqual(s.allocated, 0);
  assert.strictEqual(s.spent, 0);
  assert.strictEqual(s.dailyBudget, null);
  assert.strictEqual(s.lifecycle, 'active');
});

test('snapshotRow stringifies the owner so an ObjectId compares by value', () => {
  const owner = { toString: () => '507f1f77bcf86cd799439011' };
  assert.strictEqual(snapshotRow({ platform: 'x', owner }).owner, '507f1f77bcf86cd799439011');
  // And an unchanged owner is not reported as a change just because it is a
  // different object instance each read.
  const before = snapshotRow({ platform: 'x', owner });
  const after = snapshotRow({ platform: 'x', owner: { toString: () => '507f1f77bcf86cd799439011' } });
  assert.deepStrictEqual(diffRow(before, after), []);
});

// ---------------------------------------------------------------------------
// How the rows read — shared with the board activity export
// ---------------------------------------------------------------------------

const meta = (over = {}) => ({
  platform: 'Meta Ads',
  campaignName: '',
  isCampaign: false,
  monthKey: '2026-08',
  group: '507f1f77bcf86cd799439012',
  ...over,
});

test('money sentences say which direction it moved', () => {
  const up = describeActivity({
    actor: { name: 'Aneesh' },
    type: 'ads_budget.field_changed',
    field: 'allocated',
    oldValue: 8000,
    newValue: 10000,
    metadata: meta(),
  });
  assert.match(up, /raised the budget/);
  assert.match(up, /8,000 to 10,000/);

  const down = describeActivity({
    actor: { name: 'Aneesh' },
    type: 'ads_budget.field_changed',
    field: 'spent',
    oldValue: 900,
    newValue: 400,
    metadata: meta(),
  });
  assert.match(down, /lowered the spend/);
});

test('a campaign row names its platform; a platform row does not repeat itself', () => {
  const campaign = describeActivity({
    actor: { name: 'Aneesh' },
    type: 'ads_budget.deleted',
    metadata: meta({ isCampaign: true, campaignName: 'Summer Launch' }),
  });
  assert.match(campaign, /"Summer Launch" on Meta Ads/);

  const platform = describeActivity({
    actor: { name: 'Aneesh' },
    type: 'ads_budget.deleted',
    metadata: meta(),
  });
  assert.match(platform, /"Meta Ads"\./);
});

test('a row with no metadata still produces a sentence rather than "undefined"', () => {
  // Rows written by an older build, or by a path that forgot the context.
  const s = describeActivity({
    actor: { name: 'Aneesh' },
    type: 'ads_budget.field_changed',
    field: 'allocated',
    oldValue: 0,
    newValue: 500,
  });
  assert.match(s, /an ads budget/);
  assert.doesNotMatch(s, /undefined/);
});

test('every ads-budget event type has an export label', () => {
  for (const t of ['ads_budget.created', 'ads_budget.deleted', 'ads_budget.field_changed']) {
    assert.notStrictEqual(eventLabel(t), t, `${t} falls back to its raw key`);
  }
});

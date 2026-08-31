import test from 'node:test';
import assert from 'node:assert';

import {
  STATE_META,
  stateMeta,
  formatPct,
  barPct,
  ledgerRows,
  signedAmount,
} from './adsBudgetDisplay.js';

/**
 * The ledger is the tab's only derived data, and it is derived from a history
 * rather than from a table — so its rules cannot be checked by looking at the
 * screen. The sign convention especially: spend RISING is money leaving, even
 * though its delta is positive, and getting that backwards paints every ad
 * campaign as income.
 */

const entry = (over = {}) => ({
  _id: 'a1',
  type: 'ads_budget.field_changed',
  field: 'allocated',
  oldValue: 0,
  newValue: 2000,
  createdAt: '2026-08-03T10:00:00.000Z',
  metadata: { platform: 'Meta Ads', campaignName: '', isCampaign: false, delta: 2000 },
  actor: { _id: 'u1', name: 'Aneesh' },
  ...over,
});

const one = (over) => ledgerRows([entry(over)])[0];

// ---------------------------------------------------------------------------
// The four movements from the brief's own ledger
// ---------------------------------------------------------------------------

test('a first allocation reads as Budget added, money in', () => {
  const r = one();
  assert.strictEqual(r.activity, 'Budget added');
  assert.strictEqual(r.amount, 2000);
  assert.strictEqual(r.direction, 'in');
});

test('a later allocation change reads as Budget adjustment', () => {
  const r = one({ oldValue: 2000, newValue: 2500, metadata: { ...entry().metadata, delta: 500 } });
  assert.strictEqual(r.activity, 'Budget adjustment');
  assert.strictEqual(r.amount, 500);
  assert.strictEqual(r.direction, 'in');
});

test('spend RISING is money out, despite a positive delta', () => {
  // The one inversion in the file. If this flips, every campaign reads as income.
  const r = one({
    field: 'spent',
    oldValue: 0,
    newValue: 640,
    metadata: { ...entry().metadata, delta: 640 },
  });
  assert.strictEqual(r.activity, 'Campaign spend');
  assert.strictEqual(r.amount, 640);
  assert.strictEqual(r.direction, 'out');
});

test('lowering the budget is money out', () => {
  const r = one({ oldValue: 2500, newValue: 2000, metadata: { ...entry().metadata, delta: -500 } });
  assert.strictEqual(r.activity, 'Budget adjustment');
  assert.strictEqual(r.direction, 'out');
  assert.strictEqual(r.amount, 500, 'the amount is always positive; direction carries the sign');
});

test('correcting spend downwards puts money back', () => {
  const r = one({
    field: 'spent',
    oldValue: 700,
    newValue: 400,
    metadata: { ...entry().metadata, delta: -300 },
  });
  assert.strictEqual(r.activity, 'Spend correction');
  assert.strictEqual(r.direction, 'in');
});

// ---------------------------------------------------------------------------
// What does and does not belong in a ledger
// ---------------------------------------------------------------------------

test('non-money changes are dropped', () => {
  // Renames and pauses are real history and show in a row's own timeline. In a
  // ledger they would bury the four lines somebody opened it to read.
  for (const field of ['platform', 'name', 'objective', 'lifecycle', 'owner', 'note']) {
    assert.deepStrictEqual(ledgerRows([entry({ field, oldValue: 'a', newValue: 'b' })]), []);
  }
});

test('a zero-delta row is not a movement', () => {
  assert.deepStrictEqual(
    ledgerRows([entry({ oldValue: 500, newValue: 500, metadata: { ...entry().metadata, delta: 0 } })]),
    []
  );
});

test('a creation with no opening budget is not a movement', () => {
  // Adding an empty platform row to fill in later is not money changing hands.
  assert.deepStrictEqual(
    ledgerRows([entry({ type: 'ads_budget.created', newValue: { allocated: 0 } })]),
    []
  );
});

test('a creation WITH an opening budget is one', () => {
  const r = one({ type: 'ads_budget.created', newValue: { allocated: 8000 } });
  assert.strictEqual(r.activity, 'Budget added');
  assert.strictEqual(r.amount, 8000);
  assert.strictEqual(r.direction, 'in');
});

test('a deletion removes the money it was holding', () => {
  // After this row the client's allocated total is lower by exactly this much.
  // A ledger that omitted it would not reconcile against the tables above it.
  const r = one({ type: 'ads_budget.deleted', oldValue: { allocated: 1200, spent: 400 } });
  assert.strictEqual(r.activity, 'Budget removed');
  assert.strictEqual(r.amount, 1200);
  assert.strictEqual(r.direction, 'out');
});

test('a missing server delta is recomputed rather than dropped', () => {
  // Rows written by an older build, or by a path that forgot the metadata.
  const r = one({ oldValue: 100, newValue: 450, metadata: { platform: 'Meta Ads' } });
  assert.strictEqual(r.amount, 350);
  assert.strictEqual(r.direction, 'in');
});

test('a campaign row is named by its campaign, a platform row by its platform', () => {
  const platform = one();
  assert.strictEqual(platform.name, 'Meta Ads');

  const campaign = one({
    metadata: { platform: 'Meta Ads', campaignName: 'Summer Launch', isCampaign: true, delta: 2000 },
  });
  assert.strictEqual(campaign.name, 'Summer Launch');
  assert.strictEqual(campaign.platform, 'Meta Ads');
});

test('ledgerRows survives null and an empty list', () => {
  assert.deepStrictEqual(ledgerRows(null), []);
  assert.deepStrictEqual(ledgerRows([]), []);
});

test('signedAmount puts a real minus sign on outgoings', () => {
  const fmt = (n) => `$${n.toLocaleString('en-US')}`;
  assert.strictEqual(signedAmount({ amount: 2000, direction: 'in' }, fmt), '+$2,000');
  assert.strictEqual(signedAmount({ amount: 640, direction: 'out' }, fmt), '−$640');
});

// ---------------------------------------------------------------------------
// The state palette
// ---------------------------------------------------------------------------

test('every state the server can send has a colour here', () => {
  // Mirrors STATES in server/src/utils/adsBudgetPacing.js. A state missing from
  // this map renders as a grey chip carrying a raw key.
  for (const key of ['on_track', 'behind', 'ahead', 'at_risk', 'over', 'draft', 'paused', 'unset']) {
    assert.ok(STATE_META[key], `${key} is missing`);
    assert.ok(STATE_META[key].label && STATE_META[key].color && STATE_META[key].bg);
  }
});

test('red is reserved for over budget alone', () => {
  const red = Object.entries(STATE_META).filter(([, m]) => m.color.includes('stuck'));
  assert.deepStrictEqual(red.map(([k]) => k), ['over']);
});

test('an unknown state is named rather than blanked', () => {
  const m = stateMeta('wildly_over', 'Wildly over');
  assert.strictEqual(m.label, 'Wildly over');
  const bare = stateMeta('something_new');
  assert.strictEqual(bare.label, 'something_new');
});

test('a null percentage is an em dash, never 0%', () => {
  // "This client has no budget" and "this client has spent none of it" are
  // opposite facts that look identical as 0%.
  assert.strictEqual(formatPct(null), '—');
  assert.strictEqual(formatPct(undefined), '—');
  assert.strictEqual(formatPct(0), '0.0%');
  assert.strictEqual(formatPct(0.5712), '57.1%');
});

test('a bar never overflows its track, and never goes negative', () => {
  assert.strictEqual(barPct(1.4), 100);
  assert.strictEqual(barPct(-0.2), 0);
  assert.strictEqual(barPct(null), 0);
  assert.ok(Math.abs(barPct(0.571) - 57.1) < 0.0001);
});

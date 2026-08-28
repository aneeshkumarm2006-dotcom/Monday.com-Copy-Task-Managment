const test = require('node:test');
const assert = require('node:assert');

const { snapshotGoal, diffGoal } = require('./goalActivity');
const { describeActivity } = require('./activityFormat');

/**
 * The diff is the whole feature: every goal history row exists because these
 * rules said something moved. No database is involved in either half — the
 * snapshot is a plain object and `diffGoal` is pure — so the rules that decide
 * what counts as a change are testable, and therefore tested.
 */

const goal = (over = {}) => ({
  name: 'Grow website visits',
  type: 'numeric',
  weight: 1,
  owner: null,
  note: '',
  unit: 'none',
  unitLabel: '',
  actual: null,
  actualDayKey: null,
  config: { baseline: 4200, target: 6000 },
  columnValues: {},
  monthKey: '2026-08',
  ...over,
});

const fieldsOf = (rows) => rows.map((r) => r.field).sort();

test('a save that changed nothing writes nothing', () => {
  const before = snapshotGoal(goal());
  const after = snapshotGoal(goal());
  assert.deepStrictEqual(diffGoal(before, after), []);
});

test('the edit form re-sending every field is not a change', () => {
  // The form posts name, type, config, unit and weight on every save. Only the
  // one the user actually touched may be logged.
  const before = snapshotGoal(goal());
  const after = snapshotGoal(goal({ config: { baseline: 4200, target: 7000 } }));
  const rows = diffGoal(before, after);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].field, 'config:target');
  assert.strictEqual(rows[0].oldValue, 6000);
  assert.strictEqual(rows[0].newValue, 7000);
});

test('a config key that was cleared logs as a move to null, not as absent', () => {
  const before = snapshotGoal(goal());
  const after = snapshotGoal(goal({ config: { target: 6000 } }));
  const rows = diffGoal(before, after);
  assert.deepStrictEqual(fieldsOf(rows), ['config:baseline']);
  assert.strictEqual(rows[0].oldValue, 4200);
  assert.strictEqual(rows[0].newValue, null);
});

test('zero is a value, not a blank', () => {
  const before = snapshotGoal(goal({ actual: null }));
  const after = snapshotGoal(goal({ actual: 0 }));
  const rows = diffGoal(before, after);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].newValue, 0);
});

test('empty string and null both mean "not set" and do not log against each other', () => {
  const before = snapshotGoal(goal({ note: '' }));
  const after = snapshotGoal(goal({ note: null }));
  assert.deepStrictEqual(diffGoal(before, after), []);
});

test('unit and its label are one fact, logged once', () => {
  const before = snapshotGoal(goal({ unit: 'none', unitLabel: '' }));
  const after = snapshotGoal(goal({ unit: 'currency', unitLabel: '$' }));
  const rows = diffGoal(before, after);
  assert.deepStrictEqual(fieldsOf(rows), ['unit']);
  assert.strictEqual(rows[0].newValue, '$');
});

test('changing the KIND of goal logs the kind and the result it invalidated', () => {
  // updateGoal nulls `actual` when the type changes, because a number recorded
  // against "move a number" is not a Yes/No answer.
  const before = snapshotGoal(goal({ actual: 5640 }));
  const after = snapshotGoal(goal({ type: 'boolean', actual: null, config: {} }));
  assert.deepStrictEqual(
    fieldsOf(diffGoal(before, after)),
    ['actual', 'config:baseline', 'config:target', 'goalType']
  );
});

test('an extra column carries its name and type, keyed by column id', () => {
  const columns = [{ _id: 'c1', name: 'Channel', type: 'dropdown' }];
  const before = snapshotGoal(goal({ columnValues: {} }));
  const after = snapshotGoal(goal({ columnValues: { c1: 'Organic' } }));
  const rows = diffGoal(before, after, columns);
  assert.strictEqual(rows[0].field, 'column:c1');
  assert.strictEqual(rows[0].metadata.columnLabel, 'Channel');
  assert.strictEqual(rows[0].metadata.columnType, 'dropdown');
});

test('a person column with the same ids in the same order is not a change', () => {
  const before = snapshotGoal(goal({ columnValues: { c1: ['u1', 'u2'] } }));
  const after = snapshotGoal(goal({ columnValues: { c1: ['u1', 'u2'] } }));
  assert.deepStrictEqual(diffGoal(before, after), []);
});

test('owner is compared as an id, however it arrived', () => {
  const before = snapshotGoal(goal({ owner: { toString: () => 'u1' } }));
  const after = snapshotGoal(goal({ owner: 'u1' }));
  assert.deepStrictEqual(diffGoal(before, after), []);
});

test('the sentence for a reported result reads as a report, not a diff', () => {
  const entry = {
    type: 'goal.field_changed',
    field: 'actual',
    oldValue: null,
    newValue: 5640,
    actor: { name: 'Ann' },
    metadata: { goalName: 'Grow website visits', goalTypeKey: 'numeric' },
  };
  assert.strictEqual(
    describeActivity(entry),
    'Ann reported 5640 for "Grow website visits".'
  );
});

test('a boolean goal describes its result in words, not as 1 and 0', () => {
  const entry = {
    type: 'goal.field_changed',
    field: 'actual',
    oldValue: 0,
    newValue: 1,
    actor: { name: 'Ann' },
    metadata: { goalName: 'Publish the case study', goalTypeKey: 'boolean' },
  };
  assert.strictEqual(
    describeActivity(entry),
    'Ann changed result on "Publish the case study" from No to Yes.'
  );
});

test('importance is described by the word the UI shows, not the stored number', () => {
  const entry = {
    type: 'goal.field_changed',
    field: 'weight',
    oldValue: 1,
    newValue: 3,
    actor: { name: 'Ann' },
    metadata: { goalName: 'Ship 12 ad creatives', goalTypeKey: 'checklist' },
  };
  assert.strictEqual(
    describeActivity(entry),
    'Ann changed importance on "Ship 12 ad creatives" from Normal to Critical.'
  );
});

test('a deleted goal still names itself, from metadata alone', () => {
  const entry = {
    type: 'goal.deleted',
    actor: { name: 'Ann' },
    metadata: { goalName: 'Keep ad spend under budget' },
  };
  assert.strictEqual(
    describeActivity(entry),
    'Ann deleted the goal "Keep ad spend under budget".'
  );
});

test('task events are untouched by any of this', () => {
  assert.strictEqual(
    describeActivity({ type: 'task.created', actor: { name: 'Ann' } }),
    'Ann created the task.'
  );
});

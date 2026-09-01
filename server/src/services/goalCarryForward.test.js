const { test } = require('node:test');
const assert = require('node:assert');

const {
  SKIP_REASONS,
  shiftConfigMonths,
  rollBaselineForward,
  missingRequiredColumns,
  planCarryForward,
} = require('./goalCarryForward');

const { shiftDayKeyByMonths } = require('../utils/monthKey');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GROUP_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const GROUP_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const groups = [
  { _id: GROUP_A, name: 'Client A', order: 0 },
  { _id: GROUP_B, name: 'Client B', order: 1 },
];

let counter = 0;
const goal = (over = {}) => ({
  _id: `goal${(counter += 1)}`,
  group: GROUP_A,
  name: 'Grow organic traffic',
  nameKey: 'grow organic traffic',
  type: 'numeric',
  config: { baseline: 4200, target: 6000 },
  unit: 'none',
  unitLabel: '',
  weight: 1,
  owner: null,
  note: '',
  columnValues: {},
  actual: null,
  actualDayKey: null,
  order: 0,
  ...over,
});

const plan = (over = {}) => planCarryForward({
  sourceGoals: [],
  targetGoals: [],
  groups,
  columns: [],
  toMonth: '2026-10',
  monthDelta: 1,
  ...over,
});

// ---------------------------------------------------------------------------
// The promise travels, the result does not — the whole point of the feature
// ---------------------------------------------------------------------------

test('a copy carries the promise and NOT the result', () => {
  const { copies } = plan({
    sourceGoals: [goal({ actual: 5100, weight: 3, note: 'agreed with the client' })],
  });

  assert.equal(copies.length, 1);
  const copy = copies[0];
  assert.equal(copy.name, 'Grow organic traffic');
  assert.equal(copy.type, 'numeric');
  assert.deepEqual(copy.config, { baseline: 4200, target: 6000 });
  assert.equal(copy.weight, 3);
  assert.equal(copy.note, 'agreed with the client');
  assert.equal(copy.monthKey, '2026-10');

  // The result is the thing that must never travel: copying 5,100 forward would
  // report last month's number as this month's.
  assert.equal(copy.actual, null);
  assert.equal(copy.actualDayKey, null);
});

test('the copy remembers which row it came from, for the link carry', () => {
  const source = goal();
  const { copies } = plan({ sourceGoals: [source] });
  assert.equal(copies[0].sourceId, String(source._id));
});

// ---------------------------------------------------------------------------
// Idempotent by name — running it twice must not duplicate a table
// ---------------------------------------------------------------------------

test('a goal already in the target month is skipped, not duplicated', () => {
  const source = goal();
  const { copies, skipped } = plan({
    sourceGoals: [source],
    targetGoals: [{ group: GROUP_A, nameKey: 'grow organic traffic', order: 0 }],
  });

  assert.equal(copies.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, SKIP_REASONS.EXISTS);
  assert.equal(skipped[0].groupName, 'Client A');
});

test('the duplicate check is per GROUP — the same name in another group travels', () => {
  const { copies, skipped } = plan({
    sourceGoals: [goal({ group: GROUP_B })],
    targetGoals: [{ group: GROUP_A, nameKey: 'grow organic traffic', order: 0 }],
  });

  assert.equal(skipped.length, 0);
  assert.equal(copies.length, 1);
  assert.equal(String(copies[0].group), GROUP_B);
});

test('the duplicate check normalises case and whitespace, like nameKey does', () => {
  const { copies, skipped } = plan({
    // A row written before `nameKey` existed has only a name to go on.
    sourceGoals: [goal({ name: 'Grow  Organic   Traffic', nameKey: undefined })],
    targetGoals: [{ group: GROUP_A, nameKey: 'grow organic traffic', order: 0 }],
  });

  assert.equal(copies.length, 0);
  assert.equal(skipped[0].reason, SKIP_REASONS.EXISTS);
});

test('two identically named source rows in one group cannot both travel', () => {
  const { copies, skipped } = plan({
    sourceGoals: [goal(), goal()],
  });

  assert.equal(copies.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, SKIP_REASONS.EXISTS);
});

// ---------------------------------------------------------------------------
// Ordering — copies append to whatever is already in the target month
// ---------------------------------------------------------------------------

test('copies append after the rows already in the target group', () => {
  const { copies } = plan({
    sourceGoals: [
      goal({ name: 'One', nameKey: 'one' }),
      goal({ name: 'Two', nameKey: 'two' }),
    ],
    targetGoals: [
      { group: GROUP_A, nameKey: 'already here', order: 0 },
      { group: GROUP_A, nameKey: 'and here', order: 1 },
    ],
  });

  assert.deepEqual(copies.map((c) => c.order), [2, 3]);
});

test('each group gets its own order sequence', () => {
  const { copies } = plan({
    sourceGoals: [
      goal({ name: 'One', nameKey: 'one', group: GROUP_A }),
      goal({ name: 'Two', nameKey: 'two', group: GROUP_B }),
      goal({ name: 'Three', nameKey: 'three', group: GROUP_A }),
    ],
  });

  assert.deepEqual(copies.map((c) => [String(c.group), c.order]), [
    [GROUP_A, 0],
    [GROUP_B, 0],
    [GROUP_A, 1],
  ]);
});

// ---------------------------------------------------------------------------
// A deadline's due date moves with the copy
// ---------------------------------------------------------------------------

test('a deadline goal gets its due date shifted by the same months', () => {
  const config = shiftConfigMonths('deadline', { dueDayKey: '2026-09-05', penaltyPerDay: 5 }, 1);
  assert.equal(config.dueDayKey, '2026-10-05');
  // Everything else in the promise is untouched.
  assert.equal(config.penaltyPerDay, 5);
});

test('a due date on the 31st clamps rather than rolling into the next month', () => {
  assert.equal(shiftDayKeyByMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(shiftDayKeyByMonths('2028-01-31', 1), '2028-02-29');
});

test('shifting backwards works, for filling in a month somebody missed', () => {
  const config = shiftConfigMonths('deadline', { dueDayKey: '2026-09-05' }, -1);
  assert.equal(config.dueDayKey, '2026-08-05');
});

test('only deadline goals have anything to shift', () => {
  const config = shiftConfigMonths('numeric', { baseline: 1, target: 2 }, 1);
  assert.deepEqual(config, { baseline: 1, target: 2 });
});

test('a deadline with an unusable due date keeps it rather than losing it', () => {
  const config = shiftConfigMonths('deadline', { dueDayKey: 'not-a-date' }, 1);
  assert.equal(config.dueDayKey, 'not-a-date');
});

test('a deadline copy carries a shifted due date end to end', () => {
  const { copies } = plan({
    sourceGoals: [goal({
      name: 'Monthly report',
      nameKey: 'monthly report',
      type: 'deadline',
      config: { dueDayKey: '2026-09-05' },
      actual: null,
      actualDayKey: '2026-09-04',
    })],
  });

  assert.equal(copies[0].config.dueDayKey, '2026-10-05');
  assert.equal(copies[0].actualDayKey, null);
});

// ---------------------------------------------------------------------------
// Rolling the starting point — off unless asked
// ---------------------------------------------------------------------------

test('the baseline does not roll unless asked', () => {
  const { copies } = plan({ sourceGoals: [goal({ actual: 5100 })] });
  assert.equal(copies[0].config.baseline, 4200);
});

test('rollBaseline starts the new month from where the old one finished', () => {
  const { copies } = plan({
    sourceGoals: [goal({ actual: 5100 })],
    rollBaseline: true,
  });
  assert.equal(copies[0].config.baseline, 5100);
  assert.equal(copies[0].config.target, 6000);
});

test('a month with no reported result keeps its old starting point', () => {
  const { copies } = plan({
    sourceGoals: [goal({ actual: null })],
    rollBaseline: true,
  });
  assert.equal(copies[0].config.baseline, 4200);
});

test('only numeric goals have a baseline to roll', () => {
  const config = { direction: 'atMost', limit: 40 };
  assert.deepEqual(rollBaselineForward('threshold', config, 12), config);
  assert.deepEqual(rollBaselineForward('band', { low: 3, high: 5 }, 4), { low: 3, high: 5 });
});

test('a zero result rolls — it is a value, not a blank', () => {
  assert.equal(rollBaselineForward('numeric', { target: 10 }, 0).baseline, 0);
});

// ---------------------------------------------------------------------------
// The copy has to be a goal the board would have accepted
// ---------------------------------------------------------------------------

test('a goal whose promise no longer validates is skipped with the reason', () => {
  const { copies, skipped } = plan({
    // A numeric goal needs a target. This one predates that rule.
    sourceGoals: [goal({ config: { baseline: 4200 } })],
  });

  assert.equal(copies.length, 0);
  assert.equal(skipped[0].reason, SKIP_REASONS.BAD_TYPE);
  assert.match(skipped[0].detail, /aiming for/);
});

test('a goal of a retired type is skipped rather than crashing the batch', () => {
  const { copies, skipped } = plan({ sourceGoals: [goal({ type: 'sales-velocity' })] });
  assert.equal(copies.length, 0);
  assert.equal(skipped[0].reason, SKIP_REASONS.BAD_TYPE);
});

test('a goal whose group is gone is skipped', () => {
  const { copies, skipped } = plan({
    sourceGoals: [goal({ group: 'cccccccccccccccccccccccc' })],
  });
  assert.equal(copies.length, 0);
  assert.equal(skipped[0].reason, SKIP_REASONS.GROUP_GONE);
});

// ---------------------------------------------------------------------------
// Required columns
// ---------------------------------------------------------------------------

test('column values travel with the promise', () => {
  const { copies } = plan({
    sourceGoals: [goal({ columnValues: { c1: 'Retainer' } })],
    columns: [{ _id: 'c1', name: 'Plan', required: true }],
  });
  assert.deepEqual(copies[0].columnValues, { c1: 'Retainer' });
});

test('a column that became required after the source was written blocks its copy', () => {
  const { copies, skipped } = plan({
    sourceGoals: [goal({ columnValues: {} })],
    columns: [{ _id: 'c1', name: 'Plan', required: true }],
  });

  assert.equal(copies.length, 0);
  assert.equal(skipped[0].reason, SKIP_REASONS.REQUIRED);
  assert.equal(skipped[0].detail, 'Plan');
});

test('an archived required column is not required', () => {
  const { copies } = plan({
    sourceGoals: [goal()],
    columns: [{ _id: 'c1', name: 'Plan', required: true, archived: true }],
  });
  assert.equal(copies.length, 1);
});

test('missingRequiredColumns treats an empty array as blank but 0 as a value', () => {
  const columns = [
    { _id: 'c1', name: 'People', required: true },
    { _id: 'c2', name: 'Count', required: true },
  ];
  assert.deepEqual(missingRequiredColumns({ c1: [], c2: 0 }, columns), ['People']);
});

// ---------------------------------------------------------------------------
// The per-group cap
// ---------------------------------------------------------------------------

test('a target group already at the cap takes nothing more', () => {
  const targetGoals = Array.from({ length: 3 }, (_, i) => ({
    group: GROUP_A, nameKey: `existing ${i}`, order: i,
  }));

  const { copies, skipped } = plan({
    sourceGoals: [goal({ name: 'New one', nameKey: 'new one' })],
    targetGoals,
    maxPerGroup: 3,
  });

  assert.equal(copies.length, 0);
  assert.equal(skipped[0].reason, SKIP_REASONS.FULL);
});

test('the cap counts rows this same carry is about to add', () => {
  const { copies, skipped } = plan({
    sourceGoals: [
      goal({ name: 'One', nameKey: 'one' }),
      goal({ name: 'Two', nameKey: 'two' }),
      goal({ name: 'Three', nameKey: 'three' }),
    ],
    maxPerGroup: 2,
  });

  assert.deepEqual(copies.map((c) => c.name), ['One', 'Two']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, SKIP_REASONS.FULL);
});

// ---------------------------------------------------------------------------
// Shape guarantees the controller relies on
// ---------------------------------------------------------------------------

test('every skip names the row and its group, so the modal can say what happened', () => {
  const { skipped } = plan({
    sourceGoals: [goal({ name: 'Rank for best crm', nameKey: 'rank for best crm' })],
    targetGoals: [{ group: GROUP_A, nameKey: 'rank for best crm', order: 0 }],
  });

  assert.deepEqual(Object.keys(skipped[0]).sort(), [
    'goalId', 'group', 'groupName', 'name', 'reason',
  ]);
});

test('planning nothing is not an error', () => {
  const { copies, skipped } = plan({ sourceGoals: [] });
  assert.deepEqual(copies, []);
  assert.deepEqual(skipped, []);
});

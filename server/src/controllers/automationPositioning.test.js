const { test } = require('node:test');
const assert = require('node:assert');

const {
  computePositionedOrder,
  sanitizeActionConfig,
} = require('./automationController');

// Build a minimal task-like object. `computePositionedOrder` only reads
// _id / dueDate / priority / assignedTo, and calls .toString() on ids — plain
// strings satisfy that.
const task = (id, extra = {}) => ({
  _id: id,
  order: 0,
  createdAt: new Date('2026-01-01'),
  dueDate: null,
  priority: 'medium',
  assignedTo: [],
  ...extra,
});

const ids = (tasks) => tasks.map((t) => t._id);

test('top: floats the triggering task first, keeps the rest in order', () => {
  const tasks = [task('a'), task('b'), task('c')];
  assert.deepStrictEqual(computePositionedOrder(tasks, 'top', 'c'), ['c', 'a', 'b']);
});

test('top: no-op when the triggering task is already first', () => {
  const tasks = [task('a'), task('b')];
  assert.deepStrictEqual(computePositionedOrder(tasks, 'top', 'a'), ['a', 'b']);
});

test('dueDate: soonest first, tasks with no due date sink to the bottom', () => {
  const tasks = [
    task('mar', { dueDate: '2026-03-01' }),
    task('none', { dueDate: null }),
    task('jan', { dueDate: '2026-01-01' }),
    task('feb', { dueDate: '2026-02-01' }),
  ];
  assert.deepStrictEqual(
    computePositionedOrder(tasks, 'dueDate', 'feb'),
    ['jan', 'feb', 'mar', 'none']
  );
});

test('dueDate: equal dates keep their current relative order (stable)', () => {
  const tasks = [
    task('x', { dueDate: '2026-05-01' }),
    task('y', { dueDate: '2026-05-01' }),
  ];
  assert.deepStrictEqual(computePositionedOrder(tasks, 'dueDate', 'y'), ['x', 'y']);
});

test('priority: critical → high → medium → low', () => {
  const tasks = [
    task('med', { priority: 'medium' }),
    task('crit', { priority: 'critical' }),
    task('low', { priority: 'low' }),
    task('high', { priority: 'high' }),
  ];
  assert.deepStrictEqual(
    computePositionedOrder(tasks, 'priority', 'high'),
    ['crit', 'high', 'med', 'low']
  );
});

test('priority: equal priorities keep their current relative order (stable)', () => {
  const tasks = [
    task('a', { priority: 'high' }),
    task('b', { priority: 'high' }),
  ];
  assert.deepStrictEqual(computePositionedOrder(tasks, 'priority', 'b'), ['a', 'b']);
});

test('assignee: groups by first assignee in first-seen order, unassigned last', () => {
  const tasks = [
    task('a', { assignedTo: ['u1'] }),
    task('b', { assignedTo: ['u2'] }),
    task('c', { assignedTo: ['u1'] }),
    task('d', { assignedTo: [] }),
    task('e', { assignedTo: ['u2'] }),
  ];
  // u1 first appears at a → [a, c]; u2 at b → [b, e]; unassigned → [d].
  assert.deepStrictEqual(
    computePositionedOrder(tasks, 'assignee', 'e'),
    ['a', 'c', 'b', 'e', 'd']
  );
});

test('returns one id per input task (no drops, no dupes) for every strategy', () => {
  const tasks = [
    task('a', { assignedTo: ['u1'], dueDate: '2026-02-01', priority: 'low' }),
    task('b', { assignedTo: ['u2'], dueDate: null, priority: 'critical' }),
    task('c', { assignedTo: [], dueDate: '2026-01-01', priority: 'high' }),
  ];
  for (const strategy of ['top', 'dueDate', 'priority', 'assignee']) {
    const out = computePositionedOrder(tasks, strategy, 'a');
    assert.deepStrictEqual(
      [...out].sort(),
      [...ids(tasks)].sort(),
      `strategy ${strategy} must preserve the exact set of ids`
    );
  }
});

// --- save-path validation (sanitizeActionConfig) ---------------------------
// The POSITION_ITEM branch returns before touching board/boardId/org, so it's
// safe to call with nulls — no DB access happens.

test('sanitizeActionConfig: accepts a valid strategy and keeps only { strategy }', async () => {
  const res = await sanitizeActionConfig(
    'POSITION_ITEM',
    { strategy: 'dueDate', name: 'ignored', group: 'ignored' },
    null,
    null,
    null
  );
  assert.deepStrictEqual(res, { config: { strategy: 'dueDate' } });
});

test('sanitizeActionConfig: rejects an unknown strategy', async () => {
  const res = await sanitizeActionConfig('POSITION_ITEM', { strategy: 'nope' }, null, null, null);
  assert.ok(res.error, 'expected an error for an invalid strategy');
  assert.strictEqual(res.config, undefined);
});

test('sanitizeActionConfig: rejects a missing strategy', async () => {
  const res = await sanitizeActionConfig('POSITION_ITEM', {}, null, null, null);
  assert.ok(res.error, 'expected an error when strategy is absent');
});

const { test } = require('node:test');
const assert = require('node:assert');

const { reorderWriteOps } = require('./taskController');

/**
 * "Time in stage" — the one number the stages view adds that no column shows.
 *
 * A pipeline card says how long its deal has sat where it is, and that is the
 * whole diagnostic value of the view: a deal in Qualified for six weeks is a
 * specific, actionable problem. It reads `Task.groupChangedAt`, and the rule is
 * narrow enough to break by accident — stamp on every write and tidying a
 * column's order silently resets every clock in it, which looks like nothing at
 * all going wrong.
 *
 * `updatedAt` cannot stand in for this, which is why the field exists: editing
 * a note or ticking a checkbox would make a stale deal look fresh.
 */

const A = '64a000000000000000000001';
const B = '64a000000000000000000002';
const C = '64a000000000000000000003';
const STAGE_1 = '64b000000000000000000001';
const STAGE_2 = '64b000000000000000000002';

const AT = new Date('2026-09-09T10:00:00.000Z');

/** A task as `reorderTasks` selects it: id + its CURRENT group. */
const task = (id, group) => ({ _id: id, group });

const setOf = (ops, id) => ops.find((o) => o.updateOne.filter._id === id).updateOne.update.$set;

test('a reorder inside one stage stamps nothing', () => {
  // The regression this file exists for. All three are already in STAGE_1 and
  // are only being reordered, so not one clock may move.
  const prior = [task(A, STAGE_1), task(B, STAGE_1), task(C, STAGE_1)];
  const ops = reorderWriteOps([C, A, B], prior, STAGE_1, AT);

  assert.equal(ops.length, 3);
  for (const id of [A, B, C]) {
    assert.ok(
      !('groupChangedAt' in setOf(ops, id)),
      `${id} was only reordered and must not be re-stamped`
    );
  }
  // …and the order is still written, which is the other half of the job.
  assert.equal(setOf(ops, C).order, 0);
  assert.equal(setOf(ops, A).order, 1);
  assert.equal(setOf(ops, B).order, 2);
});

test('a card arriving from another stage is stamped', () => {
  const prior = [task(A, STAGE_1), task(B, STAGE_2)];
  const ops = reorderWriteOps([A, B], prior, STAGE_2, AT);

  assert.equal(setOf(ops, A).groupChangedAt, AT, 'A moved stages and must be stamped');
  assert.ok(!('groupChangedAt' in setOf(ops, B)), 'B was already here');
});

test('every card moved by one drag shares an instant', () => {
  // A bulk move must not spread its rows across however long the loop took —
  // two cards moved together that sort differently by age would be nonsense.
  const prior = [task(A, STAGE_1), task(B, STAGE_1), task(C, STAGE_2)];
  const ops = reorderWriteOps([A, B, C], prior, STAGE_2, AT);
  assert.equal(setOf(ops, A).groupChangedAt, AT);
  assert.equal(setOf(ops, B).groupChangedAt, AT);
  assert.equal(setOf(ops, A).groupChangedAt, setOf(ops, B).groupChangedAt);
});

test('every op sets order and the target group, stamped or not', () => {
  const prior = [task(A, STAGE_1), task(B, STAGE_2)];
  const ops = reorderWriteOps([A, B], prior, STAGE_2, AT);
  ops.forEach((op, i) => {
    const $set = op.updateOne.update.$set;
    assert.equal($set.order, i);
    assert.equal($set.group, STAGE_2);
  });
});

test('a task with no group yet counts as having moved', () => {
  // Legacy rows predating groups, and anything whose group was cleared. Null is
  // not the target group, so the stamp is correct — and it beats leaving the
  // card with no age at all.
  const ops = reorderWriteOps([A], [task(A, null)], STAGE_1, AT);
  assert.equal(setOf(ops, A).groupChangedAt, AT);
});

test('an id with no prior row is treated as arriving', () => {
  // Defensive: `reorderTasks` refuses a batch whose ids it could not all load,
  // so this cannot happen today. If that guard is ever relaxed, the safe answer
  // is "it moved" — a spurious stamp resets one clock, a missing one leaves a
  // card claiming an age it never had.
  const ops = reorderWriteOps([A], [], STAGE_1, AT);
  assert.equal(setOf(ops, A).groupChangedAt, AT);
});

test('ids and groups compare as strings, not by reference', () => {
  // The controller hands in mongoose ObjectIds and the client hands in strings.
  // Comparing them with === without normalising would stamp every row on every
  // drag — the exact bug this rule is meant to prevent, arriving silently.
  const oid = (v) => ({ toString: () => v });
  const ops = reorderWriteOps([A], [{ _id: oid(A), group: oid(STAGE_1) }], oid(STAGE_1), AT);
  assert.ok(
    !('groupChangedAt' in setOf(ops, A)),
    'an ObjectId-shaped group equal to the target must read as "did not move"'
  );
});

test('an empty batch produces no writes', () => {
  assert.deepEqual(reorderWriteOps([], [], STAGE_1, AT), []);
  assert.deepEqual(reorderWriteOps(null, null, STAGE_1, AT), []);
});

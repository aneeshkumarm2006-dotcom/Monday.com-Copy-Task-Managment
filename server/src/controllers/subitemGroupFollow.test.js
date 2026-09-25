const { test } = require('node:test');
const assert = require('node:assert');

const {
  movedGroupIds,
  subitemGroupFollow,
  reorderWriteOps,
} = require('./taskController');

/**
 * A family moves together.
 *
 * A subitem stores its own `group`, and for a long time nothing carried it
 * across when its parent was re-homed. The result is invisible until a group is
 * deleted, and then it is not recoverable: every task delete in the server keys
 * on `group` alone, so deleting the group the parent LEFT wipes live subitems of
 * a task that still exists elsewhere, and deleting the group it ARRIVED in
 * leaves the children behind a dead parent, off the board and off every link.
 *
 * These tests pin the two decisions that fix has to get right — which parents
 * count as moving (`movedGroupIds`) and which child rows follow them
 * (`subitemGroupFollow`) — plus the one thing that must NOT change as a result:
 * `reorderWriteOps` still returns a flat list of `updateOne`s, because the child
 * write is a separate `updateMany` and stageMove.test.js walks every op it
 * returns.
 *
 * Both functions are pure, and ids only ever need `.toString()`, so plain
 * strings stand in for ObjectIds throughout.
 */

const A = '64a000000000000000000001';
const B = '64a000000000000000000002';
const C = '64a000000000000000000003';
const GROUP_1 = '64b000000000000000000001';
const GROUP_2 = '64b000000000000000000002';

const AT = new Date('2026-09-19T10:00:00.000Z');

/** A task as `reorderTasks` selects it: id + its CURRENT group. */
const task = (id, group) => ({ _id: id, group });

// ---------------------------------------------------------------------------
// movedGroupIds — which parents are actually changing group
// ---------------------------------------------------------------------------

test('a drag inside one group moves nobody', () => {
  // The case that must cost nothing: reordering a column has to leave every
  // subitem row untouched, exactly as it leaves every `groupChangedAt` alone.
  const prior = [task(A, GROUP_1), task(B, GROUP_1)];
  assert.deepEqual(movedGroupIds([B, A], prior, GROUP_1), []);
});

test('only the cards that crossed a boundary count', () => {
  const prior = [task(A, GROUP_1), task(B, GROUP_2)];
  assert.deepEqual(movedGroupIds([A, B], prior, GROUP_2), [A]);
});

test('a card with no group yet counts as moving', () => {
  // Legacy rows predating groups. Null is not the target, and pulling their
  // children along with them is the right answer either way.
  assert.deepEqual(movedGroupIds([A], [task(A, null)], GROUP_1), [A]);
});

test('an id with no prior row counts as moving', () => {
  // `reorderTasks` refuses a batch whose ids it could not all load, so this
  // cannot happen today. If that guard is ever relaxed, "it moved" is the safe
  // answer: a redundant child write is a no-op, a missing one splits a family.
  assert.deepEqual(movedGroupIds([A], [], GROUP_1), [A]);
});

test('ids and groups compare as strings, not by reference', () => {
  // The controller hands in mongoose ObjectIds and the client hands in strings.
  // Comparing them with === without normalising would report every row on every
  // drag as moved, and rewrite every subitem in the board on a pure reorder.
  const oid = (v) => ({ toString: () => v });
  const moved = movedGroupIds([A], [{ _id: oid(A), group: oid(GROUP_1) }], oid(GROUP_1));
  assert.deepEqual(moved, []);
});

test('an empty batch moves nobody', () => {
  assert.deepEqual(movedGroupIds([], [], GROUP_1), []);
  assert.deepEqual(movedGroupIds(null, null, GROUP_1), []);
});

// ---------------------------------------------------------------------------
// subitemGroupFollow — which child rows follow
// ---------------------------------------------------------------------------

test('the children of the moving parents follow them', () => {
  const follow = subitemGroupFollow([A, B], GROUP_2);
  assert.deepEqual(follow.filter.parent, { $in: [A, B] });
  assert.deepEqual(follow.update, { $set: { group: GROUP_2 } });
});

test('children already in the target group are excluded', () => {
  // The filter is about DIVERGENCE, not about this request. That is what makes
  // re-issuing a half-completed move a repair instead of a no-op, and what
  // keeps a reorder that touches an already-correct family free.
  const follow = subitemGroupFollow([A], GROUP_2);
  assert.deepEqual(follow.filter.group, { $ne: GROUP_2 });
});

test('the write carries group and nothing else', () => {
  // `groupChangedAt` is "time in stage" for a top-level card on the stages view.
  // A subitem is never on that view, so stamping one would put a clock on a row
  // nothing can show — and would quietly widen a fix into a data change.
  const follow = subitemGroupFollow([A], GROUP_2);
  assert.deepEqual(Object.keys(follow.update), ['$set']);
  assert.deepEqual(Object.keys(follow.update.$set), ['group']);
  assert.ok(!('order' in follow.update.$set));
});

test('nothing to carry returns null rather than a write that matches everything', () => {
  // A bare `{ parent: { $in: [] } }` would be harmless, but a caller that
  // skipped the emptiness check and built the filter some other way would not
  // be. Returning null makes "there is no write here" the explicit answer, and
  // lets the caller skip the round trip.
  assert.strictEqual(subitemGroupFollow([], GROUP_2), null);
  assert.strictEqual(subitemGroupFollow(null, GROUP_2), null);
  assert.strictEqual(subitemGroupFollow([null, undefined], GROUP_2), null);
  assert.strictEqual(subitemGroupFollow([A], null), null);
});

// ---------------------------------------------------------------------------
// The two together, as `reorderTasks` composes them
// ---------------------------------------------------------------------------

test('a cross-group drag carries exactly the arriving cards\' children', () => {
  const prior = [task(A, GROUP_1), task(B, GROUP_2), task(C, GROUP_1)];
  const follow = subitemGroupFollow(
    movedGroupIds([A, B, C], prior, GROUP_2),
    GROUP_2
  );
  // B was already there, so its subitems are not rewritten.
  assert.deepEqual(follow.filter.parent, { $in: [A, C] });
});

test('a pure reorder produces no child write at all', () => {
  const prior = [task(A, GROUP_1), task(B, GROUP_1)];
  const follow = subitemGroupFollow(movedGroupIds([B, A], prior, GROUP_1), GROUP_1);
  assert.strictEqual(follow, null);
});

test('reorderWriteOps still returns only updateOne ops', () => {
  // The child write is issued separately on purpose. If it were ever folded into
  // this list, every consumer that walks the ops — stageMove.test.js does —
  // would hit an op with no `updateOne` and fail in a way that reads like an
  // unrelated bug.
  const prior = [task(A, GROUP_1), task(B, GROUP_2)];
  const ops = reorderWriteOps([A, B], prior, GROUP_2, AT);
  assert.equal(ops.length, 2);
  for (const op of ops) {
    assert.ok(op.updateOne, 'every reorder op is an updateOne keyed by _id');
    assert.ok(!op.updateMany);
  }
});

test('reorderWriteOps and movedGroupIds agree on who moved', () => {
  // The two used to answer this separately. A card that counts as moved for the
  // "time in stage" clock but not for its children is the split family all over
  // again, so the stamp is the observable proof they share one judgement.
  const prior = [task(A, GROUP_1), task(B, GROUP_2)];
  const ops = reorderWriteOps([A, B], prior, GROUP_2, AT);
  const stamped = ops
    .filter((o) => 'groupChangedAt' in o.updateOne.update.$set)
    .map((o) => o.updateOne.filter._id);
  assert.deepEqual(stamped, movedGroupIds([A, B], prior, GROUP_2));
});

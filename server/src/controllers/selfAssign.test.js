const { test } = require('node:test');
const assert = require('node:assert');

const { requireAssignCapability, isSelfClaim } = require('./taskController');

/**
 * The self-assignment carve-out.
 *
 * `task.assign` sits on the `edit` rung, so a `contribute` member could not put
 * their own name on a task — not on create, not on an existing row. These tests
 * pin the two halves of the fix: `requireAssignCapability` (may this DELTA be
 * written) and `isSelfClaim` (is this whole update just me claiming the row).
 *
 * Both are pure. `ctx` only needs `can`, and ids only need `.toString()`, so
 * plain strings stand in for ObjectIds throughout.
 */

const ME = 'user-me';
const OTHER = 'user-other';

/** A ctx whose capability set is exactly `caps`. */
const ctxWith = (...caps) => {
  const set = new Set(caps);
  return { can: (c) => set.has(c) };
};

/** The rung this bug was actually reported on: public board, contribute. */
const contributor = () =>
  ctxWith('task.create', 'task.edit_assigned', 'task.change_status', 'goal.view');

const editor = () =>
  ctxWith('task.create', 'task.edit_assigned', 'task.edit_any', 'task.assign');

// ---------------------------------------------------------------------------
// requireAssignCapability — the delta gate
// ---------------------------------------------------------------------------

test('a contributor may add themselves', () => {
  assert.strictEqual(requireAssignCapability(contributor(), ME, [ME]), null);
});

test('a contributor may remove themselves', () => {
  // Removal reaches the gate through the same delta list as addition.
  assert.strictEqual(requireAssignCapability(contributor(), ME, [ME]), null);
});

test('a contributor may not add anyone else', () => {
  const denied = requireAssignCapability(contributor(), ME, [OTHER]);
  assert.strictEqual(denied.status, 403);
  assert.match(denied.error, /permission to assign people/);
});

test('a contributor may not move themselves AND someone else in one write', () => {
  // The obvious way to smuggle the capability: bundle your own name with a
  // second one and hope the check only looks for yours.
  const denied = requireAssignCapability(contributor(), ME, [ME, OTHER]);
  assert.strictEqual(denied.status, 403);
});

test('an empty delta is not a power — a client echoing the list back is fine', () => {
  assert.strictEqual(requireAssignCapability(contributor(), ME, []), null);
  assert.strictEqual(requireAssignCapability(contributor(), ME, null), null);
  assert.strictEqual(requireAssignCapability(contributor(), ME, undefined), null);
});

test('null and empty ids in the delta are ignored, not treated as a stranger', () => {
  assert.strictEqual(
    requireAssignCapability(contributor(), ME, [null, ME, '', undefined]),
    null
  );
});

test('ids are compared as strings, not by reference', () => {
  const objectIdish = { toString: () => ME };
  assert.strictEqual(requireAssignCapability(contributor(), ME, [objectIdish]), null);
});

test('an editor holding task.assign may move anyone', () => {
  assert.strictEqual(requireAssignCapability(editor(), ME, [OTHER]), null);
  assert.strictEqual(requireAssignCapability(editor(), ME, [ME, OTHER]), null);
});

test('a viewer with neither capability still cannot self-assign via the delta gate', () => {
  // The carve-out is about the delta only. A `view`/`comment` rung user is
  // stopped by canEditTask / isSelfClaim, not here — but assigning OTHERS must
  // still refuse them outright.
  const denied = requireAssignCapability(ctxWith('goal.view'), ME, [OTHER]);
  assert.strictEqual(denied.status, 403);
});

// ---------------------------------------------------------------------------
// isSelfClaim — "this whole update is just me picking the row up"
// ---------------------------------------------------------------------------

const taskWith = (assignedTo = []) => ({
  assignedTo,
  createdBy: OTHER,
});

test('claiming an unassigned task is a claim', () => {
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([]), { assignedTo: [ME] }, ME),
    true
  );
});

test('claiming alongside existing assignees is a claim — nobody is displaced', () => {
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([OTHER]), { assignedTo: [OTHER, ME] }, ME),
    true
  );
});

test('dropping someone else while adding yourself is NOT a claim', () => {
  // This is the whole reason the rule is additive: a claim must never be able to
  // take work off another person.
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([OTHER]), { assignedTo: [ME] }, ME),
    false
  );
});

test('adding someone else is NOT a claim', () => {
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([]), { assignedTo: [OTHER] }, ME),
    false
  );
});

test('adding yourself AND someone else is NOT a claim', () => {
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([]), { assignedTo: [ME, OTHER] }, ME),
    false
  );
});

test('a claim may not carry another field along', () => {
  // Claiming a task is not a licence to rewrite it.
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([]), { assignedTo: [ME], name: 'x' }, ME),
    false
  );
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([]), { assignedTo: [ME], status: 's' }, ME),
    false
  );
});

test('undefined siblings in the body do not count as touched fields', () => {
  assert.strictEqual(
    isSelfClaim(
      contributor(),
      taskWith([]),
      { assignedTo: [ME], name: undefined, dueDate: undefined },
      ME
    ),
    true
  );
});

test('an update with no assignedTo at all is not a claim', () => {
  assert.strictEqual(isSelfClaim(contributor(), taskWith([]), { name: 'x' }, ME), false);
  assert.strictEqual(isSelfClaim(contributor(), taskWith([]), {}, ME), false);
});

test('a non-array assignedTo is not a claim', () => {
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([]), { assignedTo: ME }, ME),
    false
  );
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([]), { assignedTo: null }, ME),
    false
  );
});

test('someone below the contribute rung cannot claim', () => {
  // `comment` holds update.create and nothing on the task itself. Without
  // task.edit_assigned there is no "my own work" for a claim to unlock.
  const commenter = ctxWith('update.create', 'goal.view');
  assert.strictEqual(
    isSelfClaim(commenter, taskWith([]), { assignedTo: [ME] }, ME),
    false
  );
});

test('a duplicated own id in the payload is still a claim', () => {
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([]), { assignedTo: [ME, ME] }, ME),
    true
  );
});

test('clearing the list is not a claim', () => {
  assert.strictEqual(
    isSelfClaim(contributor(), taskWith([OTHER]), { assignedTo: [] }, ME),
    false
  );
});

const test = require('node:test');
const assert = require('node:assert');

/**
 * Group lifecycle logging.
 *
 * `logActivity` is stubbed BEFORE groupActivity is required, because that module
 * destructures the function at load time and would otherwise hold a reference to
 * the real one. Nothing here touches a database.
 *
 * The two things worth pinning down are the ones that fail silently in
 * production: a rename that logs when nothing changed (the update endpoint
 * re-sends `name` on every save, so an unguarded logger would write a row every
 * time somebody dragged a group or toggled a tag), and a delete row that cannot
 * be read back once its subject is gone.
 */

const activityService = require('./activityService');

const calls = [];
activityService.logActivity = async (args) => {
  calls.push(args);
  return args;
};

const {
  logGroupCreated,
  logGroupRenamed,
  logGroupDeleted,
  MAX_NAME,
} = require('./groupActivity');
const { describeActivity, eventLabel } = require('./activityFormat');

const reset = () => {
  calls.length = 0;
};

const group = (over = {}) => ({
  _id: 'g1',
  name: 'Black Suede',
  board: 'b1',
  ...over,
});

const board = (over = {}) => ({ _id: 'b1', boardType: 'tracker', ...over });

// ---------------------------------------------------------------------------
// Creation — the row that outlives the byline
// ---------------------------------------------------------------------------

test('creation records the group, the board and the actor', async () => {
  reset();
  await logGroupCreated({ group: group(), board: board(), actor: 'u1' });

  assert.strictEqual(calls.length, 1);
  const c = calls[0];
  assert.strictEqual(c.type, 'group.created');
  assert.strictEqual(c.group._id, 'g1');
  assert.strictEqual(c.board, 'b1');
  assert.strictEqual(c.actor, 'u1');
  assert.strictEqual(c.actorType, 'user');
  // The name is captured in metadata, not only in the pointer — this is what
  // still reads after the group is deleted.
  assert.strictEqual(c.metadata.groupName, 'Black Suede');
  assert.strictEqual(c.metadata.boardType, 'tracker');
});

test('creation falls back to the group own board id when no board doc is passed', async () => {
  reset();
  await logGroupCreated({ group: group({ board: 'b9' }), actor: 'u1' });
  assert.strictEqual(calls[0].board, 'b9');
  assert.strictEqual(calls[0].metadata.boardType, null);
});

// ---------------------------------------------------------------------------
// Rename — the guard is the feature
// ---------------------------------------------------------------------------

test('a rename to the same name writes nothing', async () => {
  reset();
  const r = await logGroupRenamed({
    group: group(),
    board: board(),
    from: 'Black Suede',
    to: 'Black Suede',
    actor: 'u1',
  });
  assert.strictEqual(r, null);
  assert.strictEqual(calls.length, 0, 'an unchanged save must not write a row');
});

test('a real rename carries both sides', async () => {
  reset();
  await logGroupRenamed({
    group: group({ name: 'Black Suede' }),
    board: board(),
    from: 'Gorski',
    to: 'Black Suede',
    actor: 'u1',
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].type, 'group.renamed');
  assert.strictEqual(calls[0].oldValue, 'Gorski');
  assert.strictEqual(calls[0].newValue, 'Black Suede');
  // Metadata names the group as it is NOW, matching what the board shows.
  assert.strictEqual(calls[0].metadata.groupName, 'Black Suede');
});

test('a rename with a blank side writes nothing rather than a half sentence', async () => {
  reset();
  await logGroupRenamed({ group: group(), from: '', to: 'Something', actor: 'u1' });
  await logGroupRenamed({ group: group(), from: 'Something', to: '', actor: 'u1' });
  assert.strictEqual(calls.length, 0);
});

test('an absurdly long name is truncated before it reaches the log', async () => {
  reset();
  await logGroupRenamed({
    group: group(),
    from: 'x'.repeat(400),
    to: 'y'.repeat(400),
    actor: 'u1',
  });
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].oldValue.length <= MAX_NAME);
  assert.ok(calls[0].newValue.length <= MAX_NAME);
});

// ---------------------------------------------------------------------------
// Delete — counted before the cascade, because afterwards there is nothing left
// ---------------------------------------------------------------------------

test('a delete records what went down with the group', async () => {
  reset();
  await logGroupDeleted({
    group: group(),
    board: board(),
    actor: 'u1',
    taskCount: 40,
    goalCount: 8,
  });
  const c = calls[0];
  assert.strictEqual(c.type, 'group.deleted');
  assert.strictEqual(c.metadata.taskCount, 40);
  assert.strictEqual(c.metadata.goalCount, 8);
  assert.strictEqual(c.metadata.groupName, 'Black Suede');
});

// ---------------------------------------------------------------------------
// The sentences — what a reader of the export actually sees
// ---------------------------------------------------------------------------

const entry = (type, over = {}) => ({
  type,
  actor: { name: 'Ann' },
  metadata: { groupName: 'Black Suede', boardType: 'tracker' },
  ...over,
});

test('group events read as English', () => {
  assert.strictEqual(
    describeActivity(entry('group.created')),
    'Ann created the group "Black Suede".'
  );
  assert.strictEqual(
    describeActivity(entry('group.renamed', { oldValue: 'Gorski', newValue: 'Black Suede' })),
    'Ann renamed the group "Gorski" to "Black Suede".'
  );
});

test('a group on a client board is called a client', () => {
  assert.strictEqual(
    describeActivity(entry('group.created', {
      metadata: { groupName: 'Purlux', boardType: 'client' },
    })),
    'Ann created the client "Purlux".'
  );
});

test('a delete says what it took with it, and counts singulars correctly', () => {
  assert.strictEqual(
    describeActivity(entry('group.deleted', {
      metadata: { groupName: 'Black Suede', boardType: 'tracker', taskCount: 40, goalCount: 8 },
    })),
    'Ann deleted the group "Black Suede" and the 40 tasks and 8 goals in it.'
  );
  assert.strictEqual(
    describeActivity(entry('group.deleted', {
      metadata: { groupName: 'Black Suede', boardType: 'tracker', taskCount: 1 },
    })),
    'Ann deleted the group "Black Suede" and the 1 task in it.'
  );
  // An empty group states the delete plainly rather than trailing "and the".
  assert.strictEqual(
    describeActivity(entry('group.deleted')),
    'Ann deleted the group "Black Suede".'
  );
});

test('a group row with no captured name still reads', () => {
  assert.strictEqual(
    describeActivity(entry('group.created', { metadata: {} })),
    'Ann created the group a group.'
  );
});

test('every group type has an export label', () => {
  for (const t of ['group.created', 'group.renamed', 'group.deleted']) {
    assert.notStrictEqual(eventLabel(t), t, t + ' has no label');
  }
});

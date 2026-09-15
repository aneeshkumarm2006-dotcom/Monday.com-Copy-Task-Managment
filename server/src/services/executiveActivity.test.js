const test = require('node:test');
const assert = require('node:assert');

/**
 * Executive-view logging — the metadata shaping, and the sentences it produces.
 *
 * `ActivityLog.create` is stubbed BEFORE executiveActivity is required, so
 * nothing here touches a database. The model itself is still the real one,
 * which is the point of the last block: `validateSync` runs the schema's own
 * rules with no connection, and that is what proves an org row is allowed to
 * exist without a task. Get that wrong in production and nothing throws — the
 * writer swallows its errors — the history simply comes back empty.
 *
 * The things worth pinning down are the ones that fail quietly:
 *
 *   - the TARGET PERSON's name being captured on every row, because the profile
 *     is deletable by design and the row has to outlive it;
 *   - `board` on the two board rows and NOWHERE else, since that is the only
 *     reason two of the five reach a board's activity export and the other
 *     three deliberately reach none;
 *   - the `changed` list being normalised rather than trusted, since it comes
 *     from a caller that types the words by hand.
 */

const ActivityLog = require('../models/ActivityLog');

const rows = [];
ActivityLog.create = async (doc) => {
  rows.push(doc);
  return doc;
};

const {
  logExecutiveDeclared,
  logExecutiveUpdated,
  logExecutiveRemoved,
  logExecutiveBoardAdded,
  logExecutiveBoardRemoved,
  MAX_NAME,
  MAX_LABEL,
} = require('./executiveActivity');
const { describeActivity, eventLabel } = require('./activityFormat');

const reset = () => {
  rows.length = 0;
};

const ORG = '65f000000000000000000001';
const ACTOR = '65f000000000000000000002';
const TARGET = { _id: '65f000000000000000000003', name: 'Bea Larsen' };
const BOARD = { _id: '65f000000000000000000004', name: 'SEO Tracker 2026' };

// ---------------------------------------------------------------------------
// The subject: an organisation, never a task
// ---------------------------------------------------------------------------

test('a declare carries the org, the actor and the person the view is for', async () => {
  reset();
  await logExecutiveDeclared({
    organisation: ORG,
    targetUser: TARGET,
    actor: ACTOR,
    roleKey: 'executive',
    roleName: 'Executive',
  });

  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.type, 'executive.declared');
  assert.strictEqual(r.organisation, ORG);
  assert.strictEqual(r.actor, ACTOR);
  assert.strictEqual(r.actorType, 'user');
  assert.strictEqual(r.task, null);
  assert.strictEqual(r.goal, null);
  assert.strictEqual(r.adsBudget, null);
  assert.strictEqual(r.group, null);
  // Org-level: no board, so no board export can ever show it.
  assert.strictEqual(r.board, null);
  // The captured name is what the row is read by once the profile is gone.
  assert.strictEqual(r.metadata.targetUserName, 'Bea Larsen');
  assert.strictEqual(r.metadata.targetUser, TARGET._id);
  assert.strictEqual(r.metadata.roleKey, 'executive');
});

test('nothing is written without an organisation or without an actor', async () => {
  reset();
  assert.strictEqual(
    await logExecutiveDeclared({ targetUser: TARGET, actor: ACTOR }),
    null
  );
  assert.strictEqual(
    await logExecutiveDeclared({ organisation: ORG, targetUser: TARGET }),
    null
  );
  assert.strictEqual(rows.length, 0, 'a row with no subject must never be written');
});

test('no executive row is field_changed-shaped', async () => {
  reset();
  await logExecutiveDeclared({ organisation: ORG, targetUser: TARGET, actor: ACTOR });
  await logExecutiveRemoved({ organisation: ORG, targetUser: TARGET, actor: ACTOR });
  for (const r of rows) assert.strictEqual(r.field, undefined);
});

test('an absurdly long name is truncated before it reaches the log', async () => {
  reset();
  await logExecutiveDeclared({
    organisation: ORG,
    targetUser: { _id: TARGET._id, name: 'x'.repeat(400) },
    actor: ACTOR,
  });
  assert.ok(rows[0].metadata.targetUserName.length <= MAX_NAME);
  assert.ok(rows[0].newValue.length <= MAX_NAME);
});

// ---------------------------------------------------------------------------
// The update list — passed in, not diffed, and normalised on the way through
// ---------------------------------------------------------------------------

test('the changed list is trimmed, lower-cased and de-duplicated', async () => {
  reset();
  await logExecutiveUpdated({
    organisation: ORG,
    targetUser: TARGET,
    changed: [' Home ', 'home', 'NAV', '', null, 42],
    actor: ACTOR,
  });
  assert.deepStrictEqual(rows[0].metadata.changed, ['home', 'nav']);
});

test('a save with no list still writes a row', async () => {
  reset();
  await logExecutiveUpdated({ organisation: ORG, targetUser: TARGET, actor: ACTOR });
  assert.strictEqual(rows.length, 1, 'a save with nothing named is still a save');
  assert.deepStrictEqual(rows[0].metadata.changed, []);
});

test('no single save can write a paragraph into the changed column', async () => {
  reset();
  const many = Array.from({ length: 30 }, (_, i) => `part${i}`);
  await logExecutiveUpdated({
    organisation: ORG,
    targetUser: TARGET,
    changed: many,
    actor: ACTOR,
  });
  assert.ok(rows[0].metadata.changed.length <= 10);
});

// ---------------------------------------------------------------------------
// Removal — counted before the delete, because afterwards there is nothing left
// ---------------------------------------------------------------------------

test('a removal records how much shape went with it', async () => {
  reset();
  await logExecutiveRemoved({
    organisation: ORG,
    targetUser: TARGET,
    actor: ACTOR,
    boardCount: 12,
  });
  assert.strictEqual(rows[0].type, 'executive.removed');
  assert.strictEqual(rows[0].oldValue, 'Bea Larsen');
  assert.strictEqual(rows[0].metadata.boardCount, 12);
  assert.strictEqual(rows[0].board, null);
});

// ---------------------------------------------------------------------------
// The two board rows — the only ones an export can ever contain
// ---------------------------------------------------------------------------

test('adding a board hangs the row off that board', async () => {
  reset();
  await logExecutiveBoardAdded({
    organisation: ORG,
    targetUser: TARGET,
    board: BOARD,
    level: 'edit',
    canManage: true,
    actor: ACTOR,
  });
  const r = rows[0];
  assert.strictEqual(r.type, 'executive.board_added');
  // Without this the row never reaches the board activity export, which reads
  // by board id.
  assert.strictEqual(r.board, BOARD._id);
  assert.strictEqual(r.organisation, ORG);
  assert.strictEqual(r.metadata.boardName, 'SEO Tracker 2026');
  assert.strictEqual(r.metadata.level, 'edit');
  assert.strictEqual(r.metadata.canManage, true);
  // The person's name travels on a board row too: the export names the item
  // column from it.
  assert.strictEqual(r.metadata.targetUserName, 'Bea Larsen');
});

test('a bare board id still produces a board-scoped row', async () => {
  reset();
  await logExecutiveBoardAdded({
    organisation: ORG,
    targetUser: TARGET,
    board: BOARD._id,
    actor: ACTOR,
  });
  assert.strictEqual(rows[0].board, BOARD._id);
  // No document to read a name from; the sentence falls back rather than lying.
  assert.strictEqual(rows[0].metadata.boardName, '');
  assert.strictEqual(rows[0].metadata.level, null);
});

test('removing a board records whether the grant went with it', async () => {
  reset();
  await logExecutiveBoardRemoved({
    organisation: ORG,
    targetUser: TARGET,
    board: BOARD,
    revoked: true,
    actor: ACTOR,
  });
  assert.strictEqual(rows[0].type, 'executive.board_removed');
  assert.strictEqual(rows[0].metadata.revoked, true);
  assert.strictEqual(rows[0].oldValue, 'SEO Tracker 2026');

  reset();
  await logExecutiveBoardRemoved({
    organisation: ORG,
    targetUser: TARGET,
    board: BOARD,
    actor: ACTOR,
  });
  assert.strictEqual(rows[0].metadata.revoked, false, 'revoking is never assumed');
});

test('a very long board name is truncated to the label ceiling', async () => {
  reset();
  await logExecutiveBoardAdded({
    organisation: ORG,
    targetUser: TARGET,
    board: { _id: BOARD._id, name: 'b'.repeat(400) },
    actor: ACTOR,
  });
  assert.ok(rows[0].metadata.boardName.length <= MAX_LABEL);
});

// ---------------------------------------------------------------------------
// The sentences — what a reader of the export actually sees
// ---------------------------------------------------------------------------

const entry = (type, metadata = {}) => ({
  type,
  actor: { name: 'Ann' },
  metadata: { targetUserName: 'Bea Larsen', ...metadata },
});

test('executive events read as English', () => {
  assert.strictEqual(
    describeActivity(entry('executive.declared')),
    'Ann created an executive view for "Bea Larsen".'
  );
  assert.strictEqual(
    describeActivity(entry('executive.updated', { changed: ['home', 'nav'] })),
    'Ann updated the executive view for "Bea Larsen" — home page and navigation.'
  );
  assert.strictEqual(
    describeActivity(entry('executive.removed')),
    'Ann removed the executive view for "Bea Larsen".'
  );
});

// Pinned as a STRING rather than a "contains" check, because the exact word is
// the point. The list entry and the grant are two separate writes and the
// second one can be refused by guards this log never sees, so a sentence
// stating a level as fact would tell somebody auditing the board's export that
// a person holds access they may have been denied. "requested" keeps the share
// dialog's own vocabulary and claims only what this row can actually know.
test('a board row says what was asked for, never what was granted', () => {
  assert.strictEqual(
    describeActivity(entry('executive.board_added', {
      boardName: 'SEO Tracker 2026',
      level: 'edit',
      canManage: true,
    })),
    'Ann added "SEO Tracker 2026" to the executive view for "Bea Larsen",'
      + ' with full access requested.'
  );
  assert.strictEqual(
    describeActivity(entry('executive.board_added', {
      boardName: 'SEO Tracker 2026',
      level: 'view',
    })),
    'Ann added "SEO Tracker 2026" to the executive view for "Bea Larsen",'
      + ' with view access requested.'
  );
});

// The negative half of the same rule, kept separate so a future rewording that
// re-introduces the claim fails here even if somebody updated the strings above
// to match it. A grant is a thing the share path records; this row never does.
test('no board_added sentence ever claims access was granted', () => {
  for (const meta of [
    { boardName: 'A board', level: 'edit', canManage: true },
    { boardName: 'A board', level: 'contribute' },
    { boardName: 'A board' },
  ]) {
    const sentence = describeActivity(entry('executive.board_added', meta));
    if (/access/.test(sentence)) {
      assert.match(sentence, /access requested/, `states a level as fact: ${sentence}`);
    }
    assert.doesNotMatch(sentence, /\bgranted\b|\bnow has\b|\bgave\b/, sentence);
  }
});

test('a removal only mentions access when access actually changed', () => {
  assert.strictEqual(
    describeActivity(entry('executive.board_removed', { boardName: 'SEO Tracker 2026' })),
    'Ann removed "SEO Tracker 2026" from the executive view for "Bea Larsen".'
  );
  assert.strictEqual(
    describeActivity(entry('executive.board_removed', {
      boardName: 'SEO Tracker 2026',
      revoked: true,
    })),
    'Ann removed "SEO Tracker 2026" from the executive view for "Bea Larsen"'
      + ' and revoked their access to it.'
  );
});

test('a row with no captured name still reads', () => {
  assert.strictEqual(
    describeActivity({ type: 'executive.updated', actor: { name: 'Ann' }, metadata: {} }),
    'Ann updated the executive view.'
  );
});

test('every executive type has an export label', () => {
  for (const t of [
    'executive.declared',
    'executive.updated',
    'executive.removed',
    'executive.board_added',
    'executive.board_removed',
  ]) {
    assert.notStrictEqual(eventLabel(t), t, `${t} has no label`);
  }
});

// ---------------------------------------------------------------------------
// The schema itself — the silent failure this whole subject depends on
// ---------------------------------------------------------------------------

test('the five types are in the enum, or every row is dropped unwritten', () => {
  for (const t of [
    'executive.declared',
    'executive.updated',
    'executive.removed',
    'executive.board_added',
    'executive.board_removed',
  ]) {
    assert.ok(ActivityLog.ACTIVITY_TYPES.includes(t), `${t} missing from ACTIVITY_TYPES`);
  }
});

test('an org row is valid with no task, and a subjectless row is not', () => {
  const ok = new ActivityLog({ organisation: ORG, actor: ACTOR, type: 'executive.declared' });
  assert.strictEqual(ok.validateSync(), undefined, 'an org row must not require a task');

  const bad = new ActivityLog({ actor: ACTOR, type: 'executive.declared' });
  const err = bad.validateSync();
  assert.ok(err && err.errors.task, 'a row with no subject at all must still demand a task');
});

const { test } = require('node:test');
const assert = require('node:assert');

const {
  MAX_GOAL_LINKS,
  linkedGoalIds,
  isDismissed,
  isAttachable,
  staleReasonsFor,
  isOrphan,
  evidenceStateOf,
  foldEvidenceByGroup,
} = require('./goalEvidence');

// A board task's status is an ObjectId into board.statuses; the key is the
// stable handle. Plain strings stand in for ids here — isResolvedStatus
// compares String(id), so the shape is faithful.
const board = {
  statuses: [
    { _id: 'S_TODO', key: 'not_started' },
    { _id: 'S_DONE', key: 'done' },
  ],
};

const task = (over = {}) => ({
  _id: 'T1',
  group: 'G1',
  monthKey: '2026-08',
  status: 'S_DONE',
  goalLinks: [],
  goalLinkDismissedAt: null,
  ...over,
});

const link = (over = {}) => ({
  goal: 'GOAL1',
  monthKey: '2026-08',
  group: 'G1',
  ...over,
});

// ---------------------------------------------------------------------------
// reading the links off a task
// ---------------------------------------------------------------------------

test('linkedGoalIds accepts raw ids and populated refs alike', () => {
  const t = task({
    goalLinks: [link({ goal: 'A' }), link({ goal: { _id: 'B', name: 'Rank' } })],
  });
  assert.deepStrictEqual(linkedGoalIds(t), ['A', 'B']);
});

test('linkedGoalIds is empty, never undefined, for a task never linked', () => {
  assert.deepStrictEqual(linkedGoalIds({}), []);
  assert.deepStrictEqual(linkedGoalIds(null), []);
});

test('dismissal is read off the timestamp, not a boolean', () => {
  assert.strictEqual(isDismissed(task()), false);
  assert.strictEqual(isDismissed(task({ goalLinkDismissedAt: new Date() })), true);
});

test('a subitem and a personal task are not attachable', () => {
  assert.strictEqual(isAttachable(task()), true);
  assert.strictEqual(isAttachable(task({ parent: 'P1' })), false);
  assert.strictEqual(isAttachable(task({ isPersonal: true })), false);
  assert.strictEqual(
    isAttachable(task({ monthKey: null })),
    false,
    'no month, no goals to point at'
  );
});

// ---------------------------------------------------------------------------
// staleness — the whole reason a link stores its own month and group
// ---------------------------------------------------------------------------

test('a done task still in its own month and group is not stale', () => {
  assert.deepStrictEqual(staleReasonsFor(task(), link(), board), []);
});

test('reopening flags the link but never removes it', () => {
  const r = staleReasonsFor(task({ status: 'S_TODO' }), link(), board);
  assert.deepStrictEqual(r.map((x) => x.code), ['reopened']);
});

test('the legacy string status is still understood', () => {
  const legacy = task({ status: 'done' });
  assert.deepStrictEqual(
    staleReasonsFor(legacy, link(), board),
    [],
    'pre-migration rows store the raw string'
  );
});

test('refiling the task to another month is named in the label', () => {
  const r = staleReasonsFor(
    task({ monthKey: '2026-09' }),
    link({ monthKey: '2026-08' }),
    board
  );
  assert.deepStrictEqual(r.map((x) => x.code), ['moved_month']);
  assert.strictEqual(r[0].label, 'Moved to September 2026');
});

test('moving the task to another group is drift too', () => {
  const r = staleReasonsFor(task({ group: 'G2' }), link({ group: 'G1' }), board);
  assert.deepStrictEqual(r.map((x) => x.code), ['moved_group']);
});

test('reasons accumulate — reopened AND refiled reports both', () => {
  const r = staleReasonsFor(
    task({ status: 'S_TODO', monthKey: '2026-09' }),
    link(),
    board
  );
  assert.deepStrictEqual(r.map((x) => x.code), ['reopened', 'moved_month']);
});

// ---------------------------------------------------------------------------
// the orphan rule — the most blast-radius-prone thing here
// ---------------------------------------------------------------------------

test('a done, unattached task in a group WITH goals is an orphan', () => {
  assert.strictEqual(isOrphan({ task: task(), board, groupHasGoals: true }), true);
});

test('a group with no goals produces no orphans at all', () => {
  // Without this rule every done task on every goal-less group wears a marker
  // on day one, the marker becomes wallpaper, and the feature reads as broken.
  assert.strictEqual(isOrphan({ task: task(), board, groupHasGoals: false }), false);
});

test('attached, dismissed and not-yet-done tasks are all not orphans', () => {
  const attached = task({ goalLinks: [link()] });
  const dismissed = task({ goalLinkDismissedAt: new Date('2026-08-20') });
  const open = task({ status: 'S_TODO' });
  for (const t of [attached, dismissed, open]) {
    assert.strictEqual(isOrphan({ task: t, board, groupHasGoals: true }), false);
  }
});

// ---------------------------------------------------------------------------
// the marker state the board grid renders
// ---------------------------------------------------------------------------

test('evidenceStateOf covers every row a grid can show', () => {
  const state = (t, groupHasGoals = true) =>
    evidenceStateOf({ task: t, board, groupHasGoals });

  assert.strictEqual(state(task({ goalLinks: [link()] })), 'attributed');
  assert.strictEqual(state(task()), 'orphaned');
  assert.strictEqual(state(task({ goalLinkDismissedAt: new Date() })), 'dismissed');
  assert.strictEqual(state(task({ status: 'S_TODO' })), null, 'not done yet');
  assert.strictEqual(state(task(), false), null, 'no goals in the group');
  assert.strictEqual(state(task({ parent: 'P1' })), null, 'subitems carry no evidence');
});

test('an attached task still reads as attributed after it is reopened', () => {
  // The link survives; the popover is where the staleness gets explained.
  const reopened = task({ status: 'S_TODO', goalLinks: [link()] });
  assert.strictEqual(
    evidenceStateOf({ task: reopened, board, groupHasGoals: true }),
    'attributed'
  );
});

// ---------------------------------------------------------------------------
// the per-group fold shared by the Goals tab header and the People tab
// ---------------------------------------------------------------------------

test('foldEvidenceByGroup counts done, attributed, orphaned and dismissed', () => {
  const tasks = [
    task({ _id: 'a', goalLinks: [link()] }),
    task({ _id: 'b', goalLinks: [link(), link({ goal: 'GOAL2' })] }),
    task({ _id: 'c' }),
    task({ _id: 'd', goalLinkDismissedAt: new Date() }),
    task({ _id: 'e', status: 'S_TODO' }),
    task({ _id: 'f', parent: 'P1' }),
  ];
  const byGroup = foldEvidenceByGroup(tasks, board, new Set(['G1']));
  assert.deepStrictEqual(byGroup.get('G1'), {
    done: 4,
    attributed: 2,
    orphaned: 1,
    dismissed: 1,
  });
});

test('a task attached to two goals counts once, not twice', () => {
  const byGroup = foldEvidenceByGroup(
    [task({ goalLinks: [link({ goal: 'A' }), link({ goal: 'B' })] })],
    board,
    new Set(['G1'])
  );
  assert.strictEqual(
    byGroup.get('G1').attributed,
    1,
    'the unit is the task, not the link'
  );
});

test('a goal-less group still reports done, but never orphans', () => {
  const byGroup = foldEvidenceByGroup([task(), task({ _id: 'b' })], board, new Set());
  assert.deepStrictEqual(byGroup.get('G1'), {
    done: 2,
    attributed: 0,
    orphaned: 0,
    dismissed: 0,
  });
});

test('the link cap is a small number, deliberately', () => {
  assert.ok(MAX_GOAL_LINKS > 0 && MAX_GOAL_LINKS <= 50);
});

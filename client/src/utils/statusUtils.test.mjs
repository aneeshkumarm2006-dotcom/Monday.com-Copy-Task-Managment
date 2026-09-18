import test from 'node:test';
import assert from 'node:assert/strict';
import { isStatusDone, isGroupComplete } from './statusUtils.js';

/** A board in the post-Phase-2 shape: statuses are documents with ids. */
const board = {
  statuses: [
    { _id: 's1', key: 'not_started', name: 'Not started' },
    { _id: 's2', key: 'working_on_it', name: 'Working on it' },
    { _id: 's3', key: 'done', name: 'Done' },
    // A user-added rung. `addStatus` writes `key: null` for these, so it is
    // NOT the done status however much its name sounds like one.
    { _id: 's4', key: null, name: 'Approved' },
  ],
};

const rows = (...statuses) => statuses.map((status, i) => ({ _id: `t${i}`, status }));

test('a group whose every task is done is complete', () => {
  assert.equal(isGroupComplete(rows('s3', 's3', 's3'), board), true);
});

test('one unfinished task is enough to stop it', () => {
  assert.equal(isGroupComplete(rows('s3', 's2', 's3'), board), false);
});

test('an empty group is NOT complete', () => {
  // Nothing has been completed. The other answer fires the banner the instant
  // somebody creates a group.
  assert.equal(isGroupComplete([], board), false);
});

test('a missing or unreadable bucket is not complete', () => {
  for (const bad of [undefined, null, 'x', 0, {}]) {
    assert.equal(isGroupComplete(bad, board), false);
  }
});

test('a task with no status at all is not done', () => {
  assert.equal(isGroupComplete(rows('s3', null), board), false);
  assert.equal(isGroupComplete(rows('s3', undefined), board), false);
});

test('a second done-LOOKING status does not count', () => {
  // Only the rung whose `key` is 'done' is done — the same rule the bar, the
  // done badge and the server's progress figure use. A board that wants the
  // label has to make its done rung the done status.
  assert.equal(isGroupComplete(rows('s4', 's4'), board), false);
  assert.equal(isGroupComplete(rows('s3', 's4'), board), false);
});

test('legacy enum rows resolve on a board with no statuses', () => {
  assert.equal(isGroupComplete(rows('done', 'done'), null), true);
  assert.equal(isGroupComplete(rows('done', 'stuck'), null), false);
});

test('a status pointing at a deleted id is not done', () => {
  assert.equal(isStatusDone(board, 'gone'), false);
  assert.equal(isGroupComplete(rows('s3', 'gone'), board), false);
});

test('completion is a fact about the ROWS it is handed, not the board', () => {
  // The guard that matters: the caller must pass the UNFILTERED bucket. This
  // asserts the helper has no opinion of its own to fall back on — hand it the
  // filtered rows and it will happily call a half-finished group complete,
  // which is exactly why BoardDetailPage reads `tasksByGroup` and not
  // `filteredTasksByGroup`.
  const filteredToDone = rows('s3');
  assert.equal(isGroupComplete(filteredToDone, board), true);
  assert.equal(isGroupComplete([...filteredToDone, ...rows('s2')], board), false);
});

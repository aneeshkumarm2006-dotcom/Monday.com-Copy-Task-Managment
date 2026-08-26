const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const { diffProjects } = require('./projectMirror');

/**
 * The mirror's one interesting decision, isolated and tested away from the
 * database: WHAT HAPPENS TO A PROJECT THAT DISAPPEARS.
 *
 * The tempting answer is to delete it — the provider no longer has it, so why
 * would we? Because from phase 3 that row is the parent of every snapshot ever
 * taken for that domain, and per-keyword history is not retrievable from the
 * API: our snapshots are the only copy that will ever exist. Deleting the row
 * because somebody archived a project inside a third-party product would throw
 * away the month-over-month history that is the entire point of the feature.
 *
 * So: flagged, never deleted. These tests are what stops that being "tidied up".
 */

const row = (externalId, missing = false) => ({ externalId, missing });
const incoming = (externalId) => ({ externalId, name: externalId, raw: {} });

test('a first sync is all upserts and nothing gone', () => {
  const { upserts, goneIds, returnedIds } = diffProjects([], [incoming('1'), incoming('2')]);
  assert.equal(upserts.length, 2);
  assert.deepEqual(goneIds, []);
  assert.deepEqual(returnedIds, []);
});

test('a project missing from the listing is FLAGGED, never dropped', () => {
  const { upserts, goneIds } = diffProjects([row('1'), row('2')], [incoming('1')]);
  assert.deepEqual(goneIds, ['2']);
  // And the survivor is still written — a flag on one row is not a reason to
  // stop refreshing the others.
  assert.deepEqual(upserts.map((u) => u.externalId), ['1']);
});

test('re-running the refresh does not keep re-flagging the same rows', () => {
  // The row is already flagged, so there is nothing to write. Without this the
  // weekly runner would rewrite every departed project every single week.
  const { goneIds } = diffProjects([row('1'), row('2', true)], [incoming('1')]);
  assert.deepEqual(goneIds, []);
});

test('a project that comes back is reported as returned', () => {
  // Moving a project between accounts in the provider looks exactly like this.
  const { returnedIds, upserts } = diffProjects([row('1', true)], [incoming('1')]);
  assert.deepEqual(returnedIds, ['1']);
  // The upsert clears the flag, and carries the fact that it had been set so a
  // caller can say so rather than silently un-flagging.
  assert.equal(upserts[0].wasMissing, true);
});

test('an empty listing flags everything and deletes nothing', () => {
  // The shape a revoked-but-not-yet-noticed account, or a provider outage that
  // answers 200 with an empty list, would produce. Losing the history to it
  // would be unrecoverable, so the answer has to be flags.
  const { upserts, goneIds } = diffProjects([row('1'), row('2')], []);
  assert.deepEqual(upserts, []);
  assert.deepEqual(goneIds.sort(), ['1', '2']);
});

test('external ids compare as strings, whatever the provider sent', () => {
  // The provider sends numeric ids; the model stores strings. A mismatch here
  // would make every refresh report every project as both new and gone.
  const { goneIds, upserts } = diffProjects([row('5512')], [incoming('5512')]);
  assert.deepEqual(goneIds, []);
  assert.equal(upserts.length, 1);
});

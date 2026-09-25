const { test } = require('node:test');
const assert = require('node:assert');

const { statusDeletionBlocker } = require('./boardController');

/**
 * The "may this status be deleted" decision.
 *
 * Two refusals ride on it. The default status has always been protected,
 * because it is where a deleted status's tasks are sent. The board's LAST
 * done-keyed status is the one this pins: `key: 'done'` is the handle every
 * "is this finished?" read on the board resolves through (utils/doneStatus.js),
 * every one of those readers degrades to FALSE rather than erroring, and no
 * route in the product can put a done rung back once it is pulled - `addStatus`
 * writes `key: null` and `updateStatus` never writes `key` at all. So the
 * delete has to be refused rather than repaired afterwards.
 *
 * The function is pure. Statuses only need `_id`, `key` and `isDefault`, and
 * ids only need to compare as strings, so plain strings stand in for ObjectIds
 * throughout - except in the one test that deliberately hands it id-like
 * objects, which is the shape a live Mongoose subdoc actually carries.
 */

const status = (id, extra = {}) => ({
  _id: id,
  name: id,
  color: '#6B7280',
  isDefault: false,
  key: null,
  ...extra,
});

/** The seeded board: Not Started (default) / Working on it / Done / Stuck. */
const seededBoard = () => [
  status('s-not-started', { key: 'not_started', isDefault: true }),
  status('s-working', { key: 'working_on_it' }),
  status('s-done', { key: 'done' }),
  status('s-stuck', { key: 'stuck' }),
];

// ---------------------------------------------------------------------------
// The ordinary case
// ---------------------------------------------------------------------------

test('a plain status with no key may be deleted', () => {
  const statuses = [...seededBoard(), status('s-review')];
  assert.strictEqual(statusDeletionBlocker(statuses, 's-review'), null);
});

test('an id that is not on the board is not this guard\'s problem', () => {
  // The handler answers a missing status with its own 404; returning a refusal
  // here would turn that into the wrong status code.
  assert.strictEqual(statusDeletionBlocker(seededBoard(), 's-nope'), null);
});

test('a missing or malformed status list refuses nothing', () => {
  assert.strictEqual(statusDeletionBlocker(undefined, 's-done'), null);
  assert.strictEqual(statusDeletionBlocker(null, 's-done'), null);
  assert.strictEqual(statusDeletionBlocker([], 's-done'), null);
});

// ---------------------------------------------------------------------------
// The default rung
// ---------------------------------------------------------------------------

test('the default status is refused, with the wording clients already show', () => {
  const blocked = statusDeletionBlocker(seededBoard(), 's-not-started');
  assert.strictEqual(blocked.status, 400);
  assert.strictEqual(
    blocked.error,
    'Cannot delete the default status. Reassign another status as default first.'
  );
});

test('the default check runs before the done check', () => {
  // A board whose done rung IS the default: it is refused as the default, so
  // the message names the thing the user can actually do something about.
  const statuses = [status('s-done', { key: 'done', isDefault: true })];
  const blocked = statusDeletionBlocker(statuses, 's-done');
  assert.strictEqual(blocked.status, 400);
  assert.match(blocked.error, /default status/);
});

// ---------------------------------------------------------------------------
// The done rung
// ---------------------------------------------------------------------------

test('the last done-keyed status is refused with 409', () => {
  const blocked = statusDeletionBlocker(seededBoard(), 's-done');
  assert.strictEqual(blocked.status, 409);
  assert.match(blocked.error, /Done status/);
});

test('one of two done rungs may still go', () => {
  // Nothing in the schema forbids a second one, and while another survives the
  // board keeps its contract - so this is a delete, not a refusal.
  const statuses = [...seededBoard(), status('s-shipped', { key: 'done' })];
  assert.strictEqual(statusDeletionBlocker(statuses, 's-shipped'), null);
  assert.strictEqual(statusDeletionBlocker(statuses, 's-done'), null);
});

test('the guard is narrow: working_on_it and stuck stay deletable', () => {
  // Those two keys are read for a breakdown, not for a behavioural contract.
  assert.strictEqual(statusDeletionBlocker(seededBoard(), 's-working'), null);
  assert.strictEqual(statusDeletionBlocker(seededBoard(), 's-stuck'), null);
});

test('a board with no done rung at all refuses nothing new', () => {
  const statuses = [
    status('s-not-started', { key: 'not_started', isDefault: true }),
    status('s-review'),
  ];
  assert.strictEqual(statusDeletionBlocker(statuses, 's-review'), null);
});

test('ids compare across shapes, not by identity', () => {
  // What the handler actually passes: subdoc `_id`s that are ObjectId-like,
  // against the string from req.params.
  const idLike = (v) => ({ toString: () => v });
  const statuses = [
    status(idLike('64b000000000000000000001'), { key: 'not_started', isDefault: true }),
    status(idLike('64b000000000000000000002'), { key: 'done' }),
  ];
  const blocked = statusDeletionBlocker(statuses, '64b000000000000000000002');
  assert.strictEqual(blocked.status, 409);
});

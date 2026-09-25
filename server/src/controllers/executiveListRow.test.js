const { test } = require('node:test');
const assert = require('node:assert');

const { executiveListRow } = require('./executiveViewController');

/**
 * The Executives strip's row shape, and the one thing about it that is a rule
 * rather than a rendering: A DEAD ROW MUST STILL BE ADDRESSABLE.
 *
 * An executive profile outlives the User it names. Deleting an account does not
 * delete the view, and neither does removing somebody from the workspace, so
 * the strip can hold a row whose person no longer resolves. `list` has always
 * said such a row is kept on purpose — "this list is the only surface in the
 * app that could ever surface one; hiding it would make it unfixable rather
 * than untidy" — and the payload then undid that claim by shipping `user: null`
 * and nothing else. `.populate('user', ...)` REPLACES the path, so the raw
 * ObjectId was overwritten before the row was built, and every mutating route
 * in this feature is keyed on that id. The row was visible and unreachable at
 * the same time, and the Members page counted it forever.
 *
 * So these tests pin the ids, not the prose: an orphan keeps its own `id` (what
 * `DELETE .../executive-views/by-id/:viewId` takes) and keeps `userId` (what
 * every other route takes). If a future tidy-up reintroduces a populate on this
 * path, the second assertion below is what fails.
 *
 * The function is pure — it is handed a stored profile and whatever the user
 * lookup found — so plain strings stand in for ObjectIds throughout, exactly as
 * they do in `selfAssign.test.js`.
 */

const VIEW = 'view-1';
const PERSON = 'user-1';

/** A stored profile as `.lean()` hands it over: `user` is a bare ref. */
const profile = (over = {}) => ({
  _id: VIEW,
  user: PERSON,
  boards: [{ board: 'b1' }, { board: 'b2' }],
  createdAt: 'then',
  updatedAt: 'now',
  ...over,
});

/** What the user lookup finds when the person is still there. */
const person = () => ({
  _id: PERSON,
  name: 'Ada',
  email: 'ada@example.com',
  profilePic: 'pic.png',
});

// ---------------------------------------------------------------------------
// The ordinary row
// ---------------------------------------------------------------------------

test('a resolved row carries the person and both ids', () => {
  const row = executiveListRow(profile(), person());
  assert.strictEqual(row.id, VIEW);
  assert.strictEqual(row.userId, PERSON);
  assert.deepStrictEqual(row.user, {
    _id: PERSON,
    name: 'Ada',
    email: 'ada@example.com',
    profilePic: 'pic.png',
  });
});

test('boardCount counts the stored list', () => {
  assert.strictEqual(executiveListRow(profile(), person()).boardCount, 2);
});

test('a profile with no boards array counts zero rather than throwing', () => {
  // `.lean()` returns what is stored, and a document written before the path
  // had a default has no array at all.
  assert.strictEqual(
    executiveListRow(profile({ boards: undefined }), person()).boardCount,
    0
  );
});

test('the row is a summary — no board list, no home layout, no nav', () => {
  // The strip renders avatars. Shipping the full document here would send every
  // executive's section configs to a page that draws none of them.
  const row = executiveListRow(
    profile({ home: [{ type: 'note' }], nav: { boards: false } }),
    person()
  );
  assert.deepStrictEqual(Object.keys(row).sort(), [
    'boardCount',
    'createdAt',
    'id',
    'updatedAt',
    'user',
    'userId',
  ]);
});

// ---------------------------------------------------------------------------
// The orphan — the whole point of the function
// ---------------------------------------------------------------------------

test('an orphaned row is kept rather than dropped', () => {
  const row = executiveListRow(profile(), null);
  assert.strictEqual(row.user, null);
  assert.strictEqual(row.boardCount, 2);
});

test('an orphaned row keeps BOTH ids, so something can address it', () => {
  // The bug. `user: null` says there is nobody to draw; these two say where to
  // point. `id` is what the by-id delete takes; `userId` is what every other
  // route in this feature is keyed on.
  const row = executiveListRow(profile(), null);
  assert.strictEqual(row.id, VIEW);
  assert.strictEqual(row.userId, PERSON);
});

test('userId is a string, so a client can compare it without casting', () => {
  // Stand-in for the ObjectId case: whatever the stored ref is, the row spells
  // it the way a URL and a client-side comparison both need it.
  const ref = { toString: () => PERSON };
  assert.strictEqual(executiveListRow(profile({ user: ref }), null).userId, PERSON);
});

test('userId is null only when the profile itself names nobody', () => {
  // `user` is `required` on the model, so this cannot happen to a stored row —
  // it is pinned so that a row which somehow has no id reads as "no id" rather
  // than as the string "undefined" in a URL.
  assert.strictEqual(executiveListRow(profile({ user: null }), null).userId, null);
});

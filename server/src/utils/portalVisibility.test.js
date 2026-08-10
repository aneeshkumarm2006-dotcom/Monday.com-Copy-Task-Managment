/**
 * portalVisibility.test.js — unit tests for the client-portal visibility rule.
 *
 * Run from the server directory:
 *     node --test src/utils/portalVisibility.test.js
 *
 * This module decides what an external client can read, so the tests below are
 * as much about what it REFUSES as what it allows: an over-broad filter here
 * hands one client's ticket to their colleagues, or shows an outsider the
 * team's internal rows, and neither failure is visible from the team's side of
 * the app.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isClientVisibleTask,
  portalTaskFilter,
  isTeamAuthoredIssue,
} = require('./portalVisibility');

// ---------------------------------------------------------------------------
// isClientVisibleTask
// ---------------------------------------------------------------------------
test('isClientVisibleTask: a client-raised request is visible', () => {
  assert.equal(
    isClientVisibleTask({ source: 'client', portalSubmitter: 'c1' }),
    true
  );
});

test('isClientVisibleTask: a team task shared to the portal is visible', () => {
  assert.equal(
    isClientVisibleTask({ source: 'internal', portalShared: true }),
    true
  );
});

test('isClientVisibleTask: an ordinary internal task is NOT visible', () => {
  // The whole point: living on a client board earns a task nothing.
  assert.equal(isClientVisibleTask({ source: 'internal' }), false);
  assert.equal(
    isClientVisibleTask({ source: 'internal', portalShared: false }),
    false
  );
});

test('isClientVisibleTask: source alone is not enough without a submitter', () => {
  // A half-written client row (source set, submitter missing) must not open the
  // portal door on the strength of the label alone.
  assert.equal(
    isClientVisibleTask({ source: 'client', portalSubmitter: null }),
    false
  );
});

test('isClientVisibleTask: tolerates null/undefined', () => {
  assert.equal(isClientVisibleTask(null), false);
  assert.equal(isClientVisibleTask(undefined), false);
});

// ---------------------------------------------------------------------------
// portalTaskFilter
// ---------------------------------------------------------------------------
test('portalTaskFilter: scopes to the group and excludes subitems', () => {
  const f = portalTaskFilter({ groupId: 'g1', contactId: 'c1' });
  assert.equal(f.group, 'g1');
  assert.equal(f.parent, null);
});

test('portalTaskFilter: matches own submissions OR shared tasks, nothing else', () => {
  const f = portalTaskFilter({ groupId: 'g1', contactId: 'c1' });
  assert.deepEqual(f.$or, [
    { portalSubmitter: 'c1' },
    { portalShared: true },
  ]);
});

test('portalTaskFilter: the submitter clause is pinned to THIS contact', () => {
  // Guards the regression that matters most — a filter that matched any
  // portalSubmitter would show every contact on the group each other's tickets.
  const f = portalTaskFilter({ groupId: 'g1', contactId: 'c1' });
  const submitterClause = f.$or.find((c) =>
    Object.hasOwn(c, 'portalSubmitter')
  );
  assert.equal(submitterClause.portalSubmitter, 'c1');
});

// ---------------------------------------------------------------------------
// isTeamAuthoredIssue
// ---------------------------------------------------------------------------
test('isTeamAuthoredIssue: keys off the submitter, not the shared flag', () => {
  assert.equal(isTeamAuthoredIssue({ portalShared: true }), true);
  assert.equal(isTeamAuthoredIssue({ portalSubmitter: 'c1' }), false);
  // A client-raised ticket stays client-authored even if it were ever shared.
  assert.equal(
    isTeamAuthoredIssue({ portalSubmitter: 'c1', portalShared: true }),
    false
  );
});

const test = require('node:test');
const assert = require('node:assert');

const { isPushEnabled, PUSH_DEFAULT_ON } = require('./notificationService');
const { isGone } = require('./pushService');
const { resolveNotifLink } = require('../utils/notificationLink');

/**
 * Push is the only channel that interrupts somebody, so the rules about when it
 * fires are the ones worth pinning down. Everything here is pure — no database,
 * no network — which is why it can be.
 */

test('push is OFF by default for the ambient categories', () => {
  // No preference document at all: the person granted permission and never
  // opened the switches. A status moving on a board must not buzz their phone.
  assert.equal(isPushEnabled(null, 'statusChanged'), false);
  assert.equal(isPushEnabled(null, 'commented'), false);
  assert.equal(isPushEnabled(null, 'taskMoved'), false);
  assert.equal(isPushEnabled(null, 'seoRankDrop'), false);
});

test('push is ON by default for the things that are about you', () => {
  assert.equal(isPushEnabled(null, 'assigned'), true);
  assert.equal(isPushEnabled(null, 'mentioned'), true);
  assert.equal(isPushEnabled(null, 'chatMention'), true);
  assert.equal(isPushEnabled(null, 'invited'), true);
  assert.equal(isPushEnabled(null, 'dueSoon'), true);
  assert.equal(isPushEnabled(null, 'goalsDue'), true);
});

test('an explicit choice always beats the default, in both directions', () => {
  const optedOut = { categories: { assignments: { push: false } } };
  assert.equal(isPushEnabled(optedOut, 'assigned'), false);

  const optedIn = { categories: { statusChanges: { push: true } } };
  assert.equal(isPushEnabled(optedIn, 'statusChanged'), true);
});

test('null means "never chosen", not "off"', () => {
  // The distinction the whole three-state design rests on: a stored null must
  // fall through to the default rather than read as a deliberate false.
  const untouched = { categories: { assignments: { push: null } } };
  assert.equal(isPushEnabled(untouched, 'assigned'), true);
});

test('an unmapped type still pushes', () => {
  // Ownership changing hands is not a subscription — it bypasses the other
  // gates too, and must bypass this one.
  assert.equal(isPushEnabled(null, 'ownershipTransferred'), true);
  assert.equal(isPushEnabled({ categories: {} }, 'ownershipTransferred'), true);
});

test('the client mirror of PUSH_DEFAULT_ON has not drifted', () => {
  // client/src/components/notifications/NotificationPreferences.jsx keeps its
  // own copy of this set so the switch can show the right state before the
  // server is asked. If you change one, change both — this is the tripwire.
  assert.deepEqual(
    [...PUSH_DEFAULT_ON].sort(),
    ['assignments', 'dueDates', 'goals', 'invites', 'mentions']
  );
});

test('only 404 and 410 mean a subscription is dead', () => {
  // Pruning on a transient failure would silently unsubscribe people whose
  // only crime was a bad minute on someone else's infrastructure.
  assert.equal(isGone(404), true);
  assert.equal(isGone(410), true);
  assert.equal(isGone(429), false);
  assert.equal(isGone(500), false);
  assert.equal(isGone(undefined), false);
});

test('the push link matches where the bell would have sent you', () => {
  assert.equal(
    resolveNotifLink({ type: 'assigned', board: 'b1', task: 't1', tab: 'updates' }),
    '/boards/b1?highlightTask=t1&openTab=updates'
  );
  assert.equal(
    resolveNotifLink({ type: 'goalsDue', board: 'b1', tab: 'goals', month: '2026-08' }),
    '/boards/b1?view=goals&month=2026-08'
  );
  assert.equal(
    resolveNotifLink({ type: 'chatMention', channel: 'c1' }),
    '/chat?channel=c1'
  );
  assert.equal(resolveNotifLink({ type: 'dueDigest' }), '/my-tasks');
  assert.equal(resolveNotifLink({ type: 'memberJoined' }), '/members');
  // A notification with nothing to point at still has to go somewhere real.
  assert.equal(resolveNotifLink({ type: 'assigned' }), '/notifications');
});

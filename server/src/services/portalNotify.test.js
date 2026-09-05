const test = require('node:test');
const assert = require('node:assert');

const { shouldNotify, PRESENCE_MS, CEILING_MS } = require('./portalNotify');

/**
 * The throttle on client notification emails.
 *
 * Worth testing on its own because every failure mode here is a bad outcome that
 * nothing else catches: too eager and the team's Gmail gets marked as spam by
 * the client it is trying to reach; too shy and a client never learns a reply is
 * waiting, which is the entire reason the feature exists.
 */

const NOW = new Date('2026-09-05T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);

test('a contact who has never opened the channel is notified', () => {
  assert.strictEqual(shouldNotify(null, NOW), true);
});

test('someone reading RIGHT NOW is not emailed about what they are watching', () => {
  const read = { lastReadAt: ago(30 * 1000), lastNotifiedAt: null };
  assert.strictEqual(shouldNotify(read, NOW), false);
  // ...and the boundary is the presence window, not a guess.
  assert.strictEqual(shouldNotify({ lastReadAt: ago(PRESENCE_MS - 1000), lastNotifiedAt: null }, NOW), false);
  assert.strictEqual(shouldNotify({ lastReadAt: ago(PRESENCE_MS + 1000), lastNotifiedAt: null }, NOW), true);
});

test('a long back-and-forth sends ONE email, not one per message', () => {
  // Notified five minutes ago, has not read since. Every further message in the
  // conversation lands here and must stay quiet.
  const read = { lastReadAt: ago(60 * 60 * 1000), lastNotifiedAt: ago(5 * 60 * 1000) };
  assert.strictEqual(shouldNotify(read, NOW), false);
});

test('reading, then a new message, earns a FRESH nudge', () => {
  // They were notified, they opened it, and now something new has arrived. This
  // is the case that makes the feature useful rather than one-shot.
  const read = { lastReadAt: ago(10 * 60 * 1000), lastNotifiedAt: ago(30 * 60 * 1000) };
  assert.strictEqual(shouldNotify(read, NOW), true);
});

test('the six-hour ceiling reaches a client who never opens the portal', () => {
  const justUnder = { lastReadAt: ago(48 * 60 * 60 * 1000), lastNotifiedAt: ago(CEILING_MS - 60_000) };
  assert.strictEqual(shouldNotify(justUnder, NOW), false);

  const justOver = { lastReadAt: ago(48 * 60 * 60 * 1000), lastNotifiedAt: ago(CEILING_MS + 60_000) };
  assert.strictEqual(shouldNotify(justOver, NOW), true);
});

test('a row that has been read but never notified is notified', () => {
  const read = { lastReadAt: ago(24 * 60 * 60 * 1000), lastNotifiedAt: null };
  assert.strictEqual(shouldNotify(read, NOW), true);
});

test('presence beats everything, including a lapsed ceiling', () => {
  // They are looking at it right now. It does not matter how long ago the last
  // email was — sending one would arrive while they are reading the message.
  const read = { lastReadAt: ago(10 * 1000), lastNotifiedAt: ago(3 * CEILING_MS) };
  assert.strictEqual(shouldNotify(read, NOW), false);
});

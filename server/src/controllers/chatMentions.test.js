const test = require('node:test');
const assert = require('node:assert');

/**
 * What "answered" means.
 *
 * This is the whole value of the mentions page: a "needs a reply" count is
 * worth something only if it can be trusted, and it can only be trusted if
 * READING a mention never clears it. So the rule is defined entirely by what
 * the person DID, and it is the one piece of that endpoint worth pinning down
 * without a database.
 *
 * MIRRORS the `answered` closure inside `listMentions` in chatController.js.
 */
const answered = ({ mention, me, lastInChannel, lastInThread }) => {
  const reacted = (mention.reactions || []).some((r) =>
    (r.users || []).some((u) => String(u) === String(me))
  );
  if (reacted) return true;
  const at = mention.replyTo
    ? lastInThread.get(String(mention.replyTo))
    : lastInChannel.get(String(mention.channel));
  return !!at && new Date(at).getTime() > new Date(mention.createdAt).getTime();
};

const T = (iso) => new Date(iso);
const ME = 'me';

const base = {
  channel: 'c1',
  createdAt: T('2026-09-04T10:00:00Z'),
  replyTo: null,
  reactions: [],
};

test('a mention nobody has answered stays on the list', () => {
  assert.equal(
    answered({
      mention: base,
      me: ME,
      lastInChannel: new Map(),
      lastInThread: new Map(),
    }),
    false
  );
});

test('reacting to it counts as answering', () => {
  // A 👍 is an answer, and very often the whole one. If it did not clear the
  // row, the fastest way to answer would leave the list looking untouched.
  assert.equal(
    answered({
      mention: { ...base, reactions: [{ emoji: '👍', users: [ME] }] },
      me: ME,
      lastInChannel: new Map(),
      lastInThread: new Map(),
    }),
    true
  );
});

test("somebody ELSE's reaction does not answer it for you", () => {
  assert.equal(
    answered({
      mention: { ...base, reactions: [{ emoji: '👍', users: ['someone-else'] }] },
      me: ME,
      lastInChannel: new Map(),
      lastInThread: new Map(),
    }),
    false
  );
});

test('a top-level mention is answered by anything you post in that room after it', () => {
  // Deliberately loose. Requiring a thread reply would leave every ordinary
  // back-and-forth — where the answer is just the next message — stuck on the
  // list forever.
  assert.equal(
    answered({
      mention: base,
      me: ME,
      lastInChannel: new Map([['c1', T('2026-09-04T10:05:00Z')]]),
      lastInThread: new Map(),
    }),
    true
  );
});

test('something you said BEFORE the mention does not answer it', () => {
  // The bug this guards: using "have you ever posted here" instead of "since".
  // Every mention in a room you talk in would read as answered on arrival.
  assert.equal(
    answered({
      mention: base,
      me: ME,
      lastInChannel: new Map([['c1', T('2026-09-04T09:00:00Z')]]),
      lastInThread: new Map(),
    }),
    false
  );
});

test('a mention inside a thread needs a reply IN THAT THREAD', () => {
  const inThread = { ...base, replyTo: 't1' };
  // Talking in the room afterwards is not answering a question asked in a
  // thread — the person who asked is reading the thread, not the room.
  assert.equal(
    answered({
      mention: inThread,
      me: ME,
      lastInChannel: new Map([['c1', T('2026-09-04T11:00:00Z')]]),
      lastInThread: new Map(),
    }),
    false
  );
  assert.equal(
    answered({
      mention: inThread,
      me: ME,
      lastInChannel: new Map(),
      lastInThread: new Map([['t1', T('2026-09-04T10:30:00Z')]]),
    }),
    true
  );
});

test('a reply in a DIFFERENT thread does not answer this one', () => {
  assert.equal(
    answered({
      mention: { ...base, replyTo: 't1' },
      me: ME,
      lastInChannel: new Map(),
      lastInThread: new Map([['t2', T('2026-09-04T10:30:00Z')]]),
    }),
    false
  );
});

test('an answer in another channel does not clear it', () => {
  assert.equal(
    answered({
      mention: base,
      me: ME,
      lastInChannel: new Map([['c2', T('2026-09-04T10:30:00Z')]]),
      lastInThread: new Map(),
    }),
    false
  );
});

test('reading it does nothing at all', () => {
  // There is no "seen" input to the rule, and that is the point. Every other
  // signal here is something the person actively did.
  const args = {
    mention: base,
    me: ME,
    lastInChannel: new Map(),
    lastInThread: new Map(),
  };
  assert.equal(answered(args), false);
  assert.equal(answered(args), false);
});

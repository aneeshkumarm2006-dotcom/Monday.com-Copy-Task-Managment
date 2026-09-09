const test = require('node:test');
const assert = require('node:assert');

const { ALLOWED_REACTIONS } = require('./chatController');

/**
 * The reaction rules that are worth pinning down are the ones about SHAPE —
 * what an emoji may be, and what happens to a chip nobody is on. The toggle
 * itself needs a database, so it is exercised by the e2e suite; these are the
 * rules a future edit could quietly break without any test noticing.
 */

/**
 * The toggle, lifted out of the controller so it can be tested without a
 * document. This MIRRORS the branch in `toggleReaction` — if you change the
 * rule there, change it here and the tests below will tell you what moved.
 */
const applyToggle = (reactions, emoji, userId) => {
  const next = reactions.map((r) => ({ ...r, users: [...r.users] }));
  const row = next.find((r) => r.emoji === emoji);
  if (!row) {
    next.push({ emoji, users: [userId] });
  } else if (row.users.some((u) => String(u) === String(userId))) {
    row.users = row.users.filter((u) => String(u) !== String(userId));
  } else {
    row.users.push(userId);
  }
  return next.filter((r) => r.users.length > 0);
};

test('the allowed set is closed, and small', () => {
  // Not "any string": an arbitrary emoji field is a free-text column rendered
  // at 18px in everybody's room, and a way to write in a room you were only
  // given permission to react in.
  assert.ok(ALLOWED_REACTIONS.length > 0);
  assert.ok(ALLOWED_REACTIONS.length <= 16, 'a picker nobody can scan is a picker nobody uses');
  assert.ok(ALLOWED_REACTIONS.includes('👍'));
  assert.ok(!ALLOWED_REACTIONS.includes(''));
  for (const e of ALLOWED_REACTIONS) {
    assert.ok(e.length <= 16, `${e} exceeds the schema's maxlength`);
  }
});

test('the client picker mirrors the server list', () => {
  // client/src/components/chat/chatFormat.js keeps its own copy so the message
  // row and the mentions page can both read it without importing each other.
  // A glyph in one and not the other is a chip that silently 400s.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../../client/src/components/chat/chatFormat.js'),
    'utf8'
  );
  const match = src.match(/export const REACTION_CHOICES = \[([\s\S]*?)\];/);
  assert.ok(match, 'REACTION_CHOICES not found on the client');
  // The client writes them as escapes so the file stays ASCII; eval the array
  // literal rather than trying to unescape by hand.
  // eslint-disable-next-line no-eval
  const choices = eval(`[${match[1]}]`);
  assert.deepEqual(choices, ALLOWED_REACTIONS);
});

test('a first reaction creates the row', () => {
  const out = applyToggle([], '👍', 'u1');
  assert.deepEqual(out, [{ emoji: '👍', users: ['u1'] }]);
});

test('a second person joins the existing row rather than making a new one', () => {
  // The whole reason reactions are stored one-row-per-emoji: the UI draws them
  // grouped, so the document is already in that shape.
  const out = applyToggle([{ emoji: '👍', users: ['u1'] }], '👍', 'u2');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].users, ['u1', 'u2']);
});

test('reacting again removes your reaction', () => {
  const out = applyToggle([{ emoji: '👍', users: ['u1', 'u2'] }], '👍', 'u1');
  assert.deepEqual(out[0].users, ['u2']);
});

test('an emoji whose last person leaves is dropped entirely', () => {
  // An empty chip is not a state — it would render as a zero.
  const out = applyToggle([{ emoji: '👍', users: ['u1'] }], '👍', 'u1');
  assert.deepEqual(out, []);
});

test('removing one emoji leaves the others alone', () => {
  const out = applyToggle(
    [{ emoji: '👍', users: ['u1'] }, { emoji: '🎉', users: ['u1', 'u2'] }],
    '👍',
    'u1'
  );
  assert.deepEqual(out, [{ emoji: '🎉', users: ['u1', 'u2'] }]);
});

test('ids compare as strings, so an ObjectId and its string are one person', () => {
  // The store holds ObjectIds and the client sends strings; a mismatch here
  // would let one person react twice with the same emoji.
  const objectIdish = { toString: () => 'u1' };
  const out = applyToggle([{ emoji: '👍', users: [objectIdish] }], '👍', 'u1');
  assert.deepEqual(out, []);
});

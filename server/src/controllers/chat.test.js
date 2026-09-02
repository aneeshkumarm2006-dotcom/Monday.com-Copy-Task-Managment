const { test } = require('node:test');
const assert = require('node:assert');

/**
 * Chat Phase 1 — schema and wiring regressions.
 *
 * The lesson these tests encode came from the 9am digest: a Notification type
 * missing from the strict enum does not error loudly — creation fails silently
 * at the moment the feature first fires in production. So the enum membership,
 * the preference-category mapping, and the indexes that make chat's reads and
 * races safe are pinned here, where `node --test` runs them without a
 * database.
 */

const mongoose = require('mongoose');
require('../models'); // register everything, exactly as server.js does

const Notification = mongoose.model('Notification');
const Channel = mongoose.model('Channel');
const Message = mongoose.model('Message');
const ChannelRead = mongoose.model('ChannelRead');

// ---------------------------------------------------------------------------
// Notification: the silent-failure trap
// ---------------------------------------------------------------------------

test('chatMention is a valid Notification type', () => {
  const enumValues = Notification.schema.path('type').enumValues;
  assert.ok(
    enumValues.includes('chatMention'),
    'chatMention missing from the type enum — mention notifications would fail silently'
  );
});

test('Notification carries a channel ref for chat deep links', () => {
  const path = Notification.schema.path('channel');
  assert.ok(path, 'Notification.channel path missing');
  assert.strictEqual(path.options.ref, 'Channel');
});

test('a muted mentions category mutes chat mentions too', () => {
  // The mapping lives in notificationService.TYPE_CATEGORY. It is not
  // exported, so probe it through the file's source — the same style the
  // capability-usage tests use to pin wiring without executing it.
  const fs = require('fs');
  const src = fs.readFileSync(
    require.resolve('../services/notificationService'),
    'utf8'
  );
  assert.match(
    src,
    /chatMention:\s*'mentions'/,
    "chatMention must map to the 'mentions' preference category — unmapped types are delivered to everyone with no off switch"
  );
});

// ---------------------------------------------------------------------------
// Channel: the auto-backfill race
// ---------------------------------------------------------------------------

test('one auto channel per (board, group) is enforced by a partial unique index', () => {
  const idx = Channel.schema.indexes().find(
    ([fields]) => fields.board === 1 && fields.group === 1
  );
  assert.ok(idx, 'no (board, group) index on Channel');
  const [, options] = idx;
  assert.strictEqual(options.unique, true, 'index is not unique — racing sidebar fetches would mint duplicate client channels');
  assert.ok(
    options.partialFilterExpression,
    'index is not partial — manual channels (group: null) would be limited to one per board'
  );
});

test('membership is derived, not stored — Channel has no members field', () => {
  assert.strictEqual(
    Channel.schema.path('members'),
    undefined,
    'a stored member list would be a second copy of board access that drifts'
  );
});

// ---------------------------------------------------------------------------
// Message: read paths and the one rule that must hold everywhere
// ---------------------------------------------------------------------------

test('the conversation read is indexed (channel, createdAt desc)', () => {
  const idx = Message.schema.indexes().find(
    ([fields]) => fields.channel === 1 && fields.createdAt === -1
  );
  assert.ok(idx, 'missing the pagination index — every page would collection-scan the channel');
});

test('the thread read is indexed (replyTo, createdAt asc)', () => {
  const idx = Message.schema.indexes().find(
    ([fields]) => fields.replyTo === 1 && fields.createdAt === 1
  );
  assert.ok(idx, 'missing the thread index');
});

test('share chips are references with no score-bearing fields', () => {
  // Chat never writes a score: a message points at a task or goal and
  // nothing more. If someone ever adds a value/actual/progress field to
  // Message, this is the tripwire that makes them read the rule first.
  const forbidden = ['value', 'actual', 'progress', 'score', 'status'];
  for (const field of forbidden) {
    assert.strictEqual(
      Message.schema.path(field),
      undefined,
      `Message.${field} exists — chat must never carry score-bearing state`
    );
  }
  assert.strictEqual(Message.schema.path('task').options.ref, 'Task');
  assert.strictEqual(Message.schema.path('goal').options.ref, 'Goal');
});

test('a message author is a required User — chat has no client/portal side in Phase 1', () => {
  const author = Message.schema.path('author');
  assert.ok(author.isRequired, 'author must be required');
  assert.strictEqual(Message.schema.path('portalAuthor'), undefined);
  assert.strictEqual(Message.schema.path('visibility'), undefined);
});

// ---------------------------------------------------------------------------
// ChannelRead: the unread model
// ---------------------------------------------------------------------------

test('one read marker per (channel, user)', () => {
  const idx = ChannelRead.schema.indexes().find(
    ([fields]) => fields.channel === 1 && fields.user === 1
  );
  assert.ok(idx, 'missing the (channel, user) index');
  assert.strictEqual(idx[1].unique, true, 'marker must be unique per pair');
});

// ---------------------------------------------------------------------------
// Wiring: the routes exist and the stream listens
// ---------------------------------------------------------------------------

test('the SSE hub subscribes to chat.message', () => {
  const fs = require('fs');
  const src = fs.readFileSync(
    require.resolve('../services/notificationStream'),
    'utf8'
  );
  assert.match(src, /eventBus\.on\('chat\.message'/, 'notificationStream never subscribes to chat.message — live delivery would silently not exist');
});

test('chat routes are mounted under /api/chat', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../app'), 'utf8');
  assert.match(src, /app\.use\('\/api\/chat', require\('\.\/routes\/chat'\)\)/);
});

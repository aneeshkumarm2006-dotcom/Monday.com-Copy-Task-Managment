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

test('one auto surface per (board, group, mode, audience), partial and unique', () => {
  // A workstream may carry up to four surfaces — chat/mail x team/client — so
  // the uniqueness key is the whole pair, not just the room.
  const idx = Channel.schema.indexes().find(
    ([fields]) =>
      fields.board === 1 &&
      fields.group === 1 &&
      fields.mode === 1 &&
      fields.audience === 1
  );
  assert.ok(idx, 'no (board, group, mode, audience) index on Channel');
  const [, options] = idx;
  assert.strictEqual(
    options.unique,
    true,
    'index is not unique — racing upserts would mint duplicate surfaces'
  );
  assert.ok(
    options.partialFilterExpression,
    'index is not partial — manual channels (group: null) would be limited to one per board'
  );
});

test('the OLD two-key (board, group) index is gone', () => {
  // Its own sibling above would still MATCH the four-key index if it only
  // looked for board+group — this test is what makes the change visible.
  //
  // And it must actually be dropped, not merely undeclared: Mongoose builds
  // declared indexes at boot and NEVER drops removed ones, so while
  // `{board, group}` survives in MongoDB every second surface for a group is
  // an E11000 — and `ensureAutoChannels`' unordered bulkWrite THROWS on that,
  // 500-ing the sidebar, the board tab and the portal list together.
  // scripts/migrateChatSurfaces.js is what removes it.
  const stale = Channel.schema.indexes().find(
    ([fields]) =>
      fields.board === 1 &&
      fields.group === 1 &&
      fields.mode === undefined &&
      fields.audience === undefined
  );
  assert.strictEqual(
    stale,
    undefined,
    'the one-surface-per-(board, group) index is still declared'
  );
});

test('mode and audience are two axes, and both fail closed', () => {
  const mode = Channel.schema.path('mode');
  const audience = Channel.schema.path('audience');
  assert.deepStrictEqual([...mode.enumValues].sort(), ['chat', 'mail']);
  assert.deepStrictEqual([...audience.enumValues].sort(), ['client', 'team']);

  // The defaults are the whole safety story for every channel written before
  // these fields existed: a surface is private team chat unless someone
  // deliberately opened it.
  assert.strictEqual(mode.defaultValue, 'chat');
  assert.strictEqual(
    audience.defaultValue,
    'team',
    'audience must default to team — a default of client would open every legacy room to contacts'
  );

  // `kind` stays about room-vs-DM. Overloading it with who-is-in-it is what
  // would have left nowhere to put mode.
  assert.deepStrictEqual(
    [...Channel.schema.path('kind').enumValues].sort(),
    ['channel', 'dm']
  );
});

test('room membership is derived — members is the DM-only exception', () => {
  // Rooms derive membership from board access on every read. `members` exists
  // ONLY because a DM's membership IS its identity (not a cached copy of any
  // other rule). The tripwire now guards the refined rule: the field may not
  // grow a role/level shape that would turn it back into stored access.
  const members = Channel.schema.path('members');
  assert.ok(members, 'Channel.members missing — DMs have nowhere to keep their pair');
  const def = Channel.schema.obj.members;
  assert.ok(Array.isArray(def), 'members must be an array');
  assert.strictEqual(
    def[0].ref,
    'User',
    'members must stay a plain list of Users, never {user, level} rows'
  );
  assert.strictEqual(
    def[0].type,
    mongoose.Schema.Types.ObjectId,
    'members entries must be bare User ids'
  );
  assert.ok(Channel.schema.path('kind'), 'Channel.kind missing');
  assert.deepStrictEqual(
    Channel.schema.path('kind').enumValues.sort(),
    ['channel', 'dm']
  );
});

test('one DM per pair is enforced by the partial unique dmKey index', () => {
  const idx = Channel.schema.indexes().find(([fields]) => fields.dmKey === 1);
  assert.ok(idx, 'no dmKey index — racing "message this person" taps would mint duplicate DMs');
  assert.strictEqual(idx[1].unique, true);
  assert.ok(idx[1].partialFilterExpression, 'must be partial — rooms all carry dmKey null');
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

test('a message is authored by a User OR a ClientContact — never both, never neither', () => {
  // Both `required`s are FUNCTIONS, not booleans: a system message has no
  // author and a client message has no User. Asserting `isRequired` here would
  // be asserting the wrong thing.
  const author = Message.schema.path('author');
  const portalAuthor = Message.schema.path('portalAuthor');

  assert.strictEqual(typeof author.options.required, 'function');
  assert.ok(portalAuthor, 'Message.portalAuthor missing — a client post is unattributable');
  assert.strictEqual(portalAuthor.options.ref, 'ClientContact');
  assert.strictEqual(typeof portalAuthor.options.required, 'function');

  assert.deepStrictEqual(
    [...Message.schema.path('authorType').enumValues].sort(),
    ['client', 'system', 'user']
  );

  // The cross-field rule neither `required` can see on its own. It lives as a
  // PATH validator, not a pre('validate') hook: hooks are async middleware and
  // validateSync() skips them, so a hook would enforce this on only half the
  // validation paths while reading as though it enforced it everywhere.
  const guard = Message.schema
    .path('authorType')
    .validators.find((v) => v.validator && v.validator.name === 'enforceSingleAuthor');
  assert.ok(guard, 'nothing stops a message being a team member AND a client at once');
});

test('Message still has NO visibility flag — the split is the channel', () => {
  // Update needs `visibility` because ONE task thread serves two audiences.
  // A channel never does: who may read it is Channel.audience, decided once
  // for the whole surface. A per-message flag here would be a second, weaker
  // copy of that boundary, and every read would have to remember it.
  assert.strictEqual(
    Message.schema.path('visibility'),
    undefined,
    'Message.visibility exists — client access belongs to Channel.audience, not to each message'
  );
});

test('subject is mail-only, capped, and absent by default', () => {
  // A mail THREAD is a top-level message carrying a subject; its replies are
  // that message's ordinary one-level children. No separate thread model.
  const subject = Message.schema.path('subject');
  assert.ok(subject, 'Message.subject missing — a mail thread has nothing to be titled by');
  assert.strictEqual(subject.options.maxlength, 200);
  assert.strictEqual(
    subject.options.default,
    undefined,
    'subject must be ABSENT on chat messages, not an empty string'
  );
});

test('mentions stays [User]; contacts get their own parallel array', () => {
  // `mentions` feeds createNotificationsForUsers, which takes User ids. Making
  // it polymorphic would change the wire shape of every existing message and
  // need splitting at every consumer.
  assert.strictEqual(Message.schema.path('mentions').embeddedSchemaType.options.ref, 'User');
  assert.strictEqual(
    Message.schema.path('mentionsContacts').embeddedSchemaType.options.ref,
    'ClientContact'
  );
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

// ---------------------------------------------------------------------------
// MailThreadRead: mail reads a THREAD, not a channel
// ---------------------------------------------------------------------------

test('one mail read marker per (thread, principal), partial on each', () => {
  const MailThreadRead = require('../models/MailThreadRead');
  const idx = MailThreadRead.schema.indexes();

  for (const principal of ['user', 'contact']) {
    const found = idx.find(([f]) => f.thread === 1 && f[principal] === 1);
    assert.ok(found, `missing the (thread, ${principal}) index`);
    assert.strictEqual(found[1].unique, true, `(thread, ${principal}) must be unique`);
    // Partial, not plain: a compound unique index treats null as a value, so a
    // single {thread,user,contact} index would only work by accident and would
    // stop the moment a row carried neither principal.
    assert.ok(
      found[1].partialFilterExpression,
      `(thread, ${principal}) must be partial so the other principal's rows are exempt`
    );
  }
});

test('a mail read marker belongs to exactly one principal', () => {
  // Enforced as a PATH validator rather than a pre('validate') hook, because
  // hooks are async middleware and validateSync() skips them — so this test
  // uses validateSync deliberately: it is the path the rule could have missed.
  const MailThreadRead = require('../models/MailThreadRead');
  const base = {
    thread: '000000000000000000000001',
    channel: '000000000000000000000002',
    lastReadAt: new Date(),
  };
  const mk = (extra) => new MailThreadRead({ ...base, ...extra });

  assert.ok(mk({}).validateSync(), 'a marker with NO principal must be refused');
  assert.ok(
    mk({ user: '000000000000000000000003', contact: '000000000000000000000004' }).validateSync(),
    'a marker with BOTH principals must be refused'
  );
  assert.ok(!mk({ user: '000000000000000000000003' }).validateSync());
  assert.ok(!mk({ contact: '000000000000000000000004' }).validateSync());
});

test('a message is one principal or the other, under validateSync too', () => {
  const base = { channel: '000000000000000000000001' };
  const mk = (extra) => new Message({ ...base, ...extra });
  const U = '000000000000000000000003';
  const C = '000000000000000000000004';

  assert.ok(!mk({ authorType: 'user', author: U }).validateSync());
  assert.ok(!mk({ authorType: 'client', portalAuthor: C }).validateSync());
  assert.ok(!mk({ authorType: 'system' }).validateSync());

  assert.ok(
    mk({ authorType: 'user', author: U, portalAuthor: C }).validateSync(),
    'a team message must not also carry a client author'
  );
  assert.ok(
    mk({ authorType: 'client', author: U, portalAuthor: C }).validateSync(),
    'a client message must not also carry a team author'
  );
  assert.ok(
    mk({ authorType: 'client' }).validateSync(),
    'a client message with no contact is unattributable and must be refused'
  );
  assert.ok(
    mk({ authorType: 'system', author: U }).validateSync(),
    'a system message has no author'
  );
});

// ---------------------------------------------------------------------------
// Notifications: the mapping that decides whether there is an off switch
// ---------------------------------------------------------------------------

test('clientChatMessage is in the Notification type enum', () => {
  const Notification = require('../models/Notification');
  assert.ok(
    Notification.schema.path('type').enumValues.includes('clientChatMessage'),
    'a type missing from the enum fails validation at the moment the feature first fires in production'
  );
});

test('clientChatMessage is MAPPED to a preference category', () => {
  // The load-bearing one. An unmapped type is delivered to everybody, always,
  // whatever their preferences say — and this type fires on every message a
  // client sends. Unmapped, it is the noisiest possible bell with no off switch.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../services/notificationService'), 'utf8');
  assert.match(
    src,
    /clientChatMessage:\s*'updates'/,
    'clientChatMessage has no TYPE_CATEGORY row — every client message would be undismissable'
  );
});

test("'chat' is a valid notification tab", () => {
  // Client conversations live only on their board's Chat tab; they are excluded
  // from the global /chat sidebar. Without this tab value a notification about
  // one would deep-link to a page whose sidebar no longer lists the channel.
  const Notification = require('../models/Notification');
  assert.ok(Notification.schema.path('tab').enumValues.includes('chat'));
});

// ---------------------------------------------------------------------------
// The migration that has to run before any surface can be created
// ---------------------------------------------------------------------------

test('migrateChatSurfaces backfills BEFORE it touches the indexes', () => {
  // The ordering is the whole point of the script. A Mongoose default applies
  // on write and never to stored documents, so an un-backfilled channel indexes
  // as (board, group, null, null) — a different key from (board, group, 'chat',
  // 'team'), which means the next upsert mints a duplicate room for every
  // existing tracker group, silently splitting each team's history.
  const fs = require('fs');
  const src = fs.readFileSync(
    require.resolve('../scripts/migrateChatSurfaces'),
    'utf8'
  );
  const backfillGuard = src.indexOf('REFUSED');
  assert.ok(
    backfillGuard > 0,
    'the indexes phase does not refuse to run against un-backfilled channels'
  );
  assert.match(
    src,
    /createIndex\([\s\S]{0,200}board: 1, group: 1, mode: 1, audience: 1/,
    'the script never creates the four-key index'
  );
  // And the old index is dropped by name, not left to autoIndex — which never
  // drops anything it stops seeing declared.
  assert.match(src, /dropIndex\(OLD_INDEX\)/);
});

test('ensureGroupChannel defaults to the PRIVATE team surface', () => {
  // Its filter used to be {board, group}, which identified exactly one row. A
  // workstream can now carry up to four surfaces, so that pair matches up to
  // four documents and MongoDB returns whichever it likes.
  //
  // The only caller is the POST_TO_CHANNEL automation. Without the two extra
  // arguments — and without them DEFAULTING to the team room — an automation on
  // a client board could post an internal system message straight into the room
  // the client is reading. A source probe, because the alternative is a live DB.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../services/chatSystemPost'), 'utf8');

  assert.ok(
    src.includes("mode = 'chat'") && src.includes("audience = 'team'"),
    'ensureGroupChannel does not default to the private team surface'
  );
  assert.ok(
    src.includes('{ board: boardId, group: groupId, mode, audience }'),
    'ensureGroupChannel still filters on the ambiguous (board, group) pair'
  );

  // And no caller may quietly ask for a client-facing room.
  const auto = fs.readFileSync(
    require.resolve('../controllers/automationController'),
    'utf8'
  );
  const call = auto.slice(auto.indexOf('ensureGroupChannel('));
  assert.ok(
    !call.slice(0, 200).includes("'client'"),
    'an automation is asking ensureGroupChannel for a client-facing room'
  );
});

test('chat routes are mounted under /api/chat', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../app'), 'utf8');
  assert.match(src, /app\.use\('\/api\/chat', require\('\.\/routes\/chat'\)\)/);
});

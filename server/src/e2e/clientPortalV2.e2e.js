/**
 * End-to-end check of Client Portal v2 — board-as-client, workstream surfaces,
 * client chat and client mail — against a THROWAWAY in-memory MongoDB.
 *
 * Boots the real Express app, seeds a client board with two workstreams and two
 * contacts, and drives the real HTTP endpoints on BOTH auth planes. The user's
 * Atlas cluster is never touched.
 *
 * Run: npm run e2e:client-portal   (from server/)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * `npm test` for this feature is entirely schema assertions, pure functions and
 * source probes. Everything most likely to be wrong lives BELOW that line and
 * only shows up against a real database and a real router:
 *
 *   1. THE CONFIDENTIALITY BOUNDARY. `chatAudience` decides who is in a room.
 *      A team surface must never return a ClientContact, and a client must
 *      never be able to open the private team room. Both are one predicate away
 *      from being wrong, and neither fails loudly — it just quietly shows the
 *      wrong people the wrong conversation.
 *   2. THE UNIQUE INDEX. `(board, group, mode, audience)` is what makes surface
 *      creation idempotent. Mongoose builds indexes lazily and `createSurfaces`
 *      catches E11000 on purpose, so a MISSING index looks exactly like a
 *      working one until two rooms exist for one workstream.
 *   3. THE CASCADE. Deleting a workstream must take its rooms with it, because
 *      the client-side audience gate keys on the BOARD, which outlives the
 *      group — an orphaned client room stays readable by the client and
 *      invisible to the team.
 *   4. MAIL'S SORT ORDER. Threads sort by last activity, computed by an
 *      aggregation with a $lookup. No unit test can tell whether that pipeline
 *      actually runs.
 *   5. THE MIGRATION, run as a real subprocess against a real collection.
 *
 * Assertions are written so that a FAILURE NAMES THE PROPERTY, not the value.
 */
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = process.argv[2] || path.resolve(__dirname, '../../..');
const S = (p) => path.join(ROOT, 'server', p);

process.env.JWT_SECRET = 'e2e-secret';
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = 'e2e-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'e2e-client-secret';
process.env.GOOGLE_CALLBACK_URL = 'http://localhost/api/auth/google/callback';
process.env.SESSION_SECRET = 'e2e-session';
process.env.CLIENT_URL = 'http://localhost';

let failures = 0;
const results = [];
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `\n        ${detail}` : ''}`);
  console.log(results[results.length - 1]);
};

const main = async () => {
  const { MongoMemoryServer } = require(path.join(ROOT, 'server/node_modules/mongodb-memory-server'));
  const mongoose = require(path.join(ROOT, 'server/node_modules/mongoose'));
  const jwt = require(path.join(ROOT, 'server/node_modules/jsonwebtoken'));

  console.log('starting in-memory mongod…');
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;

  await mongoose.connect(uri);
  console.log('connected:', uri, '\n');

  require(S('src/models'));
  const User = mongoose.model('User');
  const Organisation = mongoose.model('Organisation');
  const Board = mongoose.model('Board');
  const TaskGroup = mongoose.model('TaskGroup');
  const Channel = mongoose.model('Channel');
  const Message = mongoose.model('Message');
  const ClientContact = mongoose.model('ClientContact');
  const Notification = mongoose.model('Notification');
  const MailThreadRead = mongoose.model('MailThreadRead');

  const { channelAudience } = require(S('src/services/chatAudience'));

  // ======================================================================
  // Seed
  // ======================================================================
  const owner = await User.create({ name: 'Priya S', email: 'priya@agency.test', googleId: 'g-priya' });
  const mate = await User.create({ name: 'Sara K', email: 'sara@agency.test', googleId: 'g-sara' });

  const org = await Organisation.create({
    name: 'Agency',
    admin: owner._id,
    members: [owner._id, mate._id],
    inviteCode: 'e2e-invite',
  });
  org.ensureSystemRoles();
  await org.save();
  await User.updateMany({ _id: { $in: [owner._id, mate._id] } }, { $set: { organisations: [org._id] } });

  const board = await Board.create({
    name: 'Acme Corp',
    organisation: org._id,
    boardType: 'client',
    createdBy: owner._id,
    visibility: 'public',
    portalEnabled: true,
    portalToken: 'e2e-portal-token',
    portalClientName: 'Acme Corp',
    portalTier: 'basic',
  });

  const ads = await TaskGroup.create({ name: 'Ads', board: board._id, order: 0 });
  const seo = await TaskGroup.create({ name: 'SEO', board: board._id, order: 1 });

  // A second, ordinary tracker board — the control for "client rooms are
  // excluded from the global sidebar but tracker rooms are not".
  const tracker = await Board.create({
    name: 'Internal Tracker',
    organisation: org._id,
    boardType: 'tracker',
    monthTimezone: 'Asia/Kolkata',
    createdBy: owner._id,
    visibility: 'public',
  });
  await TaskGroup.create({ name: 'Client A', board: tracker._id, order: 0 });

  const dana = await ClientContact.create({
    email: 'dana@acme.test',
    name: 'Dana Q',
    board: board._id,
    organisation: org._id,
    verified: true,
  });
  const raj = await ClientContact.create({
    email: 'raj@acme.test',
    name: 'Raj P',
    board: board._id,
    organisation: org._id,
    verified: true,
  });

  // Indexes are built lazily. Force them now — assertion #2 above depends on
  // the unique index actually existing.
  await Channel.syncIndexes();
  await MailThreadRead.syncIndexes();

  const appToken = jwt.sign(
    { userId: owner._id.toString(), email: owner.email, name: owner.name },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const portalTokenFor = (contact) =>
    jwt.sign(
      {
        scope: 'portal',
        contactId: String(contact._id),
        boardId: String(board._id),
        orgId: String(org._id),
        email: contact.email,
        ptk: 'e2e-portal-token',
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

  const app = require(S('src/app'));

  // server.js does this at boot, not app.js — so booting the app alone leaves
  // the SSE handlers unsubscribed from the event bus and every live frame
  // silently goes nowhere. Mirrored here for the same reason the real server
  // does it: without it section 9b tests an event bus nobody is listening to.
  require(S('src/services/notificationStream')).mount();

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log('app listening on', base, '\n');

  const request = (token) => async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  };

  const team = request(appToken);
  const client = request(portalTokenFor(dana));
  const client2 = request(portalTokenFor(raj));

  const B = board._id;

  // ======================================================================
  console.log('--- 1. the tier gate: nothing exists on a basic board --------');
  // ======================================================================

  let r = await team('POST', `/api/chat/boards/${B}/groups/${ads._id}/surfaces`, {
    clientChat: true, team: true,
  });
  check(
    'client surfaces are REFUSED on a basic-tier board',
    r.status === 400 && /Advanced/i.test(r.body?.error || ''),
    `${r.status} ${JSON.stringify(r.body)}`
  );

  r = await team('POST', `/api/chat/boards/${B}/groups/${ads._id}/surfaces`, {});
  check(
    'an EMPTY selection is refused',
    r.status === 400 && /at least one/i.test(r.body?.error || ''),
    `${r.status} ${JSON.stringify(r.body)}`
  );

  r = await client('GET', '/api/portal/me/chat/channels');
  check(
    'the client gets 403, not an empty list, on a basic board',
    r.status === 403,
    `${r.status} ${JSON.stringify(r.body)}`
  );

  // A team-only room needs no tier — it has no client in it.
  r = await team('POST', `/api/chat/boards/${B}/groups/${seo._id}/surfaces`, { team: true });
  check(
    'a TEAM-ONLY room is allowed on a basic board',
    r.status === 201 && r.body?.created?.length === 1,
    `${r.status} ${JSON.stringify(r.body)}`
  );

  // ======================================================================
  console.log('\n--- 2. upgrading, then creating surfaces ---------------------');
  // ======================================================================

  r = await team('POST', `/api/portal/boards/${B}/tier/upgrade`, { confirm: 'Acme Corp' });
  check('the board upgrades to advanced', r.status === 200 && r.body?.tier === 'advanced',
    `${r.status} ${JSON.stringify(r.body)}`);

  r = await team('POST', `/api/chat/boards/${B}/groups/${ads._id}/surfaces`, {
    clientChat: true, clientMail: true, team: true,
  });
  check('all three surfaces are created for Ads',
    r.status === 201 && r.body?.created?.length === 3,
    `${r.status} ${JSON.stringify(r.body?.created?.map((c) => c.surfaceKey))}`);
  check('each carries its resolved surfaceKey',
    JSON.stringify((r.body?.created || []).map((c) => c.surfaceKey).sort()) ===
      JSON.stringify(['clientChat', 'clientMail', 'team']),
    JSON.stringify(r.body?.created?.map((c) => c.surfaceKey)));

  const adsChat = await Channel.findOne({ group: ads._id, mode: 'chat', audience: 'client' });
  const adsMail = await Channel.findOne({ group: ads._id, mode: 'mail', audience: 'client' });
  const adsTeam = await Channel.findOne({ group: ads._id, mode: 'chat', audience: 'team' });

  check('the client-facing room names the company',
    adsChat?.name === 'Ads · Acme Corp', adsChat?.name);
  check('the team room keeps the bare workstream name',
    adsTeam?.name === 'Ads', adsTeam?.name);

  // THE IDEMPOTENCE PROPERTY — assertion #2 in the header.
  r = await team('POST', `/api/chat/boards/${B}/groups/${ads._id}/surfaces`, {
    clientChat: true, clientMail: true, team: true,
  });
  check('re-running the picker creates NOTHING and reports them as existing',
    r.status === 201 && r.body?.created?.length === 0 && r.body?.existing?.length === 3,
    `created=${r.body?.created?.length} existing=${r.body?.existing?.length}`);
  const adsChannelCount = await Channel.countDocuments({ group: ads._id });
  check('so the workstream still has exactly three channels',
    adsChannelCount === 3, `${adsChannelCount} channels`);

  // ======================================================================
  console.log('\n--- 3. THE CONFIDENTIALITY BOUNDARY --------------------------');
  // ======================================================================

  let aud = await channelAudience(adsTeam);
  check('a TEAM surface returns NO contacts',
    aud.contactIds.length === 0, JSON.stringify(aud.contactIds));
  check('…while still returning the team',
    aud.userIds.length === 2, JSON.stringify(aud.userIds));

  aud = await channelAudience(adsChat);
  check('a CLIENT surface returns both contacts',
    aud.contactIds.length === 2, JSON.stringify(aud.contactIds));
  check('…and the team as well — a client room is not client-only',
    aud.userIds.length === 2, JSON.stringify(aud.userIds));

  // The kill switch, checked at the audience rather than only per-request.
  await Board.updateOne({ _id: B }, { $set: { portalEnabled: false } });
  aud = await channelAudience(adsChat);
  check('DISABLING the portal empties the contact audience immediately',
    aud.contactIds.length === 0, JSON.stringify(aud.contactIds));
  await Board.updateOne({ _id: B }, { $set: { portalEnabled: true } });

  // The client must not be able to open the team room even by id.
  r = await client('GET', `/api/portal/me/chat/channels/${adsTeam._id}/messages`);
  check('a client asking for the TEAM room by id gets 404',
    r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);

  // ======================================================================
  console.log('\n--- 4. the two sidebars are disjoint -------------------------');
  // ======================================================================

  r = await team('GET', `/api/chat/channels?org=${org._id}`);
  const sidebarBoards = (r.body?.channels || []).map((c) => String(c.board?._id || ''));
  check('the GLOBAL sidebar excludes every client-board room',
    !sidebarBoards.includes(String(B)),
    JSON.stringify((r.body?.channels || []).map((c) => c.name)));
  check('…but still contains the tracker board\'s room',
    sidebarBoards.includes(String(tracker._id)),
    JSON.stringify((r.body?.channels || []).map((c) => c.name)));

  r = await team('GET', `/api/chat/boards/${B}/channels`);
  check('the board tab lists the board\'s surfaces', r.status === 200, `${r.status}`);
  const adsRow = (r.body?.workstreams || []).find((w) => w.group.name === 'Ads');
  const seoRow = (r.body?.workstreams || []).find((w) => w.group.name === 'SEO');
  check('Ads shows three surfaces', adsRow?.surfaces?.length === 3,
    JSON.stringify(adsRow?.surfaces?.map((s) => s.surfaceKey)));
  check('SEO shows only its team room', seoRow?.surfaces?.length === 1,
    JSON.stringify(seoRow?.surfaces?.map((s) => s.surfaceKey)));
  check('the board payload carries the tier, for the tab gate',
    r.body?.board?.portalTier === 'advanced', JSON.stringify(r.body?.board));

  // A workstream with NO surfaces must still be listed — it is the row that
  // renders "Set up communication".
  const web = await TaskGroup.create({ name: 'Web', board: B, order: 2 });
  r = await team('GET', `/api/chat/boards/${B}/channels`);
  const webRow = (r.body?.workstreams || []).find((w) => w.group.name === 'Web');
  check('a workstream with NO surfaces is still listed, with an empty array',
    !!webRow && Array.isArray(webRow.surfaces) && webRow.surfaces.length === 0,
    JSON.stringify(webRow));

  // ======================================================================
  console.log('\n--- 5. client chat, both directions --------------------------');
  // ======================================================================

  r = await client('GET', '/api/portal/me/chat/channels');
  check('the client sees their workstreams', r.status === 200, `${r.status}`);
  const clientAds = (r.body?.workstreams || []).find((w) => w.name === 'Ads');
  check('Ads shows exactly TWO surfaces to the client (chat + mail, never the team room)',
    clientAds?.surfaces?.length === 2,
    JSON.stringify(clientAds?.surfaces?.map((s) => s.mode)));
  check('SEO is NOT shown — it has only a team room',
    !(r.body?.workstreams || []).some((w) => w.name === 'SEO'),
    JSON.stringify((r.body?.workstreams || []).map((w) => w.name)));

  r = await client('POST', `/api/portal/me/chat/channels/${adsChat._id}/messages`, {
    bodyText: 'Can we raise the daily cap?',
  });
  check('the client can post', r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  check('their own message comes back as `mine`', r.body?.message?.mine === true,
    JSON.stringify(r.body?.message));
  check('and is attributed to them by name',
    r.body?.message?.authorName === 'Dana Q', r.body?.message?.authorName);

  // THE LEAK CHECK — R3 in the plan. A team reply must not carry an email.
  const teamMsg = await team('POST', `/api/chat/channels/${adsChat._id}/messages`, {
    bodyText: 'Raising it now.',
  });
  check('the team can post into the client room', teamMsg.status === 201, `${teamMsg.status}`);

  r = await client('GET', `/api/portal/me/chat/channels/${adsChat._id}/messages`);
  const wire = JSON.stringify(r.body);
  check('NO team email address appears anywhere on the client\'s wire',
    !wire.includes('priya@agency.test') && !wire.includes('@agency.test'),
    wire.slice(0, 400));
  check('the client sees both messages', (r.body?.messages || []).length === 2,
    `${(r.body?.messages || []).length}`);
  check('the team\'s message is not `mine` to the client',
    r.body?.messages?.find((m) => m.bodyText === 'Raising it now.')?.mine === false,
    JSON.stringify(r.body?.messages?.map((m) => [m.authorName, m.mine])));

  // Share chips must be refused in a client-facing room.
  const Task = mongoose.model('Task');
  const someTask = await Task.create({
    name: 'Internal: renegotiate rate card', board: B, group: ads._id, status: 'not_started', order: 0,
  });
  r = await team('POST', `/api/chat/channels/${adsChat._id}/messages`, {
    bodyText: 'fyi', taskId: String(someTask._id),
  });
  check('a TASK CHIP is refused in a client-facing room',
    r.status === 400 && /client-facing/i.test(r.body?.error || ''),
    `${r.status} ${JSON.stringify(r.body)}`);
  r = await team('POST', `/api/chat/channels/${adsTeam._id}/messages`, {
    bodyText: 'fyi', taskId: String(someTask._id),
  });
  check('…but allowed in the team room', r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);

  // ======================================================================
  console.log('\n--- 6. the bell: one unread row per (recipient, channel) -----');
  // ======================================================================

  await Notification.deleteMany({ type: 'clientChatMessage' });
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await client('POST', `/api/portal/me/chat/channels/${adsChat._id}/messages`, {
      bodyText: `follow-up ${i}`,
    });
  }
  const bells = await Notification.find({ type: 'clientChatMessage', user: owner._id });
  check('four client messages produce ONE unread bell row, not four',
    bells.length === 1, `${bells.length} rows`);
  check('…and that row shows the LATEST message',
    /follow-up 3/.test(bells[0]?.message || ''), bells[0]?.message);
  check('it deep-links to the chat tab', bells[0]?.tab === 'chat', bells[0]?.tab);
  check('it names the channel so the link can resolve',
    String(bells[0]?.channel) === String(adsChat._id), String(bells[0]?.channel));

  // Once read, the next message opens a fresh row.
  await Notification.updateMany({ type: 'clientChatMessage' }, { $set: { isRead: true } });
  await client('POST', `/api/portal/me/chat/channels/${adsChat._id}/messages`, { bodyText: 'after read' });
  const bells2 = await Notification.find({
    type: 'clientChatMessage', user: owner._id, isRead: false,
  });
  check('after the team reads it, the next client message opens a NEW row',
    bells2.length === 1, `${bells2.length} unread rows`);

  // ======================================================================
  console.log('\n--- 7. mail: threads, sort order, per-thread reads -----------');
  // ======================================================================

  r = await client('POST', `/api/portal/me/chat/channels/${adsMail._id}/threads`, {
    bodyText: 'What did October cost us in total?',
  });
  check('a mail thread with NO subject is refused',
    r.status === 400 && /subject/i.test(r.body?.error || ''),
    `${r.status} ${JSON.stringify(r.body)}`);

  r = await client('POST', `/api/portal/me/chat/channels/${adsMail._id}/threads`, {
    subject: 'October spend', bodyText: 'What did October cost us in total?',
  });
  check('THE CLIENT CAN START A MAIL THREAD', r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  const octoberId = r.body?.message?.id;

  r = await team('POST', `/api/chat/channels/${adsMail._id}/threads`, {
    subject: 'Q4 budget', bodyText: 'Draft attached.',
  });
  check('the team can start one too', r.status === 201, `${r.status}`);
  const q4Id = String(r.body?.message?._id);

  // "October spend" is OLDER, so a naive sort by the root's createdAt puts it
  // last. Answer it, and it must jump to the top.
  await new Promise((res2) => setTimeout(res2, 25));
  r = await team('POST', `/api/chat/channels/${adsMail._id}/messages`, {
    bodyText: 'Just over £12k.', replyTo: octoberId,
  });
  check('the team can reply into a client-started thread', r.status === 201,
    `${r.status} ${JSON.stringify(r.body)}`);

  r = await team('GET', `/api/chat/channels/${adsMail._id}/threads`);
  check('the mailbox lists both threads', (r.body?.threads || []).length === 2,
    JSON.stringify(r.body?.threads?.map((t) => t.subject)));
  check('THREADS SORT BY LAST ACTIVITY — the answered one is first',
    r.body?.threads?.[0]?.subject === 'October spend',
    JSON.stringify(r.body?.threads?.map((t) => [t.subject, t.lastAt])));
  check('the reply count is carried',
    r.body?.threads?.[0]?.replyCount === 1, JSON.stringify(r.body?.threads?.[0]));
  check('participants include BOTH principal kinds',
    new Set((r.body?.threads?.[0]?.participants || []).map((p) => p.kind)).size === 2,
    JSON.stringify(r.body?.threads?.[0]?.participants));

  // Per-thread reads: opening one must not clear the other.
  r = await client('GET', `/api/portal/me/chat/channels/${adsMail._id}/threads`);
  const unreadBefore = (r.body?.threads || []).filter((t) => t.unread).length;
  // BOTH are unread to Dana, and for two different reasons worth stating:
  // "Q4 budget" she has never opened; "October spend" she wrote herself (so it
  // was marked read on send) but the team has since REPLIED, which is exactly
  // when a thread should come back.
  check('both threads are unread to the client, including her own once answered',
    unreadBefore === 2,
    `${unreadBefore} unread: ${JSON.stringify(r.body?.threads?.map((t) => [t.subject, t.unread]))}`);

  await client('POST', `/api/portal/me/chat/threads/${q4Id}/read`);
  r = await client('GET', `/api/portal/me/chat/channels/${adsMail._id}/threads`);
  const q4 = (r.body?.threads || []).find((t) => t.subject === 'Q4 budget');
  const oct = (r.body?.threads || []).find((t) => t.subject === 'October spend');
  check('reading Q4 marks Q4 read', q4?.unread === false, JSON.stringify(q4));
  // THE PROPERTY MAIL EXISTS FOR: reads are per-thread, so opening one leaves
  // the rest alone. A channel-level marker would have cleared both here.
  check('…and October is STILL UNREAD — reads are per-thread, not per-mailbox',
    oct?.unread === true,
    JSON.stringify(r.body?.threads?.map((t) => [t.subject, t.unread])));

  // A reply must never carry its own subject — the schema validator.
  const replyWithSubject = new Message({
    channel: adsMail._id, authorType: 'user', author: owner._id,
    bodyText: 'x', replyTo: octoberId, subject: 'sneaky',
  });
  check('a REPLY carrying its own subject is refused by the schema',
    !!replyWithSubject.validateSync(), 'accepted');

  // Threads on a chat channel make no sense.
  r = await team('GET', `/api/chat/channels/${adsChat._id}/threads`);
  check('asking a CHAT channel for threads is a 400',
    r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  // ======================================================================
  console.log('\n--- 8. mentions, and what the roster endpoint reveals --------');
  // ======================================================================

  r = await client('GET', '/api/portal/me/chat/mentions');
  check('the client can list mentionable team members', r.status === 200, `${r.status}`);
  check('…as names and ids only, with NO email',
    !JSON.stringify(r.body).includes('@agency.test'), JSON.stringify(r.body));
  check('…and it is the whole board-reading team', (r.body || []).length === 2,
    JSON.stringify(r.body));

  // ======================================================================
  console.log('\n--- 9. a second contact at the same company ------------------');
  // ======================================================================

  r = await client2('GET', `/api/portal/me/chat/channels/${adsChat._id}/messages`);
  check('a colleague at the client sees the same room', r.status === 200, `${r.status}`);
  check('…but Dana\'s messages are NOT `mine` to Raj',
    (r.body?.messages || []).every((m) => m.authorName !== 'Dana Q' || m.mine === false),
    JSON.stringify(r.body?.messages?.map((m) => [m.authorName, m.mine])));

  // ======================================================================
  console.log('\n--- 9b. LIVE DELIVERY over SSE ------------------------------');
  // ======================================================================
  //
  // Node has no EventSource, but SSE is only a chunked text response, so a
  // plain fetch plus a stream reader is the whole client. This is the one check
  // that exercises the TWO-SERIALIZATION fan-out — the place an email address
  // would leak, because the team's populate selects `author.email` and the
  // client's must not.

  const openStream = async (token) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/portal/me/stream?token=${encodeURIComponent(token)}`, {
      signal: ac.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames = [];
    // Drain in the background; the test polls `frames`.
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let i = buffer.indexOf('\n\n');
          while (i !== -1) {
            const chunk = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line) {
              try { frames.push(JSON.parse(line.slice(6))); } catch { /* not json */ }
            }
            i = buffer.indexOf('\n\n');
          }
        }
      } catch { /* aborted */ }
    })();
    return { status: res.status, frames, close: () => ac.abort() };
  };

  const waitFor = async (frames, predicate, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = frames.find(predicate);
      if (hit) return hit;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r2) => setTimeout(r2, 40));
    }
    return null;
  };

  // A rotated/disabled portal must be refused at connect time, not just later.
  const badStream = await fetch(`${base}/api/portal/me/stream?token=not-a-jwt`);
  check('the stream refuses an invalid token', badStream.status === 401, `${badStream.status}`);

  const stream = await openStream(portalTokenFor(dana));
  check('the client can open a stream', stream.status === 200, `${stream.status}`);

  await new Promise((r2) => setTimeout(r2, 120)); // let the registry register

  await team('POST', `/api/chat/channels/${adsChat._id}/messages`, {
    bodyText: 'Live from the team.',
  });

  const frame = await waitFor(
    stream.frames,
    (f) => f.type === 'chat.message' && f.message?.bodyText === 'Live from the team.'
  );
  check('a team message reaches the client LIVE', !!frame,
    JSON.stringify(stream.frames).slice(0, 400));
  check('…in the PORTAL shape, not the team one',
    frame?.message?.authorName === 'Priya S' && frame?.message?.id !== undefined,
    JSON.stringify(frame?.message));
  check('…carrying NO email address — the two-serialization split holds',
    !JSON.stringify(frame || {}).includes('@agency.test'),
    JSON.stringify(frame?.message));
  check('…and not `mine` to the reader', frame?.message?.mine === false,
    JSON.stringify(frame?.message));

  // The team room must never reach a client's socket.
  await team('POST', `/api/chat/channels/${adsTeam._id}/messages`, {
    bodyText: 'INTERNAL ONLY — do not send to client',
  });
  const leaked = await waitFor(
    stream.frames,
    (f) => /INTERNAL ONLY/.test(JSON.stringify(f)),
    700
  );
  check('a message in the TEAM ROOM never reaches the client\'s stream',
    leaked === null, JSON.stringify(leaked));

  // The kill switch has to reach an OPEN socket, not just the next request.
  await team('PUT', `/api/portal/boards/${B}/config`, { enabled: false });
  await new Promise((r2) => setTimeout(r2, 150));
  await team('PUT', `/api/portal/boards/${B}/config`, { enabled: true });
  await team('POST', `/api/chat/channels/${adsChat._id}/messages`, {
    bodyText: 'after the portal was switched off',
  });
  const afterKill = await waitFor(
    stream.frames,
    (f) => /after the portal was switched off/.test(JSON.stringify(f)),
    700
  );
  check('DISABLING the portal drops the live stream immediately',
    afterKill === null, JSON.stringify(afterKill));

  stream.close();

  // ======================================================================
  console.log('\n--- 10. THE CASCADE -----------------------------------------');
  // ======================================================================

  const beforeChannels = await Channel.countDocuments({ group: ads._id });
  const adsChannelIds = (await Channel.find({ group: ads._id }).select('_id')).map((c) => c._id);
  const beforeMessages = await Message.countDocuments({ channel: { $in: adsChannelIds } });
  check('before deleting: Ads has channels and messages',
    beforeChannels === 3 && beforeMessages > 0, `${beforeChannels} channels, ${beforeMessages} messages`);

  r = await team('DELETE', `/api/groups/${ads._id}`);
  check('the workstream deletes', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);

  const afterChannels = await Channel.countDocuments({ group: ads._id });
  const afterMessages = await Message.countDocuments({ channel: { $in: adsChannelIds } });
  const afterMailReads = await MailThreadRead.countDocuments({ channel: { $in: adsChannelIds } });
  check('DELETING A WORKSTREAM TAKES ITS CHANNELS WITH IT',
    afterChannels === 0, `${afterChannels} channels survived`);
  check('…and every message in them', afterMessages === 0, `${afterMessages} messages survived`);
  check('…and the mail read markers', afterMailReads === 0, `${afterMailReads} markers survived`);

  // The board cascade.
  await team('POST', `/api/chat/boards/${B}/groups/${seo._id}/surfaces`, { clientChat: true });
  const beforeBoardChannels = await Channel.countDocuments({ board: B });
  check('the board still has channels before deletion', beforeBoardChannels > 0, `${beforeBoardChannels}`);
  r = await team('DELETE', `/api/boards/${B}`);
  check('the board deletes', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  const afterBoardChannels = await Channel.countDocuments({ board: B });
  const afterContacts = await ClientContact.countDocuments({ board: B });
  check('DELETING A BOARD TAKES ITS CHANNELS WITH IT',
    afterBoardChannels === 0, `${afterBoardChannels} survived`);
  check('…and its contacts', afterContacts === 0, `${afterContacts} survived`);

  // ======================================================================
  console.log('\n--- 11. the migration, as a real subprocess ------------------');
  // ======================================================================

  // Put the collection back into its PRE-migration state: a channel with no
  // mode and no audience, exactly as every row written before this feature.
  //
  // On a group that has NO channel yet, which is the only state real data can
  // be in. Until this migration drops it, the OLD `(board, group)` unique index
  // is still there and is precisely what stops a second room existing for a
  // pair — so a legacy row can never be sitting next to its own duplicate.
  const raw = mongoose.connection.collection('channels');
  const legacyGroup = await TaskGroup.create({
    name: 'Legacy client', board: tracker._id, order: 9,
  });
  await raw.insertOne({
    organisation: org._id,
    board: tracker._id,
    group: legacyGroup._id,
    name: 'Legacy room',
    kind: 'channel',
    archived: false,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const runMigration = (args) =>
    spawnSync(process.execPath, [S('src/scripts/migrateChatSurfaces.js'), ...args], {
      env: { ...process.env, MONGODB_URI: uri },
      encoding: 'utf8',
      cwd: S('.'),
    });

  let out = runMigration(['--report']);
  check('--report runs and finds the un-backfilled row',
    /missing `mode`\s*:\s*1/.test(out.stdout || ''), (out.stdout || out.stderr || '').slice(-600));

  out = runMigration(['--indexes']);
  check('--indexes REFUSES while a channel is un-backfilled',
    /REFUSED/.test(out.stdout || '') && out.status !== 0,
    `status=${out.status} ${(out.stdout || '').slice(-400)}`);

  out = runMigration(['--backfill', '--dry-run']);
  const stillMissing = await raw.countDocuments({ mode: { $exists: false } });
  check('--dry-run writes nothing', stillMissing === 1, `${stillMissing} still missing`);

  out = runMigration(['--backfill']);
  check('--backfill exits 0', out.status === 0,
    `status=${out.status} ${(out.stdout || '').slice(-400)}`);
  const nowMissing = await raw.countDocuments({
    $or: [{ mode: { $exists: false } }, { audience: { $exists: false } }],
  });
  // BOTH fields, not just `mode`. Asserting only one is how a half-finished
  // backfill passed for a while: the mode update ran, the audience update threw,
  // and nothing looked wrong.
  check('--backfill fills BOTH fields on every row', nowMissing === 0,
    `${nowMissing} still missing a field`);
  const legacy = await raw.findOne({ name: 'Legacy room' });
  check('a backfilled row becomes a PRIVATE TEAM chat room — what it already was',
    legacy?.mode === 'chat' && legacy?.audience === 'team',
    JSON.stringify({ mode: legacy?.mode, audience: legacy?.audience }));

  out = runMigration(['--indexes', '--verify']);
  check('--indexes then --verify passes',
    out.status === 0 && /All checks passed/.test(out.stdout || ''),
    `status=${out.status} ${(out.stdout || '').slice(-700)}`);

  const idxNames = (await raw.indexes()).map((i) => i.name);
  check('the four-key unique index exists',
    idxNames.includes('board_1_group_1_mode_1_audience_1'), idxNames.join(', '));
  check('the old two-key index is GONE',
    !idxNames.includes('board_1_group_1'), idxNames.join(', '));

  // ======================================================================
  console.log('\n--- 12. migratePortalToBoard, on a PRE-migration board -------');
  // ======================================================================
  //
  // This is the migration that touches live client CREDENTIALS, so its guards
  // are worth more than its happy path. Seeded in the state production is
  // actually in: the token lives on the GROUP and the board has none.

  const legacyBoard = await Board.create({
    name: 'Legacy Client Co',
    organisation: org._id,
    boardType: 'client',
    createdBy: owner._id,
    visibility: 'public',
  });
  const legacyA = await TaskGroup.create({
    name: 'Alpha Ltd', board: legacyBoard._id, order: 0,
  });
  const legacyB = await TaskGroup.create({
    name: 'Beta Ltd', board: legacyBoard._id, order: 1,
  });
  // Group-level portal fields no longer exist on the schema, so they go in
  // through the raw driver — which is exactly how they got there originally.
  const rawGroups = mongoose.connection.collection('taskgroups');
  await rawGroups.updateOne(
    { _id: legacyA._id },
    { $set: { portalToken: 'legacy-token-alpha', portalEnabled: true, portalClientName: 'Alpha Ltd' } }
  );
  await ClientContact.create({
    email: 'ops@alpha.test', name: 'Alpha Ops', board: legacyBoard._id,
    group: legacyA._id, organisation: org._id, verified: true,
  });

  const runPortal = (args) =>
    spawnSync(process.execPath, [S('src/scripts/migratePortalToBoard.js'), ...args], {
      env: { ...process.env, MONGODB_URI: uri },
      encoding: 'utf8',
      cwd: S('.'),
    });

  // --- the guard that matters most -----------------------------------------
  out = runPortal(['--drop-legacy']);
  check('--drop-legacy REFUSES before --promote',
    /REFUSED/.test(out.stdout || '') && out.status !== 0,
    `status=${out.status} ${(out.stdout || '').slice(-400)}`);
  const tokenSurvived = await rawGroups.findOne({ _id: legacyA._id });
  check('…and the group still holds the only copy of the token',
    tokenSurvived?.portalToken === 'legacy-token-alpha', String(tokenSurvived?.portalToken));

  // --- the happy path -------------------------------------------------------
  out = runPortal(['--promote']);
  check('--promote exits 0', out.status === 0, `${out.status} ${(out.stdout || '').slice(-300)}`);
  const promoted = await mongoose.connection
    .collection('boards')
    .findOne({ _id: legacyBoard._id });
  check('THE SAME TOKEN STRING moves up to the board — existing links keep working',
    promoted?.portalToken === 'legacy-token-alpha', String(promoted?.portalToken));
  check('…carrying its enabled state', promoted?.portalEnabled === true,
    String(promoted?.portalEnabled));
  check('…and the client name the team had typed',
    promoted?.portalClientName === 'Alpha Ltd', String(promoted?.portalClientName));

  // THE ROLLBACK PROPERTY: promote must not disturb the group, so the old code
  // keeps working against the same database until --drop-legacy runs.
  const afterPromote = await rawGroups.findOne({ _id: legacyA._id });
  check('--promote leaves the GROUP token intact, so a rollback still works',
    afterPromote?.portalToken === 'legacy-token-alpha', String(afterPromote?.portalToken));

  // --- the refusal ----------------------------------------------------------
  await rawGroups.updateOne(
    { _id: legacyB._id },
    { $set: { portalToken: 'legacy-token-beta', portalEnabled: true, portalClientName: 'Beta Ltd' } }
  );
  const twoTokenBoard = await Board.create({
    name: 'Two Companies', organisation: org._id, boardType: 'client',
    createdBy: owner._id, visibility: 'public',
  });
  const twoA = await TaskGroup.create({ name: 'One', board: twoTokenBoard._id, order: 0 });
  const twoB = await TaskGroup.create({ name: 'Two', board: twoTokenBoard._id, order: 1 });
  await rawGroups.updateOne({ _id: twoA._id },
    { $set: { portalToken: 'tok-one', portalEnabled: true, portalClientName: 'One' } });
  await rawGroups.updateOne({ _id: twoB._id },
    { $set: { portalToken: 'tok-two', portalEnabled: true, portalClientName: 'Two' } });
  await ClientContact.create({
    email: 'a@one.test', board: twoTokenBoard._id, group: twoA._id,
    organisation: org._id, verified: true,
  });

  out = runPortal(['--promote']);
  check('a board with TWO group tokens is REFUSED, not guessed at',
    /REFUSED/.test(out.stdout || ''), (out.stdout || '').slice(-400));
  const stillUnpromoted = await mongoose.connection
    .collection('boards')
    .findOne({ _id: twoTokenBoard._id });
  check('…and nothing was written to it',
    !stillUnpromoted?.portalToken, String(stillUnpromoted?.portalToken));

  // --- --release-token ------------------------------------------------------
  out = runPortal(['--release-token', String(twoB._id)]);
  check('--release-token REFUSES without --force',
    /REFUSED/.test(out.stdout || '') && out.status !== 0,
    `status=${out.status} ${(out.stdout || '').slice(-300)}`);
  check('…after naming who loses the link',
    /a@one\.test|0 contact/.test(out.stdout || '') || /contact\(s\) lose/.test(out.stdout || ''),
    (out.stdout || '').slice(-300));

  out = runPortal(['--release-token', String(twoB._id), '--force']);
  check('--release-token --force releases exactly that group',
    out.status === 0, `${out.status} ${(out.stdout || '').slice(-300)}`);
  const releasedB = await rawGroups.findOne({ _id: twoB._id });
  const keptA = await rawGroups.findOne({ _id: twoA._id });
  check('…leaving the OTHER group\'s token untouched',
    !releasedB?.portalToken && keptA?.portalToken === 'tok-one',
    JSON.stringify({ b: releasedB?.portalToken, a: keptA?.portalToken }));

  out = runPortal(['--promote']);
  const nowPromoted = await mongoose.connection
    .collection('boards')
    .findOne({ _id: twoTokenBoard._id });
  check('…so the board now promotes cleanly',
    nowPromoted?.portalToken === 'tok-one', String(nowPromoted?.portalToken));

  // --- drop-legacy, now that everything is promoted -------------------------
  out = runPortal(['--drop-legacy']);
  check('--drop-legacy runs once every board is promoted',
    out.status === 0, `${out.status} ${(out.stdout || '').slice(-400)}`);
  const finalGroup = await rawGroups.findOne({ _id: legacyA._id });
  check('…and the group-level fields are gone',
    !finalGroup?.portalToken && finalGroup?.portalEnabled === undefined,
    JSON.stringify({ t: finalGroup?.portalToken, e: finalGroup?.portalEnabled }));
  const contactAfter = await mongoose.connection
    .collection('clientcontacts')
    .findOne({ email: 'ops@alpha.test' });
  check('…and ClientContact.group is unset, leaving board as the only scope',
    contactAfter?.group === undefined && String(contactAfter?.board) === String(legacyBoard._id),
    JSON.stringify({ g: contactAfter?.group, b: String(contactAfter?.board) }));

  // Idempotence: the whole thing again is a no-op.
  out = runPortal(['--promote', '--drop-legacy']);
  check('re-running the migration is a no-op, not an error',
    out.status === 0, `${out.status} ${(out.stdout || '').slice(-300)}`);

  // ======================================================================
  console.log('\n=============================================================');
  console.log(`${results.length - failures}/${results.length} checks passed`);
  if (failures) {
    console.log(`\n${failures} FAILED:`);
    results.filter((x) => x.startsWith('FAIL')).forEach((x) => console.log(x));
  }
  console.log('=============================================================');

  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures ? 1 : 0);
};

main().catch(async (err) => {
  console.error('\ne2e failed:', err);
  process.exit(1);
});

/**
 * End-to-end check of the Ads Budget add-on against a THROWAWAY in-memory MongoDB.
 *
 * Boots the real Express app, seeds a tracker board, and drives the real HTTP
 * endpoints — same controllers, same Mongoose, same pacing path the app uses.
 * The user's Atlas cluster is never touched.
 *
 * Run: npm run e2e:ads-budget   (from server/)
 *
 * Requires mongodb-memory-server, which downloads a mongod binary on first run.
 * Nothing here reads server/.env, so it can never reach the real cluster.
 *
 * What it is actually for: the unit tests cover the pacing ladder and the
 * activity diff in isolation, but the three things most likely to be wrong live
 * between the layers and only show up over HTTP —
 *
 *   1. the add-on's switch really gating the endpoints,
 *   2. the track-versus-manage split being decided from the BODY, and
 *   3. the ledger reading back the rows the edits actually wrote.
 */
const path = require('path');
const http = require('http');

// Repo root, resolved from this file (server/src/e2e/adsBudget.e2e.js).
const ROOT = process.argv[2] || path.resolve(__dirname, '../../..');
const S = (p) => path.join(ROOT, 'server', p);

process.env.JWT_SECRET = 'e2e-secret';
process.env.NODE_ENV = 'test';
// The app builds its passport strategies at require time; these are never used
// because the harness mints its own JWTs, but the constructors demand them.
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
  console.log('connected:', uri);

  require(S('src/models'));
  const User = mongoose.model('User');
  const Organisation = mongoose.model('Organisation');
  const Board = mongoose.model('Board');
  const TaskGroup = mongoose.model('TaskGroup');
  const AdsBudget = mongoose.model('AdsBudget');

  const TZ = 'Asia/Kolkata';
  const MONTH = '2026-08';

  // --- seed ----------------------------------------------------------------
  const owner = await User.create({ name: 'Owner', email: 'owner@example.com', googleId: 'g-owner' });
  const reporter = await User.create({ name: 'Reporter', email: 'rep@example.com', googleId: 'g-rep' });
  const reader = await User.create({ name: 'Reader', email: 'read@example.com', googleId: 'g-read' });

  const org = await Organisation.create({
    name: 'Acme',
    admin: owner._id,
    members: [owner._id, reporter._id, reader._id],
    inviteCode: 'e2e-invite',
  });
  org.ensureSystemRoles();
  await org.save();

  await User.updateMany(
    { _id: { $in: [owner._id, reporter._id, reader._id] } },
    { $set: { organisations: [org._id] } }
  );

  const tracker = await Board.create({
    name: 'SEO Clients',
    organisation: org._id,
    boardType: 'tracker',
    monthTimezone: TZ,
    createdBy: owner._id,
    visibility: 'public',
  });
  const standard = await Board.create({
    name: 'Plain board',
    organisation: org._id,
    boardType: 'standard',
    createdBy: owner._id,
    visibility: 'public',
  });

  const groups = [];
  for (const name of ['Acme Retail', 'Northwind', 'Blue Harbour']) {
    groups.push(await TaskGroup.create({ name, board: tracker._id, order: groups.length }));
  }

  /**
   * The two non-owner accounts, pinned to a board LEVEL.
   *
   * `memberAccess` is what the two-layer AND reads for a board level; the org
   * role supplies the other half. `reporter` sits on `contribute` (may report
   * spend, may not re-budget) and `reader` on `view`.
   */
  tracker.memberAccess = [
    { user: reporter._id, level: 'contribute' },
    { user: reader._id, level: 'view' },
  ];
  await tracker.save();

  const tokenFor = (u) =>
    jwt.sign({ userId: u._id.toString(), email: u.email, name: u.name }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });
  const token = tokenFor(owner);
  const repToken = tokenFor(reporter);
  const readToken = tokenFor(reader);

  // --- boot the real app ---------------------------------------------------
  const app = require(S('src/app'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log('app listening on', base, '\n');

  const call = async (method, url, body, tok = token) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  };

  const B = tracker._id;
  const roster = () => call('GET', `/api/boards/${B}/ads-budget?month=${MONTH}`);
  const client = (g) => call('GET', `/api/boards/${B}/ads-budget/${g}?month=${MONTH}`);
  const ledger = (g) => call('GET', `/api/boards/${B}/ads-budget/${g}/activity?month=${MONTH}`);

  // =========================================================================
  console.log('--- 1. the switch actually gates the feature -----------------');

  const offRead = await roster();
  check('reads 404 while the add-on is off', offRead.status === 404, `${offRead.status}`);
  check(
    'and says so with a code the client can branch on',
    offRead.body?.code === 'ADS_BUDGET_OFF',
    JSON.stringify(offRead.body)
  );

  const onStd = await call('PUT', `/api/boards/${standard._id}/ads-budget-settings`, { enabled: true });
  check(
    'a STANDARD board refuses the switch as 404, not 403',
    onStd.status === 404 && onStd.body?.code === 'NOT_TRACKER_BOARD',
    `${onStd.status} ${JSON.stringify(onStd.body)}`
  );

  const readerOn = await call('PUT', `/api/boards/${B}/ads-budget-settings`, { enabled: true }, readToken);
  check('a viewer cannot switch it on', readerOn.status === 403, `${readerOn.status}`);

  const on = await call('PUT', `/api/boards/${B}/ads-budget-settings`, { enabled: true, currency: 'GBP' });
  check('the owner can, and the currency sticks',
    on.status === 200 && on.body?.adsBudget?.enabled === true && on.body?.adsBudget?.currency === 'GBP',
    JSON.stringify(on.body));

  const badCur = await call('PUT', `/api/boards/${B}/ads-budget-settings`, { currency: 'dollars' });
  check('a bogus currency is refused rather than stored', badCur.status === 400, `${badCur.status}`);

  // =========================================================================
  console.log('\n--- 2. the roster lists every client, set up or not ----------');

  const r1 = await roster();
  check('the roster reads 200 once switched on', r1.status === 200, `${r1.status}`);
  check('it lists all three groups, including the empty ones',
    r1.body?.clients?.length === 3, JSON.stringify(r1.body?.clients?.length));
  check('an untouched client reads "unset", not "on track"',
    r1.body.clients.every((c) => c.state === 'unset'),
    JSON.stringify(r1.body.clients.map((c) => c.state)));
  check('the board currency travels with the read', r1.body.currency === 'GBP', r1.body.currency);

  // =========================================================================
  console.log('\n--- 3. platforms, campaigns, and the rollup rule -------------');

  const G = groups[0]._id;
  const meta = await call('POST', `/api/boards/${B}/ads-budget`, {
    group: String(G), monthKey: MONTH, platform: 'Meta Ads', allocated: 8000, spent: 4850,
  });
  check('a platform row is created', meta.status === 201, JSON.stringify(meta.body));
  const metaId = meta.body?.row?._id;

  const google = await call('POST', `/api/boards/${B}/ads-budget`, {
    group: String(G), monthKey: MONTH, platform: 'Google Ads', allocated: 7500, spent: 5100,
  });
  const draft = await call('POST', `/api/boards/${B}/ads-budget`, {
    group: String(G), monthKey: MONTH, platform: 'Other Platforms', allocated: 2000, spent: 800,
    lifecycle: 'draft',
  });
  check('a draft platform is accepted', draft.status === 201, `${draft.status}`);

  const camp = await call('POST', `/api/boards/${B}/ads-budget`, {
    parent: metaId, name: 'Summer Launch', objective: 'Conversion', allocated: 2500, spent: 1680,
  });
  check('a campaign is created under its platform', camp.status === 201, JSON.stringify(camp.body));
  check('and inherits its platform’s channel without being told',
    camp.body?.row?.platform === 'Meta Ads', camp.body?.row?.platform);

  const nested = await call('POST', `/api/boards/${B}/ads-budget`, {
    parent: camp.body.row._id, name: 'Nested', allocated: 10,
  });
  check('a campaign inside a campaign is refused', nested.status === 422, `${nested.status}`);

  const c1 = await client(G);
  check('the client read returns 200', c1.status === 200, `${c1.status}`);
  check('two active platforms plus one draft', c1.body?.platforms?.length === 3, `${c1.body?.platforms?.length}`);
  check('the campaign is nested under Meta Ads',
    c1.body.platforms.find((p) => p.platform === 'Meta Ads')?.campaigns?.length === 1,
    JSON.stringify(c1.body.platforms.map((p) => [p.platform, p.campaigns.length])));

  /**
   * THE RULE THIS WHOLE FEATURE LEANS ON. Meta 8000 + Google 7500 = 15500. The
   * campaign's 2500 is a breakdown WITHIN Meta's 8000 and must not be added,
   * and the draft's 2000 is money nobody has committed.
   */
  check('totals sum PLATFORMS only — campaigns are not double-counted',
    c1.body.totals.allocated === 15500,
    `expected 15500, got ${c1.body.totals.allocated}`);
  check('and drafts stay out of the total',
    c1.body.totals.spent === 9950,
    `expected 9950, got ${c1.body.totals.spent}`);

  const r2 = await roster();
  const acme = r2.body.clients.find((c) => String(c._id) === String(G));
  check('the roster agrees with the client screen',
    acme.allocated === 15500 && acme.spent === 9950,
    JSON.stringify({ allocated: acme.allocated, spent: acme.spent }));
  check('other clients are still "unset"',
    r2.body.clients.filter((c) => c.state === 'unset').length === 2,
    JSON.stringify(r2.body.clients.map((c) => c.state)));

  // =========================================================================
  console.log('\n--- 4. track vs manage is decided from the BODY --------------');

  const repSpend = await call('PATCH', `/api/ads-budget/${metaId}`, { spent: 5200 }, repToken);
  check('a contributor may report spend', repSpend.status === 200, JSON.stringify(repSpend.body));

  const repBudget = await call('PATCH', `/api/ads-budget/${metaId}`, { allocated: 99999 }, repToken);
  check('a contributor may NOT re-budget', repBudget.status === 403, `${repBudget.status}`);

  // The case a naive key-list check gets wrong: the edit form re-sends every
  // field, so an unchanged `allocated` must not escalate a spend report.
  const repBoth = await call(
    'PATCH', `/api/ads-budget/${metaId}`, { allocated: 8000, spent: 5300 }, repToken
  );
  check('re-sending an UNCHANGED budget alongside spend is still a spend report',
    repBoth.status === 200, `${repBoth.status} ${JSON.stringify(repBoth.body)}`);

  const readSpend = await call('PATCH', `/api/ads-budget/${metaId}`, { spent: 1 }, readToken);
  check('a viewer may not write at all', readSpend.status === 403, `${readSpend.status}`);

  const readerRoster = await call(
    'GET', `/api/boards/${B}/ads-budget?month=${MONTH}`, undefined, readToken
  );
  check('but a viewer CAN read', readerRoster.status === 200, `${readerRoster.status}`);

  const negative = await call('PATCH', `/api/ads-budget/${metaId}`, { spent: -5 });
  check('negative money is refused', negative.status === 422, `${negative.status}`);

  // =========================================================================
  console.log('\n--- 5. the ledger is the edit history, read back -------------');

  const log = await ledger(G);
  check('the ledger reads 200', log.status === 200, `${log.status}`);

  const money = log.body.items.filter(
    (i) => i.type === 'ads_budget.created' || ['allocated', 'spent'].includes(i.field)
  );
  check('every budget movement was recorded', money.length >= 5,
    `${money.length} money rows: ${JSON.stringify(log.body.items.map((i) => i.type + ':' + (i.field || '')))}`);

  const spendRow = log.body.items.find((i) => i.field === 'spent' && i.newValue === 5200);
  check('a spend change carries its delta for the ledger',
    spendRow && spendRow.metadata?.delta === 350,
    JSON.stringify(spendRow?.metadata));
  check('and names who did it',
    spendRow?.actor?.name === 'Reporter', JSON.stringify(spendRow?.actor));

  const noop = await call('PATCH', `/api/ads-budget/${metaId}`, { spent: 5300 });
  const afterNoop = await ledger(G);
  check('a save that changed nothing writes no ledger line',
    afterNoop.body.items.length === log.body.items.length,
    `${log.body.items.length} -> ${afterNoop.body.items.length} (patch ${noop.status})`);

  const otherLedger = await ledger(groups[1]._id);
  check('one client’s ledger does not leak another’s',
    otherLedger.body.items.length === 0, `${otherLedger.body.items.length}`);

  // =========================================================================
  console.log('\n--- 6. deleting a platform takes its campaigns ---------------');

  const del = await call('DELETE', `/api/ads-budget/${metaId}`);
  check('the platform deletes', del.status === 200, `${del.status}`);
  check('and reports the campaigns that went with it',
    del.body?.removedCampaigns === 1, JSON.stringify(del.body));
  check('no orphaned campaign is left in the collection',
    (await AdsBudget.countDocuments({ parent: metaId })) === 0);

  const afterDelete = await ledger(G);
  check('a deleted row’s history survives in the ledger',
    afterDelete.body.items.some((i) => i.type === 'ads_budget.deleted'),
    JSON.stringify(afterDelete.body.items.map((i) => i.type)));

  // =========================================================================
  console.log('\n--- 7. months are separate, and off means off ----------------');

  const sept = await call('GET', `/api/boards/${B}/ads-budget/${G}?month=2026-09`);
  check('another month is empty', sept.body?.platforms?.length === 0, `${sept.body?.platforms?.length}`);
  check('and its window has not started',
    sept.body?.window?.elapsedDays === 0 || sept.body?.window?.totalDays === 30,
    JSON.stringify(sept.body?.window));

  await call('PUT', `/api/boards/${B}/ads-budget-settings`, { enabled: false });
  const offAgain = await roster();
  check('switching the add-on off closes the endpoints again',
    offAgain.status === 404 && offAgain.body?.code === 'ADS_BUDGET_OFF',
    `${offAgain.status}`);
  check('but the rows are NOT destroyed by switching off',
    (await AdsBudget.countDocuments({ board: B })) > 0);

  // =========================================================================
  console.log('\n--- 8. deleting a group takes its budgets --------------------');

  await call('PUT', `/api/boards/${B}/ads-budget-settings`, { enabled: true });
  const before = await AdsBudget.countDocuments({ group: G });
  await call('DELETE', `/api/groups/${G}`);
  const after = await AdsBudget.countDocuments({ group: G });
  check('a deleted client leaves no budgets behind',
    before > 0 && after === 0, `${before} -> ${after}`);

  // =========================================================================
  console.log('\n' + '='.repeat(62));
  console.log(failures === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failures} of ${results.length} FAILED`);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures === 0 ? 0 : 1);
};

/**
 * Only when RUN, never when required.
 *
 * `capabilityUsage.test.js` loads every .js file under src/ to catch dangling
 * imports, and without this guard that scan boots an in-memory mongod and
 * connects mongoose as a side effect of importing this file. With two e2e
 * harnesses present the second connect throws outright; with one it merely
 * started a database nobody asked for on every `npm test`.
 */
if (require.main === module) {
  main().catch((err) => {
    console.error('\nHARNESS ERROR:', err);
    process.exit(2);
  });
}

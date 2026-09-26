const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'currency-settings-test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const jwt = require('jsonwebtoken');

const Organisation = require('../models/Organisation');
const Board = require('../models/Board');
const connectorCrypto = require('../utils/connectorCrypto');
const { sanitizeFxSettings, keyPreviewOf, providerNeedsKey } = require('../utils/money');
const eventBus = require('../services/eventBus');

/**
 * The workspace's FX credential must never reach a browser.
 *
 * A direct sibling of `connectorLeak.test.js`, for the same reason and against
 * the same two ways it erodes: somebody adds `.select('+fx.sealedApiKey')` while
 * debugging, or replaces the hand-built settings payload with a spread of
 * `org.fx` because it is shorter.
 *
 * The exposure here is slightly worse than the connector's, which is why it
 * gets its own file. A `ConnectorAccount` is only ever read by code that went
 * looking for it; `Organisation` is returned WHOLE by `getOrg` on every page
 * load, so a field without `select: false` would be on the wire immediately.
 */

const ORG = '69d4cd1aac4378a532868559';
const SECRET = 'fxk_this_must_never_reach_a_browser';

test('fx.sealedApiKey is select:false on the schema', () => {
  // The first line of defence, and the one that matters most here: `getOrg`
  // does not name its fields, so anything without this rides along.
  assert.strictEqual(Organisation.schema.path('fx.sealedApiKey').options.select, false);
});

test('a default org has no key and a keyless provider', () => {
  // An org that never opens the Currency screen must still get live rates.
  const org = new Organisation({ name: 'Davnoot', admin: ORG });
  assert.strictEqual(org.fx.provider, 'frankfurter');
  assert.strictEqual(providerNeedsKey(org.fx.provider), false);
  assert.strictEqual(org.fx.sealedApiKey, null);
  assert.strictEqual(org.fx.keyPreview, '');
});

test('the default base currency is rupees, and it is now a setting', () => {
  // Same default the templates hardcoded — the difference is that it moved.
  const org = new Organisation({ name: 'Davnoot', admin: ORG });
  assert.strictEqual(org.baseCurrency, 'INR');
});

test('a serialised org never carries the sealed key', () => {
  /**
   * The end-to-end version of the `select: false` assertion. A document that
   * HAS the field — because the controller just sealed one — must still not
   * expose it when the org goes over the wire.
   */
  const org = new Organisation({ name: 'Davnoot', admin: ORG });
  org.fx.sealedApiKey = connectorCrypto.seal(SECRET, { orgId: ORG, provider: 'fx' });
  org.fx.keyPreview = keyPreviewOf(SECRET);

  const wire = JSON.stringify(org.toJSON());
  assert.ok(!wire.includes(SECRET), 'the plaintext key leaked');
  assert.ok(!wire.includes(org.fx.sealedApiKey), 'the sealed key leaked');
  // The preview is fine, and is the whole point of having one.
  assert.ok(wire.includes(org.fx.keyPreview));
});

test('the preview identifies a key without revealing it', () => {
  const preview = keyPreviewOf(SECRET);
  assert.ok(preview.endsWith('wser'));
  assert.ok(preview.length < 8, `a preview should be short, got ${preview}`);
  assert.ok(!SECRET.startsWith(preview), 'a preview must not be a usable prefix');
  // Too short to have a meaningful tail — say nothing rather than most of it.
  assert.strictEqual(keyPreviewOf('abc'), '');
  assert.strictEqual(keyPreviewOf(null), '');
});

test('a sealed key round-trips only with the right workspace bound in', () => {
  // The AAD is what stops a row moving between workspaces.
  const sealed = connectorCrypto.seal(SECRET, { orgId: ORG, provider: 'fx' });
  assert.strictEqual(connectorCrypto.open(sealed, { orgId: ORG, provider: 'fx' }), SECRET);
  assert.throws(() =>
    connectorCrypto.open(sealed, { orgId: '69d4cd1aac4378a532868558', provider: 'fx' })
  );
});

// --- the partial-patch contract -------------------------------------------

test('an absent field is left alone, not cleared', () => {
  /**
   * The settings screen saves one control at a time. If this built a whole
   * object, changing the cadence would silently clear the base currency.
   */
  const r = sanitizeFxSettings({ cadence: 'daily' });
  assert.strictEqual(r.ok, true);
  assert.deepEqual(Object.keys(r.patch), ['fx.cadence']);
});

test('an empty body is a no-op rather than an error', () => {
  for (const body of [{}, null, undefined]) {
    const r = sanitizeFxSettings(body);
    assert.strictEqual(r.ok, true);
    assert.deepEqual(r.patch, {});
  }
});

test('a bad value is refused rather than coerced', () => {
  assert.strictEqual(sanitizeFxSettings({ baseCurrency: 'DOLLARS' }).ok, false);
  assert.strictEqual(sanitizeFxSettings({ provider: 'yahoo-finance' }).ok, false);
  assert.strictEqual(sanitizeFxSettings({ cadence: 'hourly' }).ok, false);
});

test('patch keys are dotted so they touch only their own field', () => {
  // `$set: { fx: {...} }` would replace the whole sub-document and drop the
  // sealed key along with it.
  const r = sanitizeFxSettings({ baseCurrency: 'cad', provider: 'exchangerate-api', cadence: 'daily' });
  assert.deepEqual(r.patch, {
    baseCurrency: 'CAD',
    'fx.provider': 'exchangerate-api',
    'fx.cadence': 'daily',
  });
});

// --- the board's own unit ---------------------------------------------------

test('a new board has no currency of its own until one is chosen', () => {
  /**
   * Null, not the workspace's code copied in by a default: a board created
   * before the field existed must resolve through its money columns
   * (boardCurrencyOf), and a schema default would have claimed a unit for it.
   */
  const board = new Board({ name: 'Invoices' });
  assert.strictEqual(board.currency, null);
});

test('the Ads Budget add-on no longer defaults to dollars', () => {
  // The old 'USD' default was written onto every board at creation, so the
  // card's fall-back-to-the-workspace branch could never run.
  const board = new Board({ name: 'Ads' });
  assert.strictEqual(board.adsBudget.currency, null);
});

test('a board currency is stored normalised and must be one we carry', () => {
  const ok = new Board({ name: 'B', currency: ' cad ' });
  assert.strictEqual(ok.currency, 'CAD');
  assert.strictEqual(ok.validateSync(), undefined);
  const bad = new Board({ name: 'B', currency: 'XYZ' });
  assert.ok(bad.validateSync().errors.currency, 'an unknown code must not validate');
});

// ===========================================================================
// Boards that FOLLOW the workspace currency move with it — over HTTP
//
// The real boards and orgs routers against a THROWAWAY in-memory MongoDB
// (mongodb-memory-server) with real JWTs; nothing here reads server/.env. Each
// test builds its own workspace, so the relabelled counts are exactly its own.
// ===========================================================================

let mem;
let server;
let base;
let owner;
let member;
let ownerToken;
let memberToken;
let Task;
let TaskGroup;

const boardPings = [];
eventBus.on('board.changed', (e) => boardPings.push(e));

const tokenFor = (u) =>
  jwt.sign({ userId: u._id.toString(), email: u.email, name: u.name }, process.env.JWT_SECRET);

const call = async (method, url, body, token = ownerToken) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
};

before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  require('../models');
  Task = mongoose.model('Task');
  TaskGroup = mongoose.model('TaskGroup');
  const User = mongoose.model('User');
  owner = await User.create({ name: 'Owner', email: 'fx-owner@example.com', googleId: 'g-fx-owner' });
  member = await User.create({ name: 'Member', email: 'fx-member@example.com', googleId: 'g-fx-member' });
  ownerToken = tokenFor(owner);
  memberToken = tokenFor(member);

  const app = express();
  app.use(express.json());
  app.use('/api/boards', require('../routes/boards'));
  app.use('/api/orgs', require('../routes/orgs'));
  // Mounted bare, as app.js does — its paths straddle two shapes.
  app.use('/api', require('../routes/adsBudget'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

let wsSeq = 0;
/** A fresh workspace in `baseCurrency`, owned by `owner`, `member` a plain member. */
const makeWorkspace = async (baseCurrency = 'INR') => {
  wsSeq += 1;
  const org = await Organisation.create({
    name: `Workspace ${wsSeq}`,
    admin: owner._id,
    members: [owner._id, member._id],
    inviteCode: `fx-ws-${wsSeq}`,
    baseCurrency,
  });
  org.ensureSystemRoles();
  await org.save();
  await mongoose.model('User').updateMany(
    { _id: { $in: [owner._id, member._id] } },
    { $addToSet: { organisations: org._id } }
  );
  return org;
};

let boardSeq = 0;
const makeBoard = async (org, extra = {}) => {
  boardSeq += 1;
  const r = await call('POST', '/api/boards', {
    name: `Board ${boardSeq}`,
    organisation: String(org._id),
    visibility: 'public',
    ...extra,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.board;
};

const colOf = (board, key) => (board.columns || []).find((c) => c.key === key);
const stored = (id) => Board.findById(id).lean();
const codesOf = (board) =>
  Object.fromEntries(
    (board.columns || [])
      .filter((c) => c.settings && c.settings.format === 'currency')
      .map((c) => [c.key, c.settings.currency])
  );
const saveBase = (org, baseCurrency, token) =>
  call('PUT', `/api/orgs/${org._id}/currency`, { baseCurrency }, token);

test('a new workspace currency relabels every FOLLOWING board — and only those', async () => {
  const org = await makeWorkspace('INR');
  const follows = await makeBoard(org, { template: 'billing' });
  const followsToo = await makeBoard(org, { template: 'budget' });
  const ownUsd = await makeBoard(org, { template: 'billing', currency: 'USD' });
  const ownInr = await makeBoard(org, { template: 'billing' });
  assert.strictEqual((await call('PATCH', `/api/boards/${ownInr._id}/currency`, { currency: 'INR' })).status, 200);
  const noMoney = await makeBoard(org, { template: 'blank' });
  // Following, but already in the NEW unit — nothing to do for it.
  const inStep = await makeBoard(org, { template: 'billing' });
  await Board.updateOne(
    { _id: inStep._id },
    { $set: { 'columns.$[m].settings.currency': 'CAD' } },
    { arrayFilters: [{ 'm.settings.format': 'currency' }] }
  );
  const inStepBefore = await stored(inStep._id);

  const group = await TaskGroup.findOne({ board: follows._id }).lean();
  const amount = colOf(follows, 'amount');
  const task = await Task.create({
    name: 'INV-1', board: follows._id, group: group._id,
    columnValues: { [String(amount._id)]: 1234.5 },
  });

  boardPings.length = 0;
  const r = await saveBase(org, 'cad');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.currency.baseCurrency, 'CAD');
  assert.strictEqual(r.body.relabelled.count, 2);
  assert.deepStrictEqual(
    [...r.body.relabelled.boardIds].sort(),
    [String(follows._id), String(followsToo._id)].sort()
  );
  assert.deepStrictEqual(r.body.relabelled.failed, []);

  // The following boards read CAD, and still follow.
  const f = await stored(follows._id);
  assert.strictEqual(f.currency, null);
  assert.deepStrictEqual(codesOf(f), { amount: 'CAD', payments: 'CAD' });
  const f2 = await stored(followsToo._id);
  assert.strictEqual(f2.currency, null);
  assert.deepStrictEqual(codesOf(f2), { allocated: 'CAD', spent: 'CAD', remaining: 'CAD' });
  // RELABELLED — the figure is exactly what was typed, not converted.
  assert.strictEqual((await Task.findById(task._id).lean()).columnValues[String(amount._id)], 1234.5);

  // A currency of its own is never touched — not even one equal to the old base.
  const u = await stored(ownUsd._id);
  assert.strictEqual(u.currency, 'USD');
  assert.deepStrictEqual(codesOf(u), { amount: 'USD', payments: 'USD' });
  const i = await stored(ownInr._id);
  assert.strictEqual(i.currency, 'INR');
  assert.deepStrictEqual(codesOf(i), { amount: 'INR', payments: 'INR' });
  // Already in step: skipped, and left exactly as it was.
  assert.deepStrictEqual(await stored(inStep._id), inStepBefore);
  assert.strictEqual((await stored(noMoney._id)).currency, null);

  // Every open tab on a relabelled board is told to refetch it.
  const pinged = new Set(boardPings.map((p) => p.boardId));
  assert.ok(pinged.has(String(follows._id)), 'a relabelled board was not announced');
  assert.ok(pinged.has(String(followsToo._id)));
  assert.ok(!pinged.has(String(ownUsd._id)), 'an untouched override was announced');

  // The Currency tab now says who follows and what each is in.
  const list = await call('GET', `/api/orgs/${org._id}/currency/boards`);
  assert.strictEqual(list.status, 200, JSON.stringify(list.body));
  const row = (id) => list.body.boards.find((x) => String(x._id) === String(id));
  assert.deepStrictEqual(
    { following: row(follows._id).following, effective: row(follows._id).effective },
    { following: true, effective: 'CAD' }
  );
  assert.deepStrictEqual(
    { following: row(ownUsd._id).following, effective: row(ownUsd._id).effective },
    { following: false, effective: 'USD' }
  );
  assert.strictEqual(row(ownInr._id).following, false);
});

test('running it again finds nothing, and a save that leaves the currency alone relabels nothing', async () => {
  const org = await makeWorkspace('INR');
  const b = await makeBoard(org, { template: 'billing' });
  const first = await saveBase(org, 'CAD');
  assert.strictEqual(first.body.relabelled.count, 1);

  // Same code again: every following board is already in step.
  const again = await saveBase(org, 'CAD');
  assert.strictEqual(again.status, 200);
  assert.deepStrictEqual(again.body.relabelled, { count: 0, boardIds: [], failed: [] });

  // A save of another setting never runs the relabel, even over a following
  // board that has since been knocked out of step by hand.
  await Board.updateOne(
    { _id: b._id },
    { $set: { 'columns.$[a].settings.currency': 'AUD' } },
    { arrayFilters: [{ 'a.key': 'amount' }] }
  );
  const cadence = await call('PUT', `/api/orgs/${org._id}/currency`, { cadence: 'daily' });
  assert.strictEqual(cadence.status, 200, JSON.stringify(cadence.body));
  assert.deepStrictEqual(cadence.body.relabelled, { count: 0, boardIds: [], failed: [] });
  assert.strictEqual(colOf(await stored(b._id), 'amount').settings.currency, 'AUD');

  // …while re-saving the base is how it is brought back into step.
  const heal = await saveBase(org, 'CAD');
  assert.deepStrictEqual(heal.body.relabelled.boardIds, [String(b._id)]);
  assert.deepStrictEqual(codesOf(await stored(b._id)), { amount: 'CAD', payments: 'CAD' });
});

test('a board that cannot be relabelled is reported, and the rest still move', async () => {
  const org = await makeWorkspace('INR');
  const broken = await makeBoard(org, { template: 'billing' });
  const fine = await makeBoard(org, { template: 'budget' });
  // A stored value today's schema refuses, so saving this board fails.
  // (The raw driver, so no schema check stops it — and so a real ObjectId.)
  const raw = await Board.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(broken._id)) },
    { $set: { defaultView: 'nonsense' } }
  );
  assert.strictEqual(raw.modifiedCount, 1);

  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let r;
  try {
    r = await saveBase(org, 'GBP');
  } finally {
    console.error = realError;
  }
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.relabelled.failed, [String(broken._id)]);
  assert.deepStrictEqual(r.body.relabelled.boardIds, [String(fine._id)]);
  assert.strictEqual(r.body.relabelled.count, 1);
  assert.ok(errors.some((e) => e.includes(String(broken._id))), 'the failure was not logged');
  // The setting itself is saved either way.
  assert.strictEqual((await Organisation.findById(org._id).lean()).baseCurrency, 'GBP');
  assert.deepStrictEqual(codesOf(await stored(broken._id)), { amount: 'INR', payments: 'INR' });
  assert.strictEqual(codesOf(await stored(fine._id)).allocated, 'GBP');
});

test("mirrors follow the boards they read, and a following board's mirror moving never pins it", async () => {
  /**
   * `R` follows the workspace and mirrors `A`'s Amount. `A` is relabelled
   * first; its mirror on `R` follows to CAD, and `R`'s own columns are still
   * INR at that moment. Letting that reconcile pin `R` to INR would have made
   * it an override a moment before its own turn — and so skipped it forever.
   */
  const org = await makeWorkspace('INR');
  const A = await makeBoard(org, { template: 'billing' });
  const R = await makeBoard(org, { template: 'budget' });
  const O = await makeBoard(org, { template: 'blank', currency: 'SGD' });
  const mirrorOf = async (board) => {
    const link = await call('POST', `/api/boards/${board._id}/columns`, {
      name: 'Invoice', type: 'connect_boards', settings: { targetBoardIds: [A._id] },
    });
    assert.strictEqual(link.status, 201, JSON.stringify(link.body));
    const m = await call('POST', `/api/boards/${board._id}/columns`, {
      name: 'Billed',
      type: 'mirror',
      settings: {
        sourceConnectColumnId: link.body.column._id,
        sourceColumnId: colOf(A, 'amount')._id,
        aggregation: 'sum',
      },
    });
    assert.strictEqual(m.status, 201, JSON.stringify(m.body));
    assert.strictEqual(m.body.column.settings.currency, 'INR');
    return m.body.column;
  };
  const onR = await mirrorOf(R);
  const onO = await mirrorOf(O);

  const r = await saveBase(org, 'CAD');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(
    [...r.body.relabelled.boardIds].sort(),
    [String(A._id), String(R._id)].sort(),
    'the following board with a mirror was skipped'
  );

  const rNow = await stored(R._id);
  assert.strictEqual(rNow.currency, null, 'R was pinned by its mirror moving');
  assert.strictEqual(colOf(rNow, 'allocated').settings.currency, 'CAD');
  assert.strictEqual(rNow.columns.find((c) => String(c._id) === String(onR._id)).settings.currency, 'CAD');

  // An override board's mirror of A follows A — and the board keeps its own unit.
  const oNow = await stored(O._id);
  assert.strictEqual(oNow.currency, 'SGD');
  assert.strictEqual(oNow.columns.find((c) => String(c._id) === String(onO._id)).settings.currency, 'CAD');
});

test('an override board is never moved by a workspace change, even through a formula over a mirror', async () => {
  /**
   * `O` has its own currency (SGD), and its only own money column is a
   * formula over a mirror of a following board's Amount. The workspace moving
   * relabels that board, its mirror on `O` follows to the new unit, and the
   * formula re-derives from it — all true. What must NOT happen is the mirror
   * move re-voting `O.currency` to the new workspace unit: an override is the
   * one kind of board a workspace change leaves alone.
   */
  const org = await makeWorkspace('INR');
  const A = await makeBoard(org, { template: 'billing' });
  const O = await makeBoard(org, { template: 'blank', currency: 'SGD' });
  const link = await call('POST', `/api/boards/${O._id}/columns`, {
    name: 'Invoice', type: 'connect_boards', settings: { targetBoardIds: [A._id] },
  });
  assert.strictEqual(link.status, 201, JSON.stringify(link.body));
  const mirror = await call('POST', `/api/boards/${O._id}/columns`, {
    name: 'Billed',
    type: 'mirror',
    settings: {
      sourceConnectColumnId: link.body.column._id,
      sourceColumnId: colOf(A, 'amount')._id,
      aggregation: 'sum',
    },
  });
  assert.strictEqual(mirror.status, 201, JSON.stringify(mirror.body));
  const formula = await call('POST', `/api/boards/${O._id}/columns`, {
    name: 'Billed again',
    type: 'formula',
    settings: { expression: `column.${mirror.body.column.key}`, format: 'currency' },
  });
  assert.strictEqual(formula.status, 201, JSON.stringify(formula.body));
  assert.strictEqual((await stored(O._id)).currency, 'SGD');

  const r = await saveBase(org, 'CAD');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.relabelled.boardIds, [String(A._id)]);

  const oNow = await stored(O._id);
  assert.strictEqual(oNow.currency, 'SGD', 'a workspace change moved an override board');
  const codeOf = (id) => oNow.columns.find((c) => String(c._id) === String(id)).settings.currency;
  // The mirror follows its source, and the formula follows what it computes from.
  assert.strictEqual(codeOf(mirror.body.column._id), 'CAD');
  assert.strictEqual(codeOf(formula.body.column._id), 'CAD');
});

test("a following board's Ads Budget follows the workspace; one on a board with its own currency keeps it", async () => {
  /**
   * Switching the add-on on used to PIN the workspace's unit of the day onto
   * every board — so the next workspace change relabelled a following board's
   * columns and left its budgets behind, under a mismatch warning. Unset, it
   * reads the board's unit (`adsBudgetCurrencyOf`), which on a following board
   * is the workspace's.
   */
  const org = await makeWorkspace('INR');
  const tracker = (extra = {}) =>
    makeBoard(org, { template: 'blank', boardType: 'tracker', monthTimezone: 'Asia/Kolkata', ...extra });
  const switchOn = (id) => call('PUT', `/api/boards/${id}/ads-budget-settings`, { enabled: true });
  const unitOf = async (id) => {
    const r = await call('GET', `/api/boards/${id}/ads-budget`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.currency;
  };

  const follows = await tracker();
  const on = await switchOn(follows._id);
  assert.strictEqual(on.status, 200, JSON.stringify(on.body));
  assert.deepStrictEqual(on.body.adsBudget, { enabled: true, currency: null });
  assert.strictEqual(await unitOf(follows._id), 'INR');

  const own = await tracker({ currency: 'USD' });
  assert.strictEqual((await switchOn(own._id)).body.adsBudget.currency, 'USD');

  assert.strictEqual((await saveBase(org, 'CAD')).status, 200);
  assert.strictEqual(await unitOf(follows._id), 'CAD', "the following board's budgets were left behind");
  assert.strictEqual((await stored(follows._id)).adsBudget.currency, null);
  assert.strictEqual(await unitOf(own._id), 'USD', 'a board with its own currency moved');

  // Given a currency of its own later, an unset Ads Budget reads the board's.
  const pin = await call('PATCH', `/api/boards/${follows._id}/currency`, { currency: 'GBP' });
  assert.strictEqual(pin.status, 200, JSON.stringify(pin.body));
  assert.strictEqual(await unitOf(follows._id), 'GBP');
});

test("the answer names only boards the caller can read — the relabel still reaches them all", async () => {
  /**
   * `org.manage_settings` is a workspace power, not a key to every private
   * board (listMoneyBoards draws the same line). A workspace admin who cannot
   * open the owner's private board still moves it — it follows the workspace —
   * but is not told its id, and it is not in the count the Currency tab reads.
   */
  const org = await makeWorkspace('INR');
  const adminRole = org.roles.find((r) => r.key === 'admin');
  assert.ok(adminRole, 'no admin preset to hand the member');
  org.memberRoles = [
    ...org.memberRoles.filter((mr) => String(mr.user) !== String(member._id)),
    { user: member._id, role: adminRole._id },
  ];
  await org.save();

  const open = await makeBoard(org, { template: 'billing' });
  const hidden = await makeBoard(org, { template: 'billing', visibility: 'private' });
  assert.strictEqual((await stored(hidden._id)).visibility, 'private');

  const r = await saveBase(org, 'CAD', memberToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.relabelled, { count: 1, boardIds: [String(open._id)], failed: [] });
  // Moved all the same: it follows the workspace.
  assert.deepStrictEqual(codesOf(await stored(hidden._id)), { amount: 'CAD', payments: 'CAD' });
});

test('a code-less money column on a following board is stamped with the new unit', async () => {
  const org = await makeWorkspace('INR');
  const b = await makeBoard(org, { template: 'billing' });
  await Board.updateOne(
    { _id: b._id },
    { $unset: { 'columns.$[p].settings.currency': '' } },
    { arrayFilters: [{ 'p.key': 'payments' }] }
  );
  const r = await saveBase(org, 'EUR');
  assert.deepStrictEqual(r.body.relabelled.boardIds, [String(b._id)]);
  assert.deepStrictEqual(codesOf(await stored(b._id)), { amount: 'EUR', payments: 'EUR' });
});

test('only somebody who may change the workspace settings can move it', async () => {
  const org = await makeWorkspace('INR');
  const b = await makeBoard(org, { template: 'billing' });
  const r = await saveBase(org, 'CAD', memberToken);
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await Organisation.findById(org._id).lean()).baseCurrency, 'INR');
  assert.deepStrictEqual(codesOf(await stored(b._id)), { amount: 'INR', payments: 'INR' });
});

test('relabelBoardMoney finds the workspace itself when it is not handed one', async () => {
  const { relabelBoardMoney } = require('../services/boardCurrency');
  const org = await makeWorkspace('INR');
  const created = await makeBoard(org, { template: 'billing' });
  const doc = await Board.findById(created._id);
  const out = await relabelBoardMoney(doc, 'gbp', { actorId: String(owner._id) });
  assert.strictEqual(out.following, false);
  assert.strictEqual(out.effective, 'GBP');
  const b = await stored(created._id);
  assert.strictEqual(b.currency, 'GBP');
  assert.deepStrictEqual(codesOf(b), { amount: 'GBP', payments: 'GBP' });

  // `follow` stores null, in whatever unit it is handed (the workspace's).
  const back = await relabelBoardMoney(await Board.findById(created._id), 'INR', { follow: true });
  assert.strictEqual(back.following, true);
  assert.strictEqual((await stored(created._id)).currency, null);

  await assert.rejects(() => relabelBoardMoney(doc, 'DOLLARS'), /not a currency we carry/);
});

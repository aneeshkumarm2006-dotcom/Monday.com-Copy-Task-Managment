const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

/**
 * THE BOARD'S MONEY UNIT, end to end over HTTP.
 *
 * Runs the real boards and orgs routers against a THROWAWAY in-memory MongoDB
 * (mongodb-memory-server) with real JWTs — nothing here reads server/.env, so it
 * can never reach the real cluster.
 *
 * Why over HTTP rather than calling the helpers: every defect this covers lived
 * BETWEEN the layers. The seeding helper was right and the controller's copy
 * branch still re-stamped CAD into rupees; the connect validator was right and
 * a footer change still 400'd because it ran on every write; the currency
 * validator was right and still stored 'cad' verbatim. Each is asserted here
 * where the person would have met it.
 *
 * Cloudinary is never called: the file-column cleanup is stubbed BEFORE the
 * controllers are required (they destructure their helpers at require time),
 * so the delete test can see exactly what it was handed.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'board-currency-test';

const cloudinaryConfig = require('../config/cloudinary');
cloudinaryConfig.destroyCloudinaryAssets = async () => {};
cloudinaryConfig.destroyLogos = async () => {};
const fileColumnAssets = require('../utils/fileColumnAssets');
const destroyedWith = [];
fileColumnAssets.destroyFileColumnAssets = async (columns, tasks, opts) => {
  destroyedWith.push({ columns, tasks, opts });
};
// Every `board.changed` ping, so the relabel's live refresh can be asserted.
const eventBus = require('../services/eventBus');
const boardPings = [];
eventBus.on('board.changed', (e) => boardPings.push(e));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const jwt = require('jsonwebtoken');

let mem;
let server;
let base;
let owner;
let member;
let org;
let ownerToken;
let memberToken;

let Board;
let Task;
let TaskGroup;
let BoardConnection;
let Organisation;
let AdsBudget;

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

let seq = 0;
/** Create a board through the real endpoint. */
const createBoard = async (extra = {}) => {
  seq += 1;
  const r = await call('POST', '/api/boards', {
    name: `Board ${seq}`,
    organisation: String(org._id),
    visibility: 'public',
    ...extra,
  });
  return r;
};

const colOf = (board, key) => (board.columns || []).find((c) => c.key === key);

before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  require('../models');
  Board = mongoose.model('Board');
  Task = mongoose.model('Task');
  TaskGroup = mongoose.model('TaskGroup');
  BoardConnection = mongoose.model('BoardConnection');
  Organisation = mongoose.model('Organisation');
  AdsBudget = mongoose.model('AdsBudget');
  const User = mongoose.model('User');

  owner = await User.create({ name: 'Owner', email: 'owner@example.com', googleId: 'g-owner' });
  member = await User.create({ name: 'Member', email: 'member@example.com', googleId: 'g-member' });
  // An INR workspace — the default, and the one every copy bug was seen in.
  org = await Organisation.create({
    name: 'Acme',
    admin: owner._id,
    members: [owner._id, member._id],
    inviteCode: 'currency-test',
  });
  org.ensureSystemRoles();
  await org.save();
  await User.updateMany({}, { $set: { organisations: [org._id] } });
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

// ---------------------------------------------------------------------------
// Creating a board
// ---------------------------------------------------------------------------

test('a board created with a currency is born in it, columns and all', async () => {
  // CAD in an INR workspace: a currency of its own — pinned as the override.
  const r = await createBoard({ template: 'billing', currency: 'cad' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body.board;
  assert.equal(b.currency, 'CAD');
  assert.equal(colOf(b, 'amount').settings.currency, 'CAD');
  assert.equal(colOf(b, 'payments').type, 'payments');
  assert.equal(colOf(b, 'payments').settings.currency, 'CAD');
  assert.equal(colOf(b, 'amount').settings.decimals, undefined);
  assert.equal(colOf(b, 'due').settings.role, 'dueDate');
});

test('without one, a board FOLLOWS the workspace currency, its columns born in it', async () => {
  const r = await createBoard({ template: 'budget' });
  assert.equal(r.status, 201);
  // null is "follows the workspace", not "unknown": the columns name the unit.
  assert.equal(r.body.board.currency, null);
  assert.equal((await Board.findById(r.body.board._id).lean()).currency, null);
  for (const k of ['allocated', 'spent', 'remaining']) {
    assert.equal(colOf(r.body.board, k).settings.currency, 'INR', k);
  }
});

test("asking for the workspace's own currency is following, not an override", async () => {
  /**
   * The create dialog may send the workspace code explicitly. Pinning it would
   * make a board that says "INR, like the workspace" stay INR when the
   * workspace moves — the opposite of what the person picked.
   */
  const r = await createBoard({ template: 'billing', currency: 'inr' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.board.currency, null);
  assert.equal(colOf(r.body.board, 'amount').settings.currency, 'INR');
  assert.equal(colOf(r.body.board, 'payments').settings.currency, 'INR');
});

test('an empty currency on create is no choice at all: the board follows', async () => {
  const r = await createBoard({ template: 'billing', currency: '' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.board.currency, null);
  assert.equal(colOf(r.body.board, 'amount').settings.currency, 'INR');
});

test('a currency we do not carry is refused, not defaulted', async () => {
  const r = await createBoard({ template: 'billing', currency: 'DOLLARS' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Currency must be one of/);
});

// ---------------------------------------------------------------------------
// The Ads Budget add-on's unit
// ---------------------------------------------------------------------------

let trackerSeq = 0;
/** A tracker board (the only kind with an Ads Budget), in `currency`. */
const createTracker = async (currency) => {
  trackerSeq += 1;
  const r = await createBoard({
    template: 'blank',
    boardType: 'tracker',
    monthTimezone: 'Asia/Kolkata',
    name: `Tracker ${trackerSeq}`,
    ...(currency ? { currency } : {}),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.board;
};
const switchAdsBudget = (boardId, body) => call('PUT', `/api/boards/${boardId}/ads-budget-settings`, body);

test('an ads budget is born with no unit of its own, and takes the board\'s when switched on', async () => {
  /**
   * It used to be stamped with the board's unit at CREATION, which froze the
   * wrong moment: relabel the board CAD afterwards and switch the add-on on,
   * and it opened in the rupees it was born with — the pin-on-enable never
   * fired because a unit was already there.
   */
  const b = await createTracker('INR');
  const stored = await Board.findById(b._id).lean();
  assert.equal(stored.adsBudget.currency, null);
  assert.equal(stored.adsBudget.enabled, false);

  const relabel = await call('PATCH', `/api/boards/${b._id}/currency`, { currency: 'CAD' });
  assert.equal(relabel.status, 200, JSON.stringify(relabel.body));

  const on = await switchAdsBudget(b._id, { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(on.body.adsBudget, { enabled: true, currency: 'CAD' });
  assert.equal((await Board.findById(b._id).lean()).adsBudget.currency, 'CAD');
});

test("a legacy 'USD' nobody chose is re-pinned on first switch-on — or cleared, on a following board", async () => {
  /**
   * Every board saved under the old schema default carries 'USD'. On an
   * add-on that was never on and has no rows it cannot have been a choice, so
   * switching on pins the board's own unit instead of opening a rupee board
   * in dollars…
   */
  const own = await createTracker('CAD');
  await Board.updateOne({ _id: own._id }, { $set: { 'adsBudget.currency': 'USD', 'adsBudget.enabled': false } });
  const on = await switchAdsBudget(own._id, { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.adsBudget.currency, 'CAD');

  // …and on a board that FOLLOWS the workspace it is cleared, not pinned: the
  // add-on then reads the workspace's unit and moves with it.
  const follows = await createTracker('INR');
  assert.equal((await Board.findById(follows._id).lean()).currency, null);
  await Board.updateOne({ _id: follows._id }, { $set: { 'adsBudget.currency': 'USD', 'adsBudget.enabled': false } });
  const cleared = await switchAdsBudget(follows._id, { enabled: true });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.adsBudget.currency, null);
  const roster = await call('GET', `/api/boards/${follows._id}/ads-budget`);
  assert.equal(roster.status, 200, JSON.stringify(roster.body));
  assert.equal(roster.body.currency, 'INR');
});

test("a stored 'USD' that may be real is left alone", async () => {
  // Rows exist: they are labelled in USD, and relabelling them silently would
  // go beyond anything the person was asked.
  const withRows = await createTracker('INR');
  await Board.updateOne({ _id: withRows._id }, { $set: { 'adsBudget.currency': 'USD' } });
  const group = await TaskGroup.create({ name: 'Client A', board: withRows._id, order: 0 });
  await AdsBudget.create({
    board: withRows._id, organisation: org._id, group: group._id, monthKey: '2026-09', platform: 'Meta',
  });
  assert.equal((await switchAdsBudget(withRows._id, { enabled: true })).body.adsBudget.currency, 'USD');

  // Already on: a switch-on that changes nothing does not re-decide the unit.
  const alreadyOn = await createTracker('INR');
  await Board.updateOne(
    { _id: alreadyOn._id },
    { $set: { 'adsBudget.currency': 'USD', 'adsBudget.enabled': true } }
  );
  assert.equal((await switchAdsBudget(alreadyOn._id, { enabled: true })).body.adsBudget.currency, 'USD');

  // Chosen in the same request: the choice wins.
  const chosen = await createTracker('INR');
  await Board.updateOne({ _id: chosen._id }, { $set: { 'adsBudget.currency': 'USD' } });
  const r = await switchAdsBudget(chosen._id, { enabled: true, currency: 'usd' });
  assert.equal(r.body.adsBudget.currency, 'USD');
});

// ---------------------------------------------------------------------------
// Template revision
// ---------------------------------------------------------------------------

test('a board seeded from a template is born at the current template revision', async () => {
  const { TEMPLATE_REVISION } = require('../utils/boardTemplates');
  const billing = (await createBoard({ template: 'billing' })).body.board;
  assert.equal((await Board.findById(billing._id).lean()).templateRevision, TEMPLATE_REVISION);
  const blank = (await createBoard({ template: 'blank' })).body.board;
  assert.equal((await Board.findById(blank._id).lean()).templateRevision, TEMPLATE_REVISION);
});

test("a copy carries its SOURCE's revision, so the upgrade script can still reach it", async () => {
  const { TEMPLATE_REVISION } = require('../utils/boardTemplates');
  const legacy = (await createBoard({ template: 'billing' })).body.board;
  await Board.updateOne({ _id: legacy._id }, { $set: { templateRevision: 0 } });
  const copyOfLegacy = (await createBoard({ template: `board:${legacy._id}` })).body.board;
  assert.equal((await Board.findById(copyOfLegacy._id).lean()).templateRevision, 0);

  const current = (await createBoard({ template: 'billing' })).body.board;
  const copyOfCurrent = (await createBoard({ template: `board:${current._id}` })).body.board;
  assert.equal((await Board.findById(copyOfCurrent._id).lean()).templateRevision, TEMPLATE_REVISION);
});

// ---------------------------------------------------------------------------
// Copying a board
// ---------------------------------------------------------------------------

test('a CAD board copied in an INR workspace stays CAD', async () => {
  /**
   * THE BUG: every money column of the copy was re-stamped with the workspace
   * currency, so the copy of a CAD billing board read ₹ on every amount.
   */
  const source = (await createBoard({ template: 'billing' })).body.board;
  const relabel = await call('PATCH', `/api/boards/${source._id}/currency`, { currency: 'CAD' });
  assert.equal(relabel.status, 200);

  const r = await createBoard({ template: `board:${source._id}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const copy = r.body.board;
  assert.equal(copy.currency, 'CAD');
  assert.equal(colOf(copy, 'amount').settings.currency, 'CAD');
  assert.equal(colOf(copy, 'payments').settings.currency, 'CAD');
});

test('a copied column that never had a code takes the source board unit', async () => {
  const source = (await createBoard({ template: 'billing' })).body.board;
  await Board.updateOne(
    { _id: source._id },
    { $set: { currency: 'AUD' }, $unset: { 'columns.$[a].settings.currency': '' } },
    { arrayFilters: [{ 'a.key': 'amount' }] }
  );
  const copy = (await createBoard({ template: `board:${source._id}` })).body.board;
  assert.equal(copy.currency, 'AUD');
  assert.equal(colOf(copy, 'amount').settings.currency, 'AUD');
});

test('a copy re-points its mirrors at its own connect column, and gets its edge', async () => {
  const target = (await createBoard({ template: 'pipeline' })).body.board;
  const source = (await createBoard({ template: 'blank' })).body.board;
  const link = await call('POST', `/api/boards/${source._id}/columns`, {
    name: 'Deal', type: 'connect_boards', settings: { targetBoardIds: [target._id] },
  });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  const mirror = await call('POST', `/api/boards/${source._id}/columns`, {
    name: 'Deal value',
    type: 'mirror',
    settings: {
      sourceConnectColumnId: link.body.column._id,
      sourceColumnId: colOf(target, 'value')._id,
      aggregation: 'sum',
    },
  });
  assert.equal(mirror.status, 201, JSON.stringify(mirror.body));

  const copy = (await createBoard({ template: `board:${source._id}` })).body.board;
  const copyLink = copy.columns.find((c) => c.type === 'connect_boards');
  const copyMirror = copy.columns.find((c) => c.type === 'mirror');
  assert.equal(String(copyMirror.settings.sourceConnectColumnId), String(copyLink._id));
  const edge = await BoardConnection.findOne({ fromBoardId: copy._id, fromColumnId: copyLink._id }).lean();
  assert.ok(edge, 'the copied connect column has no BoardConnection edge');
  assert.equal(String(edge.toBoardId), String(target._id));
});

// ---------------------------------------------------------------------------
// PATCH /api/boards/:id/currency
// ---------------------------------------------------------------------------

test('relabelling a board changes every money column and converts nothing', async () => {
  const b = (await createBoard({ template: 'budget' })).body.board;
  // A plain and a percent column, which have no unit to change.
  await call('POST', `/api/boards/${b._id}/columns`, { name: 'Count', type: 'number' });
  await call('POST', `/api/boards/${b._id}/columns`, {
    name: 'Share', type: 'number', settings: { format: 'percent' },
  });
  const paid = await call('POST', `/api/boards/${b._id}/columns`, { name: 'Paid', type: 'payments' });
  assert.equal(paid.status, 201);

  const group = await TaskGroup.create({ name: 'G', board: b._id, order: 0 });
  const allocated = colOf(b, 'allocated');
  const task = await Task.create({
    name: 'Ads', board: b._id, group: group._id,
    columnValues: { [String(allocated._id)]: 1000 },
  });

  const r = await call('PATCH', `/api/boards/${b._id}/currency`, { currency: ' cad ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.board.currency, 'CAD');
  assert.equal(String(r.body.board._id), String(b._id));
  const cols = r.body.board.columns;
  for (const k of ['allocated', 'spent', 'remaining', 'paid']) {
    assert.equal(colOf({ columns: cols }, k).settings.currency, 'CAD', k);
  }
  assert.equal(colOf({ columns: cols }, 'count').settings?.currency, undefined);
  assert.equal(colOf({ columns: cols }, 'share').settings?.currency, undefined);

  const stored = await Board.findById(b._id).lean();
  assert.equal(stored.currency, 'CAD');
  // The figure is exactly what was typed — relabelled, never multiplied.
  const fresh = await Task.findById(task._id).lean();
  assert.equal(fresh.columnValues[String(allocated._id)], 1000);
});

test('relabelling needs column.manage, a code, and a code we carry', async () => {
  const b = (await createBoard({ template: 'billing' })).body.board;
  // On a public board a member lands on `contribute`, below the column rung.
  const denied = await call('PATCH', `/api/boards/${b._id}/currency`, { currency: 'CAD' }, memberToken);
  assert.equal(denied.status, 403);
  const untouched = await Board.findById(b._id).lean();
  assert.equal(untouched.currency, null, 'still following');
  assert.equal(colOf(untouched, 'amount').settings.currency, 'INR');
  // Putting a board back to following is the same edit, behind the same gate.
  const deniedFollow = await call('PATCH', `/api/boards/${b._id}/currency`, { currency: null }, memberToken);
  assert.equal(deniedFollow.status, 403);

  // Saying nothing is not "follow": the request must name one or the other.
  assert.equal((await call('PATCH', `/api/boards/${b._id}/currency`, {})).status, 400);
  assert.equal((await call('PATCH', `/api/boards/${b._id}/currency`, { currency: 'XYZ' })).status, 400);
  assert.equal((await call('PATCH', '/api/boards/not-an-id/currency', { currency: 'CAD' })).status, 400);
});

// ---------------------------------------------------------------------------
// Following the workspace vs a currency of its own
// ---------------------------------------------------------------------------

test('a code pins the board as an override, and the answer says so', async () => {
  const b = (await createBoard({ template: 'billing' })).body.board;
  const r = await call('PATCH', `/api/boards/${b._id}/currency`, { currency: 'usd' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ['board', 'effective', 'following']);
  assert.deepEqual(Object.keys(r.body.board).sort(), ['_id', 'columns', 'currency']);
  assert.equal(r.body.board.currency, 'USD');
  assert.equal(r.body.following, false);
  assert.equal(r.body.effective, 'USD');
  assert.equal((await Board.findById(b._id).lean()).currency, 'USD');
});

test("pinning the workspace's own code is still an override — a deliberate one", async () => {
  // From the board's own menu, "INR" (not "Workspace currency") is a choice to
  // STAY in rupees whatever the workspace does next.
  const b = (await createBoard({ template: 'billing' })).body.board;
  const r = await call('PATCH', `/api/boards/${b._id}/currency`, { currency: 'INR' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.board.currency, 'INR');
  assert.equal(r.body.following, false);
  assert.equal((await Board.findById(b._id).lean()).currency, 'INR');
});

test('null puts a board back to following, relabelled to the workspace unit and converting nothing', async () => {
  const b = (await createBoard({ template: 'billing', currency: 'CAD' })).body.board;
  assert.equal(b.currency, 'CAD');
  const group = await TaskGroup.findOne({ board: b._id }).lean();
  const amount = colOf(b, 'amount');
  const task = await Task.create({
    name: 'INV-1', board: b._id, group: group._id,
    columnValues: { [String(amount._id)]: 5000 },
  });

  boardPings.length = 0;
  const r = await call('PATCH', `/api/boards/${b._id}/currency`, { currency: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.board.currency, null);
  assert.equal(r.body.following, true);
  assert.equal(r.body.effective, 'INR', "the workspace's unit, as it stands now");
  assert.equal(colOf(r.body.board, 'amount').settings.currency, 'INR');
  assert.equal(colOf(r.body.board, 'payments').settings.currency, 'INR');

  const stored = await Board.findById(b._id).lean();
  assert.equal(stored.currency, null);
  assert.equal(colOf(stored, 'amount').settings.currency, 'INR');
  // Relabelled, never multiplied.
  assert.equal((await Task.findById(task._id).lean()).columnValues[String(amount._id)], 5000);
  assert.ok(boardPings.some((p) => p.boardId === String(b._id)), 'open tabs were not told');
});

test("an empty string is read as null — what an unset select sends", async () => {
  const b = (await createBoard({ template: 'budget', currency: 'EUR' })).body.board;
  const r = await call('PATCH', `/api/boards/${b._id}/currency`, { currency: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.following, true);
  assert.equal(r.body.board.currency, null);
  assert.equal(colOf(r.body.board, 'allocated').settings.currency, 'INR');
});

test('following again moves the mirrors other boards keep of its money', async () => {
  const { billing, reports, follows, pinned } = await billingWithMirrorsNextDoor();
  const pin = await call('PATCH', `/api/boards/${billing._id}/currency`, { currency: 'CAD' });
  assert.equal(pin.status, 200);
  assert.equal(await mirrorCode(reports._id, follows._id), 'CAD');

  const back = await call('PATCH', `/api/boards/${billing._id}/currency`, { currency: null });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(await mirrorCode(reports._id, follows._id), 'INR');
  assert.equal(await mirrorCode(reports._id, pinned._id), 'EUR', 'an explicit choice was overwritten');
});

test('relabelling every column of a following board to the workspace unit keeps it following', async () => {
  /**
   * `reconcileMoneyUnits` used to pin `Board.currency` to whatever the columns
   * agreed on. On a following board that agree on the WORKSPACE's unit, that
   * would have quietly turned it into an override, and the next workspace
   * change would have left it behind.
   */
  const b = (await createBoard({ template: 'budget' })).body.board;
  // One column out of step (set to USD by hand): the board is mixed.
  await Board.updateOne(
    { _id: b._id },
    { $set: { 'columns.$[s].settings.currency': 'USD' } },
    { arrayFilters: [{ 's.key': 'spent' }] }
  );
  const spent = colOf(b, 'spent');
  // …and put back to rupees from the Table header: every own money column now
  // agrees on INR, the workspace's unit.
  const r = await call('PATCH', `/api/boards/${b._id}/columns/${spent._id}`, {
    settings: { ...spent.settings, currency: 'INR' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.currency, null, 'the board was pinned to the unit it already follows');
  assert.equal((await Board.findById(b._id).lean()).currency, null);

  // Relabelling all of it to ANOTHER unit by hand is an override, and is pinned.
  for (const key of ['allocated', 'spent']) {
    const c = colOf(b, key);
    // eslint-disable-next-line no-await-in-loop
    const x = await call('PATCH', `/api/boards/${b._id}/columns/${c._id}`, {
      settings: { ...c.settings, currency: 'CAD' },
    });
    assert.equal(x.status, 200, JSON.stringify(x.body));
  }
  assert.equal((await Board.findById(b._id).lean()).currency, 'CAD');
});

// ---------------------------------------------------------------------------
// Copies and following
// ---------------------------------------------------------------------------

test('a copy of a following board follows too', async () => {
  const source = (await createBoard({ template: 'billing' })).body.board;
  assert.equal(source.currency, null);
  const r = await createBoard({ template: `board:${source._id}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.board.currency, null);
  assert.equal(colOf(r.body.board, 'amount').settings.currency, 'INR');
  assert.equal(colOf(r.body.board, 'payments').settings.currency, 'INR');
});

test('a copy of a following board whose columns say another unit is pinned to it', async () => {
  // Out of step with the workspace (a relabel that failed, a legacy board):
  // the copied figures are in USD, so the copy must not follow into INR.
  const source = (await createBoard({ template: 'billing' })).body.board;
  await Board.updateOne(
    { _id: source._id },
    { $set: { 'columns.$[m].settings.currency': 'USD' } },
    { arrayFilters: [{ 'm.settings.format': 'currency' }] }
  );
  const copy = (await createBoard({ template: `board:${source._id}` })).body.board;
  assert.equal(copy.currency, 'USD');
  assert.equal(colOf(copy, 'amount').settings.currency, 'USD');
});

test("a copy of an override board is pinned to the source's unit, even the workspace's", async () => {
  // The source was deliberately pinned to INR; the copy keeps that choice.
  const source = (await createBoard({ template: 'billing' })).body.board;
  await call('PATCH', `/api/boards/${source._id}/currency`, { currency: 'INR' });
  const copy = (await createBoard({ template: `board:${source._id}` })).body.board;
  assert.equal(copy.currency, 'INR');
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

test('a column currency is stored normalised, and an absent one is pinned', async () => {
  const b = (await createBoard({ template: 'billing', currency: 'SGD' })).body.board;
  const typed = await call('POST', `/api/boards/${b._id}/columns`, {
    name: 'Fee', type: 'number', settings: { format: 'currency', currency: ' cad ' },
  });
  assert.equal(typed.status, 201);
  assert.equal(typed.body.column.settings.currency, 'CAD');

  // No code: born in the board's unit, not left to whatever the fallback is next week.
  const open = await call('POST', `/api/boards/${b._id}/columns`, {
    name: 'Tax', type: 'number', settings: { format: 'currency' },
  });
  assert.equal(open.body.column.settings.currency, 'SGD');

  // Switching a plain column to currency pins it the same way.
  const plain = await call('POST', `/api/boards/${b._id}/columns`, { name: 'Hours', type: 'number' });
  const switched = await call('PATCH', `/api/boards/${b._id}/columns/${plain.body.column._id}`, {
    settings: { format: 'currency' },
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.column.settings.currency, 'SGD');

  // Resending the format without the code keeps the code it already had.
  const again = await call('PATCH', `/api/boards/${b._id}/columns/${typed.body.column._id}`, {
    settings: { format: 'currency', summary: 'avg' },
  });
  assert.equal(again.body.column.settings.currency, 'CAD');
});

test("billing's Client column is a client column, and takes a footer like any other", async () => {
  const b = (await createBoard({ template: 'billing' })).body.board;
  const client = colOf(b, 'client');
  assert.equal(client.type, 'client');
  const r = await call('PATCH', `/api/boards/${b._id}/columns/${client._id}`, {
    settings: { ...client.settings, summary: 'filled' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.column.settings.summary, 'filled');

  // …and a board can add one of its own.
  const added = await call('POST', `/api/boards/${b._id}/columns`, { name: 'Billed to', type: 'client' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.column.type, 'client');
});

test("a legacy billing board's unlinked connect Client column accepts a footer change", async () => {
  /**
   * THE BUG: every settings write re-ran the target check, so choosing a
   * Summary on billing's seeded Client column failed with "connect_boards
   * requires at least one target board".
   *
   * New billing boards seed a `client` column instead, so this is set up as a
   * board from before that — the shape every existing billing board has until
   * the upgrade script converts it.
   */
  const b = (await createBoard({ template: 'billing' })).body.board;
  await Board.updateOne(
    { _id: b._id },
    { $set: { 'columns.$[c].type': 'connect_boards' } },
    { arrayFilters: [{ 'c.key': 'client' }] }
  );
  const client = colOf(b, 'client');
  const url = `/api/boards/${b._id}/columns/${client._id}`;

  const summary = await call('PATCH', url, { settings: { ...client.settings, summary: 'filled' } });
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.column.settings.summary, 'filled');

  // Changing the targets is still checked…
  const bad = await call('PATCH', url, { settings: { targetBoardIds: ['nope'] } });
  assert.equal(bad.status, 400);
  const self = await call('PATCH', url, { settings: { targetBoardIds: [b._id] } });
  assert.equal(self.status, 400);

  // …and a valid one is saved, with its edge.
  const clients = (await createBoard({ template: 'blank' })).body.board;
  const ok = await call('PATCH', url, { settings: { targetBoardIds: [clients._id] } });
  assert.equal(ok.status, 200);
  assert.ok(await BoardConnection.exists({ fromBoardId: b._id, fromColumnId: client._id }));

  // A later display-only edit that does not mention the targets keeps them.
  const later = await call('PATCH', url, { settings: { summary: 'empty' } });
  assert.equal(later.status, 200);
  assert.deepEqual(later.body.column.settings.targetBoardIds.map(String), [String(clients._id)]);
});

test('a formula column can be created and edited, and a broken expression is refused', async () => {
  const b = (await createBoard({ template: 'billing' })).body.board;
  const cols = `/api/boards/${b._id}/columns`;

  // No expression yet: the null probe used to 400 here with "read-only".
  const bare = await call('POST', cols, { name: 'Draft', type: 'formula' });
  assert.equal(bare.status, 201, JSON.stringify(bare.body));

  const typo = await call('POST', cols, {
    name: 'Due now', type: 'formula', settings: { expression: 'column.amont - column.payments' },
  });
  assert.equal(typo.status, 400);
  assert.match(typo.body.error, /not a column/);

  const notNumber = await call('POST', cols, {
    name: 'X', type: 'formula', settings: { expression: 'column.invoice * 2' },
  });
  assert.equal(notNumber.status, 400);

  const good = await call('POST', cols, {
    name: 'Outstanding',
    type: 'formula',
    settings: { expression: 'column.amount - column.payments', format: 'currency' },
  });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body.column.settings.currency, 'INR');

  const self = await call('PATCH', `${cols}/${good.body.column._id}`, {
    settings: { expression: 'column.outstanding + 1' },
  });
  assert.equal(self.status, 400);
  assert.match(self.body.error, /itself/);

  // A display edit that omits the expression keeps it.
  const footer = await call('PATCH', `${cols}/${good.body.column._id}`, { settings: { summary: 'sum' } });
  assert.equal(footer.status, 200);
  assert.equal(footer.body.column.settings.expression, 'column.amount - column.payments');
});

test('a payments column is money from birth', async () => {
  const b = (await createBoard({ template: 'blank', currency: 'EUR' })).body.board;
  const r = await call('POST', `/api/boards/${b._id}/columns`, { name: 'Received', type: 'payments' });
  assert.equal(r.status, 201);
  assert.deepEqual(
    { format: r.body.column.settings.format, currency: r.body.column.settings.currency, summary: r.body.column.settings.summary },
    { format: 'currency', currency: 'EUR', summary: 'sum' }
  );
  // …and cannot be switched to a plain number by a settings edit.
  const plain = await call('PATCH', `/api/boards/${b._id}/columns/${r.body.column._id}`, {
    settings: { format: 'plain' },
  });
  assert.equal(plain.body.column.settings.format, 'currency');
});

test('a mirror of a money column inherits its unit', async () => {
  const pipeline = (await createBoard({ template: 'pipeline', currency: 'CAD' })).body.board;
  const invoices = (await createBoard({ template: 'blank', currency: 'INR' })).body.board;
  const link = await call('POST', `/api/boards/${invoices._id}/columns`, {
    name: 'Deal', type: 'connect_boards', settings: { targetBoardIds: [pipeline._id] },
  });
  const settings = (aggregation) => ({
    sourceConnectColumnId: link.body.column._id,
    sourceColumnId: colOf(pipeline, 'value')._id,
    aggregation,
  });

  const sum = await call('POST', `/api/boards/${invoices._id}/columns`, {
    name: 'Deal value', type: 'mirror', settings: settings('sum'),
  });
  assert.equal(sum.status, 201, JSON.stringify(sum.body));
  // CAD, from the SOURCE — not the INR of the board it is shown on.
  assert.equal(sum.body.column.settings.format, 'currency');
  assert.equal(sum.body.column.settings.currency, 'CAD');

  const count = await call('POST', `/api/boards/${invoices._id}/columns`, {
    name: 'Deals', type: 'mirror', settings: settings('count'),
  });
  assert.equal(count.body.column.settings.format, undefined, 'a count is not money');

  const explicit = await call('POST', `/api/boards/${invoices._id}/columns`, {
    name: 'Deal value (plain)', type: 'mirror', settings: { ...settings('sum'), format: 'plain' },
  });
  assert.equal(explicit.body.column.settings.format, 'plain');
});

test('a role must be one we know, on a column of the right type', async () => {
  const b = (await createBoard({ template: 'blank' })).body.board;
  const cols = `/api/boards/${b._id}/columns`;
  assert.equal((await call('POST', cols, { name: 'When', type: 'date', settings: { role: 'assignee' } })).status, 400);
  assert.equal((await call('POST', cols, { name: 'Who', type: 'person', settings: { role: 'boss' } })).status, 400);
  const ok = await call('POST', cols, { name: 'Deadline', type: 'date', settings: { role: 'dueDate' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.column.settings.role, 'dueDate');
});

// ---------------------------------------------------------------------------
// A role is held by ONE column
// ---------------------------------------------------------------------------

const { roleColumn, columnRole } = require('../utils/columnRoles');

test('a new column that claims a role takes it from the template column', async () => {
  /**
   * THE BUG: every billing board is born with `due` marking itself the due
   * date, a new column is appended AFTER it, and the resolver keeps the first
   * own-role column in array order — so marking "Payment due" as the due date
   * did nothing at all while looking configured.
   */
  const b = (await createBoard({ template: 'billing' })).body.board;
  const r = await call('POST', `/api/boards/${b._id}/columns`, {
    name: 'Payment due', type: 'date', settings: { role: 'dueDate' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const stored = await Board.findById(b._id).lean();
  assert.equal(roleColumn(stored, 'dueDate').key, 'payment_due');
  // `due` let go all the way — it does not keep the role through its template.
  const due = colOf(stored, 'due');
  assert.equal(due.settings.role, 'none');
  assert.equal(columnRole(stored, due), null);
  // The response carries the released column, so the client needs no refetch.
  assert.equal(colOf({ columns: r.body.columns }, 'due').settings.role, 'none');
  // The OTHER role is untouched.
  assert.equal(roleColumn(stored, 'assignee').key, 'owner');
});

test('claiming a role on an existing column releases it; resending it releases nothing', async () => {
  const b = (await createBoard({ template: 'blank' })).body.board;
  const cols = `/api/boards/${b._id}/columns`;
  const first = (await call('POST', cols, { name: 'Deadline', type: 'date', settings: { role: 'dueDate' } })).body.column;
  const second = (await call('POST', cols, { name: 'Cutoff', type: 'date' })).body.column;

  const claim = await call('PATCH', `${cols}/${second._id}`, { settings: { role: 'dueDate' } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  let stored = await Board.findById(b._id).lean();
  assert.equal(roleColumn(stored, 'dueDate').key, 'cutoff');
  // No template or slug hands `deadline` the role back, so its key is simply gone.
  assert.equal(colOf(stored, 'deadline').settings?.role, undefined);

  // The header menu resends the whole settings object on a footer change; that
  // is not a new claim and must not move the role.
  const footer = await call('PATCH', `${cols}/${first._id}`, { settings: { summary: 'filled' } });
  assert.equal(footer.status, 200);
  stored = await Board.findById(b._id).lean();
  assert.equal(roleColumn(stored, 'dueDate').key, 'cutoff');
});

test("'none' un-marks a template column for good, and survives a resend", async () => {
  const b = (await createBoard({ template: 'billing' })).body.board;
  const due = colOf(b, 'due');
  const url = `/api/boards/${b._id}/columns/${due._id}`;

  const off = await call('PATCH', url, { settings: { role: 'none' } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  let stored = await Board.findById(b._id).lean();
  assert.equal(colOf(stored, 'due').settings.role, 'none');
  // The template no longer hands it back: the board has no due date column.
  assert.equal(roleColumn(stored, 'dueDate'), null);

  // A later display edit resends `{ ...settings, summary }` — a stored 'none'
  // must come back through as valid, not as a 400.
  const again = await call('PATCH', url, { settings: { ...colOf(stored, 'due').settings, summary: 'filled' } });
  assert.equal(again.status, 200, JSON.stringify(again.body));

  // An empty role is "back to the default", which for `due` is the template's.
  const reset = await call('PATCH', url, { settings: { role: null } });
  assert.equal(reset.status, 200);
  stored = await Board.findById(b._id).lean();
  assert.equal(colOf(stored, 'due').settings?.role, undefined);
  assert.equal(roleColumn(stored, 'dueDate').key, 'due');

  // 'none' is valid on any type — a text column may say it plays no role.
  const text = await call('POST', `/api/boards/${b._id}/columns`, { name: 'Ref', type: 'text', settings: { role: 'none' } });
  assert.equal(text.status, 201, JSON.stringify(text.body));
});

// ---------------------------------------------------------------------------
// Mirrors keep their source's unit
// ---------------------------------------------------------------------------

/** An INR invoice board carrying a CAD mirror from a CAD pipeline. */
const boardWithCadMirror = async () => {
  const pipeline = (await createBoard({ template: 'pipeline', currency: 'CAD' })).body.board;
  const invoices = (await createBoard({ template: 'budget', currency: 'INR' })).body.board;
  const link = await call('POST', `/api/boards/${invoices._id}/columns`, {
    name: 'Deal', type: 'connect_boards', settings: { targetBoardIds: [pipeline._id] },
  });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  const mirror = await call('POST', `/api/boards/${invoices._id}/columns`, {
    name: 'Deal value',
    type: 'mirror',
    settings: {
      sourceConnectColumnId: link.body.column._id,
      sourceColumnId: colOf(pipeline, 'value')._id,
      aggregation: 'sum',
    },
  });
  assert.equal(mirror.status, 201, JSON.stringify(mirror.body));
  assert.equal(mirror.body.column.settings.currency, 'CAD');
  return { invoices, mirror: mirror.body.column };
};

test('relabelling a board leaves its mirrors in their source unit', async () => {
  /**
   * THE BUG: the relabel stamped every money column, mirrors included — so a
   * CAD figure mirrored from a pipeline said INR, and a reader in dollars saw
   * it converted at the rupee rate.
   */
  const { invoices, mirror } = await boardWithCadMirror();
  const r = await call('PATCH', `/api/boards/${invoices._id}/currency`, { currency: 'SGD' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cols = { columns: r.body.board.columns };
  assert.equal(colOf(cols, 'allocated').settings.currency, 'SGD');
  assert.equal(cols.columns.find((c) => String(c._id) === String(mirror._id)).settings.currency, 'CAD');
});

test('the Currency tab does not call a board mixed over a mirror', async () => {
  const { invoices } = await boardWithCadMirror();
  const r = await call('GET', `/api/orgs/${org._id}/currency/boards`);
  assert.equal(r.status, 200);
  const row = r.body.boards.find((x) => String(x._id) === String(invoices._id));
  assert.ok(row);
  assert.equal(row.currency, 'INR');
  assert.equal(row.mixed, false, 'a CAD mirror made an all-INR board read as mixed');
  assert.equal(row.moneyColumns, 3, 'allocated, spent and remaining — not the mirror');
});

test("a mirror's unit does not stop the board following its own columns", async () => {
  // reconcileMoneyUnits: every OWN money column relabelled to AUD one at a time
  // → the board is AUD, whatever the mirror says.
  const { invoices } = await boardWithCadMirror();
  for (const key of ['allocated', 'spent', 'remaining']) {
    const c = colOf(invoices, key);
    // eslint-disable-next-line no-await-in-loop
    const r = await call('PATCH', `/api/boards/${invoices._id}/columns/${c._id}`, {
      settings: { ...c.settings, currency: 'AUD' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal((await Board.findById(invoices._id).lean()).currency, 'AUD');
});

/** An INR billing board, and a board next door mirroring its Amount twice. */
const billingWithMirrorsNextDoor = async () => {
  const billing = (await createBoard({ template: 'billing', currency: 'INR' })).body.board;
  const reports = (await createBoard({ template: 'blank', currency: 'INR' })).body.board;
  const link = await call('POST', `/api/boards/${reports._id}/columns`, {
    name: 'Invoice', type: 'connect_boards', settings: { targetBoardIds: [billing._id] },
  });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  const settings = {
    sourceConnectColumnId: link.body.column._id,
    sourceColumnId: colOf(billing, 'amount')._id,
    aggregation: 'sum',
  };
  const follows = await call('POST', `/api/boards/${reports._id}/columns`, {
    name: 'Billed', type: 'mirror', settings,
  });
  assert.equal(follows.status, 201, JSON.stringify(follows.body));
  assert.equal(follows.body.column.settings.currency, 'INR');
  // One somebody deliberately set to another unit.
  const pinned = await call('POST', `/api/boards/${reports._id}/columns`, {
    name: 'Billed (EUR)', type: 'mirror', settings: { ...settings, format: 'currency', currency: 'EUR' },
  });
  assert.equal(pinned.status, 201, JSON.stringify(pinned.body));
  assert.equal(pinned.body.column.settings.currency, 'EUR');
  return { billing, reports, follows: follows.body.column, pinned: pinned.body.column };
};

const mirrorCode = async (boardId, colId) => {
  const b = await Board.findById(boardId).lean();
  return b.columns.find((c) => String(c._id) === String(colId)).settings.currency;
};

test('relabelling a board moves the mirrors OTHER boards keep of its money', async () => {
  /**
   * THE BUG: a mirror is stamped with its source's code when it is made, and
   * nothing re-stamped it — so after Billing went INR→CAD, a mirror of its
   * Amount next door still said ₹ over CAD figures.
   */
  const { billing, reports, follows, pinned } = await billingWithMirrorsNextDoor();
  boardPings.length = 0;
  const r = await call('PATCH', `/api/boards/${billing._id}/currency`, { currency: 'CAD' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await mirrorCode(reports._id, follows._id), 'CAD');
  assert.equal(await mirrorCode(reports._id, pinned._id), 'EUR', 'an explicit choice was overwritten');
  assert.ok(
    boardPings.some((p) => p.boardId === String(reports._id)),
    'the mirroring board was not told to refresh'
  );
});

test("relabelling Amount from the Table header takes Payments, the board and its mirrors with it", async () => {
  /**
   * THE BUG: only the edited column moved. Payments stayed INR under a CAD
   * Amount, so the ledger printed rupee receipts as CA$ and auto-Paid compared
   * rupees with dollars; the board stayed INR because its columns disagreed.
   */
  const { billing, reports, follows } = await billingWithMirrorsNextDoor();
  const amount = colOf(billing, 'amount');
  boardPings.length = 0;
  const r = await call('PATCH', `/api/boards/${billing._id}/columns/${amount._id}`, {
    settings: { ...amount.settings, currency: 'CAD' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(colOf({ columns: r.body.columns }, 'payments').settings.currency, 'CAD');
  assert.equal(r.body.currency, 'CAD');
  const stored = await Board.findById(billing._id).lean();
  assert.equal(stored.currency, 'CAD');
  assert.equal(colOf(stored, 'payments').settings.currency, 'CAD');
  assert.equal(await mirrorCode(reports._id, follows._id), 'CAD');
  // Other open tabs on the board itself are told too — PATCH /currency always
  // announced, the per-column path did not.
  assert.ok(boardPings.some((p) => p.boardId === String(billing._id)), 'the board was not announced');

  // Switching a column OUT of money leaves its partner's unit alone.
  const again = await call('PATCH', `/api/boards/${billing._id}/columns/${amount._id}`, {
    settings: { ...amount.settings, format: 'plain', currency: undefined },
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(colOf({ columns: again.body.columns }, 'payments').settings.currency, 'CAD');
});

test('a relabel pings every open tab that can read the board', async () => {
  const b = (await createBoard({ template: 'billing' })).body.board;
  boardPings.length = 0;
  const r = await call('PATCH', `/api/boards/${b._id}/currency`, { currency: 'CAD' });
  assert.equal(r.status, 200);
  const pinged = new Set(boardPings.filter((p) => p.boardId === String(b._id)).map((p) => p.userId));
  // A public board: the actor (for their other tabs) and the member both read it.
  assert.ok(pinged.has(String(owner._id)), 'the actor was not pinged');
  assert.ok(pinged.has(String(member._id)), 'a reader was not pinged');

  // A private board the member cannot open does not tell them it changed.
  const priv = (await createBoard({ template: 'billing', visibility: 'private' })).body.board;
  boardPings.length = 0;
  await call('PATCH', `/api/boards/${priv._id}/currency`, { currency: 'CAD' });
  const privPinged = new Set(boardPings.filter((p) => p.boardId === String(priv._id)).map((p) => p.userId));
  assert.ok(privPinged.has(String(owner._id)));
  assert.ok(!privPinged.has(String(member._id)), 'a private board leaked a ping to a non-reader');
});

// ---------------------------------------------------------------------------
// Deleting a client board
// ---------------------------------------------------------------------------

test("deleting a client board keeps its invoices' client name and drops only the pointer", async () => {
  const clientBoard = (await createBoard({ template: 'blank', boardType: 'client', clientName: 'Kredoo' })).body.board;
  const billing = (await createBoard({ template: 'billing' })).body.board;
  const group = await TaskGroup.findOne({ board: billing._id }).lean();
  const clientCol = colOf(billing, 'client');
  const cellPath = String(clientCol._id);
  const pointing = await Task.create({
    name: 'INV-1', board: billing._id, group: group._id,
    columnValues: { [cellPath]: { boardId: String(clientBoard._id), name: 'Kredoo' } },
  });
  const other = await Task.create({
    name: 'INV-2', board: billing._id, group: group._id,
    columnValues: { [cellPath]: { boardId: null, name: 'Walk-in' } },
  });

  const r = await call('DELETE', `/api/boards/${clientBoard._id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const after = await Task.findById(pointing._id).lean();
  assert.deepEqual(after.columnValues[cellPath], { boardId: null, name: 'Kredoo' });
  const untouched = await Task.findById(other._id).lean();
  assert.deepEqual(untouched.columnValues[cellPath], { boardId: null, name: 'Walk-in' });
});

// ---------------------------------------------------------------------------
// The workspace view — GET /api/orgs/:id/currency/boards
// ---------------------------------------------------------------------------

test('the Currency tab can list every money board, with its unit and whether it is mixed', async () => {
  // A following billing board whose Payments column somebody set to USD by
  // hand: Amount still says INR, so the board reads INR — and is mixed.
  const mixed = (await createBoard({ template: 'billing' })).body.board;
  await Board.updateOne(
    { _id: mixed._id },
    { $set: { 'columns.$[p].settings.currency': 'USD' } },
    { arrayFilters: [{ 'p.key': 'payments' }] }
  );
  const pinned = (await createBoard({ template: 'billing', currency: 'CAD' })).body.board;

  const r = await call('GET', `/api/orgs/${org._id}/currency/boards`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = r.body.boards.find((x) => String(x._id) === String(mixed._id));
  assert.ok(row, 'a billing board is missing from the list');
  assert.equal(row.currency, 'INR');
  assert.equal(row.effective, 'INR');
  assert.equal(row.following, true);
  assert.equal(row.moneyColumns, 2);
  assert.equal(row.mixed, true);
  assert.equal(row.canManage, true);
  // A board with a currency of its own says so.
  const own = r.body.boards.find((x) => String(x._id) === String(pinned._id));
  assert.equal(own.following, false);
  assert.equal(own.effective, 'CAD');
  assert.equal(own.mixed, false);
  for (const b of r.body.boards) {
    assert.deepEqual(
      Object.keys(b).sort(),
      ['_id', 'canManage', 'currency', 'effective', 'following', 'mixed', 'moneyColumns', 'name']
    );
  }
  // A board with no money column is not listed at all.
  const blank = (await createBoard({ template: 'blank' })).body.board;
  const again = await call('GET', `/api/orgs/${org._id}/currency/boards`);
  assert.ok(!again.body.boards.some((x) => String(x._id) === String(blank._id)));

  // Same gate as the currency settings themselves.
  const denied = await call('GET', `/api/orgs/${org._id}/currency/boards`, undefined, memberToken);
  assert.equal(denied.status, 403);
});

test('a workspace can be created in its own currency', async () => {
  const r = await call('POST', '/api/orgs', { name: 'Maple Co', baseCurrency: 'cad' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.org.baseCurrency, 'CAD');
  const bad = await call('POST', '/api/orgs', { name: 'Nope Co', baseCurrency: 'loonies' });
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------------------
// Deleting a board
// ---------------------------------------------------------------------------

test("deleting a board hands its file columns' files to the cleanup", async () => {
  const b = (await createBoard({ template: 'billing' })).body.board;
  const group = await TaskGroup.findOne({ board: b._id }).lean();
  const pdf = colOf(b, 'pdf');
  const publicId = `macan/board-files/${b._id}/ab12-INV`;
  await Task.create({
    name: 'INV-1',
    board: b._id,
    group: group._id,
    columnValues: {
      [String(pdf._id)]: [{ url: `https://res.cloudinary.com/x/raw/upload/v1/${publicId}`, name: 'INV.pdf', publicId }],
    },
  });
  destroyedWith.length = 0;
  const r = await call('DELETE', `/api/boards/${b._id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(destroyedWith.length, 1);
  const { columns, tasks, opts } = destroyedWith[0];
  assert.ok(columns.some((c) => c.type === 'file' && String(c._id) === String(pdf._id)));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].columnValues[String(pdf._id)][0].publicId, publicId);
  // The rows arrive WITH their board, and the board is named as well: it is
  // the only folder the cleanup may destroy from.
  assert.equal(String(tasks[0].board), String(b._id));
  assert.equal(String(opts.boardId), String(b._id));
  assert.equal(await Board.exists({ _id: b._id }), null);
});

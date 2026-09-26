/**
 * taskWritePath.test.js — what ELSE a row write does, against a real
 * (throwaway, in-memory) MongoDB.
 *
 * Run from server/:   node --test src/controllers/taskWritePath.test.js
 *
 * taskColumnSync.test.js pins what a write stores. This pins what a write
 * TRIGGERS — the consequences that used to be missing, each of which left the
 * board quietly wrong:
 *
 *   - PAID IN FULL. A row whose payments now cover its amount is moved to the
 *     board's done status by the server (utils/paymentsSettle.js), logged and
 *     announced like any status change — so the due digest, My Work and the
 *     executive tiles stop chasing an invoice that has been paid. Never the
 *     other way round.
 *   - ASSIGNING FROM THE OWNER CELL. Writing somebody into the Owner (assignee
 *     role) cell makes them an assignee through the save hook, but only
 *     `assignedTo` in the body ever notified or emailed anyone.
 *   - THE CLIENT CELL. A `client` cell names a workspace CLIENT board; the
 *     server checks it is one, in this workspace, that the writer can open,
 *     and stamps the board's own name as the snapshot.
 *   - THE TOLD STRIP. Posting an update that mentions people hands the
 *     task's fresh "notified" stamp back, so the ledger can patch its tile
 *     without a refetch.
 *
 * Nothing here reaches the network: nodemailer is swapped for a recorder
 * before anything loads it.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

// Before anything requires emailService, whose transporters are built at load.
const nodemailer = require('nodemailer');
let sent = [];
nodemailer.createTransport = () => ({
  sendMail: async (mail) => {
    sent.push(mail);
    return { messageId: 'test' };
  },
});

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

require('../models');
const Task = mongoose.model('Task');
const Board = mongoose.model('Board');
const TaskGroup = mongoose.model('TaskGroup');
const User = mongoose.model('User');
const Organisation = mongoose.model('Organisation');
const Notification = mongoose.model('Notification');
const ActivityLog = require('../models/ActivityLog');
const { getColumnType } = require('../utils/columnTypes');
const { describeActivity } = require('../services/activityFormat');
const { createTask, updateTask } = require('./taskController');
const { addUpdate, editUpdate, deleteUpdate } = require('./updateController');
const { cloudinary } = require('../config/cloudinary');
const Update = mongoose.model('Update');

let mongod;
let owner; // Nora — made the boards, holds every capability.
let member; // Milo — a `contribute` member of the ledger.
let other; // Ola — a workspace member, the usual assignee.
let outsider; // Xan — another workspace entirely.
let org;
let foreignOrg;
let ledger;
let group;
// Client boards (and one that is not), for the Client cell.
let acme;
let hidden;
let ops;
let foreign;

let DRAFT;
let SENT;
let PAID;

const colId = (key) => String(ledger.columns.find((c) => c.key === key)._id);

/** Call a controller the way Express would, and hand back what it answered. */
const call = async (handler, { params = {}, body = {}, query = {}, as = owner } = {}) => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler(
    { user: { userId: String(as._id), name: as.name }, params, body, query },
    res
  );
  return res;
};

/** `logActivity` is fire-and-forget: wait it out. */
const settle = async (check, tries = 40) => {
  for (let i = 0; i < tries; i += 1) {
    const out = await check();
    if (out) return out;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
};

const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  owner = await User.create({ name: 'Nora C', email: 'nora@example.com', googleId: 'g-nora' });
  member = await User.create({ name: 'Milo K', email: 'milo@example.com', googleId: 'g-milo' });
  other = await User.create({ name: 'Ola P', email: 'ola@example.com', googleId: 'g-ola' });
  outsider = await User.create({ name: 'Xan Q', email: 'xan@example.com', googleId: 'g-xan' });

  org = await Organisation.create({
    name: 'Davnoot',
    admin: owner._id,
    members: [owner._id, member._id, other._id],
    inviteCode: 'task-write-path',
    baseCurrency: 'CAD',
  });
  org.ensureSystemRoles();
  await org.save();
  await User.updateMany(
    { _id: { $in: [owner._id, member._id, other._id] } },
    { $set: { organisations: [org._id] } }
  );
  foreignOrg = await Organisation.create({
    name: 'Elsewhere',
    admin: outsider._id,
    members: [outsider._id],
    inviteCode: 'task-write-path-2',
  });

  // Shaped like a billing board, but nothing below reads its name or its
  // template: settling is two column TYPES and a status KEY.
  ledger = await Board.create({
    name: 'Receivables',
    organisation: org._id,
    createdBy: owner._id,
    visibility: 'public',
    publicDefaultLevel: 'contribute',
    useFlexibleColumns: true,
    statuses: [
      { key: 'not_started', name: 'Draft', order: 0, isDefault: true },
      { key: 'working_on_it', name: 'Sent', order: 1 },
      { key: 'done', name: 'Paid', order: 2 },
      { key: 'stuck', name: 'Overdue', order: 3 },
    ],
    columns: [
      { key: 'invoice', name: 'Invoice', type: 'text', isPrimary: true },
      { key: 'amount', name: 'Amount', type: 'number', settings: { format: 'currency', currency: 'CAD' } },
      { key: 'payments', name: 'Payments', type: 'payments', settings: { format: 'currency', currency: 'CAD' } },
      { key: 'due', name: 'Due', type: 'date', settings: { role: 'dueDate' } },
      { key: 'owner', name: 'Owner', type: 'person', settings: { role: 'assignee' } },
      { key: 'client', name: 'Client', type: 'client' },
    ],
  });
  DRAFT = ledger.statuses.find((s) => s.key === 'not_started');
  SENT = ledger.statuses.find((s) => s.key === 'working_on_it');
  PAID = ledger.statuses.find((s) => s.key === 'done');
  group = await TaskGroup.create({ name: 'Invoices', board: ledger._id });

  acme = await Board.create({
    name: 'Acme',
    portalClientName: 'Acme Corp',
    boardType: 'client',
    organisation: org._id,
    createdBy: owner._id,
    visibility: 'public',
  });
  hidden = await Board.create({
    name: 'Hidden Co',
    boardType: 'client',
    organisation: org._id,
    createdBy: owner._id,
    visibility: 'private',
  });
  ops = await Board.create({
    name: 'Ops',
    organisation: org._id,
    createdBy: owner._id,
    visibility: 'public',
  });
  foreign = await Board.create({
    name: 'Their Client',
    boardType: 'client',
    organisation: foreignOrg._id,
    createdBy: outsider._id,
    visibility: 'public',
  });
});

after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => {
  sent = [];
});

/** An invoice row. Cells are written the way the save hook expects on insert. */
const newRow = ({ name = 'INV', status = SENT._id, amount, payments, ownerIds, createdBy = owner._id, client } = {}) => {
  const cells = { [colId('invoice')]: name };
  if (amount !== undefined) cells[colId('amount')] = amount;
  if (payments !== undefined) cells[colId('payments')] = payments;
  if (ownerIds !== undefined) cells[colId('owner')] = ownerIds.map(String);
  if (client !== undefined) cells[colId('client')] = client;
  return new Task({
    name,
    board: ledger._id,
    group: group._id,
    status,
    createdBy,
    columnValues: cells,
  }).save();
};

const receipt = (amount, id, date = '2026-09-10') => ({ id, amount, date });

const put = (task, body, as = owner) =>
  call(updateTask, { params: { id: String(task._id) }, body, as });

const statusOf = async (task) => String((await Task.findById(task._id).lean()).status);

// ---------------------------------------------------------------------------
// Paid in full
// ---------------------------------------------------------------------------

test('payments that cover the amount mark the row Paid, logged and announced like a status change', async () => {
  const task = await newRow({ name: 'INV-100', amount: 1000, ownerIds: [other._id] });
  const res = await put(task, {
    columnValues: { [colId('payments')]: [receipt(400, 'a'), receipt(600, 'b')] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(String(res.body.task.status), String(PAID._id), 'the reply already says Paid');
  assert.equal(await statusOf(task), String(PAID._id));

  const row = await settle(() => ActivityLog.findOne({ task: task._id, field: 'status' }).lean());
  assert.ok(row, 'the move to Paid is in the history');
  assert.equal(row.oldValue, String(SENT._id));
  assert.equal(row.newValue, String(PAID._id));
  assert.equal(row.metadata.settledBy, 'payments');
  assert.ok(
    await ActivityLog.exists({ task: task._id, field: 'column:payments' }),
    'and so is the payment that did it'
  );

  const told = await settle(() =>
    Notification.findOne({ user: other._id, task: task._id, type: 'statusChanged' }).lean()
  );
  assert.ok(told, 'the assignee was told, exactly as for a status change by hand');
  assert.match(told.message, /changed to Paid/);
  assert.equal(
    await Notification.countDocuments({ user: owner._id, task: task._id, type: 'statusChanged' }),
    0,
    'the person who recorded the payment is not told about their own write'
  );
});

test('a part payment leaves the status alone', async () => {
  const task = await newRow({ name: 'INV-101', amount: 1000 });
  const res = await put(task, { columnValues: { [colId('payments')]: [receipt(400, 'a')] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(await statusOf(task), String(SENT._id));
  await pause();
  assert.equal(await ActivityLog.countDocuments({ task: task._id, field: 'status' }), 0);
});

test('raising the amount to meet recorded payments settles it too', async () => {
  // The amount is the other half of the comparison — a write to it counts.
  const task = await newRow({ name: 'INV-102', amount: 2000, payments: [receipt(1500, 'a')] });
  const res = await put(task, { columnValues: { [colId('amount')]: 1500 } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(await statusOf(task), String(PAID._id));
});

test('removing a payment never un-marks a Paid row', async () => {
  const task = await newRow({ name: 'INV-103', amount: 500 });
  await put(task, { columnValues: { [colId('payments')]: [receipt(500, 'a')] } });
  assert.equal(await statusOf(task), String(PAID._id));

  const res = await put(task, { columnValues: { [colId('payments')]: [] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(await statusOf(task), String(PAID._id), 'still Paid — reopening is a person\'s call');
});

test("a migrated board's status cell settles with the row, so the save hook cannot undo it", async () => {
  /**
   * THE BUG: on a board migrated from the legacy table, the save hook copies
   * the column keyed 'status' onto task.status on every save. Settling set
   * task.status alone, so the hook put the old status straight back — while
   * the activity row, the notification and the client email all said Paid,
   * and said it again on every later payment edit.
   */
  const old = await Board.create({
    name: 'Old ledger',
    organisation: org._id,
    createdBy: owner._id,
    visibility: 'public',
    useFlexibleColumns: true,
    statuses: [
      { key: 'not_started', name: 'Todo', order: 0, isDefault: true },
      { key: 'done', name: 'Done', order: 1 },
    ],
  });
  const [todo, done] = old.statuses;
  // As migrateLegacyColumns builds it: the options ARE the board's statuses.
  old.columns = [
    { key: 'lead_name', name: 'Name', type: 'text', isPrimary: true },
    {
      key: 'status',
      name: 'Stage',
      type: 'status',
      settings: { options: [{ id: String(todo._id), label: 'Todo' }, { id: String(done._id), label: 'Done' }] },
    },
    { key: 'amount', name: 'Amount', type: 'number', settings: { format: 'currency', currency: 'CAD' } },
    { key: 'payments', name: 'Payments', type: 'payments', settings: { format: 'currency', currency: 'CAD' } },
  ];
  await old.save();
  const g = await TaskGroup.create({ name: 'G', board: old._id });
  const cid = (k) => String(old.columns.find((c) => c.key === k)._id);
  const row = await new Task({
    name: 'INV-L1',
    board: old._id,
    group: g._id,
    status: todo._id,
    createdBy: owner._id,
    columnValues: { [cid('lead_name')]: 'INV-L1', [cid('status')]: String(todo._id), [cid('amount')]: 500 },
  }).save();

  const res = await put(row, { columnValues: { [cid('payments')]: [receipt(500, 'l1')] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(row._id).lean();
  assert.equal(String(fresh.status), String(done._id), 'the hook put the old status back');
  assert.equal(fresh.columnValues[cid('status')], String(done._id));
});

test('a status CHANGED in the same request stands', async () => {
  const task = await newRow({ name: 'INV-104', amount: 500, status: DRAFT._id });
  const res = await put(task, {
    status: String(SENT._id),
    columnValues: { [colId('payments')]: [receipt(500, 'a')] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(await statusOf(task), String(SENT._id));
});

test('a status merely echoed back is not an instruction, so the row still settles', async () => {
  const task = await newRow({ name: 'INV-105', amount: 500 });
  const res = await put(task, {
    status: String(SENT._id),
    columnValues: { [colId('payments')]: [receipt(500, 'a')] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(await statusOf(task), String(PAID._id));
});

test('a row moved back out of Paid is not re-settled by an unrelated edit', async () => {
  const task = await newRow({ name: 'INV-106', amount: 500 });
  await put(task, { columnValues: { [colId('payments')]: [receipt(500, 'a')] } });
  assert.equal(await statusOf(task), String(PAID._id));

  // Somebody reopens it on purpose (written off, disputed — the cells cannot say).
  await put(task, { status: String(SENT._id) });
  assert.equal(await statusOf(task), String(SENT._id));

  // Editing its due date, from the panel or from the Due cell, is not a
  // payment: the reopened status survives both.
  await put(task, { dueDate: '2026-12-31T00:00:00.000Z' });
  await put(task, { columnValues: { [colId('due')]: '2027-01-15T00:00:00.000Z' } });
  assert.equal(await statusOf(task), String(SENT._id));
});

test('a row created with payments that cover it is created Paid, and says why', async () => {
  const res = await call(createTask, {
    body: {
      name: 'INV-107',
      board: String(ledger._id),
      group: String(group._id),
      columnValues: { [colId('amount')]: 750, [colId('payments')]: [receipt(750, 'a')] },
    },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(String(res.body.task.status), String(PAID._id));
  const row = await settle(() =>
    ActivityLog.findOne({ task: res.body.task._id, field: 'status' }).lean()
  );
  assert.ok(row);
  assert.equal(row.oldValue, String(DRAFT._id), 'from the board default it would have had');
  assert.equal(row.metadata.settledBy, 'payments');
});

test('a status NAMED on create stands', async () => {
  const res = await call(createTask, {
    body: {
      name: 'INV-108',
      board: String(ledger._id),
      group: String(group._id),
      status: String(SENT._id),
      columnValues: { [colId('amount')]: 750, [colId('payments')]: [receipt(750, 'a')] },
    },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(String(res.body.task.status), String(SENT._id));
});

// ---------------------------------------------------------------------------
// Assigning through the Owner cell
// ---------------------------------------------------------------------------

test('writing someone into the Owner cell assigns them: notified and emailed, the writer is not', async () => {
  const task = await newRow({ name: 'INV-200' });
  const res = await put(task, {
    columnValues: { [colId('owner')]: [String(owner._id), String(other._id)] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const fresh = await Task.findById(task._id).lean();
  assert.deepStrictEqual(
    fresh.assignedTo.map(String).sort(),
    [String(owner._id), String(other._id)].sort(),
    'the cell reached assignedTo'
  );

  const note = await settle(() =>
    Notification.findOne({ user: other._id, task: task._id, type: 'assigned' }).lean()
  );
  assert.ok(note, 'Ola was told she was assigned');
  assert.equal(
    await Notification.countDocuments({ user: owner._id, task: task._id, type: 'assigned' }),
    0,
    'Nora assigned herself — nothing to tell her'
  );
  assert.ok(sent.some((m) => m.to === 'ola@example.com'), 'Ola was emailed');
  assert.ok(!sent.some((m) => m.to === 'nora@example.com'), 'Nora was not');
});

test('someone already in the Owner cell is not told again when another name is added', async () => {
  const task = await newRow({ name: 'INV-201', ownerIds: [other._id] });
  const res = await put(task, {
    columnValues: { [colId('owner')]: [String(other._id), String(member._id)] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(
    await settle(() => Notification.findOne({ user: member._id, task: task._id, type: 'assigned' }).lean()),
    'Milo is new here'
  );
  assert.equal(
    await Notification.countDocuments({ user: other._id, task: task._id, type: 'assigned' }),
    0,
    'Ola was already on it'
  );
  assert.deepStrictEqual(sent.map((m) => m.to), ['milo@example.com']);
});

test('naming someone in assignedTo while the same request writes the Owner cell tells only who landed', async () => {
  // The save hook lets the cell win, so Ola — named only in `assignedTo` —
  // never ends up on the row, and must not be told she was assigned.
  const task = await newRow({ name: 'INV-203' });
  const res = await put(task, {
    assignedTo: [String(other._id)],
    columnValues: { [colId('owner')]: [String(member._id)] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.deepStrictEqual(fresh.assignedTo.map(String), [String(member._id)]);
  assert.ok(
    await settle(() => Notification.findOne({ user: member._id, task: task._id, type: 'assigned' }).lean()),
    'Milo, who landed, was told'
  );
  await pause();
  assert.equal(
    await Notification.countDocuments({ user: other._id, task: task._id, type: 'assigned' }),
    0,
    'Ola was told about an assignment that never happened'
  );
  assert.ok(!sent.some((m) => m.to === 'ola@example.com'));
});

test('a row created with its Owner already filled in announces the assignment', async () => {
  const res = await call(createTask, {
    body: {
      name: 'INV-202',
      board: String(ledger._id),
      group: String(group._id),
      columnValues: { [colId('owner')]: [String(other._id)] },
    },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.ok(
    await settle(() =>
      Notification.findOne({ user: other._id, task: res.body.task._id, type: 'assigned' }).lean()
    )
  );
  assert.ok(sent.some((m) => m.to === 'ola@example.com'));
});

test('claiming a row yourself does not email you that you were assigned', async () => {
  const task = await newRow({ name: 'INV-203', createdBy: member._id });
  const res = await put(task, { assignedTo: [String(member._id)] }, member);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  await pause();
  assert.deepStrictEqual(sent, []);
  assert.equal(await Notification.countDocuments({ user: member._id, task: task._id }), 0);
});

// ---------------------------------------------------------------------------
// The Client cell
// ---------------------------------------------------------------------------

const clientTypeReady = !!getColumnType('client');
const clientTest = (name, fn) =>
  test(name, { skip: clientTypeReady ? false : 'the client column type is not registered' }, fn);

clientTest("a client cell keeps the client board's own name, whatever the request called it", async () => {
  const task = await newRow({ name: 'INV-300' });
  const res = await put(task, {
    columnValues: { [colId('client')]: { boardId: String(acme._id), name: 'Totally Not Acme' } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.deepStrictEqual(fresh.columnValues[colId('client')], {
    boardId: String(acme._id),
    name: 'Acme Corp',
  });

  const row = await settle(() => ActivityLog.findOne({ task: task._id, field: 'column:client' }).lean());
  assert.ok(row);
  assert.equal(row.metadata.columnType, 'client');
  assert.equal(
    describeActivity({ ...row, actor: { name: 'Nora' } }),
    'Nora set Client to Acme Corp.'
  );
});

clientTest('a board that is not a client board is refused, and the cell is untouched', async () => {
  const task = await newRow({ name: 'INV-301' });
  const res = await put(task, {
    columnValues: { [colId('client')]: { boardId: String(ops._id), name: 'Ops' } },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /client boards/);
  const fresh = await Task.findById(task._id).lean();
  assert.equal(fresh.columnValues[colId('client')], undefined);
});

clientTest("another workspace's client board is refused", async () => {
  const task = await newRow({ name: 'INV-302' });
  const res = await put(task, {
    columnValues: { [colId('client')]: { boardId: String(foreign._id), name: 'x' } },
  });
  assert.equal(res.statusCode, 400);
});

clientTest('an id that names no board at all is refused', async () => {
  const task = await newRow({ name: 'INV-303' });
  const res = await put(task, {
    columnValues: { [colId('client')]: { boardId: String(new mongoose.Types.ObjectId()), name: 'x' } },
  });
  assert.equal(res.statusCode, 400);
});

clientTest('a malformed board id is the column type\'s field error', async () => {
  const task = await newRow({ name: 'INV-304' });
  const res = await put(task, {
    columnValues: { [colId('client')]: { boardId: 'not-an-id', name: 'x' } },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(Array.isArray(res.body.errors), JSON.stringify(res.body));
});

clientTest('a client typed in with no board is kept as typed', async () => {
  const task = await newRow({ name: 'INV-305' });
  const res = await put(task, {
    columnValues: { [colId('client')]: { boardId: null, name: '  Walk-in   Customer ' } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.deepStrictEqual(fresh.columnValues[colId('client')], { boardId: null, name: 'Walk-in Customer' });
});

clientTest('a private client board the writer cannot open is refused', async () => {
  // Milo may edit his own row, but cannot open Hidden Co's board — its name
  // must not reach a board he can read through his own cell.
  const task = await newRow({ name: 'INV-306', createdBy: member._id });
  const res = await put(
    task,
    { columnValues: { [colId('client')]: { boardId: String(hidden._id), name: 'x' } } },
    member
  );
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
});

clientTest('a client board the cell already names is not re-judged, and keeps its snapshot', async () => {
  const task = await newRow({
    name: 'INV-307',
    client: { boardId: String(acme._id), name: 'Acme Corp' },
  });
  // Acme's board stops being a client board after the invoice was filed.
  await Board.updateOne({ _id: acme._id }, { $set: { boardType: 'standard' } });
  try {
    const res = await put(task, {
      columnValues: {
        [colId('client')]: { boardId: String(acme._id), name: 'Renamed By Request' },
        [colId('amount')]: 10,
      },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const fresh = await Task.findById(task._id).lean();
    assert.equal(fresh.columnValues[colId('client')].name, 'Acme Corp', 'the old snapshot, not the request');
    assert.equal(fresh.columnValues[colId('amount')], 10, 'and the rest of the write landed');
  } finally {
    await Board.updateOne({ _id: acme._id }, { $set: { boardType: 'client' } });
  }
});

clientTest('create stamps the client board\'s name too', async () => {
  const res = await call(createTask, {
    body: {
      name: 'INV-308',
      board: String(ledger._id),
      group: String(group._id),
      columnValues: { [colId('client')]: { boardId: String(acme._id), name: '' } },
    },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const fresh = await Task.findById(res.body.task._id).lean();
  assert.equal(fresh.columnValues[colId('client')].name, 'Acme Corp');
});

// ---------------------------------------------------------------------------
// Activity wording (pure)
// ---------------------------------------------------------------------------

const clientRow = (oldValue, newValue) => ({
  type: 'task.field_changed',
  field: 'column:client',
  oldValue,
  newValue,
  metadata: { taskName: 'INV-1', columnLabel: 'Client', columnType: 'client' },
  actor: { name: 'Aneesh' },
});

test('a Client cell reads as set, changed and cleared', () => {
  const acmeV = { boardId: 'a'.repeat(24), name: 'Acme' };
  const betaV = { boardId: null, name: 'Beta Ltd' };
  assert.equal(describeActivity(clientRow(null, acmeV)), 'Aneesh set Client to Acme.');
  assert.equal(describeActivity(clientRow(acmeV, betaV)), 'Aneesh changed Client from Acme to Beta Ltd.');
  assert.equal(describeActivity(clientRow(acmeV, null)), 'Aneesh cleared Client (was Acme).');
});

test('a status the payments settled says so', () => {
  const text = describeActivity({
    type: 'task.field_changed',
    field: 'status',
    oldValue: { id: 's', name: 'Sent' },
    newValue: { id: 'p', name: 'Paid' },
    metadata: { taskName: 'INV-1', settledBy: 'payments' },
    actor: { name: 'Aneesh' },
  });
  assert.equal(text, 'Aneesh changed status from Sent to Paid (payments cover the amount).');
});

// ---------------------------------------------------------------------------
// The told stamp on a posted update
// ---------------------------------------------------------------------------

test('an update that mentions someone hands back the task\'s told stamp', async () => {
  const task = await newRow({ name: 'INV-400' });
  const res = await call(addUpdate, {
    params: { taskId: String(task._id) },
    body: { bodyText: 'Sent this over', mentions: [String(other._id)] },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.ok(res.body.update, 'the update itself is still there');
  assert.ok(res.body.task, 'and the stamp rides along');
  assert.equal(String(res.body.task._id), String(task._id));
  assert.equal(res.body.task.notifiedUsers.length, 1);
  const told = res.body.task.notifiedUsers[0];
  assert.equal(String(told._id), String(other._id));
  assert.equal(told.name, 'Ola P');
  assert.equal(told.email, 'ola@example.com');
  assert.ok('profilePic' in told && 'avatar' in told);
  assert.ok(res.body.task.notifiedAt, 'with when');

  // A second post naming somebody else MERGES — the tile shows everyone told.
  const again = await call(addUpdate, {
    params: { taskId: String(task._id) },
    body: { bodyText: 'Chasing', mentions: [String(member._id)] },
  });
  assert.deepStrictEqual(
    again.body.task.notifiedUsers.map((u) => String(u._id)).sort(),
    [String(other._id), String(member._id)].sort()
  );
});

test('an update that mentions nobody carries no task', async () => {
  const task = await newRow({ name: 'INV-401' });
  const res = await call(addUpdate, {
    params: { taskId: String(task._id) },
    body: { bodyText: 'A note to self' },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.task, undefined);
});

// ---------------------------------------------------------------------------
// An update's attachments never name somebody else's file
// ---------------------------------------------------------------------------

test("an update cannot carry — and so cannot destroy — an asset it did not upload", async () => {
  /**
   * THE BUG: an attachment's `publicId` was stored straight from the request
   * body, and deleting or editing the update destroyed it with the account's
   * secret. Anyone who may comment could name an invoice PDF they had seen a
   * URL for (`macan/board-files/<board>/…`), delete the update, and have the
   * server destroy the invoice.
   */
  const destroyed = [];
  const originalDestroy = cloudinary.uploader.destroy;
  cloudinary.uploader.destroy = async (publicId) => {
    destroyed.push(publicId);
    return { result: 'ok' };
  };
  try {
    const task = await newRow({ name: 'INV-402' });
    const invoice = `macan/board-files/${String(ledger._id)}/ab12-INV`;
    const posted = await call(addUpdate, {
      params: { taskId: String(task._id) },
      body: {
        bodyText: 'see attached',
        attachments: [
          { url: 'https://x.example/a', mime: 'application/pdf', publicId: invoice },
          { url: 'https://x.example/b', publicId: 'macan/updates/../avatars/me' },
          { url: 'https://x.example/c', publicId: 'macan/updates/1726-notes' },
        ],
      },
    });
    assert.equal(posted.statusCode, 201, JSON.stringify(posted.body));
    const stored = await Update.findById(posted.body.update._id).lean();
    assert.deepStrictEqual(stored.attachments.map((a) => a.publicId), ['', '', 'macan/updates/1726-notes']);

    // An edit may keep what the update already holds, but not add a plant.
    const edited = await call(editUpdate, {
      params: { taskId: String(task._id), id: String(stored._id) },
      body: {
        bodyText: 'see attached',
        attachments: [
          { url: 'https://x.example/c', publicId: 'macan/updates/1726-notes' },
          { url: 'https://x.example/a', publicId: invoice },
        ],
      },
    });
    assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
    const after = await Update.findById(stored._id).lean();
    assert.deepStrictEqual(after.attachments.map((a) => a.publicId), ['macan/updates/1726-notes', '']);

    const gone = await call(deleteUpdate, { params: { taskId: String(task._id), id: String(stored._id) } });
    assert.ok(gone.statusCode < 300, JSON.stringify(gone.body));
    assert.ok(!destroyed.includes(invoice), JSON.stringify(destroyed));
    assert.deepStrictEqual(destroyed, ['macan/updates/1726-notes']);
  } finally {
    cloudinary.uploader.destroy = originalDestroy;
  }
});

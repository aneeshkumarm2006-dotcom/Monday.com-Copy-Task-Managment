/**
 * taskColumnSync.test.js — a task's CELLS and its FIELDS, against a real
 * (throwaway, in-memory) MongoDB.
 *
 * Run from server/:   node --test src/controllers/taskColumnSync.test.js
 *
 * The bugs this pins all lived BELOW the controller, in the save hook and in
 * Mongoose's change tracking, which is why it is not a stubbed unit test:
 *
 *   - a billing board's `due` / `owner` columns never reached `task.dueDate` /
 *     `task.assignedTo`, so the Due and Owner filters, My Work and the due
 *     digest never saw an invoice's due date or owner;
 *   - the obvious fix to that reverts every panel edit of the due date on the
 *     way to the database, because the hook treated the old cell as the truth;
 *   - the primary "Invoice" cell and `task.name` were two unrelated values;
 *   - a new row and its PDF cell took two requests, so a failed second one
 *     left an invoice with no invoice;
 *   - column edits logged with no label or type, so history read
 *     'updated "a column"';
 *   - an invoice's PDF, living in a file cell, survived the invoice;
 *   - the no-op check compared lists of RECORDS by `toString()`, so any two
 *     file or payment lists of the same length were "equal": swapping one PDF
 *     for another, or correcting a payment in place, was dropped with a 200;
 *   - linking or unlinking a connect item marked the WHOLE cell map modified,
 *     so the save hook took the empty Due / Owner cells' side and wiped the
 *     row's due date and assignees.
 *
 * Nothing here reaches the network: nodemailer and Cloudinary's destroy are
 * swapped for recorders before the controller is loaded.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

// Before anything requires emailService, whose transporter is built at load.
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: 'test' }) });

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

require('../models');
const Task = mongoose.model('Task');
const Board = mongoose.model('Board');
const TaskGroup = mongoose.model('TaskGroup');
const User = mongoose.model('User');
const Organisation = mongoose.model('Organisation');
const ActivityLog = require('../models/ActivityLog');
const { cloudinary } = require('../config/cloudinary');
const { createTask, updateTask, deleteTask, columnValuesEqual } = require('./taskController');
const { linkTask, unlinkTask } = require('./linkController');

let mongod;
// A second board in the workspace, and a row on it, for the Client connect
// column to link to.
let clientsBoard;
let clientRow;
let owner;
// A `contribute` member of the (public) board — may claim rows, not hand them out.
let member;
// A second workspace member, whose name sits in cells the panel never showed.
let other;
// Somebody from outside the workspace entirely.
let outsider;
let org;
let board;
let group;
let destroyed = [];
const originalDestroy = cloudinary.uploader.destroy;

const colId = (key) => String(board.columns.find((c) => c.key === key)._id);

/**
 * A public id in this board's own file folder — the only place cleanup may
 * destroy from (utils/fileColumnAssets.js; `POST /api/boards/:id/files`
 * uploads there). An id anywhere else is never destroyed on a row's behalf.
 */
const bf = (name) => `macan/board-files/${String(board._id)}/${name}`;

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

/** `logActivity` and the post-save destroy are fire-and-forget: wait them out. */
const settle = async (check, tries = 40) => {
  for (let i = 0; i < tries; i += 1) {
    const out = await check();
    if (out) return out;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
};

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  cloudinary.uploader.destroy = async (publicId, opts) => {
    destroyed.push({ publicId, resourceType: opts && opts.resource_type });
    return { result: 'ok' };
  };

  owner = await User.create({ name: 'Nora C', email: 'nora@example.com', googleId: 'g-nora' });
  member = await User.create({ name: 'Milo K', email: 'milo@example.com', googleId: 'g-milo' });
  other = await User.create({ name: 'Ola P', email: 'ola@example.com', googleId: 'g-ola' });
  outsider = await User.create({ name: 'Xan Q', email: 'xan@example.com', googleId: 'g-xan' });
  org = await Organisation.create({
    name: 'Davnoot',
    admin: owner._id,
    members: [owner._id, member._id, other._id],
    inviteCode: 'task-column-sync',
    baseCurrency: 'INR',
  });
  org.ensureSystemRoles();
  await org.save();
  await User.updateMany(
    { _id: { $in: [owner._id, member._id, other._id] } },
    { $set: { organisations: [org._id] } }
  );

  // A billing board as one created BEFORE templates carried roles: its Due and
  // Owner columns say nothing about themselves, so the role has to come from
  // the template the board was made from.
  board = await Board.create({
    name: 'Billing',
    organisation: org._id,
    createdBy: owner._id,
    visibility: 'public',
    // The default, spelled out: a plain member stands on `contribute` here.
    publicDefaultLevel: 'contribute',
    useFlexibleColumns: true,
    templateKey: 'billing',
    statuses: [
      { key: 'unpaid', name: 'Unpaid', order: 0, isDefault: true },
      { key: 'paid', name: 'Paid', order: 1 },
    ],
    columns: [
      { key: 'invoice', name: 'Invoice', type: 'text', isPrimary: true },
      { key: 'pdf', name: 'PDF', type: 'file' },
      { key: 'amount', name: 'Amount', type: 'number', settings: { format: 'currency', currency: 'CAD', summary: 'sum' } },
      // No status here is keyed 'done', so recording payments never settles a
      // row on this board — the auto-Paid path has its own board in
      // taskWritePath.test.js.
      { key: 'payments', name: 'Payments', type: 'payments', settings: { format: 'currency', currency: 'CAD', summary: 'sum' } },
      { key: 'issued', name: 'Issued', type: 'date' },
      { key: 'due', name: 'Due', type: 'date' },
      { key: 'owner', name: 'Owner', type: 'person' },
      { key: 'client', name: 'Client', type: 'connect_boards' },
    ],
  });
  group = await TaskGroup.create({ name: 'Invoices', board: board._id });

  clientsBoard = await Board.create({
    name: 'Clients',
    organisation: org._id,
    createdBy: owner._id,
    visibility: 'public',
    useFlexibleColumns: true,
    columns: [{ key: 'name', name: 'Name', type: 'text', isPrimary: true }],
  });
  const clientsGroup = await TaskGroup.create({ name: 'Active', board: clientsBoard._id });
  clientRow = await Task.create({ name: 'Acme', board: clientsBoard._id, group: clientsGroup._id });
});

after(async () => {
  cloudinary.uploader.destroy = originalDestroy;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => {
  destroyed = [];
});

const newTask = (extra = {}) =>
  new Task({ name: 'INV-1', board: board._id, group: group._id, ...extra }).save();

// ---------------------------------------------------------------------------
// Roles: the Due / Owner cells and the legacy fields
// ---------------------------------------------------------------------------

test('the save hook copies a billing Due / Owner cell onto dueDate / assignedTo', async () => {
  const due = '2026-09-01T00:00:00.000Z';
  const task = await newTask({
    columnValues: { [colId('due')]: due, [colId('owner')]: [String(owner._id)] },
  });
  const fresh = await Task.findById(task._id).lean();
  assert.equal(new Date(fresh.dueDate).toISOString(), due);
  assert.deepStrictEqual(fresh.assignedTo.map(String), [String(owner._id)]);
});

test('the Issued date is NOT mistaken for the due date', async () => {
  const task = await newTask({ columnValues: { [colId('issued')]: '2026-08-01T00:00:00.000Z' } });
  const fresh = await Task.findById(task._id).lean();
  assert.equal(fresh.dueDate, undefined);
});

test('updateTask { dueDate } writes the Due cell, and the hook does not revert it', async () => {
  const task = await newTask({ columnValues: { [colId('due')]: '2026-09-01T00:00:00.000Z' } });
  const next = '2026-09-20T00:00:00.000Z';

  const res = await call(updateTask, { params: { id: String(task._id) }, body: { dueDate: next } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const fresh = await Task.findById(task._id).lean();
  assert.equal(new Date(fresh.dueDate).toISOString(), next, 'the field kept the panel\'s date');
  assert.equal(fresh.columnValues[colId('due')], next, 'the ledger\'s cell followed it');

  // A later save of something unrelated must not drag either side back.
  await call(updateTask, { params: { id: String(task._id) }, body: { note: 'chased' } });
  const later = await Task.findById(task._id).lean();
  assert.equal(new Date(later.dueDate).toISOString(), next);
  assert.equal(later.columnValues[colId('due')], next);
});

test('clearing the due date from the panel clears the cell too', async () => {
  const task = await newTask({ columnValues: { [colId('due')]: '2026-09-01T00:00:00.000Z' } });
  const res = await call(updateTask, { params: { id: String(task._id) }, body: { dueDate: null } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.equal(fresh.dueDate, undefined);
  assert.equal(fresh.columnValues[colId('due')], null);
});

test('updateTask { assignedTo } writes the Owner cell', async () => {
  const task = await newTask();
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { assignedTo: [String(owner._id)] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.deepStrictEqual(fresh.columnValues[colId('owner')], [String(owner._id)]);
  assert.deepStrictEqual(fresh.assignedTo.map(String), [String(owner._id)]);
});

test('a Due cell written from the Table reaches the field', async () => {
  const task = await newTask();
  const due = '2026-10-05T00:00:00.000Z';
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('due')]: due } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.equal(new Date(fresh.dueDate).toISOString(), due);
});

test('a row whose field and cell disagree is filled, never erased, by a passive save', async () => {
  // Written before roles existed: the panel set the field, the cell is empty.
  // It has SOME cell (every billing row does — its title, its PDF); a row with
  // none at all is skipped by the hook's no-columns bail-out on purpose.
  const task = await newTask({ columnValues: { [colId('invoice')]: 'INV-1' } });
  const due = new Date('2026-07-07T00:00:00.000Z');
  await Task.updateOne({ _id: task._id }, { $set: { dueDate: due } });

  const res = await call(updateTask, { params: { id: String(task._id) }, body: { note: 'x' } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.equal(new Date(fresh.dueDate).toISOString(), due.toISOString(), 'the date survived');
  assert.equal(fresh.columnValues[colId('due')], due.toISOString(), 'and the empty cell was filled');
});

test('a passive status save does not re-date or reassign a row whose field and cell disagree', async () => {
  // Both sides hold something, and they differ: the Due cell says one date and
  // the panel set another; the Owner cell names one person and `assignedTo`
  // another. Ticking the invoice Paid is not a decision about either — the
  // hook used to let the cell win on every save, so it silently moved the due
  // date and handed the row to somebody else.
  const cellDue = '2026-09-01T00:00:00.000Z';
  const task = await newTask({
    columnValues: { [colId('due')]: cellDue, [colId('owner')]: [String(owner._id)] },
  });
  const fieldDue = new Date('2026-10-15T00:00:00.000Z');
  await Task.updateOne(
    { _id: task._id },
    { $set: { dueDate: fieldDue, assignedTo: [other._id] } }
  );

  const paid = board.statuses.find((st) => st.key === 'paid');
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { status: String(paid._id) },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const fresh = await Task.findById(task._id).lean();
  assert.equal(String(fresh.status), String(paid._id), 'the status did change');
  assert.equal(new Date(fresh.dueDate).toISOString(), fieldDue.toISOString(), 'the due date was not moved');
  assert.deepStrictEqual(fresh.assignedTo.map(String), [String(other._id)], 'the row was not reassigned');
  assert.equal(fresh.columnValues[colId('due')], cellDue, 'nor was the Due cell');
  assert.deepStrictEqual(fresh.columnValues[colId('owner')], [String(owner._id)], 'nor the Owner cell');
});

// ---------------------------------------------------------------------------
// Claiming a row whose Owner cell names people the panel never showed
// ---------------------------------------------------------------------------

/**
 * A row whose Owner cell says [Nora, Ola] while `assignedTo` — what the panel
 * shows — says only [Nora]. Written straight to the database, the way rows
 * from before the two were kept in step look.
 */
const rowWithUnseenOwner = async () => {
  const task = await newTask({ columnValues: { [colId('invoice')]: 'INV-U' } });
  await Task.updateOne(
    { _id: task._id },
    {
      $set: {
        assignedTo: [owner._id],
        [`columnValues.${colId('owner')}`]: [String(owner._id), String(other._id)],
      },
    }
  );
  return task;
};

test('a contributor claiming a row MERGES into an Owner cell holding names they never saw', async () => {
  // The panel sends what it showed plus the claimer. Refusing that with a 403
  // (because Ola would be "dropped") meant the row could not be claimed at
  // all; overwriting would take Ola off the work. Neither is right.
  const task = await rowWithUnseenOwner();
  const res = await call(updateTask, {
    as: member,
    params: { id: String(task._id) },
    body: { assignedTo: [String(owner._id), String(member._id)] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const fresh = await Task.findById(task._id).lean();
  const expected = [String(owner._id), String(other._id), String(member._id)].sort();
  assert.deepStrictEqual([...fresh.columnValues[colId('owner')]].sort(), expected, 'Ola kept her place');
  assert.deepStrictEqual(fresh.assignedTo.map(String).sort(), expected, 'and the field agrees with the cell');
});

test('a contributor un-claiming merges too: only their own name leaves the cell', async () => {
  const task = await rowWithUnseenOwner();
  await Task.updateOne(
    { _id: task._id },
    {
      $set: {
        assignedTo: [owner._id, member._id],
        [`columnValues.${colId('owner')}`]: [String(owner._id), String(other._id), String(member._id)],
      },
    }
  );
  const res = await call(updateTask, {
    as: member,
    params: { id: String(task._id) },
    body: { assignedTo: [String(owner._id)] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.deepStrictEqual(
    [...fresh.columnValues[colId('owner')]].sort(),
    [String(owner._id), String(other._id)].sort()
  );
});

test("an editor's explicit assignedTo still REPLACES the Owner cell", async () => {
  // Holding `task.assign`, their list is an instruction about who is on the
  // row — dropping a name is a power they have.
  const task = await rowWithUnseenOwner();
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { assignedTo: [String(owner._id)] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.deepStrictEqual(fresh.columnValues[colId('owner')], [String(owner._id)]);
  assert.deepStrictEqual(fresh.assignedTo.map(String), [String(owner._id)]);
});

// ---------------------------------------------------------------------------
// Who may be written into a person cell
// ---------------------------------------------------------------------------

test('a person cell refuses someone from outside the workspace, on update', async () => {
  // The Owner cell is copied onto `assignedTo`, so it must answer the same
  // question `assignedTo` does — a member who can read the board — or it hands
  // the row (and its notification) to anybody with an id.
  const task = await newTask({ columnValues: { [colId('owner')]: [String(owner._id)] } });
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('owner')]: [String(owner._id), String(outsider._id)] } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Assignee is not a member of this workspace');
  const fresh = await Task.findById(task._id).lean();
  assert.deepStrictEqual(fresh.columnValues[colId('owner')], [String(owner._id)]);
  assert.deepStrictEqual(fresh.assignedTo.map(String), [String(owner._id)]);
});

test('a person cell refuses someone from outside the workspace, on create', async () => {
  const before = await Task.countDocuments({ board: board._id });
  const res = await call(createTask, {
    body: {
      name: 'INV-OUT',
      board: String(board._id),
      group: String(group._id),
      columnValues: { [colId('owner')]: [String(outsider._id)] },
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Assignee is not a member of this workspace');
  assert.equal(await Task.countDocuments({ board: board._id }), before);
});

test('a name already in a person cell is not re-judged by an edit that keeps or removes it', async () => {
  // Somebody who has since left the workspace must not make the cell
  // unwritable — least of all by the edit that takes them out.
  const task = await newTask({ columnValues: { [colId('invoice')]: 'INV-GONE' } });
  await Task.updateOne(
    { _id: task._id },
    { $set: { [`columnValues.${colId('owner')}`]: [String(outsider._id), String(owner._id)] } }
  );
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('owner')]: [String(owner._id)] } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.deepStrictEqual(fresh.columnValues[colId('owner')], [String(owner._id)]);
});

test('a workspace member who can read the board may be written into a person cell', async () => {
  const res = await call(createTask, {
    body: {
      name: 'INV-OK',
      board: String(board._id),
      group: String(group._id),
      columnValues: { [colId('owner')]: [String(member._id)] },
    },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const fresh = await Task.findById(res.body.task._id).lean();
  assert.deepStrictEqual(fresh.assignedTo.map(String), [String(member._id)]);
});

// ---------------------------------------------------------------------------
// Primary column <-> task.name
// ---------------------------------------------------------------------------

test('writing the primary cell renames the task, logged once as a rename', async () => {
  const task = await newTask({ name: 'INV-2026-012 Kredoo' });
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('invoice')]: '  INV-2026-012  ' } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.task.name, 'INV-2026-012');

  const rows = await settle(async () => {
    const found = await ActivityLog.find({ task: task._id, type: 'task.field_changed' }).lean();
    return found.length ? found : null;
  });
  assert.deepStrictEqual(rows.map((r) => r.field), ['name']);
  assert.equal(rows[0].newValue, 'INV-2026-012');
});

test('an empty primary cell is refused and the title is untouched', async () => {
  const task = await newTask({ name: 'INV-7' });
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('invoice')]: '   ' } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "The title can't be empty");
  const fresh = await Task.findById(task._id).lean();
  assert.equal(fresh.name, 'INV-7');
});

test('a rename from the panel reaches the primary cell', async () => {
  const task = await newTask({ name: 'INV-8' });
  const res = await call(updateTask, { params: { id: String(task._id) }, body: { name: 'INV-8b' } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const fresh = await Task.findById(task._id).lean();
  assert.equal(fresh.columnValues[colId('invoice')], 'INV-8b');
});

// ---------------------------------------------------------------------------
// createTask with columnValues
// ---------------------------------------------------------------------------

test('createTask writes the row and its file cell in ONE save', async () => {
  const stored = {
    url: `https://res.cloudinary.com/demo/raw/upload/v1726000000/${bf('1726000000-INV-12')}`,
    name: 'INV-12.pdf',
    mime: 'application/pdf',
    size: 1234,
    publicId: bf('1726000000-INV-12'),
  };
  const saves = [];
  const originalSave = Task.prototype.save;
  Task.prototype.save = function countedSave(...args) {
    saves.push(this.isNew ? 'insert' : 'update');
    return originalSave.apply(this, args);
  };
  let res;
  try {
    res = await call(createTask, {
      body: {
        name: 'INV-12',
        board: String(board._id),
        group: String(group._id),
        columnValues: { [colId('pdf')]: [stored], [colId('amount')]: 1500 },
      },
    });
  } finally {
    Task.prototype.save = originalSave;
  }
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepStrictEqual(saves, ['insert'], 'one insert, no follow-up write');

  const fresh = await Task.findById(res.body.task._id).lean();
  assert.equal(fresh.columnValues[colId('pdf')][0].publicId, stored.publicId);
  assert.equal(fresh.columnValues[colId('amount')], 1500);
  assert.equal(fresh.columnValues[colId('invoice')], 'INV-12', 'the title cell starts as the name');
});

test('a bad cell on create is a 400 and leaves no row behind', async () => {
  const before = await Task.countDocuments({ board: board._id });
  const res = await call(createTask, {
    body: {
      name: 'INV-13',
      board: String(board._id),
      group: String(group._id),
      columnValues: { [colId('amount')]: 'not a number' },
    },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(Array.isArray(res.body.errors));
  assert.equal(await Task.countDocuments({ board: board._id }), before);
});

test('createTask with a due date fills the Due cell', async () => {
  const due = '2026-11-30T00:00:00.000Z';
  const res = await call(createTask, {
    body: { name: 'INV-14', board: String(board._id), group: String(group._id), dueDate: due },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const fresh = await Task.findById(res.body.task._id).lean();
  assert.equal(fresh.columnValues[colId('due')], due);
  assert.equal(new Date(fresh.dueDate).toISOString(), due);
});

// ---------------------------------------------------------------------------
// Activity metadata
// ---------------------------------------------------------------------------

test('a column edit logs its label, type and currency', async () => {
  const task = await newTask({ name: 'INV-20' });
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('amount')]: 12000 } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const row = await settle(() =>
    ActivityLog.findOne({ task: task._id, field: 'column:amount' }).lean()
  );
  assert.ok(row, 'an activity row was written');
  assert.equal(row.metadata.taskName, 'INV-20');
  assert.equal(row.metadata.columnLabel, 'Amount');
  assert.equal(row.metadata.columnType, 'number');
  assert.equal(row.metadata.currency, 'CAD');
  assert.equal(row.newValue, 12000);
});

// ---------------------------------------------------------------------------
// File-column cleanup
// ---------------------------------------------------------------------------

test('deleting a task destroys the file in its file cell', async () => {
  const task = await newTask({
    columnValues: {
      [colId('pdf')]: [{
        url: `https://res.cloudinary.com/demo/raw/upload/v1/${bf('1-INV')}`,
        name: 'INV.pdf',
        mime: 'application/pdf',
        publicId: bf('1-INV'),
      }],
    },
  });
  const res = await call(deleteTask, { params: { id: String(task._id) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(
    destroyed.some((d) => d.publicId === bf('1-INV') && d.resourceType === 'raw'),
    JSON.stringify(destroyed)
  );
});

test('replacing a file cell destroys the old file, after the save, unless the task still holds it', async () => {
  const old = {
    url: `https://res.cloudinary.com/demo/raw/upload/v1/${bf('2-OLD')}`,
    name: 'OLD.pdf',
    mime: 'application/pdf',
    publicId: bf('2-OLD'),
  };
  const kept = {
    url: `https://res.cloudinary.com/demo/raw/upload/v1/${bf('3-KEPT')}`,
    name: 'KEPT.pdf',
    mime: 'application/pdf',
    publicId: bf('3-KEPT'),
  };
  const task = await newTask({
    columnValues: { [colId('pdf')]: [old, kept] },
    // The same asset is also in the Files tab — dropping it from the cell must
    // not destroy a file the task still shows.
    attachments: [{ url: kept.url, name: kept.name, mime: kept.mime, publicId: kept.publicId, source: 'team' }],
  });
  const replacement = {
    url: `https://res.cloudinary.com/demo/raw/upload/v1/${bf('4-NEW')}`,
    name: 'NEW.pdf',
    mime: 'application/pdf',
    publicId: bf('4-NEW'),
  };
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('pdf')]: [replacement] } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const gone = await settle(() =>
    destroyed.find((d) => d.publicId === bf('2-OLD')) || null
  );
  assert.ok(gone, 'the replaced file was destroyed');
  assert.ok(!destroyed.some((d) => d.publicId === bf('3-KEPT')), 'the file still attached was kept');
  assert.ok(!destroyed.some((d) => d.publicId === bf('4-NEW')));
});

test('a refused edit destroys nothing', async () => {
  const old = {
    url: `https://res.cloudinary.com/demo/raw/upload/v1/${bf('5-OLD')}`,
    name: 'OLD.pdf',
    mime: 'application/pdf',
    publicId: bf('5-OLD'),
  };
  const task = await newTask({ name: 'INV-30', columnValues: { [colId('pdf')]: [old] } });
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    // The file write is fine; the empty title is not, so nothing may land.
    body: { columnValues: { [colId('pdf')]: [], [colId('invoice')]: '' } },
  });
  assert.equal(res.statusCode, 400);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(destroyed.length, 0);
  const fresh = await Task.findById(task._id).lean();
  assert.equal(fresh.columnValues[colId('pdf')].length, 1);
});

test("a member who plants a colleague's file id on their own row and clears it destroys nothing", async () => {
  /**
   * THE BUG: the board prefix scopes a destroy to a BOARD, not a row, and every
   * reader sees every row's ids. A `contribute` member — who may edit only
   * their own rows — copied a colleague's invoice id into their own PDF cell,
   * cleared it, and the server destroyed her PDF while her row still linked it.
   */
  const victimFile = {
    url: `https://res.cloudinary.com/demo/raw/upload/v1/${bf('8-VICTIM')}`,
    name: 'VICTIM.pdf',
    mime: 'application/pdf',
    publicId: bf('8-VICTIM'),
  };
  await newTask({ name: 'INV-40', createdBy: owner._id, columnValues: { [colId('pdf')]: [victimFile] } });
  const mine = await newTask({ name: 'INV-41', createdBy: member._id });

  const plant = await call(updateTask, {
    params: { id: String(mine._id) },
    body: { columnValues: { [colId('pdf')]: [victimFile] } },
    as: member,
  });
  assert.equal(plant.statusCode, 200, JSON.stringify(plant.body));
  const clear = await call(updateTask, {
    params: { id: String(mine._id) },
    body: { columnValues: { [colId('pdf')]: [] } },
    as: member,
  });
  assert.equal(clear.statusCode, 200, JSON.stringify(clear.body));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!destroyed.some((d) => d.publicId === bf('8-VICTIM')), JSON.stringify(destroyed));
});

test('deleting one of two rows that share a file keeps the file the other still links', async () => {
  // The innocent way in: the ledger drop's Retry reuses a stored upload, so a
  // create that landed despite a failed reply leaves two rows on one id.
  const shared = {
    url: `https://res.cloudinary.com/demo/raw/upload/v1/${bf('9-SHARED')}`,
    name: 'SHARED.pdf',
    mime: 'application/pdf',
    publicId: bf('9-SHARED'),
  };
  const first = await newTask({ name: 'INV-42', columnValues: { [colId('pdf')]: [shared] } });
  const second = await newTask({ name: 'INV-43', columnValues: { [colId('pdf')]: [shared] } });

  const res = await call(deleteTask, { params: { id: String(first._id) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(!destroyed.some((d) => d.publicId === bf('9-SHARED')), 'a file another row links was destroyed');

  // Once nothing else holds it, it goes.
  const last = await call(deleteTask, { params: { id: String(second._id) } });
  assert.equal(last.statusCode, 200, JSON.stringify(last.body));
  assert.ok(destroyed.some((d) => d.publicId === bf('9-SHARED')), JSON.stringify(destroyed));
});

// ---------------------------------------------------------------------------
// The no-op check: record lists in order, id lists as sets
// ---------------------------------------------------------------------------

test('columnValuesEqual: two same-length lists of different records are NOT equal', () => {
  const fileA = [{ url: 'https://res.cloudinary.com/demo/raw/upload/v1/a', name: 'A.pdf', publicId: 'a' }];
  const fileB = [{ url: 'https://res.cloudinary.com/demo/raw/upload/v1/b', name: 'B.pdf', publicId: 'b' }];
  assert.equal(columnValuesEqual(fileA, fileB), false, '[fileA] vs [fileB]');

  const before = [{ id: 'p1', amount: 100, date: '2026-09-01' }];
  const after = [{ id: 'p1', amount: 250, date: '2026-09-10' }];
  assert.equal(columnValuesEqual(before, after), false, 'a payment edited in place');

  // …while the same records ARE equal, even as separate objects.
  assert.equal(columnValuesEqual(before, [{ ...before[0] }]), true);
  assert.equal(columnValuesEqual(fileA, [{ ...fileA[0] }]), true);
});

test('columnValuesEqual: a record list is a LIST, so reordering it is a change', () => {
  const a = { id: 'a', amount: 1, date: '2026-09-01' };
  const b = { id: 'b', amount: 2, date: '2026-09-02' };
  assert.equal(columnValuesEqual([a, b], [b, a]), false);
});

test('columnValuesEqual: id lists are still a SET, order means nothing', () => {
  const x = new mongoose.Types.ObjectId();
  const y = new mongoose.Types.ObjectId();
  assert.equal(columnValuesEqual([x, y], [String(y), String(x)]), true, 'people in another order');
  assert.equal(columnValuesEqual([String(x)], [String(y)]), false);
  assert.equal(columnValuesEqual(['opt-1', 'opt-2'], ['opt-2', 'opt-1']), true, 'tags in another order');
});

test('swapping one file for another (1 to 1) is stored and logged, not dropped', async () => {
  const old = {
    url: `https://res.cloudinary.com/demo/raw/upload/v1/${bf('6-OLD')}`,
    name: 'OLD.pdf',
    mime: 'application/pdf',
    publicId: bf('6-OLD'),
  };
  const replacement = {
    url: `https://res.cloudinary.com/demo/raw/upload/v1/${bf('7-NEW')}`,
    name: 'NEW.pdf',
    mime: 'application/pdf',
    publicId: bf('7-NEW'),
  };
  const task = await newTask({ name: 'INV-40', columnValues: { [colId('pdf')]: [old] } });
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('pdf')]: [replacement] } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const fresh = await Task.findById(task._id).lean();
  assert.equal(fresh.columnValues[colId('pdf')].length, 1);
  assert.equal(fresh.columnValues[colId('pdf')][0].url, replacement.url, 'the new file is stored');

  const row = await settle(() => ActivityLog.findOne({ task: task._id, field: 'column:pdf' }).lean());
  assert.ok(row, 'the swap was logged');
  assert.equal(row.metadata.columnType, 'file');

  // …and the file it replaced is cleaned up, which the dropped write never
  // reached.
  const gone = await settle(() => destroyed.find((d) => d.publicId === bf('6-OLD')) || null);
  assert.ok(gone, 'the replaced file was destroyed');
  assert.ok(!destroyed.some((d) => d.publicId === bf('7-NEW')));
});

test('a file cell naming an id outside this board\'s folder never destroys it', async () => {
  // A legacy task-attachment upload, or an id planted from another board: the
  // cell can let go of it, but the server may not delete it on this row's say.
  const foreign = {
    url: 'https://res.cloudinary.com/demo/raw/upload/v1/macan/tasks/8-LEGACY',
    name: 'LEGACY.pdf',
    mime: 'application/pdf',
    publicId: 'macan/tasks/8-LEGACY',
  };
  const task = await newTask({ name: 'INV-42', columnValues: { [colId('pdf')]: [foreign] } });
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('pdf')]: [] } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(destroyed.length, 0, JSON.stringify(destroyed));
  const fresh = await Task.findById(task._id).lean();
  assert.deepStrictEqual(fresh.columnValues[colId('pdf')], [], 'the cell itself was still cleared');
});

test('editing a payment in place (same count) is stored and logged, and a resend is a no-op', async () => {
  const task = await newTask({
    name: 'INV-41',
    columnValues: { [colId('payments')]: [{ id: 'p1', amount: 100, date: '2026-09-01' }] },
  });
  const res = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('payments')]: [{ id: 'p1', amount: 250, date: '2026-09-10' }] } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const fresh = await Task.findById(task._id).lean();
  const cell = fresh.columnValues[colId('payments')];
  assert.equal(cell.length, 1);
  assert.equal(cell[0].id, 'p1', 'the entry kept its id');
  assert.equal(cell[0].amount, 250);
  assert.equal(cell[0].date, '2026-09-10');

  const logged = await settle(async () => {
    const rows = await ActivityLog.find({ task: task._id, field: 'column:payments' }).lean();
    return rows.length ? rows : null;
  });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].newValue[0].amount, 250);

  // Sending back exactly what is stored changes nothing and logs nothing.
  const again = await call(updateTask, {
    params: { id: String(task._id) },
    body: { columnValues: { [colId('payments')]: cell } },
  });
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await ActivityLog.countDocuments({ task: task._id, field: 'column:payments' }), 1);
});

// ---------------------------------------------------------------------------
// Link / unlink write ONE cell, and must not look like they wrote the rest
// ---------------------------------------------------------------------------

/**
 * A row as rows from before roles existed look: the panel set the due date
 * and the assignee, while the Due and Owner cells hold an explicit null / [].
 */
const rowWithEmptyRoleCells = async (name) => {
  const task = await newTask({ name, columnValues: { [colId('invoice')]: name } });
  await Task.updateOne(
    { _id: task._id },
    {
      $set: {
        dueDate: new Date('2026-12-01T00:00:00.000Z'),
        assignedTo: [owner._id],
        [`columnValues.${colId('due')}`]: null,
        [`columnValues.${colId('owner')}`]: [],
      },
    }
  );
  return task;
};

test('linking a Client keeps the due date and owner of a row whose role cells are empty', async () => {
  const task = await rowWithEmptyRoleCells('INV-50');
  const res = await call(linkTask, {
    params: { id: String(task._id), columnId: colId('client') },
    body: { targetTaskId: String(clientRow._id), targetBoardId: String(clientsBoard._id) },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const fresh = await Task.findById(task._id).lean();
  assert.equal(fresh.columnValues[colId('client')].links.length, 1, 'the link landed');
  assert.equal(new Date(fresh.dueDate).toISOString(), '2026-12-01T00:00:00.000Z', 'the due date survived');
  assert.deepStrictEqual(fresh.assignedTo.map(String), [String(owner._id)], 'and so did the owner');
  // The save was passive for the role cells, so the hook FILLS them from the
  // fields rather than emptying the fields from them.
  assert.equal(fresh.columnValues[colId('due')], '2026-12-01T00:00:00.000Z');
  assert.deepStrictEqual(fresh.columnValues[colId('owner')], [String(owner._id)]);
});

test('unlinking a Client keeps them too', async () => {
  const task = await rowWithEmptyRoleCells('INV-51');
  await Task.updateOne(
    { _id: task._id },
    {
      $set: {
        [`columnValues.${colId('client')}`]: {
          links: [{ boardId: String(clientsBoard._id), taskId: String(clientRow._id) }],
        },
      },
    }
  );
  const res = await call(unlinkTask, {
    params: { id: String(task._id), columnId: colId('client'), targetTaskId: String(clientRow._id) },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const fresh = await Task.findById(task._id).lean();
  assert.equal(fresh.columnValues[colId('client')].links.length, 0, 'the link is gone');
  assert.equal(new Date(fresh.dueDate).toISOString(), '2026-12-01T00:00:00.000Z');
  assert.deepStrictEqual(fresh.assignedTo.map(String), [String(owner._id)]);
});

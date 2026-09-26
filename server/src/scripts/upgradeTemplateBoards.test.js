const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * The template-board upgrade, against a THROWAWAY in-memory MongoDB.
 *
 * A board is seeded in the shape the OLD billing template produced — no roles,
 * no Payments column, `decimals: 0` on Amount, opening on the table, an
 * unfillable connect-boards Client column, no board currency, the phantom 'USD'
 * on its Ads Budget add-on, rows with an empty title cell and a Due/Owner the
 * legacy fields never heard about — and the script is run over it: dry, then
 * for real, then again.
 *
 * The three runs are the point. A dry run that writes is a migration nobody can
 * safely preview; a real run that misses something leaves the board half old;
 * and a second run that finds work means the script cannot be re-run after a
 * partial failure, which is the one thing a migration must allow.
 *
 * The later tests pin each step's REFUSALS as hard as its changes — the linked
 * Client cell, the stranger in the Owner cell, the add-on somebody switched on —
 * because a migration's worst failure is the confident overwrite.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { SYSTEM_ROLES } = require('../utils/capabilities');
const { TEMPLATE_REVISION } = require('../utils/boardTemplates');

let mem;
let Board;
let Task;
let TaskGroup;
let Organisation;
let AdsBudget;
let BoardConnection;
let upgradeTemplateBoards;
let isEmptyConnectValue;

const quiet = () => {};

before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  require('../models');
  Board = mongoose.model('Board');
  Task = mongoose.model('Task');
  TaskGroup = mongoose.model('TaskGroup');
  Organisation = mongoose.model('Organisation');
  AdsBudget = mongoose.model('AdsBudget');
  BoardConnection = mongoose.model('BoardConnection');
  ({ upgradeTemplateBoards, isEmptyConnectValue } = require('./upgradeTemplateBoards'));
});

after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const oid = () => new mongoose.Types.ObjectId();

/** A workspace with the real system roles, so `resolveAccess` answers for real. */
const seedOrg = async ({ members = [], baseCurrency = 'INR' } = {}) =>
  Organisation.create({
    name: 'Old Co',
    admin: oid(),
    members,
    roles: SYSTEM_ROLES.map((r) => ({ ...r })),
    baseCurrency,
    inviteCode: `old-${new mongoose.Types.ObjectId()}`,
  });

/**
 * The billing board as the template made it before this change. Written with
 * `collection.insertOne` so no schema default (revision, currency) is filled in
 * for us — these documents are what the old code left behind.
 */
const seedOldBilling = async ({ visibility = 'public', boardExtra = {} } = {}) => {
  const person = oid();
  const org = await seedOrg({ members: [person] });
  const ids = {
    invoice: oid(), pdf: oid(), client: oid(), amount: oid(), issued: oid(), due: oid(), owner: oid(),
  };
  const boardId = oid();
  await Board.collection.insertOne({
    _id: boardId,
    name: 'Invoices',
    organisation: org._id,
    templateKey: 'billing',
    useFlexibleColumns: true,
    visibility,
    defaultView: 'table',
    currency: null,
    adsBudget: { enabled: false, currency: 'USD' },
    statuses: [],
    columns: [
      { _id: ids.invoice, key: 'invoice', name: 'Invoice', type: 'text', isPrimary: true, order: 0, settings: {} },
      { _id: ids.pdf, key: 'pdf', name: 'PDF', type: 'file', order: 1, settings: {} },
      { _id: ids.client, key: 'client', name: 'Client', type: 'connect_boards', order: 2, settings: { targetBoardIds: [], summary: 'filled' } },
      {
        _id: ids.amount, key: 'amount', name: 'Amount', type: 'number', order: 3,
        settings: { format: 'currency', currency: 'CAD', decimals: 0, summary: 'sum' },
      },
      { _id: ids.issued, key: 'issued', name: 'Issued', type: 'date', order: 4, settings: {} },
      { _id: ids.due, key: 'due', name: 'Due', type: 'date', order: 5, settings: {} },
      { _id: ids.owner, key: 'owner', name: 'Owner', type: 'person', order: 6, settings: {} },
    ],
    ...boardExtra,
  });
  const board = await Board.findById(boardId).lean();
  const group = await TaskGroup.create({ name: 'Invoices', board: board._id, order: 0 });
  const stranger = oid(); // an id no workspace has ever had as a member
  // Written with insertMany so no save hook fills anything in for us — these
  // rows are what the old code left behind.
  const [late, done] = await Task.insertMany([
    {
      name: 'INV-7',
      board: board._id,
      group: group._id,
      columnValues: {
        [String(ids.due)]: '2026-08-01T00:00:00.000Z',
        [String(ids.owner)]: [String(person), String(stranger)],
        [String(ids.client)]: { links: [] },
      },
    },
    {
      name: 'INV-8',
      board: board._id,
      group: group._id,
      dueDate: new Date('2026-07-01'),
      assignedTo: [oid()],
      columnValues: { [String(ids.invoice)]: 'INV-8 (typed)', [String(ids.due)]: '2026-09-30T00:00:00.000Z' },
    },
  ]);
  return { org, board, group, ids, late, done, person, stranger };
};

test('a dry run reports the work and writes nothing', async () => {
  const { board } = await seedOldBilling();
  const before = await Board.findById(board._id).lean();
  const summaries = await upgradeTemplateBoards({ boardId: board._id, log: quiet });
  assert.equal(summaries.length, 1);
  const s = summaries[0];
  assert.deepEqual(s.roles.sort(), ['due→dueDate', 'owner→assignee']);
  assert.equal(s.paymentsAdded, 'CAD');
  assert.equal(s.defaultView, 'ledger');
  assert.equal(s.clientConverted, true);
  assert.deepEqual(s.decimalsCleared, ['amount']);
  assert.equal(s.currencyPinned, 'CAD', 'the unit the board has been rendering in');
  assert.equal(s.titles, 1, 'only the row whose title cell is empty');
  assert.equal(s.dueDates, 1, 'only the row whose legacy dueDate is empty');
  assert.equal(s.owners, 1);
  assert.equal(s.ownersDropped, 1, 'the id that is not a member is not copied');
  assert.equal(s.adsBudgetCurrencyCleared, true);
  const afterDry = await Board.findById(board._id).lean();
  assert.deepEqual(afterDry, before, 'a dry run changed the board');
});

test('--apply brings an old billing board up to today, and a second run finds nothing', async () => {
  const { board, ids, late, done, person } = await seedOldBilling();
  await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet });

  const b = await Board.findById(board._id).lean();
  const byKey = Object.fromEntries(b.columns.map((c) => [c.key, c]));
  assert.equal(byKey.due.settings.role, 'dueDate');
  assert.equal(byKey.owner.settings.role, 'assignee');
  assert.equal(byKey.amount.settings.decimals, undefined);
  assert.equal(byKey.amount.settings.currency, 'CAD', 'money is never relabelled');
  assert.equal(b.defaultView, 'ledger');
  assert.equal(b.currency, 'CAD');
  assert.equal(b.templateRevision, TEMPLATE_REVISION);
  assert.equal(b.adsBudget.currency, null);
  assert.equal(b.updatedAt, undefined, 'a migration does not make the board look edited');

  // The Client column is now a client pick, keeping only its footer summary.
  assert.equal(byKey.client.type, 'client');
  assert.deepEqual(byKey.client.settings, { summary: 'filled' });
  assert.equal(String(byKey.client._id), String(ids.client), 'same column, not a new one');

  // Payments sits right after Amount, in Amount's currency; everything after shifted.
  const ordered = b.columns.slice().sort((x, y) => x.order - y.order).map((c) => c.key);
  assert.deepEqual(ordered, ['invoice', 'pdf', 'client', 'amount', 'payments', 'issued', 'due', 'owner']);
  assert.equal(byKey.payments.type, 'payments');
  assert.deepEqual(byKey.payments.settings, { format: 'currency', currency: 'CAD', summary: 'sum' });

  const t1 = await Task.findById(late._id).lean();
  assert.equal(t1.columnValues[String(ids.invoice)], 'INV-7');
  assert.equal(t1.dueDate.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.deepEqual(t1.assignedTo.map(String), [String(person)], 'only the workspace member');
  assert.equal(t1.columnValues[String(ids.owner)].length, 2, 'the cell itself is never rewritten');
  assert.equal(String(ids.client) in t1.columnValues, false, 'the empty connect value is cleared');
  assert.equal(t1.updatedAt.toISOString(), late.updatedAt.toISOString(), 'a backfill does not make the row look edited');

  // What was already there is left alone.
  const t2 = await Task.findById(done._id).lean();
  assert.equal(t2.columnValues[String(ids.invoice)], 'INV-8 (typed)');
  assert.equal(t2.dueDate.toISOString(), new Date('2026-07-01').toISOString());
  assert.equal(t2.assignedTo.length, 1);
  assert.notEqual(String(t2.assignedTo[0]), String(person));

  const again = await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet });
  assert.deepEqual(again, [], 'a second run should have nothing to do');
});

test('a re-run never puts back a column somebody deleted after the first', async () => {
  const { board } = await seedOldBilling();
  await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet });
  await Board.updateOne({ _id: board._id }, { $pull: { columns: { key: 'payments' } } });
  await Board.updateOne({ _id: board._id }, { $set: { defaultView: 'table' } });

  const again = await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet });
  assert.deepEqual(again, []);
  const b = await Board.findById(board._id).lean();
  assert.equal(b.columns.some((c) => c.type === 'payments'), false, 'the deleted Payments column came back');
  assert.equal(b.defaultView, 'table', 'a view chosen after the upgrade was overridden');
});

test('a board already at the current revision is skipped whole, and a dry run never stamps', async () => {
  // (Its add-on currency is not the legacy USD: that pass is deliberately not
  // revision-gated, and is tested on its own below.)
  const { board } = await seedOldBilling({
    boardExtra: { templateRevision: TEMPLATE_REVISION, adsBudget: { enabled: false, currency: null } },
  });
  assert.deepEqual(await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet }), []);
  const b = await Board.findById(board._id).lean();
  assert.equal(b.columns.some((c) => c.type === 'payments'), false);

  const { board: old } = await seedOldBilling({ boardExtra: { templateRevision: 1 } });
  await upgradeTemplateBoards({ boardId: old._id, log: quiet });
  assert.equal((await Board.findById(old._id).lean()).templateRevision, 1, 'a dry run stamped');
  const [s] = await upgradeTemplateBoards({ boardId: old._id, apply: true, log: quiet });
  assert.ok(s, 'a board at an OLDER revision is still upgraded');
  assert.equal((await Board.findById(old._id).lean()).templateRevision, TEMPLATE_REVISION);
});

test('a board with nothing to do is still stamped, so a later deletion sticks', async () => {
  const org = await seedOrg();
  const board = await Board.create({
    name: 'Blank flexible',
    organisation: org._id,
    useFlexibleColumns: true,
    currency: 'INR',
    columns: [{ key: 'title', name: 'Title', type: 'text', isPrimary: true, order: 0 }],
  });
  await Board.updateOne({ _id: board._id }, { $set: { templateRevision: 0 } });
  assert.deepEqual(await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet }), []);
  assert.equal((await Board.findById(board._id).lean()).templateRevision, TEMPLATE_REVISION);
});

test('a role another column already claims is not handed out twice', async () => {
  const { board, ids } = await seedOldBilling();
  const deadline = oid();
  await Board.updateOne(
    { _id: board._id },
    { $push: { columns: { _id: deadline, key: 'deadline', name: 'Deadline', type: 'date', order: 7, settings: { role: 'dueDate' } } } }
  );
  const [s] = await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet });
  assert.deepEqual(s.roles, ['owner→assignee']);
  const b = await Board.findById(board._id).lean();
  assert.equal(b.columns.find((c) => String(c._id) === String(ids.due)).settings?.role, undefined);
});

test('the Client column is kept as a connect column while ANY row links through it', async () => {
  const { board, ids, done } = await seedOldBilling();
  const link = { boardId: String(oid()), taskId: String(oid()) };
  await Task.updateOne(
    { _id: done._id },
    { $set: { [`columnValues.${ids.client}`]: { links: [link] } } }
  );
  await BoardConnection.create({ fromBoardId: board._id, toBoardId: oid(), fromColumnId: ids.client });

  const [s] = await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet });
  assert.equal(s.clientConverted, false);
  assert.match(s.clientKept, /1 row\(s\) hold a link/);
  const b = await Board.findById(board._id).lean();
  const client = b.columns.find((c) => c.key === 'client');
  assert.equal(client.type, 'connect_boards');
  assert.deepEqual(client.settings, { targetBoardIds: [], summary: 'filled' });
  const t = await Task.findById(done._id).lean();
  assert.deepEqual(t.columnValues[String(ids.client)].links, [link], 'a link was destroyed');
  assert.ok(await BoardConnection.exists({ fromBoardId: board._id, fromColumnId: ids.client }));
});

test('converting the Client column drops its connection edge; a mirror reading through it blocks the conversion', async () => {
  const { board, ids } = await seedOldBilling();
  await BoardConnection.create({ fromBoardId: board._id, toBoardId: oid(), fromColumnId: ids.client });
  await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet });
  assert.equal(await BoardConnection.exists({ fromBoardId: board._id, fromColumnId: ids.client }), null);

  const { board: mirrored, ids: mids } = await seedOldBilling();
  await Board.updateOne(
    { _id: mirrored._id },
    {
      $push: {
        columns: {
          key: 'clientCity', name: 'Client city', type: 'mirror', order: 9,
          settings: { sourceConnectColumnId: String(mids.client), sourceColumnId: String(oid()) },
        },
      },
    }
  );
  const [s] = await upgradeTemplateBoards({ boardId: mirrored._id, apply: true, log: quiet });
  assert.equal(s.clientConverted, false);
  assert.match(s.clientKept, /mirror/);
  const b = await Board.findById(mirrored._id).lean();
  assert.equal(b.columns.find((c) => c.key === 'client').type, 'connect_boards');
});

test('an empty connect cell is recognised as empty, and anything unexpected is not', () => {
  assert.equal(isEmptyConnectValue(null), true);
  assert.equal(isEmptyConnectValue({ links: [] }), true);
  assert.equal(isEmptyConnectValue({}), true);
  assert.equal(isEmptyConnectValue({ links: [{ boardId: 'b', taskId: 't' }] }), false);
  assert.equal(isEmptyConnectValue([{ boardId: 'b' }]), false);
  assert.equal(isEmptyConnectValue('Acme'), false);
});

test('a billing board somebody set to open elsewhere keeps its view', async () => {
  const { board } = await seedOldBilling({ boardExtra: { defaultView: 'stages' } });
  const [s] = await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet });
  assert.equal(s.defaultView, null);
  assert.equal((await Board.findById(board._id).lean()).defaultView, 'stages');
});

test('decimals are unpinned on EVERY template\'s money columns, and nowhere else', async () => {
  const org = await seedOrg({ baseCurrency: 'INR' });
  const pinned = { format: 'currency', currency: 'AUD', decimals: 0, summary: 'sum' };
  const make = async (templateKey, columns) => {
    const _id = oid();
    await Board.collection.insertOne({
      _id, name: templateKey, organisation: org._id, templateKey, useFlexibleColumns: true,
      currency: null, statuses: [], columns,
    });
    return _id;
  };
  const budget = await make('budget', [
    { _id: oid(), key: 'category', name: 'Category', type: 'text', isPrimary: true, order: 0, settings: {} },
    { _id: oid(), key: 'allocated', name: 'Allocated', type: 'number', order: 1, settings: { ...pinned } },
    { _id: oid(), key: 'spent', name: 'Spent', type: 'number', order: 2, settings: { ...pinned } },
    {
      _id: oid(), key: 'remaining', name: 'Remaining', type: 'formula', order: 3,
      settings: { expression: 'column.allocated - column.spent', ...pinned },
    },
    // A column the user added, with a precision they chose: not the template's.
    { _id: oid(), key: 'fees', name: 'Fees', type: 'number', order: 4, settings: { ...pinned } },
  ]);
  const pipeline = await make('pipeline', [
    { _id: oid(), key: 'company', name: 'Company', type: 'text', isPrimary: true, order: 0, settings: {} },
    { _id: oid(), key: 'value', name: 'Deal value', type: 'number', order: 1, settings: { ...pinned } },
  ]);
  const expenses = await make('expenses', [
    { _id: oid(), key: 'what', name: 'What', type: 'text', isPrimary: true, order: 0, settings: {} },
    // Same key, different type: somebody rebuilt it. Not the template's column.
    { _id: oid(), key: 'amount', name: 'Amount', type: 'text', order: 1, settings: { decimals: 0 } },
  ]);

  const summaries = await upgradeTemplateBoards({ apply: true, log: quiet });
  const of = (id) => summaries.find((x) => x.boardId === String(id));
  assert.deepEqual(of(budget).decimalsCleared, ['allocated', 'spent', 'remaining']);
  assert.deepEqual(of(pipeline).decimalsCleared, ['value']);
  // Its rebuilt column is not the template's, and with no money it simply
  // follows the workspace — which writes nothing, so it reports no change.
  assert.equal(of(expenses), undefined, 'the rebuilt expenses board had something done to it');

  const b = await Board.findById(budget).lean();
  const byKey = Object.fromEntries(b.columns.map((c) => [c.key, c.settings]));
  assert.equal(byKey.allocated.decimals, undefined);
  assert.equal(byKey.remaining.decimals, undefined);
  assert.equal(byKey.remaining.expression, 'column.allocated - column.spent');
  assert.equal(byKey.fees.decimals, 0, 'a user column was touched');
  assert.equal(b.currency, 'AUD', 'pinned to the unit its money is in, not the workspace\'s');
  assert.equal((await Board.findById(expenses).lean()).columns[1].settings.decimals, 0);
  // No money column: nothing to protect, so it FOLLOWS the workspace — null.
  assert.equal((await Board.findById(expenses).lean()).currency, null, 'no money column: follows the workspace');
});

// ---------------------------------------------------------------------------
// Step 4 — follow the workspace, or pin what the columns say
// ---------------------------------------------------------------------------

/** A flexible board with no currency of its own and these own money codes. */
const seedMoneyBoard = async (org, codes, { extraColumns = [], name = 'Money' } = {}) => {
  const _id = oid();
  await Board.collection.insertOne({
    _id,
    name,
    organisation: org._id,
    templateKey: null,
    useFlexibleColumns: true,
    currency: null,
    statuses: [],
    columns: [
      { _id: oid(), key: 'title', name: 'Title', type: 'text', isPrimary: true, order: 0, settings: {} },
      ...codes.map((code, i) => ({
        _id: oid(),
        key: `m${i}`,
        name: `Money ${i}`,
        type: i === 1 ? 'payments' : 'number',
        order: i + 1,
        settings: { format: 'currency', ...(code ? { currency: code } : {}) },
      })),
      ...extraColumns,
    ],
  });
  return _id;
};

test('a board whose money is all in the workspace unit is left FOLLOWING it', async () => {
  const org = await seedOrg({ baseCurrency: 'CAD' });
  const id = await seedMoneyBoard(org, ['CAD', 'cad ']);
  const [s] = await upgradeTemplateBoards({ boardId: id, apply: true, log: quiet });
  // Nothing written for the currency — null is already what following is.
  assert.equal(s, undefined, 'a follow decision alone is not a change');
  const b = await Board.findById(id).lean();
  assert.equal(b.currency, null);
  assert.equal(b.templateRevision, TEMPLATE_REVISION);
});

test('a board whose money is all in ANOTHER unit is pinned to it, so a workspace change cannot relabel it', async () => {
  const org = await seedOrg({ baseCurrency: 'INR' });
  const id = await seedMoneyBoard(org, ['USD', 'USD']);
  const [s] = await upgradeTemplateBoards({ boardId: id, apply: true, log: quiet });
  assert.equal(s.currencyPinned, 'USD');
  assert.equal(s.currencyFollows, null);
  assert.equal((await Board.findById(id).lean()).currency, 'USD');
});

test('a mixed board is pinned to its first own money column, as before', async () => {
  const org = await seedOrg({ baseCurrency: 'INR' });
  // A code-less column first: it names nothing, so the first CODE is GBP.
  const id = await seedMoneyBoard(org, [null, 'GBP', 'INR']);
  const [s] = await upgradeTemplateBoards({ boardId: id, apply: true, log: quiet });
  assert.equal(s.currencyPinned, 'GBP');
  assert.equal((await Board.findById(id).lean()).currency, 'GBP');

  // Code-less alone renders in the workspace unit: that board follows.
  const bare = await seedMoneyBoard(org, [null, null]);
  await upgradeTemplateBoards({ boardId: bare, apply: true, log: quiet });
  assert.equal((await Board.findById(bare).lean()).currency, null);
});

test("a mirror's unit has no vote: an all-INR board with a CAD mirror follows", async () => {
  const org = await seedOrg({ baseCurrency: 'INR' });
  const id = await seedMoneyBoard(org, ['INR'], {
    extraColumns: [{
      _id: oid(), key: 'deal', name: 'Deal value', type: 'mirror', order: 9,
      settings: { format: 'currency', currency: 'CAD', aggregation: 'sum' },
    }],
  });
  await upgradeTemplateBoards({ boardId: id, apply: true, log: quiet });
  assert.equal((await Board.findById(id).lean()).currency, null);
});

test('the dry run says which boards follow and which are pinned, and writes neither', async () => {
  const org = await seedOrg({ baseCurrency: 'INR' });
  const follows = await seedMoneyBoard(org, ['INR'], { name: 'Follower' });
  const pinned = await seedMoneyBoard(org, ['USD'], { name: 'Dollars' });
  const lines = [];
  const log = (line) => lines.push(String(line));
  await upgradeTemplateBoards({ boardId: follows, log });
  await upgradeTemplateBoards({ boardId: pinned, log });
  assert.ok(
    lines.some((l) => l.includes('Follower') && l.includes('follows workspace INR')),
    `no follow line in:\n${lines.join('\n')}`
  );
  assert.ok(
    lines.some((l) => l.includes('Dollars') && l.includes('currency pinned USD')),
    `no pin line in:\n${lines.join('\n')}`
  );
  assert.ok(!lines.some((l) => l.includes('Follower') && l.includes('currency pinned')));
  assert.equal((await Board.findById(follows).lean()).currency, null);
  assert.equal((await Board.findById(pinned).lean()).currency, null, 'a dry run pinned');
});

test('a board that already names its currency keeps it', async () => {
  const { board } = await seedOldBilling({ boardExtra: { currency: 'GBP' } });
  const [s] = await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet });
  assert.equal(s.currencyPinned, null);
  assert.equal((await Board.findById(board._id).lean()).currency, 'GBP');
});

test('owners are copied only for members who can open the board', async () => {
  // Private, created by somebody else, no grant: a plain member cannot read it.
  const { board, late, person } = await seedOldBilling({ visibility: 'private', boardExtra: { createdBy: oid() } });
  const [s] = await upgradeTemplateBoards({ boardId: board._id, apply: true, log: quiet });
  assert.equal(s.owners, 0);
  assert.equal(s.ownersDropped, 2);
  assert.deepEqual((await Task.findById(late._id).lean()).assignedTo || [], []);

  // With a grant, the same member is copied.
  const granted = await seedOldBilling({ visibility: 'private', boardExtra: { createdBy: oid() } });
  await Board.updateOne(
    { _id: granted.board._id },
    { $push: { memberAccess: { user: granted.person, level: 'view', canManage: false } } }
  );
  const [g] = await upgradeTemplateBoards({ boardId: granted.board._id, apply: true, log: quiet });
  assert.equal(g.owners, 1);
  assert.deepEqual((await Task.findById(granted.late._id).lean()).assignedTo.map(String), [String(granted.person)]);
  assert.notEqual(String(person), String(granted.person));
});

test('the legacy Ads Budget USD is cleared only where it was never a choice — on any board', async () => {
  const org = await seedOrg();
  const plain = async (adsBudget, extra = {}) => {
    const _id = oid();
    // A tracker board, born blank: no template, no flexible columns. The
    // template loop never visits it; the add-on pass must.
    await Board.collection.insertOne({
      _id, name: `Tracker ${_id}`, organisation: org._id, boardType: 'tracker', templateKey: null,
      useFlexibleColumns: false, columns: [], statuses: [], adsBudget, ...extra,
    });
    return _id;
  };
  const untouched = await plain({ enabled: false, currency: 'USD' });
  const switchedOn = await plain({ enabled: true, currency: 'USD' });
  const hasRows = await plain({ enabled: false, currency: 'USD' });
  const chosen = await plain({ enabled: false, currency: 'CAD' });
  await AdsBudget.collection.insertOne({
    board: hasRows, organisation: org._id, group: oid(), monthKey: '2026-09',
  });

  // --board scopes this pass too.
  const scoped = await upgradeTemplateBoards({ boardId: switchedOn, apply: true, log: quiet });
  assert.deepEqual(scoped, []);

  const summaries = await upgradeTemplateBoards({ apply: true, log: quiet });
  const cleared = summaries.filter((s) => s.adsBudgetCurrencyCleared).map((s) => s.boardId);
  assert.ok(cleared.includes(String(untouched)));
  for (const id of [switchedOn, hasRows, chosen]) assert.ok(!cleared.includes(String(id)), `${id} was cleared`);

  const read = async (id) => (await Board.findById(id).lean()).adsBudget.currency;
  assert.equal(await read(untouched), null);
  assert.equal(await read(switchedOn), 'USD');
  assert.equal(await read(hasRows), 'USD');
  assert.equal(await read(chosen), 'CAD');

  const again = await upgradeTemplateBoards({ apply: true, log: quiet });
  assert.deepEqual(again, [], 'the whole database is idempotent on a second run');
});

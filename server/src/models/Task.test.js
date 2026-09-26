/**
 * Task.test.js — unit tests for the Task pre-save sync hook.
 *
 * Run from the server directory:
 *     node --test src/models/Task.test.js
 *
 * The hook needs to call `Board.findById(...)` so we register Board first
 * and stub its findById on each test. No live MongoDB connection is needed
 * because we never call `task.save()` — we invoke the hook function
 * directly with a hand-built `this`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

// Order matters: Board first so Task's pre-save hook can resolve it via
// mongoose.model('Board'). The Board model registers itself on require.
require('./Board');
const Task = require('./Task');

// Pluck the pre-save hook function out of the compiled schema so we can
// call it directly with a synthetic `this`. The first 'save' hook on the
// schema is the legacy-field sync.
const findSyncHook = () => {
  const callQueue = Task.schema.s.hooks._pres.get('save') || [];
  // Each entry is { fn, ... }. We want our sync hook by name.
  const entry = callQueue.find((q) =>
    (q.fn && q.fn.name) === 'syncLegacyFieldsFromColumnValues'
  );
  if (!entry) throw new Error('sync hook not found on Task schema');
  return entry.fn;
};

// The hook is an ASYNC function with no `next` parameter — Mongoose awaits the
// promise it returns. Calling it with a callback, as this used to, passed a
// function nobody ever invoked, so the promise below never settled and every
// test that reached it hung until the runner gave up. Wait on what it returns.
const runHook = (ctx) =>
  new Promise((resolve, reject) => {
    const hook = findSyncHook();
    Promise.resolve(hook.call(ctx)).then(resolve, reject);
  });

// Build a fake `this` that resembles a mongoose document for the bits the
// hook touches: `isPersonal`, `board`, `columnValues` (a Map), and `set`.
const makeFakeTask = ({ isPersonal = false, board = null, columnValues = new Map() } = {}) => {
  const fields = {};
  return {
    isPersonal,
    board,
    columnValues,
    dueDate: undefined,
    status: undefined,
    priority: undefined,
    assignedTo: [],
    labels: [],
    fields,
    set(field, value) {
      this[field] = value;
      this.fields[field] = value;
    },
  };
};

// Replace Board.findById with a stub that returns a fixed payload.
const withStubbedBoard = async (board, fn) => {
  const Board = mongoose.model('Board');
  const original = Board.findById;
  Board.findById = () => ({
    select: () => ({ lean: async () => board }),
  });
  try {
    await fn();
  } finally {
    Board.findById = original;
  }
};

test('hook skips when task is personal', async () => {
  const ctx = makeFakeTask({ isPersonal: true, board: null });
  await withStubbedBoard(null, async () => {
    await runHook(ctx);
  });
  assert.equal(ctx.fields.status, undefined);
});

test('hook skips when task has no board reference', async () => {
  const ctx = makeFakeTask({ board: null });
  await withStubbedBoard(null, async () => {
    await runHook(ctx);
  });
  assert.equal(ctx.fields.status, undefined);
});

test('hook skips when board.useFlexibleColumns is false', async () => {
  const ctx = makeFakeTask({
    board: new mongoose.Types.ObjectId(),
    columnValues: new Map([['col_a', 'value_a']]),
  });
  await withStubbedBoard(
    { useFlexibleColumns: false, columns: [] },
    async () => {
      await runHook(ctx);
    }
  );
  assert.equal(ctx.fields.status, undefined);
});

test('hook projects columnValues onto legacy fields when flag is on', async () => {
  const statusColId = new mongoose.Types.ObjectId();
  const priorityColId = new mongoose.Types.ObjectId();
  const dueDateColId = new mongoose.Types.ObjectId();
  const assigneesColId = new mongoose.Types.ObjectId();
  const tagsColId = new mongoose.Types.ObjectId();

  const userA = new mongoose.Types.ObjectId().toString();
  const userB = new mongoose.Types.ObjectId().toString();
  const tagA = new mongoose.Types.ObjectId().toString();

  const ctx = makeFakeTask({
    board: new mongoose.Types.ObjectId(),
    columnValues: new Map([
      [statusColId.toString(), 'done'],
      [priorityColId.toString(), 'high'],
      [dueDateColId.toString(), '2026-12-31T00:00:00.000Z'],
      [assigneesColId.toString(), [userA, userB]],
      [tagsColId.toString(), [tagA]],
    ]),
  });

  await withStubbedBoard(
    {
      useFlexibleColumns: true,
      columns: [
        { _id: statusColId, key: 'status', type: 'status' },
        { _id: priorityColId, key: 'priority', type: 'dropdown' },
        { _id: dueDateColId, key: 'due_date', type: 'date' },
        { _id: assigneesColId, key: 'assignees', type: 'person' },
        { _id: tagsColId, key: 'tags', type: 'tags' },
      ],
    },
    async () => {
      await runHook(ctx);
    }
  );

  assert.equal(ctx.fields.status, 'done');
  assert.equal(ctx.fields.priority, 'high');
  assert.ok(ctx.dueDate instanceof Date);
  assert.equal(ctx.dueDate.toISOString(), '2026-12-31T00:00:00.000Z');
  assert.deepEqual(ctx.fields.assignedTo, [userA, userB]);
  assert.deepEqual(ctx.fields.labels, [tagA]);
});

test('hook leaves legacy fields alone when their column is missing', async () => {
  const otherColId = new mongoose.Types.ObjectId();
  const ctx = makeFakeTask({
    board: new mongoose.Types.ObjectId(),
    columnValues: new Map([[otherColId.toString(), 'not-mapped']]),
  });

  await withStubbedBoard(
    {
      useFlexibleColumns: true,
      columns: [{ _id: otherColId, key: 'unrelated', type: 'text' }],
    },
    async () => {
      await runHook(ctx);
    }
  );

  assert.equal(ctx.fields.status, undefined);
  assert.equal(ctx.fields.priority, undefined);
});

test('a passive save fills an empty side but never overwrites one that holds a value', async () => {
  // The fake has no change tracking, so the hook reads this as a save that
  // touched neither the cells nor the fields — a status change, say. Both
  // sides disagree and both hold something: which one is right is not the
  // hook's call, so neither moves.
  const dueColId = new mongoose.Types.ObjectId();
  const ownerColId = new mongoose.Types.ObjectId();
  const cellOwner = new mongoose.Types.ObjectId().toString();
  const fieldOwner = new mongoose.Types.ObjectId().toString();
  const fieldDue = new Date('2026-07-07T00:00:00.000Z');

  const ctx = makeFakeTask({
    board: new mongoose.Types.ObjectId(),
    columnValues: new Map([
      [dueColId.toString(), '2026-12-31T00:00:00.000Z'],
      [ownerColId.toString(), [cellOwner]],
    ]),
  });
  ctx.dueDate = fieldDue;
  ctx.assignedTo = [fieldOwner];

  await withStubbedBoard(
    {
      useFlexibleColumns: true,
      columns: [
        { _id: dueColId, key: 'due_date', type: 'date' },
        { _id: ownerColId, key: 'assignees', type: 'person' },
      ],
    },
    async () => {
      await runHook(ctx);
    }
  );

  assert.equal(ctx.dueDate, fieldDue);
  assert.deepEqual(ctx.assignedTo, [fieldOwner]);
  assert.equal(ctx.columnValues.get(dueColId.toString()), '2026-12-31T00:00:00.000Z');
  assert.deepEqual(ctx.columnValues.get(ownerColId.toString()), [cellOwner]);
});

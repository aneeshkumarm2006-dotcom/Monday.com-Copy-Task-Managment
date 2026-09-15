/**
 * analyticsReport.test.js — the two ways `buildAnalytics` can be silently wrong.
 *
 * Run from the server directory:
 *     node --test src/services/analyticsReport.test.js
 *
 * This file does not re-test the aggregations. Those moved verbatim out of
 * `analyticsController.getAnalytics` and are covered by the Analytics page
 * itself: if a bucket breaks, a screen full of numbers goes visibly wrong.
 *
 * What it DOES test is the pair of failures that a screen cannot show you,
 * both introduced by the service gaining a second caller (the executive home,
 * whose section config is a Mixed field rather than a query string):
 *
 *   1. A range the caller believes in but the report does not. `90d` used to
 *      match no branch, so it got no `createdAt` floor and reported ALL-TIME
 *      numbers under a "90 days" label. Nothing errors; the tile is just a lie,
 *      and it disagrees with nothing you can put beside it.
 *   2. A board id that is not a string. `id.toString() === boardFilter` is
 *      false for an ObjectId, so the report answers "board not found", which
 *      the home renders as "You no longer have access to this board" — an
 *      access message for a board the caller can read perfectly well.
 *
 * Both are asserted against the FILTERS the service builds, because that is
 * where the damage happens; the Mongo layer is stubbed in memory (the models
 * are patched on the mongoose singleton, as `mirrorRefresh.test.js` does).
 * `node --test` gives each file its own process, so the patches cannot reach
 * another suite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Board = require('../models/Board');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');

const { buildAnalytics, VALID_RANGES } = require('./analyticsReport');

const oid = () => new mongoose.Types.ObjectId();

const MS_PER_DAY = 86400000;

// ---------------------------------------------------------------------------
// Fixture: one workspace, two boards, and a caller who is the org owner.
//
// Owner rather than a granted member on purpose — `resolveAccess` is the REAL
// one here, not a stub, and the owner short-circuit is the cheapest way to get
// `canRead` on both boards without hand-building a role matrix. What is under
// test is the filtering, not the reach rule (which has its own suite in
// utils/permissions.test.js).
// ---------------------------------------------------------------------------
const makeFixture = () => {
  const userId = oid();
  const boardA = {
    _id: oid(),
    name: 'Board A',
    visibility: 'private',
    createdBy: userId,
    memberAccess: [],
    statuses: [{ _id: oid(), key: 'done', name: 'Done', color: '#0f0' }],
  };
  const boardB = {
    _id: oid(),
    name: 'Board B',
    visibility: 'private',
    createdBy: userId,
    memberAccess: [],
    statuses: [],
  };
  const org = {
    _id: oid(),
    admin: userId, // owner: canRead everywhere
    members: [],
    roles: [],
    memberRoles: [],
  };
  return { org, userId, boardA, boardB };
};

/**
 * Patch the three models with in-memory doubles and record every filter the
 * service builds, then restore. The recorded filters ARE the assertions: a
 * missing `createdAt` floor is the whole of failure #1.
 */
const withStubbedMongo = async (boards, fn) => {
  const originals = {
    boardFind: Board.find,
    taskFind: Task.find,
    taskAggregate: Task.aggregate,
    taskCount: Task.countDocuments,
    groupDistinct: TaskGroup.distinct,
  };
  const calls = { taskFinds: [], aggregates: [], counts: [] };

  Board.find = () => ({ select: () => ({ sort: async () => boards }) });
  TaskGroup.distinct = async () => [oid()];
  Task.find = (filter) => {
    calls.taskFinds.push(filter);
    return { select: () => ({ lean: async () => [] }) };
  };
  Task.aggregate = async (pipeline) => {
    calls.aggregates.push(pipeline);
    return [];
  };
  Task.countDocuments = async (filter) => {
    calls.counts.push(filter);
    return 0;
  };

  try {
    return await fn(calls);
  } finally {
    Board.find = originals.boardFind;
    Task.find = originals.taskFind;
    Task.aggregate = originals.taskAggregate;
    Task.countDocuments = originals.taskCount;
    TaskGroup.distinct = originals.groupDistinct;
  }
};

/** The scan for overdue work carries a `dueDate`; the status scan does not. */
const statusFilterOf = (calls) => calls.taskFinds.find((f) => !f.dueDate);
const overdueFilterOf = (calls) => calls.taskFinds.find((f) => f.dueDate);

/** How many days before now is this filter's `createdAt` floor? */
const floorDaysOf = (filter) => {
  if (!filter.createdAt) return null;
  return (Date.now() - filter.createdAt.$gte.getTime()) / MS_PER_DAY;
};

const run = async (args, boards) => {
  let result;
  const calls = await withStubbedMongo(boards, async (recorded) => {
    result = await buildAnalytics(args);
    return recorded;
  });
  return { result, calls };
};

// ---------------------------------------------------------------------------
// Ranges — the accepted list and the date floor are one table, so they agree
// ---------------------------------------------------------------------------

test('VALID_RANGES carries every range a caller is allowed to configure', () => {
  // The executive home's `workspaceNumbers` config is specified as
  // 7d / 30d / 90d / all. A value that is legal to configure and unknown here
  // is the exact shape of the bug this file exists for.
  for (const range of ['7d', '30d', '90d', 'all']) {
    assert.ok(
      VALID_RANGES.includes(range),
      `${range} is configurable but not in VALID_RANGES`
    );
  }
});

test('every range in VALID_RANGES puts a floor where its label says', async () => {
  const { org, userId, boardA } = makeFixture();
  const expected = { '7d': 7, '30d': 30, '90d': 90, all: null };

  for (const range of VALID_RANGES) {
    const { result, calls } = await run({ org, userId, range }, [boardA]);
    const days = floorDaysOf(statusFilterOf(calls));

    if (expected[range] === null) {
      assert.equal(days, null, `${range} should count everything ever`);
    } else {
      // Generous window: the floor is computed from `new Date()` a moment
      // before this runs, and calendar arithmetic makes it approximate across
      // a DST boundary.
      assert.ok(
        days > expected[range] - 1 && days < expected[range] + 1,
        `${range} floored ${days} days back, expected ~${expected[range]}`
      );
    }
    // Whatever the floor, the echoed label must be the range asked for — a
    // tile labelled one thing and counting another is the failure mode.
    assert.equal(result.filters.range, range);
  }
});

test('90d counts a quarter, not all time', async () => {
  const { org, userId, boardA } = makeFixture();
  const { result, calls } = await run(
    { org, userId, range: '90d' },
    [boardA]
  );
  const days = floorDaysOf(statusFilterOf(calls));
  assert.ok(days !== null, '90d reported all-time numbers under a 90d label');
  assert.ok(days > 89 && days < 91, `90d floored ${days} days back`);
  assert.equal(result.filters.range, '90d');
});

test('an unrecognised range degrades to all time rather than throwing', async () => {
  const { org, userId, boardA } = makeFixture();
  // Documented behaviour, not an accident: the controller substitutes its own
  // default before we are ever called, so this path only exists for a caller
  // that skipped `VALID_RANGES`. It must not take the page down.
  const { result, calls } = await run(
    { org, userId, range: 'last-tuesday' },
    [boardA]
  );
  assert.equal(floorDaysOf(statusFilterOf(calls)), null);
  assert.equal(result.filters.range, 'last-tuesday');
});

test('overdue ignores the range floor at every range', async () => {
  const { org, userId, boardA } = makeFixture();
  for (const range of VALID_RANGES) {
    const { calls } = await run({ org, userId, range }, [boardA]);
    // A task created before the window is still overdue today. Applying the
    // floor here would quietly shrink the overdue count as the range narrows.
    assert.equal(
      overdueFilterOf(calls).createdAt,
      undefined,
      `overdue picked up a createdAt floor at range ${range}`
    );
  }
});

// ---------------------------------------------------------------------------
// The board filter — an id is an id, whatever type it arrives as
// ---------------------------------------------------------------------------

test('a board id narrows the report whether it arrives as a string, an ObjectId or a document', async () => {
  const { org, userId, boardA, boardB } = makeFixture();
  const shapes = {
    string: boardB._id.toString(),
    ObjectId: boardB._id,
    'loaded board': { _id: boardB._id, name: 'Board B' },
  };

  for (const [label, boardFilter] of Object.entries(shapes)) {
    const { result, calls } = await run(
      { org, userId, range: '30d', boardFilter },
      [boardA, boardB]
    );

    assert.equal(
      result.error,
      undefined,
      `${label} was refused: ${result.error}`
    );
    // Narrowed to the one board...
    const scoped = statusFilterOf(calls).board.$in;
    assert.equal(scoped.length, 1, `${label} did not narrow to one board`);
    assert.equal(String(scoped[0]), boardB._id.toString());
    // ...and the echo is a plain id string for every shape, so a caller that
    // round-trips `filters` back into its config cannot store a serialised
    // ObjectId where an id string belongs.
    assert.equal(result.filters.board, boardB._id.toString());
    assert.equal(typeof result.filters.board, 'string');
    // The board LIST is still every readable board — the filter narrows the
    // numbers, not the picker.
    assert.equal(result.boards.length, 2);
  }
});

test('no board filter reports over every readable board and echoes "all"', async () => {
  const { org, userId, boardA, boardB } = makeFixture();
  const { result, calls } = await run({ org, userId, range: '30d' }, [
    boardA,
    boardB,
  ]);
  assert.equal(statusFilterOf(calls).board.$in.length, 2);
  assert.equal(result.filters.board, 'all');
});

test('a board outside the caller\'s workspace is still refused as not found', async () => {
  const { org, userId, boardA } = makeFixture();
  // Normalising the id must not turn the refusals into matches: a board that
  // exists but is closed to this caller 404s (a 403 would confirm it exists).
  const { result } = await run(
    { org, userId, range: '30d', boardFilter: oid() },
    [boardA]
  );
  assert.equal(result.status, 404);
  assert.equal(result.error, 'Board not found in workspace');
});

test('a malformed board id is still refused as a bad request', async () => {
  const { org, userId, boardA } = makeFixture();
  const { result } = await run(
    { org, userId, range: '30d', boardFilter: 'not-an-id' },
    [boardA]
  );
  assert.equal(result.status, 400);
  assert.equal(result.error, 'Invalid board id');
});

// ---------------------------------------------------------------------------
// Fail closed on names
// ---------------------------------------------------------------------------

test('the named per-assignee breakdown is withheld unless the caller says otherwise', async () => {
  const { org, userId, boardA } = makeFixture();
  // `canSeeOthers` defaults to false so a caller that forgets to resolve
  // `productivity.view_others` withholds names rather than publishing them.
  const { result } = await run({ org, userId, range: '30d' }, [boardA]);
  assert.deepEqual(result.overdue.topAssignees, []);
  assert.deepEqual(result.overdue.byAssignee, {});
});

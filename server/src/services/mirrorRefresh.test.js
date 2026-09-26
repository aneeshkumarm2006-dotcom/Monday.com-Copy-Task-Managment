/**
 * mirrorRefresh.test.js — unit tests for the F2 mirror engine's pure logic:
 * aggregation, display resolution, link parsing, and cycle detection.
 *
 * Run from the server directory:
 *     node --test src/services/mirrorRefresh.test.js
 *
 * Cycle detection reads boards via Board.findById(...).select('columns').lean();
 * we stub that with an in-memory fixture map (no live MongoDB needed). The
 * compute/invalidate paths hit the DB and are covered by the manual
 * acceptance checklist (phase-1-TODO §F2.6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

// Board first so the service can resolve it via mongoose.model('Board').
require('../models/Board');
require('../models/Task');
require('../models/BoardConnection');

const {
  aggregate,
  aggregationDefault,
  resolveDisplay,
  readLinks,
  wouldCreateMirrorCycle,
} = require('./mirrorRefresh');

const oid = () => new mongoose.Types.ObjectId();

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------
test('aggregate: sum/min/max over numbers', () => {
  assert.equal(aggregate('sum', [1, 2, 3]), 6);
  assert.equal(aggregate('min', [5, 2, 9]), 2);
  assert.equal(aggregate('max', [5, 2, 9]), 9);
});

test('aggregate: numeric modes coerce numeric strings and skip non-numbers', () => {
  assert.equal(aggregate('sum', ['10', '5', 'abc']), 15);
});

test('aggregate: first returns the first value, count returns length', () => {
  assert.equal(aggregate('first', ['a', 'b']), 'a');
  assert.equal(aggregate('count', ['a', 'b', 'c']), 3);
});

test('aggregate: concat joins non-empty string values', () => {
  assert.equal(aggregate('concat', ['A', '', 'B']), 'A, B');
});

test('aggregate: empty input falls back to the aggregation default', () => {
  assert.equal(aggregate('sum', []), 0);
  assert.equal(aggregate('first', []), null);
  assert.equal(aggregate('concat', []), '');
  assert.equal(aggregate('count', []), 0);
});

// ---------------------------------------------------------------------------
// aggregationDefault
// ---------------------------------------------------------------------------
test('aggregationDefault: sum/count are 0, concat is "", others null', () => {
  assert.equal(aggregationDefault('sum'), 0);
  assert.equal(aggregationDefault('count'), 0);
  assert.equal(aggregationDefault('concat'), '');
  assert.equal(aggregationDefault('first'), null);
  assert.equal(aggregationDefault('min'), null);
  assert.equal(aggregationDefault('max'), null);
});

// ---------------------------------------------------------------------------
// resolveDisplay
// ---------------------------------------------------------------------------
test('resolveDisplay: resolves status/dropdown option ids to labels', () => {
  const statusColId = oid();
  const board = {
    columns: [
      {
        _id: statusColId,
        type: 'status',
        settings: { options: [{ id: 'new', label: 'New' }, { id: 'won', label: 'Won' }] },
      },
    ],
  };
  assert.equal(resolveDisplay('won', board, statusColId.toString()), 'Won');
});

test('resolveDisplay: passes primitives through when the column is unknown', () => {
  assert.equal(resolveDisplay('123 Main St', null, oid().toString()), '123 Main St');
});

test('resolveDisplay: joins tag option labels', () => {
  const tagsColId = oid();
  const board = {
    columns: [
      {
        _id: tagsColId,
        type: 'tags',
        settings: { options: [{ id: 'a', label: 'Hot' }, { id: 'b', label: 'VIP' }] },
      },
    ],
  };
  assert.equal(resolveDisplay(['a', 'b'], board, tagsColId.toString()), 'Hot, VIP');
});

test('resolveDisplay: a payments cell mirrors as the total of its receipts', () => {
  // The default branch turns every object into null, so a mirrored "Paid"
  // read blank and a `sum` of it was always 0.
  const payColId = oid();
  const board = {
    columns: [{ _id: payColId, type: 'payments', settings: { format: 'currency', currency: 'CAD' } }],
  };
  const cid = payColId.toString();
  assert.equal(
    resolveDisplay(
      [
        { id: 'a', amount: 1200, date: '2026-09-01' },
        { id: 'b', amount: '300.5', date: '2026-09-10' },
        // Junk entries count for nothing rather than poisoning the sum.
        { id: 'c', amount: 'lots' },
        null,
      ],
      board,
      cid
    ),
    1500.5
  );
  // Nothing paid yet is a real zero — "Outstanding" must read the full amount.
  assert.equal(resolveDisplay([], board, cid), 0);
  // Not a list at all is not a figure.
  assert.equal(resolveDisplay({ amount: 5 }, board, cid), null);
  assert.equal(resolveDisplay('12', board, cid), null);
});

// ---------------------------------------------------------------------------
// readLinks — tolerates Map (hydrated doc) and plain object (lean)
// ---------------------------------------------------------------------------
test('readLinks: reads from a plain-object columnValues', () => {
  const cid = oid();
  const boardId = oid().toString();
  const taskId = oid().toString();
  const task = { columnValues: { [cid.toString()]: { links: [{ boardId, taskId }] } } };
  const links = readLinks(task, cid);
  assert.equal(links.length, 1);
  assert.equal(links[0].taskId, taskId);
});

test('readLinks: reads from a Map columnValues', () => {
  const cid = oid();
  const taskId = oid().toString();
  const task = {
    columnValues: new Map([[cid.toString(), { links: [{ boardId: oid().toString(), taskId }] }]]),
  };
  const links = readLinks(task, cid);
  assert.equal(links.length, 1);
  assert.equal(links[0].taskId, taskId);
});

test('readLinks: returns [] when the column has no value', () => {
  assert.deepEqual(readLinks({ columnValues: {} }, oid()), []);
});

// ---------------------------------------------------------------------------
// wouldCreateMirrorCycle — stub Board.findById with a fixture map
// ---------------------------------------------------------------------------
const withStubbedBoards = async (boardsById, fn) => {
  const Board = mongoose.model('Board');
  const original = Board.findById;
  Board.findById = (idValue) => ({
    select: () => ({ lean: async () => boardsById.get(idValue.toString()) || null }),
  });
  try {
    await fn();
  } finally {
    Board.findById = original;
  }
};

// Two boards that point at each other. Board B's mirror MB already mirrors
// board A's mirror MA. Pointing MA at MB closes the loop.
const buildCyclicFixture = () => {
  const A = oid();
  const B = oid();
  const CA = oid();
  const MA = oid();
  const textA = oid();
  const CB = oid();
  const MB = oid();
  const textB = oid();

  const boardA = {
    _id: A,
    columns: [
      { _id: CA, type: 'connect_boards', settings: { targetBoardIds: [B.toString()] } },
      { _id: MA, type: 'mirror', settings: { sourceConnectColumnId: CA.toString(), sourceColumnId: textB.toString() } },
      { _id: textA, type: 'text', settings: {} },
    ],
  };
  const boardB = {
    _id: B,
    columns: [
      { _id: CB, type: 'connect_boards', settings: { targetBoardIds: [A.toString()] } },
      // MB mirrors A's MA already.
      { _id: MB, type: 'mirror', settings: { sourceConnectColumnId: CB.toString(), sourceColumnId: MA.toString() } },
      { _id: textB, type: 'text', settings: {} },
    ],
  };
  const boardsById = new Map([[A.toString(), boardA], [B.toString(), boardB]]);
  return { boardA, boardB, boardsById, CA, MA, MB, textB };
};

test('wouldCreateMirrorCycle: false for a mirror over a plain column', async () => {
  const f = buildCyclicFixture();
  await withStubbedBoards(f.boardsById, async () => {
    const cycle = await wouldCreateMirrorCycle(
      f.boardA,
      { sourceConnectColumnId: f.CA.toString(), sourceColumnId: f.textB.toString() },
      f.MA
    );
    assert.equal(cycle, false);
  });
});

test('wouldCreateMirrorCycle: true when the new edge closes a loop', async () => {
  const f = buildCyclicFixture();
  await withStubbedBoards(f.boardsById, async () => {
    // Re-point MA at B's mirror MB, which already mirrors MA → cycle.
    const cycle = await wouldCreateMirrorCycle(
      f.boardA,
      { sourceConnectColumnId: f.CA.toString(), sourceColumnId: f.MB.toString() },
      f.MA
    );
    assert.equal(cycle, true);
  });
});

test('wouldCreateMirrorCycle: false when the source connect column is missing', async () => {
  const f = buildCyclicFixture();
  await withStubbedBoards(f.boardsById, async () => {
    const cycle = await wouldCreateMirrorCycle(
      f.boardA,
      { sourceConnectColumnId: oid().toString(), sourceColumnId: f.MB.toString() },
      f.MA
    );
    assert.equal(cycle, false);
  });
});

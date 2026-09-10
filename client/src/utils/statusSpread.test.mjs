import test from 'node:test';
import assert from 'node:assert/strict';
import { statusSpread, UNSET } from './statusSpread.js';

const BOARD = {
  statuses: [
    { _id: 's1', key: 'not_started', name: 'Not started', color: '#6B7280', order: 0 },
    { _id: 's2', key: 'working_on_it', name: 'Working on it', color: '#D97706', order: 1 },
    { _id: 's3', key: 'stuck', name: 'Stuck', color: '#DC2626', order: 2 },
    { _id: 's4', key: 'done', name: 'Done', color: '#16A34A', order: 3 },
  ],
};

const rows = (...statuses) => statuses.map((status, i) => ({ _id: `t${i}`, status }));

test('no tasks means no bar at all', () => {
  const out = statusSpread([], BOARD);
  assert.equal(out.total, 0);
  assert.deepEqual(out.segments, []);
});

test('counts by board status id, in board order', () => {
  const out = statusSpread(rows('s4', 's2', 's4', 's3'), BOARD);
  assert.equal(out.total, 4);
  assert.deepEqual(
    out.segments.map((s) => [s.name, s.count]),
    [['Working on it', 1], ['Stuck', 1], ['Done', 2]]
  );
});

test('order follows `order`, not array position', () => {
  const board = {
    statuses: [
      { _id: 'b', key: null, name: 'Second', color: '#DC2626', order: 9 },
      { _id: 'a', key: null, name: 'First', color: '#16A34A', order: 1 },
    ],
  };
  const out = statusSpread(rows('b', 'a'), board);
  assert.deepEqual(out.segments.map((s) => s.name), ['First', 'Second']);
});

test('percentages always sum to exactly 100 — no hairline gap', () => {
  // 3 buckets of 1 is the classic 33/33/33 = 99 case.
  for (const counts of [[1, 1, 1], [1, 1, 1, 1, 1, 1, 1], [2, 1], [5, 3, 1]]) {
    const board = {
      statuses: counts.map((_, i) => ({ _id: `s${i}`, key: null, name: `S${i}`, color: '#16A34A', order: i })),
    };
    const tasks = counts.flatMap((n, i) => Array.from({ length: n }, () => ({ status: `s${i}` })));
    const out = statusSpread(tasks, board);
    const sum = out.segments.reduce((a, s) => a + s.pct, 0);
    assert.equal(sum, 100, `counts ${JSON.stringify(counts)} summed to ${sum}`);
  }
});

test('a single status fills the bar', () => {
  const out = statusSpread(rows('s4', 's4', 's4'), BOARD);
  assert.equal(out.segments.length, 1);
  assert.equal(out.segments[0].pct, 100);
});

test('missing, empty and deleted statuses land in one trailing Not set bucket', () => {
  const out = statusSpread(
    [{ status: 's4' }, { status: null }, { status: '' }, { status: 'deleted-id' }, {}],
    BOARD
  );
  const last = out.segments[out.segments.length - 1];
  assert.equal(last.id, UNSET);
  assert.equal(last.count, 4);
  assert.equal(last.name, 'Not set');
});

test('legacy enum strings resolve on a board that has statuses', () => {
  // A personal task carries the enum even where the board uses ObjectIds.
  const out = statusSpread(rows('done', 's3'), BOARD);
  assert.deepEqual(
    out.segments.map((s) => [s.name, s.count]),
    [['Stuck', 1], ['Done', 1]]
  );
});

test('a board with no statuses at all still gets a real spread', () => {
  const out = statusSpread(rows('done', 'stuck', 'done'), { statuses: [] });
  assert.deepEqual(
    out.segments.map((s) => [s.name, s.count]),
    [['Stuck', 1], ['Done', 2]]
  );
  assert.equal(out.doneCount, 2);
});

test('doneCount matches what the old progress bar counted', () => {
  assert.equal(statusSpread(rows('s4', 's4', 's2'), BOARD).doneCount, 2);
  assert.equal(statusSpread(rows('done', 'stuck'), { statuses: [] }).doneCount, 1);
  assert.equal(statusSpread(rows('s2', 's3'), BOARD).doneCount, 0);
});

test('segments carry a colour and never a null one', () => {
  const out = statusSpread(rows('s4', null, 'done'), BOARD);
  out.segments.forEach((s) => assert.ok(s.color, `${s.name} had no colour`));
});

test('undefined board and undefined tasks do not throw', () => {
  assert.deepEqual(statusSpread(undefined, undefined).segments, []);
  assert.equal(statusSpread([{ status: 'done' }], undefined).segments.length, 1);
});

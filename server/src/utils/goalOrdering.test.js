const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGoalOrder, isOneTable } = require('./goalOrdering');

// ---------------------------------------------------------------------------
// mergeGoalOrder
// ---------------------------------------------------------------------------

test('a complete list is written exactly as sent', () => {
  assert.deepStrictEqual(
    mergeGoalOrder(['c', 'a', 'b'], ['a', 'b', 'c']),
    ['c', 'a', 'b']
  );
});

test('a goal added while the tab sat open keeps its place at the end', () => {
  // The client only ever saw a and b; `c` arrived from someone else.
  assert.deepStrictEqual(
    mergeGoalOrder(['b', 'a'], ['a', 'b', 'c']),
    ['b', 'a', 'c']
  );
});

test('goals the client never saw keep their relative order among themselves', () => {
  assert.deepStrictEqual(
    mergeGoalOrder(['b'], ['a', 'b', 'c', 'd']),
    ['b', 'a', 'c', 'd']
  );
});

test('a goal deleted from under the client is dropped, not resurrected', () => {
  assert.deepStrictEqual(
    mergeGoalOrder(['gone', 'a', 'b'], ['a', 'b']),
    ['a', 'b']
  );
});

test('a repeated id is honoured once, at its first position', () => {
  assert.deepStrictEqual(
    mergeGoalOrder(['b', 'a', 'b'], ['a', 'b']),
    ['b', 'a']
  );
});

test('ids compare as strings, so ObjectIds and their strings mix freely', () => {
  const objectish = { toString: () => 'a' };
  assert.deepStrictEqual(mergeGoalOrder([objectish], ['a', 'b']), ['a', 'b']);
});

test('an empty request still returns the table it was given', () => {
  assert.deepStrictEqual(mergeGoalOrder([], ['a', 'b']), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// isOneTable
// ---------------------------------------------------------------------------

test('one group in one month is one table', () => {
  assert.strictEqual(
    isOneTable([
      { group: 'g1', monthKey: '2026-08' },
      { group: 'g1', monthKey: '2026-08' },
    ]),
    true
  );
});

test('the same group in two months is NOT one table', () => {
  assert.strictEqual(
    isOneTable([
      { group: 'g1', monthKey: '2026-08' },
      { group: 'g1', monthKey: '2026-09' },
    ]),
    false
  );
});

test('two groups in the same month are NOT one table', () => {
  assert.strictEqual(
    isOneTable([
      { group: 'g1', monthKey: '2026-08' },
      { group: 'g2', monthKey: '2026-08' },
    ]),
    false
  );
});

test('nothing is not a table', () => {
  assert.strictEqual(isOneTable([]), false);
});

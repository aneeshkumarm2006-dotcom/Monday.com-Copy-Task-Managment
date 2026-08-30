/**
 * tableControls.test.mjs — the two bits of table arithmetic that are wrong in a
 * way nobody reports.
 *
 * A two-state sort toggle looks completely normal; what it costs is the table's
 * unsorted order, permanently, and the only symptom is somebody saying "I can't
 * get it back the way it was". A pager whose window shrinks at the ends also
 * looks normal; what it costs is a misclick every time you page past 3, because
 * the buttons moved under the cursor.
 *
 * Run from the client directory:
 *     node --test src/utils/tableControls.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PAGE_WINDOW, nextSort, pageSlots } from './tableControls.js';

// ---------------------------------------------------------------------------
// The sort cycle
// ---------------------------------------------------------------------------

test('clicking a new column starts ascending', () => {
  assert.deepEqual(nextSort({ key: null, dir: 'asc' }, 'rank'), {
    key: 'rank',
    dir: 'asc',
  });
  assert.deepEqual(nextSort({ key: 'keyword', dir: 'desc' }, 'rank'), {
    key: 'rank',
    dir: 'asc',
  });
});

test('the THIRD click clears the sort rather than going back to ascending', () => {
  // The state a two-state toggle throws away: the table's authored order, which
  // on a rank table is the order somebody typed the keywords in and which no
  // other control can restore.
  const first = nextSort({ key: null, dir: 'asc' }, 'rank');
  const second = nextSort(first, 'rank');
  const third = nextSort(second, 'rank');
  assert.equal(first.dir, 'asc');
  assert.equal(second.dir, 'desc');
  assert.equal(third.key, null);
});

test('the whole cycle, pinned against the board’s own contract', () => {
  /**
   * The four transitions `goalSort.nextGoalSort` defines, written out rather
   * than imported from it.
   *
   * Not for lack of trying: `goalSort.js` reaches `./goalDisplay` without a file
   * extension, which Vite resolves and plain Node ESM does not, so importing it
   * here would make this file un-runnable outside a bundler. The table below is
   * therefore the contract, copied deliberately — if a header in this app ever
   * behaves differently from a goals column, one of these two files is wrong and
   * this one is the copy.
   */
  const CONTRACT = [
    [{ key: null, dir: 'asc' }, 'a', { key: 'a', dir: 'asc' }],
    [{ key: 'a', dir: 'asc' }, 'a', { key: 'a', dir: 'desc' }],
    [{ key: 'a', dir: 'desc' }, 'a', { key: null, dir: 'asc' }],
    [{ key: 'a', dir: 'desc' }, 'b', { key: 'b', dir: 'asc' }],
  ];
  for (const [current, key, expected] of CONTRACT) {
    assert.deepEqual(
      nextSort(current, key),
      expected,
      `wrong next state for ${JSON.stringify(current)} + ${key}`
    );
  }
});

// ---------------------------------------------------------------------------
// The pager window
// ---------------------------------------------------------------------------

const numbered = (slots) => slots.filter((s) => s !== null).length;

test('a short pager lists every page with no ellipsis', () => {
  const slots = pageSlots(1, PAGE_WINDOW + 2);
  assert.equal(slots.includes(null), false);
  assert.deepEqual(slots, [1, 2, 3, 4, 5, 6, 7]);
});

test('the pager offers the SAME NUMBER OF BUTTONS wherever you are in it', () => {
  // The property that stops buttons moving under the cursor. The naive version
  // — slice a window around the current page and let it clip at the ends —
  // fails exactly here: near page 1 and page N the window is short, so the
  // count drops and every button shifts.
  //
  // Only the ellipsis count varies (one at an end, two in the middle), because
  // an ellipsis marking a gap of zero pages would misdescribe what is hidden.
  const pageCount = 40;
  const counts = new Set();
  for (let page = 1; page <= pageCount; page += 1) {
    counts.add(numbered(pageSlots(page, pageCount)));
  }
  assert.equal(counts.size, 1, `button counts seen: ${[...counts].join(', ')}`);
  assert.equal([...counts][0], PAGE_WINDOW + 2);
});

test('the first and last page are always reachable', () => {
  for (const page of [1, 2, 20, 39, 40]) {
    const slots = pageSlots(page, 40);
    assert.equal(slots[0], 1);
    assert.equal(slots[slots.length - 1], 40);
    assert.ok(slots.includes(page), `page ${page} is not in its own pager`);
  }
});

test('ellipses appear only where pages are actually skipped', () => {
  const near = pageSlots(2, 40);
  // Nothing is hidden between 1 and 2, so there is no gap to mark.
  assert.equal(near[1], 2);

  const middle = pageSlots(20, 40);
  assert.equal(middle[1], null);
  assert.equal(middle[middle.length - 2], null);

  const end = pageSlots(39, 40);
  assert.equal(end[end.length - 2], 39);
});

test('a single page is a single slot', () => {
  assert.deepEqual(pageSlots(1, 1), [1]);
});

import test from 'node:test';
import assert from 'node:assert';

import { filterOptions, nextIndex, SEARCH_THRESHOLD } from './menuNav.js';

const OPTIONS = [
  { value: '1', label: 'Presentation Ready' },
  { value: '2', label: 'Meeting Scheduled' },
  { value: '3', label: 'Meeting Denied' },
  { value: '4', label: 'Sent' },
  { value: '5', label: 'Draft Done' },
];

test('search matches anywhere in the label, not just the start', () => {
  // "Meeting Scheduled" is found by typing "sched" as readily as "meet". A
  // prefix-only search is the version that feels broken.
  assert.deepEqual(filterOptions(OPTIONS, 'sched').map((o) => o.value), ['2']);
  assert.deepEqual(filterOptions(OPTIONS, 'meeting').map((o) => o.value), ['2', '3']);
  assert.deepEqual(filterOptions(OPTIONS, 'DONE').map((o) => o.value), ['5']);
});

test('an empty query shows everything', () => {
  // Not nothing — which is what a naive `label.includes(q)` on undefined does.
  for (const q of ['', '   ', null, undefined]) {
    assert.equal(filterOptions(OPTIONS, q).length, OPTIONS.length);
  }
});

test('no match is an empty list, not the whole list', () => {
  assert.deepEqual(filterOptions(OPTIONS, 'zzz'), []);
});

test('bad input does not throw', () => {
  assert.deepEqual(filterOptions(null, 'a'), []);
  assert.deepEqual(filterOptions(undefined, undefined), []);
  assert.equal(filterOptions([{ value: 'x' }], 'a').length, 0, 'an option with no label');
});

test('arrows wrap at both ends', () => {
  // Up from the top reaches the bottom. On a four-status menu that is the
  // fastest route to "Stuck", and a list that stops dead at the edges is the
  // thing people describe as the keyboard "not working".
  assert.equal(nextIndex(0, -1, 5), 4);
  assert.equal(nextIndex(4, 1, 5), 0);
  assert.equal(nextIndex(2, 1, 5), 3);
  assert.equal(nextIndex(2, -1, 5), 1);
});

test('the first Down lands on the first option', () => {
  // Starting from "nothing highlighted", Down must go to index 0 — not 1, which
  // is what `current + 1` gives when current starts at 0 by default.
  assert.equal(nextIndex(-1, 1, 5), 0);
  assert.equal(nextIndex(-1, -1, 5), 4, 'and the first Up lands on the last');
});

test('an empty list has nothing to highlight', () => {
  // Reached whenever a search matches nothing. Returning 0 here would highlight
  // a row that is not rendered, and Enter would then select it.
  assert.equal(nextIndex(-1, 1, 0), -1);
  assert.equal(nextIndex(3, 1, 0), -1);
  assert.equal(nextIndex(0, 1, NaN), -1);
});

test('the search threshold is a small number', () => {
  assert.ok(SEARCH_THRESHOLD >= 6 && SEARCH_THRESHOLD <= 12);
});

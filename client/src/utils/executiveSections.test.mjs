/**
 * executiveSections.test.mjs — the two properties an undoable editor rests on.
 *
 * The section editor is explicitly Save/Cancel, and both halves of that promise
 * are made HERE rather than in the component:
 *
 *   1. **Nothing is mutated.** Cancel is "go back to the array we started
 *      from". If any helper reached into the list it was handed and changed a
 *      section in place, Cancel would restore an array that had already been
 *      edited — and the failure is invisible: the screen looks right, the list
 *      looks right, and the change turns up after a reload as something nobody
 *      remembers saving. So every test below keeps a deep snapshot of its input
 *      and asserts the input is untouched afterwards.
 *   2. **Order stays dense.** The server renumbers `order` into 0..n-1 on every
 *      save (`withDenseOrder`, `server/src/services/executiveView.js`). A client
 *      that sent holes would watch its own list renumber underneath it on the
 *      next load, and a later append using `length` as its order would land on
 *      top of an existing section. The numbers the client produces must already
 *      be the numbers the server will store.
 *
 * The section TYPES are synthetic ('alpha', 'beta', 'gamma'). The real ones
 * live in `components/executive/sectionRegistry.js`, which holds React
 * components and cannot be imported here — but more to the point, a test naming
 * real types would be a third place that lists them, and it would go stale the
 * week a type is added. Every function under test takes the registry as an
 * argument precisely so it has no opinion about which types exist, and these
 * tests prove that by never telling it any real ones.
 *
 * Run from the client directory:
 *     node --test src/utils/executiveSections.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WIDTHS,
  addSection,
  boardTitle,
  configDefaultsFor,
  normaliseHome,
  pickableBoards,
  removeSection,
  reorderSections,
  sectionKey,
  setConfig,
  setWidth,
} from './executiveSections.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A registry of the shape `sectionRegistry.js` exports, minus the React parts
 * these helpers never touch (`component`, `icon`).
 *
 * `alpha` carries an ARRAY and a nested-looking default on purpose: a shared
 * default array handed to two sections by reference is the mutation bug these
 * helpers are supposed to make impossible.
 */
const REGISTRY = {
  alpha: {
    label: 'Alpha',
    defaultConfig: { board: null, month: null, tags: [] },
    defaultWidth: 'half',
  },
  beta: {
    label: 'Beta',
    defaultConfig: { text: '' },
    // No defaultWidth: the model's own default must be used.
  },
  gamma: {
    label: 'Gamma',
    // No defaultConfig at all.
    defaultWidth: 'nonsense', // and an illegal one, which must not be trusted
  },
};

/** A stored home, dense and in order, as the server would have sent it. */
const storedHome = () => [
  { _id: 'aaa', type: 'alpha', order: 0, width: 'full', config: { board: 'b1', month: null } },
  { _id: 'bbb', type: 'beta', order: 1, width: 'half', config: { text: 'hello' } },
  { _id: 'ccc', type: 'alpha', order: 2, width: 'full', config: { board: 'b2', month: '2026-01' } },
];

const keysOf = (home) => home.map(sectionKey);
const ordersOf = (home) => home.map((s) => s.order);

/** `[0, 1, 2, …]` for a list of this length. */
const dense = (n) => Array.from({ length: n }, (_, i) => i);

/**
 * Snapshot a value deeply enough to catch an in-place edit anywhere in it.
 * `structuredClone` is in Node 17+; this codebase's other tests already assume
 * a modern runtime.
 */
const snapshot = (value) => structuredClone(value);

/**
 * Run `fn` and assert it changed nothing about `input`.
 *
 * Both halves matter: the array must still have the same section OBJECTS in the
 * same places (identity), and those objects must still hold the same values
 * (deep equality). A helper could pass one and fail the other — replacing an
 * element leaves the deep shape intact, editing one in place leaves the
 * identities intact — and either is a Cancel that does not cancel.
 */
const assertPure = (input, fn) => {
  const before = snapshot(input);
  const identities = [...input];
  const result = fn(input);
  assert.deepEqual(input, before, 'the input list was mutated');
  assert.deepEqual([...input], identities, 'an element of the input list was replaced');
  return result;
};

// ---------------------------------------------------------------------------
// Property 1: purity, on every helper
// ---------------------------------------------------------------------------

test('every helper leaves the list it was given untouched', () => {
  const home = storedHome();

  assertPure(home, (h) => addSection(h, 'alpha', REGISTRY));
  assertPure(home, (h) => removeSection(h, 'bbb'));
  assertPure(home, (h) => reorderSections(h, 'aaa', 'ccc'));
  assertPure(home, (h) => setWidth(h, 'aaa', 'half'));
  assertPure(home, (h) => setConfig(h, 'aaa', { month: '2026-09' }));
  assertPure(home, (h) => normaliseHome(h));
});

test('a config is copied, never edited through', () => {
  const home = storedHome();
  const originalConfig = home[0].config;

  const next = setConfig(home, 'aaa', { month: '2026-09' });

  // The stored section still says what it said…
  assert.equal(originalConfig.month, null);
  assert.equal(home[0].config, originalConfig);
  // …and the new one is a different object, not the same one with a new key.
  assert.notEqual(next[0].config, originalConfig);
  assert.equal(next[0].config.month, '2026-09');
});

test('two added sections do not share the registry default config', () => {
  const one = addSection([], 'alpha', REGISTRY);
  const two = addSection(one, 'alpha', REGISTRY);

  assert.notEqual(two[0].config, two[1].config, 'both sections hold one config object');
  assert.notEqual(two[0].config.tags, two[1].config.tags, 'both sections hold one array');

  // And neither of them is the registry's own object, or editing a section
  // would change what every future "add" starts from, for the whole session.
  assert.notEqual(two[0].config, REGISTRY.alpha.defaultConfig);
  assert.notEqual(two[0].config.tags, REGISTRY.alpha.defaultConfig.tags);
});

// ---------------------------------------------------------------------------
// Property 2: order is dense 0..n-1 after everything
// ---------------------------------------------------------------------------

test('add, remove and reorder all leave a dense 0..n-1 order', () => {
  const home = storedHome();

  assert.deepEqual(ordersOf(addSection(home, 'beta', REGISTRY)), dense(4));
  assert.deepEqual(ordersOf(removeSection(home, 'bbb')), dense(2));
  assert.deepEqual(ordersOf(reorderSections(home, 'ccc', 'aaa')), dense(3));
});

test('a list arriving with holes and gaps comes back dense and in that order', () => {
  // What a removal on an older client, or a hand-edited document, looks like.
  const ragged = [
    { _id: 'x', type: 'beta', order: 7, width: 'full', config: {} },
    { _id: 'y', type: 'beta', order: 2, width: 'full', config: {} },
    { _id: 'z', type: 'beta', order: 4.5, width: 'full', config: {} },
  ];

  const out = normaliseHome(ragged);

  assert.deepEqual(keysOf(out), ['y', 'z', 'x'], 'sorted by the order it had');
  assert.deepEqual(ordersOf(out), dense(3));
});

test('two sections claiming one slot keep the order they arrived in', () => {
  // The one case the server cannot renumber away, and the client must sort it
  // the same way the server does or the list jumps on the next load.
  const tied = [
    { _id: 'first', type: 'beta', order: 3, width: 'full', config: {} },
    { _id: 'second', type: 'beta', order: 3, width: 'full', config: {} },
  ];

  assert.deepEqual(keysOf(normaliseHome(tied)), ['first', 'second']);
});

test('an append lands at the end and takes the next order', () => {
  const out = addSection(storedHome(), 'beta', REGISTRY);

  assert.equal(out.length, 4);
  assert.equal(out[3].type, 'beta');
  assert.equal(out[3].order, 3);
  // The three that were already arranged did not move.
  assert.deepEqual(keysOf(out).slice(0, 3), ['aaa', 'bbb', 'ccc']);
});

// ---------------------------------------------------------------------------
// addSection
// ---------------------------------------------------------------------------

test('a new section takes the registry width, or full when there is none usable', () => {
  assert.equal(addSection([], 'alpha', REGISTRY)[0].width, 'half');
  assert.equal(addSection([], 'beta', REGISTRY)[0].width, 'full');
  // 'nonsense' is not a width. It must not reach the document: the server
  // refuses the save outright, losing every other section's edits with it.
  assert.equal(addSection([], 'gamma', REGISTRY)[0].width, 'full');
});

test('a type the registry does not know is refused, and the list is handed back', () => {
  const home = storedHome();

  // By identity: "nothing happened" has to be distinguishable from "something
  // happened and produced a similar list".
  assert.equal(addSection(home, 'notAType', REGISTRY), home);
  assert.equal(addSection(home, '', REGISTRY), home);
  assert.equal(addSection(home, 'alpha', null), home);
});

test('local keys are unique within the list and are not ObjectId-shaped', () => {
  let home = [];
  for (let i = 0; i < 4; i += 1) home = addSection(home, 'beta', REGISTRY);

  const keys = keysOf(home);
  assert.equal(new Set(keys).size, 4, 'two sections share a key');
  for (const key of keys) {
    assert.ok(key.startsWith('new-'), `${key} does not look local`);
    // A 24-hex string would be kept by the server as a real `_id`. These must
    // never be mistakable for one.
    assert.ok(!/^[0-9a-f]{24}$/i.test(key));
  }

  // Mixed with stored sections, the derived key still cannot collide.
  const mixed = addSection([...storedHome(), ...home], 'beta', REGISTRY);
  assert.equal(new Set(keysOf(mixed)).size, mixed.length);
});

// ---------------------------------------------------------------------------
// removeSection
// ---------------------------------------------------------------------------

test('remove drops exactly the addressed section', () => {
  const out = removeSection(storedHome(), 'bbb');

  assert.deepEqual(keysOf(out), ['aaa', 'ccc']);
  assert.deepEqual(ordersOf(out), dense(2));
});

test('removing something that is not there changes nothing', () => {
  const home = storedHome();
  assert.equal(removeSection(home, 'nope'), home);
  assert.equal(removeSection(home, ''), home);
  assert.equal(removeSection(home, null), home);
});

// ---------------------------------------------------------------------------
// reorderSections — the drag result, both directions
// ---------------------------------------------------------------------------

test('reorder moves the dragged section to where the target sits — downwards', () => {
  // Drag the first onto the third: it should END UP third, not second.
  const out = reorderSections(storedHome(), 'aaa', 'ccc');

  assert.deepEqual(keysOf(out), ['bbb', 'ccc', 'aaa']);
  assert.deepEqual(ordersOf(out), dense(3));
});

test('reorder moves the dragged section to where the target sits — upwards', () => {
  const out = reorderSections(storedHome(), 'ccc', 'aaa');

  assert.deepEqual(keysOf(out), ['ccc', 'aaa', 'bbb']);
  assert.deepEqual(ordersOf(out), dense(3));
});

test('reorder is reversible: the same drag back restores the list', () => {
  const home = storedHome();
  const moved = reorderSections(home, 'aaa', 'ccc');
  const back = reorderSections(moved, 'aaa', 'bbb');

  // 'aaa' is last after the first move; dropping it on 'bbb' (now first) puts
  // it back at the top.
  assert.deepEqual(keysOf(back), ['aaa', 'bbb', 'ccc']);
  assert.deepEqual(ordersOf(back), dense(3));
});

test('a drag that went nowhere, or onto nothing, changes nothing', () => {
  const home = storedHome();
  assert.equal(reorderSections(home, 'aaa', 'aaa'), home);
  assert.equal(reorderSections(home, 'aaa', 'ghost'), home);
  assert.equal(reorderSections(home, 'ghost', 'aaa'), home);
  assert.equal(reorderSections(home, null, undefined), home);
});

test('reorder addresses a not-yet-saved section by its local key', () => {
  // The interesting case: somebody adds a section and drags it before saving.
  const home = addSection(storedHome(), 'beta', REGISTRY);
  const added = sectionKey(home[3]);

  const out = reorderSections(home, added, 'aaa');

  assert.deepEqual(keysOf(out), [added, 'aaa', 'bbb', 'ccc']);
  assert.deepEqual(ordersOf(out), dense(4));
});

// ---------------------------------------------------------------------------
// setWidth
// ---------------------------------------------------------------------------

test('setWidth accepts only full and half', () => {
  const home = storedHome();

  assert.equal(setWidth(home, 'aaa', 'half')[0].width, 'half');
  assert.equal(setWidth(home, 'bbb', 'full')[1].width, 'full');

  // Everything else is refused rather than coerced: a coerced width would be a
  // layout nobody chose, and the server's enum would reject the save anyway.
  for (const bad of ['third', 'FULL', '', null, undefined, 0, ['half']]) {
    assert.equal(setWidth(home, 'aaa', bad), home, `accepted ${JSON.stringify(bad)}`);
  }

  // And the vocabulary itself is the two the model stores.
  assert.deepEqual([...WIDTHS], ['full', 'half']);
});

test('setWidth to the width it already has does not arm the Save button', () => {
  const home = storedHome();
  // Identity, because that is what a dirty check compares.
  assert.equal(setWidth(home, 'aaa', 'full'), home);
  assert.equal(setWidth(home, 'ghost', 'half'), home);
});

test('setWidth touches one section and leaves its neighbours alone', () => {
  const home = storedHome();
  const out = setWidth(home, 'bbb', 'full');

  assert.equal(out[1].width, 'full');
  assert.equal(out[0].width, home[0].width);
  assert.equal(out[2].width, home[2].width);
  assert.deepEqual(out[0].config, home[0].config);
});

// ---------------------------------------------------------------------------
// setConfig — merging, because a form does not own every key
// ---------------------------------------------------------------------------

test('setConfig merges rather than replaces', () => {
  // `ccc` is narrowed to a month AND a board. A form that edits the month must
  // not delete the board — nor, in the real `goalScores` case, the `groups`
  // narrowing, which no form in the editor can even show.
  const out = setConfig(storedHome(), 'ccc', { month: '2026-09' });

  assert.deepEqual(out[2].config, { board: 'b2', month: '2026-09' });
});

test('setConfig can write null, because null is a real value', () => {
  // `month: null` means "always the current month" — the difference between a
  // home that follows the calendar and one frozen in January.
  const out = setConfig(storedHome(), 'ccc', { month: null });

  assert.equal(out[2].config.month, null);
  assert.equal(out[2].config.board, 'b2');
});

test('setConfig adds a key the stored config never had', () => {
  const out = setConfig(storedHome(), 'bbb', { title: 'Reminder' });
  assert.deepEqual(out[1].config, { text: 'hello', title: 'Reminder' });
});

test('setConfig refuses a patch that is not an object, and an unknown id', () => {
  const home = storedHome();

  for (const bad of ['abc', 42, null, undefined, ['month']]) {
    assert.equal(setConfig(home, 'aaa', bad), home, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(setConfig(home, 'ghost', { month: null }), home);
});

test('setConfig survives a section stored without a config at all', () => {
  const home = [{ _id: 'x', type: 'beta', order: 0, width: 'full' }];
  const out = setConfig(home, 'x', { text: 'now there is one' });

  assert.deepEqual(out[0].config, { text: 'now there is one' });
});

// ---------------------------------------------------------------------------
// configDefaultsFor
// ---------------------------------------------------------------------------

test('configDefaultsFor returns the registry defaults, as a copy', () => {
  const out = configDefaultsFor('alpha', REGISTRY);

  assert.deepEqual(out, { board: null, month: null, tags: [] });
  assert.notEqual(out, REGISTRY.alpha.defaultConfig);
  assert.notEqual(out.tags, REGISTRY.alpha.defaultConfig.tags);
});

test('configDefaultsFor is safe for a type nobody can describe', () => {
  // A stored section whose type the registry no longer lists still has to be
  // openable and removable — the config form merges this under the stored
  // config, so `{}` means "nothing to fill in", which is the truth.
  assert.deepEqual(configDefaultsFor('gamma', REGISTRY), {}); // no defaultConfig
  assert.deepEqual(configDefaultsFor('notAType', REGISTRY), {});
  assert.deepEqual(configDefaultsFor('alpha', null), {});
  assert.deepEqual(configDefaultsFor(undefined, REGISTRY), {});
  assert.deepEqual(configDefaultsFor('alpha', { alpha: { defaultConfig: 'nope' } }), {});
});

// ---------------------------------------------------------------------------
// sectionKey and normaliseHome edge cases
// ---------------------------------------------------------------------------

test('sectionKey reads a stored id, a composed id, or a local key', () => {
  assert.equal(sectionKey({ _id: 'stored' }), 'stored');
  // The composed home envelope spells the same value `id`.
  assert.equal(sectionKey({ id: 'composed' }), 'composed');
  assert.equal(sectionKey({ key: 'new-1' }), 'new-1');
  // An ObjectId-like object, which is what an unserialised `_id` looks like.
  assert.equal(sectionKey({ _id: { toString: () => 'oid' } }), 'oid');
  assert.equal(sectionKey({}), '');
  assert.equal(sectionKey(null), '');
});

test('normaliseHome turns a missing profile into an empty list', () => {
  assert.deepEqual(normaliseHome(null), []);
  assert.deepEqual(normaliseHome(undefined), []);
  assert.deepEqual(normaliseHome('sections'), []);
});

// ---------------------------------------------------------------------------
// pickableBoards — only the boards on the view
// ---------------------------------------------------------------------------

test('pickableBoards takes profile entries or bare boards, and keeps them apart', () => {
  const fromEntries = pickableBoards([
    { board: { _id: 'b1', name: 'Acme Digital — 2026' }, label: 'Q4 Retainer', order: 0 },
    { board: { _id: 'b2', name: 'Ads' }, label: '', order: 1 },
  ]);

  assert.deepEqual(fromEntries, [
    { id: 'b1', name: 'Acme Digital — 2026', label: 'Q4 Retainer' },
    { id: 'b2', name: 'Ads', label: '' },
  ]);

  const fromBoards = pickableBoards([{ _id: 'b1', name: 'Acme Digital — 2026' }]);
  assert.deepEqual(fromBoards, [{ id: 'b1', name: 'Acme Digital — 2026', label: '' }]);
});

test('pickableBoards handles an entry whose board is still a bare id', () => {
  const out = pickableBoards([{ board: 'b9', label: 'SEO' }]);
  assert.deepEqual(out, [{ id: 'b9', name: '', label: 'SEO' }]);
});

test('pickableBoards drops junk and duplicates, keeping the first', () => {
  const out = pickableBoards([
    { board: { _id: 'b1', name: 'One' }, label: 'First' },
    null,
    { board: null },
    { board: { _id: 'b1', name: 'One' }, label: 'Second' },
    'nonsense',
  ]);

  assert.deepEqual(out, [{ id: 'b1', name: 'One', label: 'First' }]);
});

test('pickableBoards is empty for anything that is not a list', () => {
  assert.deepEqual(pickableBoards(null), []);
  assert.deepEqual(pickableBoards({ board: 'b1' }), []);
});

// ---------------------------------------------------------------------------
// boardTitle — one answer to "what is this board called here"
// ---------------------------------------------------------------------------

test('boardTitle prefers the view nickname, then the real name', () => {
  assert.equal(boardTitle({ label: 'Q4 Retainer', name: 'Acme Digital — 2026' }), 'Q4 Retainer');
  assert.equal(boardTitle({ label: '', name: 'Acme Digital — 2026' }), 'Acme Digital — 2026');
  // An entry whose board the caller only had an id for still has to render as
  // something a person can click.
  assert.equal(boardTitle({ label: '', name: '' }), 'Untitled board');
  assert.equal(boardTitle(null), 'Untitled board');
});

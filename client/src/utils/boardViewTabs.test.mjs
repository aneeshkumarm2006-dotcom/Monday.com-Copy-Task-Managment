/**
 * boardViewTabs.test.mjs — the tab-registration trap, asserted rather than
 * commented.
 *
 * Registering a board view has needed THREE coordinated edits, and getting any
 * of them wrong produced no error at all: a `visible` predicate reading a gate
 * key nobody defined evaluates to `undefined`, `undefined` is falsy, the tab is
 * filtered out, and `?view=<tab>` then falls back to the board. The feature
 * looks unshipped.
 *
 * These tests are about the CLASS of mistake, not about any one tab. Nothing
 * below names `seo`, `vault` or `connector` — they run against synthetic tab
 * tables, so they keep holding for the screens phases 6-8 add.
 *
 * Run from the client directory:
 *     node --test src/utils/boardViewTabs.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gateSignature,
  resolveView,
  resolveViewTabs,
  viewParamFor,
} from './boardViewTabs.js';

const BOARD = { value: 'board', label: 'Board', visible: () => true };

// ---------------------------------------------------------------------------
// Edit 1 and 2: the tab and the gate key
// ---------------------------------------------------------------------------

test('a tab whose gate key is missing THROWS instead of disappearing', () => {
  const tabs = [BOARD, { value: 'seo', label: 'SEO', visible: (g) => g.canViewSeo }];
  // The gate a forgetful author left behind.
  const gate = { canViewDelivery: true };

  assert.throws(() => resolveViewTabs(tabs, gate), /canViewSeo/);
  // And it names the tab, so the fix is obvious from the message alone.
  assert.throws(() => resolveViewTabs(tabs, gate), /"seo"/);
});

test('a function LABEL is audited too, not just the predicate', () => {
  // The connector tab titles itself from the gate. A missing key there produced
  // a tab labelled "undefined" rather than a missing tab — different symptom,
  // same cause, same fix.
  const tabs = [
    BOARD,
    { value: 'data', label: (g) => g.connectorLabel, visible: (g) => g.canViewAddons },
  ];
  assert.throws(
    () => resolveViewTabs(tabs, { canViewAddons: true }),
    /connectorLabel/
  );
});

test('a key that exists on Object.prototype is still a missing key', () => {
  // `g.constructor` and `g.toString` are truthy functions. Without an
  // own-property check, a typo landing on one would SHOW a tab rather than hide
  // it — the same silence with the opposite sign.
  const tabs = [{ value: 'x', label: 'X', visible: (g) => g.constructor }];
  assert.throws(() => resolveViewTabs(tabs, { canViewGoals: true }), /constructor/);
});

test('a key that exists and is false hides the tab, quietly and correctly', () => {
  const tabs = [BOARD, { value: 'seo', label: 'SEO', visible: (g) => g.canViewSeo }];
  const out = resolveViewTabs(tabs, { canViewSeo: false });
  assert.deepEqual(out.map((t) => t.value), ['board']);
});

test('a key that exists and is null or undefined is not an error', () => {
  // `connectorProvider` is legitimately null on a board with no connector. Only
  // an ABSENT key is a programming mistake; a present one holding a falsy value
  // is an answer.
  const tabs = [
    BOARD,
    { value: 'data', label: 'Data', visible: (g) => !!g.connectorProvider },
  ];
  assert.deepEqual(
    resolveViewTabs(tabs, { connectorProvider: null }).map((t) => t.value),
    ['board']
  );
  assert.deepEqual(
    resolveViewTabs(tabs, { connectorProvider: undefined }).map((t) => t.value),
    ['board']
  );
});

test('a resolved tab carries a string label, never a function', () => {
  const tabs = [
    { value: 'data', label: (g) => g.connectorLabel || 'Data', visible: () => true },
  ];
  const [tab] = resolveViewTabs(tabs, { connectorLabel: 'DataForSEO' });
  assert.equal(tab.label, 'DataForSEO');
  assert.equal(typeof tab.label, 'string');

  const [fallback] = resolveViewTabs(tabs, { connectorLabel: null });
  assert.equal(fallback.label, 'Data');
});

test('order is preserved, because the tab bar is read left to right', () => {
  const tabs = [
    BOARD,
    { value: 'a', label: 'A', visible: (g) => g.a },
    { value: 'b', label: 'B', visible: (g) => g.b },
    { value: 'c', label: 'C', visible: (g) => g.c },
  ];
  assert.deepEqual(
    resolveViewTabs(tabs, { a: true, b: false, c: true }).map((t) => t.value),
    ['board', 'a', 'c']
  );
});

// ---------------------------------------------------------------------------
// Edit 3: the hand-maintained dependency array
// ---------------------------------------------------------------------------

test('the gate signature changes whenever any gate value changes', () => {
  // This is what replaces the memo's hand-written dep array. A tab that appears
  // only after some unrelated state changes is the failure mode of forgetting
  // to extend that array — it works in development, where something always
  // changes, and not on a cold production load.
  const base = { canViewGoals: true, canViewSeo: false, connectorLabel: null };
  const changed = { ...base, canViewSeo: true };
  assert.notEqual(gateSignature(base), gateSignature(changed));
});

test('the signature does not depend on the order the gate was written in', () => {
  assert.equal(
    gateSignature({ a: true, b: false }),
    gateSignature({ b: false, a: true })
  );
});

test('adding a key changes the signature even when its value is undefined', () => {
  // `JSON.stringify` drops undefined values, so a naive signature would read
  // "nothing changed" for exactly the edit that adds a new gate key.
  assert.notEqual(
    gateSignature({ a: true }),
    gateSignature({ a: true, seoProvider: undefined })
  );
});

test('an unchanged gate produces an unchanged signature', () => {
  const gate = { a: true, b: 'x', c: null };
  assert.equal(gateSignature(gate), gateSignature({ ...gate }));
});

// ---------------------------------------------------------------------------
// The fallback
// ---------------------------------------------------------------------------

test('an unknown or hidden view falls back to the board', () => {
  const visible = [BOARD, { value: 'goals', label: 'Goals', visible: () => true }];
  assert.equal(resolveView('goals', visible), 'goals');
  // The exact case the missing gate key produced: a valid-looking URL for a tab
  // that is not on this board.
  assert.equal(resolveView('seo', visible), 'board');
  assert.equal(resolveView(null, visible), 'board');
  assert.equal(resolveView('', visible), 'board');
});

// ---------------------------------------------------------------------------
// The per-person allowlist — a preset, and provably not a permission
// ---------------------------------------------------------------------------
//
// A curated profile may say "this board opens with two tabs". That is a
// PRESENTATION preset, and the tests below are about the one property that
// keeps it from becoming anything else: it subtracts from what the capability
// gate returned, and never adds to it. Same discipline as above — synthetic tab
// tables, nothing named but `board`, so these keep holding as tabs come and go.

test('the allowlist hides a tab the gate was showing', () => {
  const tabs = [
    BOARD,
    { value: 'a', label: 'A', visible: () => true },
    { value: 'b', label: 'B', visible: () => true },
  ];
  assert.deepEqual(
    resolveViewTabs(tabs, {}, { allow: ['board', 'a'] }).map((t) => t.value),
    ['board', 'a']
  );
});

test('the allowlist NEVER shows a tab the gate hid', () => {
  // The whole point. `b` is listed and the capability says no; the capability
  // wins, because the allowlist only ever filters the gate's OUTPUT. If this
  // ever fails, a presentation preset has become a permission.
  const tabs = [
    BOARD,
    { value: 'a', label: 'A', visible: () => true },
    { value: 'b', label: 'B', visible: (g) => g.canB },
  ];
  assert.deepEqual(
    resolveViewTabs(tabs, { canB: false }, { allow: ['board', 'a', 'b'] }).map(
      (t) => t.value
    ),
    ['board', 'a']
  );
});

test('the board tab survives an allowlist that leaves it out', () => {
  // A page with no tabs is a page nobody can use. The profile's validator
  // refuses to STORE such a list; this is the render-side half of the same
  // rule, for the documents that were written before it or around it.
  const tabs = [BOARD, { value: 'a', label: 'A', visible: () => true }];
  assert.deepEqual(
    resolveViewTabs(tabs, {}, { allow: ['a'] }).map((t) => t.value),
    ['board', 'a']
  );
});

test('an empty allowlist still leaves the board tab', () => {
  const tabs = [BOARD, { value: 'a', label: 'A', visible: () => true }];
  assert.deepEqual(
    resolveViewTabs(tabs, {}, { allow: [] }).map((t) => t.value),
    ['board']
  );
});

test('an allowlist preserves registry order rather than its own', () => {
  // The bar is read left to right and the registry decides that order. A list
  // written back-to-front is a list, not a rearrangement.
  const tabs = [
    BOARD,
    { value: 'a', label: 'A', visible: () => true },
    { value: 'b', label: 'B', visible: () => true },
    { value: 'c', label: 'C', visible: () => true },
  ];
  assert.deepEqual(
    resolveViewTabs(tabs, {}, { allow: ['c', 'a', 'board'] }).map((t) => t.value),
    ['board', 'a', 'c']
  );
});

test('no allowlist is byte for byte what it was before there was one', () => {
  // Invariant 7: nobody else's screen changes. Every reader without a profile
  // takes this path, so "the same answer" is not good enough — it has to be the
  // same loop, and the cheapest way to keep somebody honest about that is to
  // assert that all four spellings of "no allowlist" agree exactly.
  const tabs = [
    BOARD,
    { value: 'a', label: (g) => g.aLabel || 'A', visible: (g) => g.canA },
    { value: 'b', label: 'B', visible: (g) => g.canB },
  ];
  const gate = { canA: true, canB: false, aLabel: 'Alpha' };

  const baseline = resolveViewTabs(tabs, gate);
  assert.deepEqual(resolveViewTabs(tabs, gate, {}), baseline);
  assert.deepEqual(resolveViewTabs(tabs, gate, { allow: null }), baseline);
  assert.deepEqual(resolveViewTabs(tabs, gate, { allow: undefined }), baseline);
  // And it really did resolve the label, so the comparison above is comparing
  // something rather than two empty lists.
  assert.deepEqual(baseline.map((t) => t.label), ['Board', 'Alpha']);
});

test('the gate audit still throws for a tab the allowlist excludes', () => {
  // The gate runs FIRST, for every registered tab, including ones about to be
  // dropped. Otherwise a missing gate key would go unnoticed for as long as
  // somebody's preset happened to exclude that tab — the same silent-hide bug
  // this file exists to end, wearing a preset as a disguise.
  const tabs = [BOARD, { value: 'a', label: 'A', visible: (g) => g.canA }];
  assert.throws(
    () => resolveViewTabs(tabs, {}, { allow: ['board'] }),
    /canA/
  );
});

test('the allowlist is invisible to the gate signature, on purpose', () => {
  // It is not a gate key: no predicate reads it, and the Proxy only throws for
  // keys a predicate READS, so putting it in the gate would be dead weight that
  // still moved the signature. The consequence is the thing worth pinning —
  // anyone memoising `resolveViewTabs` on `gateSignature` ALONE will not see an
  // allowlist arrive, and must add it to the memo key themselves.
  const gate = { canA: true };
  assert.equal(gateSignature(gate), gateSignature(gate));
  assert.deepEqual(
    resolveViewTabs([BOARD], gate, { allow: ['board'] }).map((t) => t.value),
    ['board']
  );
});

// ---------------------------------------------------------------------------
// The fallback, when somebody names one
// ---------------------------------------------------------------------------

test('a named default opens instead of the board', () => {
  const visible = [BOARD, { value: 'a', label: 'A', visible: () => true }];
  assert.equal(resolveView(null, visible, 'a'), 'a');
  assert.equal(resolveView('', visible, 'a'), 'a');
});

test('the URL still wins over a named default', () => {
  // The default is what to do when the URL says nothing usable. A link somebody
  // pasted says something, and that is the whole reason the view lives in the
  // URL in the first place.
  const visible = [
    BOARD,
    { value: 'a', label: 'A', visible: () => true },
    { value: 'b', label: 'B', visible: () => true },
  ];
  assert.equal(resolveView('b', visible, 'a'), 'b');
});

test('a default that is not visible falls back to the board, not to a blank pane', () => {
  // The case the allowlist creates: a preset naming a tab that a capability —
  // or the allowlist itself — has since removed. Re-checking the fallback is
  // already this function's job, which is why no caller may re-implement it.
  const visible = [BOARD, { value: 'a', label: 'A', visible: () => true }];
  assert.equal(resolveView(null, visible, 'b'), 'board');
  assert.equal(resolveView('b', visible, 'b'), 'board');
});

// ---------------------------------------------------------------------------
// Writing the view back — the other half of the fallback
// ---------------------------------------------------------------------------
//
// A fallback does not only change what an empty URL READS as, it changes what
// an empty URL can be used to SAY. Deleting `?view=` used to mean "the board
// tab" and now means "this reader's default", which broke the Board tab's own
// click and every deep link that returns to the rows by clearing the view
// first. `viewParamFor` is that rule; these pin it, because the page it is
// called from has no test harness and the failure is silent by construction —
// a URL that does not change re-renders nothing and reports nothing.

const VISIBLE = [BOARD, { value: 'a', label: 'A', visible: () => true }];

test('with no preset, the board tab is still spelled by deleting the param', () => {
  // Invariant 7, on the write side: the reader without a profile must take the
  // path they always took, not a new one that happens to agree.
  assert.equal(viewParamFor('board', VISIBLE), null);
  assert.equal(viewParamFor('a', VISIBLE), 'a');
  // And the same with the fallback passed explicitly as the board, which is how
  // the page spells "this reader has no default".
  assert.equal(viewParamFor('board', VISIBLE, 'board'), null);
  assert.equal(viewParamFor('a', VISIBLE, 'board'), 'a');
});

test('with a preset, the board tab is spelled OUT rather than by silence', () => {
  // The bug: `delete('view')` on a URL that has no `view` produces the same URL
  // and therefore no navigation, so the Board tab could not be clicked at all
  // and `highlightTask` was never revealed.
  assert.equal(viewParamFor('board', VISIBLE, 'a'), 'board');
  // Round trip: what this writes is what `resolveView` reads back.
  assert.equal(resolveView(viewParamFor('board', VISIBLE, 'a'), VISIBLE, 'a'), 'board');
});

test('with a preset, the preset tab is spelled out too', () => {
  // The tempting optimisation is to delete the parameter whenever `next` is
  // what an empty URL would resolve to. It is refused: a bare board URL that
  // opens a different tab for each reader is a link to somebody's preference,
  // not a link to a tab, and the view lives in the URL precisely so it can be
  // pasted to a colleague.
  assert.equal(viewParamFor('a', VISIBLE, 'a'), 'a');
});

test('a preset naming a tab this board does not show writes the old URL', () => {
  // `resolveView` already collapses an unusable default back to the board, and
  // this asks IT rather than comparing against the raw preference — otherwise
  // the two would disagree and this reader would get `?view=board` spelled out
  // to mean the thing an empty URL already meant.
  assert.equal(viewParamFor('board', VISIBLE, 'gone'), null);
  assert.equal(viewParamFor('a', VISIBLE, 'gone'), 'a');
});

test('what is written always reads back as the tab that was asked for', () => {
  // The property that actually matters, over every combination of preset and
  // destination: writing then reading is the identity. If this ever fails, some
  // click somewhere navigates to a tab nobody chose.
  const tabs = [BOARD, { value: 'a', label: 'A', visible: () => true },
    { value: 'b', label: 'B', visible: () => true }];
  for (const fallback of ['board', 'a', 'b', 'gone', undefined]) {
    for (const next of ['board', 'a', 'b']) {
      const param = viewParamFor(next, tabs, fallback);
      assert.equal(
        resolveView(param, tabs, fallback === undefined ? 'board' : fallback),
        next,
        `writing ${next} with fallback ${fallback} read back wrong`
      );
    }
  }
});

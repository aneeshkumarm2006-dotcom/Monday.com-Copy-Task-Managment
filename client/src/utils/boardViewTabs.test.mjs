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

import { gateSignature, resolveView, resolveViewTabs } from './boardViewTabs.js';

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

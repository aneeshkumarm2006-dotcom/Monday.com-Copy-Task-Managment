/**
 * connectorScreens.test.mjs — the three derivation rules, asserted.
 *
 * Every one of them fails SILENTLY when it is wrong: a rail that renders
 * nothing, a screen that hides data we still hold, or a heading that files a
 * domain-wide number under a project. None of those throw, and none of them look
 * broken in a screenshot.
 *
 * Nothing below names a provider — the fixtures are synthetic catalogs, so these
 * keep holding for a second kind-shaped connector.
 *
 * Run from the client directory:
 *     node --test src/utils/connectorScreens.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { OVERVIEW_KEY, screensFromKinds } from './connectorScreens.js';

const KINDS = [
  { key: 'positions', label: 'Rank tracking', blurb: 'where things rank', subject: 'project' },
  { key: 'keyword_metrics', label: 'Keywords', subject: 'project' },
  { key: 'site_audit', label: 'Site audit', subject: 'domain' },
  { key: 'backlinks', label: 'Backlinks', subject: 'domain' },
];

const keys = (screens) => screens.map((s) => s.key);

// ---------------------------------------------------------------------------
// Rule 1: an empty selection means everything
// ---------------------------------------------------------------------------

test('no selection renders every kind, not none', () => {
  const { screens } = screensFromKinds({ kinds: KINDS, selectedKinds: [] });
  assert.deepEqual(keys(screens), [
    OVERVIEW_KEY,
    'positions',
    'keyword_metrics',
    'site_audit',
    'backlinks',
  ]);
});

test('a narrowed selection renders only what it names', () => {
  const { screens } = screensFromKinds({
    kinds: KINDS,
    selectedKinds: ['positions', 'site_audit'],
  });
  assert.deepEqual(keys(screens), [OVERVIEW_KEY, 'positions', 'site_audit']);
});

// ---------------------------------------------------------------------------
// Rule 2: a kind with a stored reading survives being switched off
// ---------------------------------------------------------------------------

test('an unselected kind that HAS a reading is still rendered', () => {
  const { screens } = screensFromKinds({
    kinds: KINDS,
    selectedKinds: ['positions'],
    snapshots: { backlinks: { kind: 'backlinks', data: {} } },
  });
  // Backlinks is no longer collected, but three months of it are stored and
  // hiding the screen would present that as deleted.
  assert.deepEqual(keys(screens), [OVERVIEW_KEY, 'positions', 'backlinks']);
});

test('a null snapshot does NOT resurrect an unselected kind', () => {
  const { screens } = screensFromKinds({
    kinds: KINDS,
    selectedKinds: ['positions'],
    snapshots: { backlinks: null },
  });
  assert.deepEqual(keys(screens), ['positions']);
});

// ---------------------------------------------------------------------------
// Rule 3: the grouping comes off `subject`
// ---------------------------------------------------------------------------

test('two subjects produce two headings, in catalog order', () => {
  const { screens, groups } = screensFromKinds({ kinds: KINDS });
  assert.deepEqual(
    groups.map((g) => g.key),
    ['project', 'domain']
  );
  assert.equal(screens.find((s) => s.key === 'positions').group, 'project');
  assert.equal(screens.find((s) => s.key === 'backlinks').group, 'domain');
  // The overview belongs to no subject and must sit above the first heading.
  assert.equal(screens[0].group, null);
});

test('one subject produces NO headings — a single heading is noise', () => {
  const { screens, groups } = screensFromKinds({
    kinds: KINDS.filter((k) => k.subject === 'project'),
  });
  assert.deepEqual(groups, []);
  assert.ok(screens.every((s) => s.group === null));
});

test('an unknown subject is filed under More rather than dropped', () => {
  const { screens, groups } = screensFromKinds({
    kinds: [...KINDS, { key: 'weather', label: 'Weather', subject: 'sky' }],
  });
  assert.ok(keys(screens).includes('weather'));
  assert.equal(screens.find((s) => s.key === 'weather').group, '__more');
  assert.equal(groups.filter((g) => g.key === '__more').length, 1);
});

test('two unknown subjects share ONE More heading', () => {
  const { groups } = screensFromKinds({
    kinds: [
      ...KINDS,
      { key: 'weather', label: 'Weather', subject: 'sky' },
      { key: 'tides', label: 'Tides', subject: 'sea' },
    ],
  });
  assert.equal(groups.filter((g) => g.key === '__more').length, 1);
});

// ---------------------------------------------------------------------------
// The synthetic overview
// ---------------------------------------------------------------------------

test('a single rendered kind gets no overview', () => {
  const { screens } = screensFromKinds({
    kinds: KINDS,
    selectedKinds: ['positions'],
  });
  assert.deepEqual(keys(screens), ['positions']);
});

test('a provider declaring its OWN overview kind keeps it', () => {
  const { screens } = screensFromKinds({
    kinds: [{ key: OVERVIEW_KEY, label: 'Summary', subject: 'project' }, ...KINDS],
  });
  assert.equal(screens[0].key, OVERVIEW_KEY);
  assert.equal(screens[0].label, 'Summary');
  // And exactly once — the synthetic one must not be prepended beside it.
  assert.equal(keys(screens).filter((k) => k === OVERVIEW_KEY).length, 1);
});

test('an empty catalog produces nothing rather than a lone overview', () => {
  const { screens, groups } = screensFromKinds({ kinds: [] });
  assert.deepEqual(screens, []);
  assert.deepEqual(groups, []);
});

test('the blurb travels from the kind, so the heading needs no second catalog', () => {
  const { screens } = screensFromKinds({ kinds: KINDS });
  assert.equal(screens.find((s) => s.key === 'positions').blurb, 'where things rank');
  // A kind with no blurb gets an empty string, never `undefined` in the DOM.
  assert.equal(screens.find((s) => s.key === 'keyword_metrics').blurb, '');
});

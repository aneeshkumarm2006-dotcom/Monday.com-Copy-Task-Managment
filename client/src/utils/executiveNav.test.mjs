/**
 * executiveNav.test.mjs — invariant 6, asserted rather than commented.
 *
 * "A nav switch can hide an entry, never reveal one" is the sentence the whole
 * Executive View feature rests on when it lets the Executive edit their OWN
 * profile. If it ever stopped being true, the failure would not look like a
 * bug: it would look like a checkbox in somebody's settings that hands them a
 * page their role was built to keep from them. Nothing would throw, nothing
 * would warn, and the server would go on refusing the requests that page makes
 * — so the symptom is a broken screen for the one person nobody wants to hand
 * a broken screen to.
 *
 * These tests are therefore about the CLASS of mistake, not about any one row:
 *
 *   1. Only ever a subtraction (a switch cannot add a row, and neither can the
 *      `always` list).
 *   2. Home and Settings survive everything (an app you cannot navigate is not
 *      a customised app).
 *   3. No profile changes literally nothing (the non-Executive rail must be
 *      provably the one that shipped before this feature existed).
 *
 * Real routes appear below because the route→key MAP is itself under test —
 * that is the one thing here that cannot be asserted against synthetic data,
 * since drifting from the server's `NAV_KEYS` is exactly the mistake the mirror
 * test catches. Everything else is written so it keeps holding when the rail
 * gains or loses rows.
 *
 * Run from the client directory:
 *     node --test src/utils/executiveNav.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALWAYS_VISIBLE_ROUTES,
  NAV_KEYS,
  NAV_KEY_BY_ROUTE,
  applyNavSwitches,
  navKeyForRoute,
} from './executiveNav.js';

/** A rail's worth of rows, of the shape `SideRail.jsx` builds. */
const RAIL = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/boards', label: 'My Boards' },
  { to: '/my-tasks', label: 'My Work' },
  { to: '/chat', label: 'Chat' },
  { to: '/members', label: 'Members' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/productivity', label: 'Productivity' },
  { to: '/settings', label: 'Settings' },
];

const routesOf = (entries) => entries.map((e) => e.to);

/** Every switch set to the same answer — the two ends of the range. */
const allNav = (value) =>
  NAV_KEYS.reduce((nav, key) => ({ ...nav, [key]: value }), {});

// ---------------------------------------------------------------------------
// Property (a): it can only HIDE
// ---------------------------------------------------------------------------

test('a switch cannot reveal a row the capability gate already removed', () => {
  // The gates run first, so this is the list AFTER a person without
  // `analytics.view` or `org.view_members` has been filtered down. Their
  // profile says those destinations are on. They must still not be there:
  // a profile is presentation, and presentation cannot grant.
  const gated = [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/boards', label: 'My Boards' },
    { to: '/settings', label: 'Settings' },
  ];

  const out = applyNavSwitches(gated, allNav(true));

  assert.deepEqual(routesOf(out), ['/dashboard', '/boards', '/settings']);
  assert.ok(!routesOf(out).includes('/analytics'));
  assert.ok(!routesOf(out).includes('/members'));
});

test('the result is always a subsequence of the input — same objects, same order', () => {
  // The strongest form of "it can only hide": every row that comes out went in,
  // by identity, and nothing overtook anything. A future rewrite that builds a
  // fresh list from the nav keys instead of filtering would fail here long
  // before it failed in a way anybody could see.
  const nav = { boards: true, myWork: false, chat: true, members: false, analytics: true, productivity: false };
  const out = applyNavSwitches(RAIL, nav);

  let cursor = -1;
  for (const entry of out) {
    const at = RAIL.indexOf(entry); // identity, not deep equality
    assert.ok(at > cursor, `${entry.to} is not in its original position`);
    cursor = at;
  }
});

test('an entry whose route has no nav key survives every switch', () => {
  // Adding a rail row must be safe. An unrecognised route means "not
  // switchable", never "switched off" — otherwise the day somebody adds a row
  // it would be invisible to every Executive in every workspace, and the bug
  // report would read "the new feature never shipped for the executives",
  // filed weeks later by whichever of them noticed first.
  const withNewRow = [...RAIL, { to: '/invoices', label: 'Invoices' }];
  const out = applyNavSwitches(withNewRow, allNav(false));

  assert.ok(routesOf(out).includes('/invoices'));
});

test('an unknown key in the profile changes nothing', () => {
  // A retired switch, or one from a build ahead of this client. It names no
  // route here, so it can have no effect — this helper only ever asks about
  // entries it was handed.
  const out = applyNavSwitches(RAIL, { ...allNav(true), timesheets: false, boards: false });

  assert.deepEqual(
    routesOf(out),
    RAIL.map((e) => e.to).filter((to) => to !== '/boards')
  );
});

test('the input array is not mutated', () => {
  const before = [...RAIL];
  applyNavSwitches(RAIL, allNav(false));
  assert.deepEqual(RAIL, before);
});

// ---------------------------------------------------------------------------
// Property (b): Home and Settings are never hideable
// ---------------------------------------------------------------------------

test('turning every switch off still leaves Home and Settings', () => {
  // The lockout case. A rail with no way to the home page and no way to the
  // settings that own the switches is an app with no way out of the choice the
  // person just made.
  const out = applyNavSwitches(RAIL, allNav(false));
  assert.deepEqual(routesOf(out), ['/dashboard', '/settings']);
});

test('Home and Settings are protected even if a switch is invented for them', () => {
  // Neither is in NAV_KEYS, so this profile is already malformed — but the
  // protection is checked BEFORE the profile is consulted, so it cannot matter
  // what a malformed one says.
  const out = applyNavSwitches(RAIL, { ...allNav(false), dashboard: false, settings: false, home: false });
  assert.deepEqual(routesOf(out), ['/dashboard', '/settings']);
});

test('the always-list protects rows, it does not add them', () => {
  // `always` is an override for a second surface's rule, not a way to compose a
  // rail. Naming a route that is not in `entries` must stay a no-op, or the one
  // parameter here would be the hole in invariant 6.
  const gated = [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/chat', label: 'Chat' },
  ];
  const out = applyNavSwitches(gated, allNav(false), {
    always: ['/dashboard', '/chat', '/analytics'],
  });

  assert.deepEqual(routesOf(out), ['/dashboard', '/chat']);
});

test('emptying the always-list still leaves Home and Settings — belt AND braces', () => {
  // Two independent mechanisms protect those two rows, and this asserts the
  // second one. `always` is the explicit guard; the implicit one is that
  // neither route is in the map at all, so even with the guard removed they
  // are unswitchable rather than merely exempt. A caller that passes its own
  // `always` and forgets them does not lock anybody out.
  const out = applyNavSwitches(RAIL, allNav(true), { always: [] });
  assert.deepEqual(routesOf(out), routesOf(RAIL));

  const none = applyNavSwitches(RAIL, allNav(false), { always: [] });
  assert.deepEqual(routesOf(none), ['/dashboard', '/settings']);
});

// ---------------------------------------------------------------------------
// Property (c): no profile means no change at all
// ---------------------------------------------------------------------------

test('no profile returns the very same array, not a copy of it', () => {
  // Identity, deliberately. "Provably identical to today's rail" is a claim
  // about the array the component renders, and deep equality would still pass
  // for a rebuilt list that had quietly dropped a row.
  assert.equal(applyNavSwitches(RAIL, null), RAIL);
  assert.equal(applyNavSwitches(RAIL, undefined), RAIL);
  assert.equal(applyNavSwitches(RAIL), RAIL);
});

test('a malformed nav is treated as no profile, never as all-off', () => {
  // It arrives over the network. "Nothing hidden" is the only safe reading of
  // a value this helper cannot interpret — an all-off reading would empty a
  // person's rail because a response was mangled.
  assert.equal(applyNavSwitches(RAIL, 'boards'), RAIL);
  assert.equal(applyNavSwitches(RAIL, 0), RAIL);
  assert.equal(applyNavSwitches(RAIL, false), RAIL);
});

test('an EMPTY nav object is a profile, and hides nothing', () => {
  // Distinct from the case above: `{}` is a real profile whose switches are all
  // at their default, and the default is on. It gets filtered (a new array),
  // and the filter keeps everything.
  const out = applyNavSwitches(RAIL, {});
  assert.deepEqual(routesOf(out), routesOf(RAIL));
});

test('a missing key means ON, because that is the model default', () => {
  // A profile written before a switch existed, or a partial optimistic update.
  // The default state of being made an Executive is that everything is still
  // there, so an absent key cannot read as "hide this".
  const out = applyNavSwitches(RAIL, { chat: false });
  assert.deepEqual(
    routesOf(out),
    RAIL.map((e) => e.to).filter((to) => to !== '/chat')
  );
});

// ---------------------------------------------------------------------------
// Matching by route, not by label
// ---------------------------------------------------------------------------

test('a row is matched by its route, not its label', () => {
  // Labels get renamed and translated. If the key came from the label, either
  // would unhook every switch silently. These two rows swap labels; the
  // switches must follow the ROUTES.
  const renamed = [
    { to: '/dashboard', label: 'Home' },
    { to: '/chat', label: 'Messages' },
    { to: '/messages', label: 'Chat' },
  ];
  const out = applyNavSwitches(renamed, { chat: false });

  // '/chat' went, despite being labelled "Messages".
  // '/messages' stayed, despite being labelled "Chat" — it has no nav key.
  assert.deepEqual(routesOf(out), ['/dashboard', '/messages']);
});

test('a query string or trailing slash does not unhook a switch', () => {
  // `utils/myWorkFilters.js` builds `/my-tasks?due=overdue` for deep links. A
  // row gaining one of those must not stop obeying its switch.
  const deepLinked = [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/my-tasks?due=overdue', label: 'My Work' },
    { to: '/chat/', label: 'Chat' },
  ];
  const out = applyNavSwitches(deepLinked, { myWork: false, chat: false });

  assert.deepEqual(routesOf(out), ['/dashboard']);
});

test('a row with no route at all is never hidden', () => {
  // Nothing renders one today, but a helper that threw on a malformed row
  // would take the whole rail with it.
  const out = applyNavSwitches([{ label: 'Orphan' }, { to: null, label: 'Nully' }], allNav(false));
  assert.equal(out.length, 2);
});

test('navKeyForRoute answers with the key, or null for an unswitchable route', () => {
  assert.equal(navKeyForRoute('/my-tasks'), 'myWork');
  assert.equal(navKeyForRoute('/my-tasks?due=today'), 'myWork');
  assert.equal(navKeyForRoute('/invoices'), null);
  assert.equal(navKeyForRoute('/dashboard'), null); // never switchable
  assert.equal(navKeyForRoute(undefined), null);
});

// ---------------------------------------------------------------------------
// The map and the model
// ---------------------------------------------------------------------------

test('the map names all eight switches the profile stores, in rail order', () => {
  // Mirrors `NAV_KEYS` in server/src/models/ExecutiveView.js. Nothing can
  // import across the two halves of the repo, so this is the only thing
  // standing between a switch added server-side and a client that ignores it
  // forever. Calendar and Notifications are in the list on purpose: they are
  // switchable destinations with no rail row TODAY, and the helper is written
  // so the day one gains a row it obeys its switch with no edit here.
  assert.deepEqual(NAV_KEYS, [
    'boards',
    'myWork',
    'chat',
    'calendar',
    'notifications',
    'members',
    'analytics',
    'productivity',
  ]);
  assert.equal(Object.keys(NAV_KEY_BY_ROUTE).length, 8);
});

test('neither always-visible route is switchable', () => {
  // Belt and braces on the lockout: if somebody ever adds `/settings` to the
  // map, the protection above is the only thing still holding — and this fails
  // first, at the place where the mistake was made.
  for (const route of ALWAYS_VISIBLE_ROUTES) {
    assert.equal(NAV_KEY_BY_ROUTE[route], undefined, `${route} must not be switchable`);
  }
});

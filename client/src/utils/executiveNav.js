/**
 * Executive nav switches — the rail rows a profile is allowed to TAKE AWAY.
 *
 * An Executive's profile carries a `nav` object of eight Booleans, all `true`
 * by default (`server/src/models/ExecutiveView.js`, `NAV_KEYS`). This module is
 * the one place that turns those Booleans into a shorter list of rail rows.
 *
 * ---- The property this file exists to guarantee -----------------------------
 *
 * Spec invariant 6: **a switch can only hide an entry the capability already
 * allows. It can never show one the capability forbids.**
 *
 * That is not a comment here, it is the shape of the code: `applyNavSwitches`
 * is a FILTER over the entries it is handed. There is no branch anywhere in it
 * that can push an entry, so a row the rail's capability gates already dropped
 * cannot come back no matter what the profile says — and the profile is the one
 * part of this feature the Executive may edit themselves. Without that
 * property, "switch Analytics on" in a person's own settings would be a
 * privilege escalation with a checkbox for a UI.
 *
 * Two rows are additionally never filterable at all: Home (`/dashboard`) and
 * Settings (`/settings`). The rail IS the navigation on desktop — the rail
 * component's own header says collapsing it to nothing "would leave the app
 * with no way to move" — so a switch that could remove the way back to the home
 * page and the way into the settings that own the switches would be a one-click
 * lockout with no route out of it. Hence `ALWAYS_VISIBLE_ROUTES`, checked
 * before the profile is consulted. The model agrees: it stores eight switches
 * and neither Home nor Settings is one of them.
 *
 * ---- Why an entry is matched by its ROUTE and not by its label --------------
 *
 * A label is display text. It gets renamed the week a word tests badly, and it
 * gets translated the day this app ships in a second language; either would
 * unhook every switch, and SILENTLY — the row would simply stop obeying its
 * switch, with no error anywhere to say so. A route is an identifier: it is
 * what `NavLink` navigates to, it is in the URL bar, and changing one is
 * already a change nobody makes by accident.
 *
 * ---- Why the map names EIGHT destinations when the rail renders FEWER -------
 *
 * `NAV_KEY_BY_ROUTE` lists all eight switchable destinations, including
 * Calendar and Notifications — and `SideRail.jsx` has no row for either of them
 * today (the calendar is reached from a board, notifications from the bell in
 * the navbar). That is deliberate, and it is the reason this helper works on
 * the entries it is GIVEN rather than owning a list of its own:
 *
 *   - The profile's `nav` is the SPEC's list of switchable destinations, not a
 *     mirror of one component's current rows. Section 4.6 names all of them.
 *     Storing only the rows that happen to exist today would mean rewriting
 *     every stored profile the day one more appears.
 *   - A switch for a destination with no row is simply INERT. This module never
 *     consults `nav` except to ask about an entry it was handed, so an inert
 *     switch cannot do anything — it is not an error, a warning, or a hidden
 *     row; it is a preference waiting for a row.
 *   - The day Notifications (or anything else in the map) gains a rail row, it
 *     starts obeying its switch with NO change to this file. That is the whole
 *     point of mapping by route: adding the row is the only edit.
 *
 * The reverse case is handled just as deliberately. An entry whose route is not
 * in the map is NEVER hidden, because "unknown" here means "not switchable",
 * not "switched off". Adding a rail row is therefore safe by default: it
 * appears for everyone, Executives included, until somebody decides it should
 * be switchable and puts it in the map (and in the model's `NAV_KEYS`, which is
 * the other half of that edit — see the mirror test in `executiveNav.test.mjs`).
 *
 * ---- Why this is a separate file from SideRail.jsx --------------------------
 *
 * Same reason as `boardViewTabs.js`: no React, no JSX and no icons in here, so
 * a plain Node test can import it. The three properties above are the kind that
 * are easy to state and easy to break later, and asserting them beats
 * describing them. Inside a component they could only ever be described.
 */

/**
 * Route → profile `nav` key, in rail order.
 *
 * This is the client half of `NAV_KEYS` in `server/src/models/ExecutiveView.js`
 * — same eight names, same order. Nothing can import across the two halves of
 * the repo, so the pairing is asserted in the test instead of enforced by a
 * shared constant.
 */
export const NAV_KEY_BY_ROUTE = Object.freeze({
  '/boards': 'boards',
  '/my-tasks': 'myWork',
  '/chat': 'chat',
  '/calendar': 'calendar',
  '/notifications': 'notifications',
  '/members': 'members',
  '/analytics': 'analytics',
  '/productivity': 'productivity',
});

/**
 * The eight switch names, in rail order, derived from the map above so the two
 * cannot disagree. Exported for anything that has to RENDER the switches (the
 * configurator, the "My view" settings tab); retyping the list there would be a
 * third copy of it.
 */
export const NAV_KEYS = Object.freeze(Object.values(NAV_KEY_BY_ROUTE));

/**
 * Routes no profile may ever remove. See the header: the rail is the
 * navigation, and these two are the way home and the way to the switches.
 */
export const ALWAYS_VISIBLE_ROUTES = Object.freeze(['/dashboard', '/settings']);

/**
 * The comparable form of a route.
 *
 * Strips a query string or hash and one trailing slash, so a row that deep
 * links (`/my-tasks?due=overdue` — `utils/myWorkFilters.js` builds exactly
 * that) is still recognised as the My Work destination. Without this, a row
 * could quietly stop obeying its switch by gaining a query parameter, which is
 * not a change anybody would expect to have that effect.
 *
 * A non-string `to` collapses to `''`, which matches nothing in either list and
 * therefore survives — consistent with "unknown means not switchable".
 */
const routeKey = (to) => {
  if (typeof to !== 'string') return '';
  const path = to.split('?')[0].split('#')[0].trim();
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
};

/**
 * The profile `nav` key a rail entry answers to, or `null` when it answers to
 * none. Exported because a configurator rendering a switch beside a live rail
 * row needs the same answer this filter uses, not a second opinion.
 *
 * @param {string} to - the entry's route
 * @returns {string|null}
 */
export const navKeyForRoute = (to) => NAV_KEY_BY_ROUTE[routeKey(to)] || null;

/**
 * The entries the rail should render, after the profile's switches.
 *
 * @param {Array<{to: string, label: string}>} entries - the rows that survived
 *        the rail's own capability gates. Those gates run FIRST and are not
 *        this function's business; it never reads a capability.
 * @param {Object|null|undefined} nav - the profile's `nav` object. Null or
 *        undefined means "not an Executive".
 * @param {Object} [options]
 * @param {string[]} [options.always=ALWAYS_VISIBLE_ROUTES] - routes that are
 *        never hidden. An option rather than a constant read straight from the
 *        module, so a second surface (a preview pane in the configurator, say)
 *        can state its own rule explicitly instead of inheriting one silently.
 *        It can only ever PROTECT a row: naming a route that is not in
 *        `entries` adds nothing, because this is still a filter.
 * @returns {Array} the same entry objects, in the same order, minus the hidden
 *          ones — and the SAME ARRAY when there is no profile.
 */
export const applyNavSwitches = (entries, nav, { always = ALWAYS_VISIBLE_ROUTES } = {}) => {
  // No profile, no change — and `entries` ITSELF comes back, not a copy of it.
  // This is what makes a non-Executive's rail provably identical to the one
  // that shipped before this feature existed: not "the same contents", the same
  // array. It also keeps the identity stable for anything downstream that
  // memoises on it.
  //
  // A non-object `nav` takes the same exit. The value arrives over the network,
  // and the answer to "what does this malformed profile hide?" must be
  // "nothing" rather than "whatever `undefined[key]` happens to do".
  if (!nav || typeof nav !== 'object') return entries;

  // Defensive, for the same reason: a caller whose rows have not loaded yet
  // should get its own value back, not a crash from inside a nav helper.
  if (!Array.isArray(entries)) return entries;

  const protectedRoutes = new Set((Array.isArray(always) ? always : []).map(routeKey));

  return entries.filter((entry) => {
    const route = routeKey(entry?.to);

    // Checked before the profile, so no switch can ever reach these two.
    if (protectedRoutes.has(route)) return true;

    const key = NAV_KEY_BY_ROUTE[route];
    // Unknown route: not switchable, therefore not hidden. See the header.
    if (!key) return true;

    // An ABSENT key is not a "no". The model defaults every switch to true and
    // the validator fills missing ones in, but a profile written by an older
    // build — or a `nav` a client has only half applied optimistically — must
    // read as "on", because the default state of being made an Executive is
    // that everything is still there.
    if (!Object.prototype.hasOwnProperty.call(nav, key)) return true;

    // Truthiness rather than `=== false`: the server coerces these to real
    // Booleans, so anything else arriving here is already malformed, and a
    // malformed switch should behave like the one thing it can plausibly mean.
    return !!nav[key];
  });
};

/**
 * executiveBoards.js — an Executive's board list, in THEIR order.
 *
 * Somebody with an executive view sees My Boards as two groups: the boards
 * their profile names — in the profile's order, under the profile's labels —
 * and then everything else they can still read. This file is the arithmetic
 * behind that split, pulled out of the page so it can be tested without React.
 * What is left in the page is dnd wiring, two view modes and three modals,
 * none of which has an opinion about which board belongs in which group.
 *
 * ---- WHY THE ORDER LIVES IN THE PROFILE AND NOT ON THE BOARD ---------------
 *
 * `Board.order` is WORKSPACE-WIDE. It is one number on one board document, and
 * `reorderBoards` in `server/src/controllers/boardController.js` rewrites it
 * FOR EVERYONE: it takes a full permutation of the caller's visible boards and
 * writes each board's new index onto the board itself. That is the right
 * behaviour for a shared list — somebody tidies the workspace and the
 * workspace is tidy — and it is exactly the wrong behaviour here.
 *
 * So an Executive's drag must write the PROFILE's `boards[].order`, through
 * `PUT /api/me/executive-view` (the store's `saveMine({ boards })`), and must
 * NEVER reach `reorderBoards`. If it did, one person dragging a card in their
 * own curated four-board list would silently reorder the whole company's board
 * list: a change nobody asked for, made by somebody who could not see it
 * happen, on a screen that never mentioned anybody else, and undoable only by
 * whoever notices and drags forty cards back. The profile is the only place a
 * per-person order can be written without touching another person's screen —
 * which is the whole point of the feature (invariant 7).
 *
 * The same reasoning is why `listed` hands back the board and the entry's
 * label side by side instead of a merged object: a label is a NICKNAME for
 * finding a board in a list, not a rename, and nothing here may overwrite
 * `board.name`. See `displayName`.
 *
 * ---- WHY AN ENTRY CAN VANISH ----------------------------------------------
 *
 * A profile entry whose board is not among the boards the server sent is
 * DROPPED rather than rendered as a placeholder. `GET /api/boards` already
 * filters on `resolveAccess(...).canRead`, and `GET /api/me/executive-view`
 * already drops the same entries into its own `skipped[]` — so a missing board
 * is not a gap in the data, it is the server having said twice that this
 * person cannot open that board. The place to SEE that is the admin's
 * configurator, which is told which boards were skipped and why. On the
 * person's own screen it is simply not their board.
 */

/**
 * Id of a board, a profile entry's `board` ref, or a bare id string.
 *
 * The profile arrives as JSON, so `entry.board` is a string — but the same
 * shape read straight out of a store that populated it would be an object, and
 * a comparison that works for one and not the other fails silently by putting
 * every board in the wrong group. Never `ref.toString()`; always this.
 *
 * Exported because the page that draws this split has to match entries to cards
 * itself — the drag handler finds the ENTRY a dragged card belongs to — and a
 * second, almost-identical spelling of the same comparison living in the page
 * is how the two halves of one feature end up disagreeing about which board is
 * which. One idiom, one file.
 */
export const boardIdOf = (value) => String(value?._id ?? value ?? '');

/**
 * Sort profile entries the way the server does: by `order`, with the entry's
 * position as the tiebreaker.
 *
 * `server/src/services/executiveView.js` `withDenseOrder` renumbers `order`
 * into a dense 0..n-1 run on every save using exactly this comparison, so the
 * two sides agree about what a saved list means. The tiebreaker matters for
 * the one case the server cannot renumber away — a client that sends two
 * entries claiming the same slot — where "keep the order they arrived in"
 * beats "swap unpredictably between renders".
 */
const inProfileOrder = (entries) =>
  entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (Number.isFinite(a.entry?.order) ? a.entry.order : a.index) -
          (Number.isFinite(b.entry?.order) ? b.entry.order : b.index) ||
        a.index - b.index
    )
    .map(({ entry }) => entry);

/**
 * Split the boards the server sent into the profile's list and the remainder.
 *
 *   boards   — what `GET /api/boards` returned, in the order it returned them
 *              (that is `Board.order`, the workspace-wide one).
 *   profile  — the resolved executive view, or null.
 *
 * Returns `{ listed, other }`:
 *
 *   listed   `[{ board, label, order }]` — the profile's entries, in profile
 *            order, each resolved against a board the server actually sent.
 *            `order` is the POSITION IN THIS LIST, not the stored number: once
 *            an entry has been dropped the stored numbers have gaps, and every
 *            caller so far wants "third card" rather than "order 5".
 *   other    the boards no entry claimed, in the order the server sent them.
 *
 * A null profile — the ordinary, non-executive path — returns
 * `{ listed: [], other: boards }` with `other` being the SAME ARRAY that came
 * in. Nothing is copied, reordered or re-keyed, because the page renders that
 * array for everybody who is not an Executive and "untouched" has to mean
 * untouched.
 */
export const orderBoardsForProfile = (boards, profile) => {
  const readable = Array.isArray(boards) ? boards : [];
  const entries = Array.isArray(profile?.boards) ? profile.boards : null;

  // No profile (or a profile with no boards array): the whole list is "other",
  // handed straight back.
  if (!entries) return { listed: [], other: readable };

  const byId = new Map(readable.map((board) => [boardIdOf(board), board]));

  const listed = [];
  const claimed = new Set();
  for (const entry of inProfileOrder(entries)) {
    const id = boardIdOf(entry?.board);
    const board = byId.get(id);
    // Not sent by the server ⇒ not readable ⇒ not this person's board today.
    if (!board) continue;
    // One entry per board is the document's rule and the server deduplicates
    // on save, but a duplicate that slipped through must not put the same card
    // on screen twice — and worse, must not leave the second copy in `other`.
    if (claimed.has(id)) continue;
    claimed.add(id);
    listed.push({ board, label: entry?.label || '', order: listed.length });
  }

  const other = readable.filter((board) => !claimed.has(boardIdOf(board)));
  return { listed, other };
};

/**
 * What to call this board on this person's screen.
 *
 * The profile's label wins when there is one; otherwise the board's own name.
 * An empty label is stored as '' and MEANS "use the board's own name" — the
 * model says so — so a falsy label falls through rather than rendering a blank
 * card title.
 *
 * This is a display name and only a display name. The board's real name is
 * what everybody else calls it, what the board page's <h1> shows, and what the
 * Edit form must save; a nickname that leaked into either of those is a
 * support ticket about a board that renamed itself.
 */
export const displayName = (board, entry) => entry?.label || board?.name || '';

/**
 * Every label this profile sets, keyed by board id — `Map<string, string>`.
 *
 * ---- WHY A LOOKUP AND NOT JUST `listed` ------------------------------------
 *
 * `orderBoardsForProfile` answers "which group, and what is it called" for the
 * boards that SURVIVED the search box. Search itself runs earlier, over the
 * whole list, and it needs the labels too — otherwise an Executive cannot find
 * a board by the only name they have ever seen it under.
 *
 * That is not a hypothetical. A label is a nickname for finding a board in a
 * list (spec 4.3), so the interesting case is the one where it shares no letters
 * with the real name: a board called "Acme Digital — 2026" that this person's
 * profile calls "Q4 Retainer". They read "Q4 Retainer" off the card, type "Q4",
 * and a name-only filter hands back nothing — the page renders "Nothing found"
 * for a card that was on screen one keystroke earlier. So the caller matches the
 * board's real name OR this label, and the label has to be reachable by id
 * before the split runs.
 *
 * Entries with no label are LEFT OUT rather than mapped to `board.name`: the
 * caller already tests the real name, and an entry whose label is '' means "use
 * the board's own name" (see `displayName`), not "call it the empty string".
 *
 * Read in profile order and first-writer-wins, the same way the split resolves
 * a duplicate, so the label the search matches is always the label the card is
 * actually titled with.
 */
export const labelsByBoardId = (profile) => {
  const out = new Map();
  const entries = Array.isArray(profile?.boards) ? profile.boards : [];
  for (const entry of inProfileOrder(entries)) {
    const id = boardIdOf(entry?.board);
    const label = entry?.label || '';
    if (!id || !label || out.has(id)) continue;
    out.set(id, label);
  }
  return out;
};

/* -------------------------------------------------------------------------- */
/* Per-board presets — which tab a board opens on, and which tabs it shows     */
/* -------------------------------------------------------------------------- */

/**
 * ---- WHAT A PRESET IS, AND THE TWO WAYS IT GOES WRONG ----------------------
 *
 * A profile board entry carries two more fields than a nickname and a slot:
 *
 *   defaultTab  the `?view=` value that board opens on for this person, or
 *               null for "whatever the board opens on for everybody else".
 *   tabs        an ALLOWLIST of `?view=` values, or null for "every tab".
 *
 * Neither grants anything. `resolveViewTabs` can only ever SUBTRACT from the
 * tabs the capability gate already allowed, and `resolveView` re-checks the
 * default against what survived — so a preset is a tidier screen and never a
 * wider one (invariant 6, the same rule the rail switches obey).
 *
 * The two ways it goes wrong are both silent, which is why this section exists:
 *
 * ONE: THE ALLOWLIST STRANDS THE BOARD. `tabs: []` — or `['goals']` on a board
 * whose Goals tab a capability hides — leaves a board with no reachable view.
 * The server refuses both on the way in (`validateBoardEntry` in
 * `server/src/services/executiveView.js`: non-empty, and must contain 'board'),
 * `resolveViewTabs` keeps 'board' alive a second time on the render side, and
 * `normalisePreset` below is the third: the point of the form is that nobody
 * can compose a shape the server would reject, so the client never needs
 * telling.
 *
 * TWO: THE PRESET NAMES A TAB THE BOARD CANNOT SHOW. A Goals default on a
 * standard board is a stored setting that does nothing, for ever, invisibly —
 * `resolveView` falls back to 'board' and nothing anywhere says why. The cure
 * is at the point of CHOOSING: `tabsForBoard` derives the candidates from the
 * board's own type and add-ons, so Goals is never offered on a board that has
 * no Goals, and `normalisePreset` drops a preset that outlived a board changing
 * type.
 *
 * ---- WHY `null` AND "EVERY BOX TICKED" MUST STAY DIFFERENT -----------------
 *
 * They mean different things over time. `null` says "whatever tabs this board
 * has"; a list of all ten says "these ten". The day an eleventh tab ships, the
 * first keeps up and the second freezes — for one person, on one board, with
 * nothing on screen to explain it. So nothing here ever folds one into the
 * other: a full list stays a list, and only an absent or emptied `tabs` is
 * null.
 */

/**
 * The one tab an allowlist may never drop.
 *
 * `BASE_TAB` on the server (`services/executiveView.js`), `'board'` in
 * `VIEW_TABS`, and the tab whose `visible` predicate is `() => true`. A board
 * with no tabs cannot be opened at all, so this one survives every filter on
 * every side.
 */
export const BASE_TAB = 'board';

/**
 * A board's type, defaulting the way the model does.
 *
 * `Board.boardType` has `default: 'standard'`, so an absent one is a standard
 * board rather than an unknown one — reading it as unknown here would offer
 * Delivery on every board written before the field existed.
 */
const boardTypeOf = (board) => String(board?.boardType || 'standard');

/**
 * THE BOARD PAGE'S TABS, MIRRORED — and the third copy of this list.
 *
 * The other two are `VIEW_TABS` in `client/src/pages/BoardDetailPage.jsx` (the
 * real registry, carrying React icons and predicates over live gate state) and
 * `BOARD_TABS` in `server/src/services/executiveView.js` (the write-side
 * validator, which is the only side that can refuse a bad value). Neither can
 * be imported here: the first would pull a page module — and React — into a
 * plain Node test, and the second is server code.
 *
 * So the coupling is NAMED rather than hidden behind a shared constants file
 * that would still have to be edited three times. Adding a tab means editing
 * all three, and the failure if this copy is forgotten is small and visible:
 * the new tab is simply not offered as a preset, while everything else about it
 * works.
 *
 * `shows` is what THE BOARD DOCUMENT says — the board's type, and the one
 * add-on switch that rides on the board itself. It is deliberately not a
 * capability check: which capabilities the TARGET holds on a board is something
 * only their own board page resolves, and this list is drawn on somebody else's
 * screen. See `certain`.
 */
const TAB_CATALOG = [
  { value: 'board', label: 'Board', shows: () => true },
  // Client boards only — the portal's own conversation surface.
  { value: 'chat', label: 'Chat', shows: (b) => boardTypeOf(b) === 'client' },
  { value: 'delivery', label: 'Delivery', shows: (b) => boardTypeOf(b) === 'tracker' },
  { value: 'goals', label: 'Goals', shows: (b) => boardTypeOf(b) === 'tracker' },
  // People spans goals and delivery, so it rides the same board type as both.
  { value: 'people', label: 'People', shows: (b) => boardTypeOf(b) === 'tracker' },
  // The one tab tied to no board type at all: every board can hold credentials.
  { value: 'vault', label: 'Vault', shows: () => true },
  { value: 'addons', label: 'Add-ons', shows: (b) => boardTypeOf(b) === 'tracker' },
  /**
   * Ads Budget is the only tab whose existence a per-board SWITCH decides, and
   * that switch is two fields on the board document rather than a request — so
   * it is knowable here, and a board with the add-on off does not offer it.
   */
  {
    value: 'adsbudget',
    label: 'Ads Budget',
    shows: (b) => boardTypeOf(b) === 'tracker' && b?.adsBudget?.enabled === true,
  },
  /**
   * The two connector tabs, and the only pair this file CANNOT be sure about.
   *
   * Each appears once a connector of the right shape is switched on for that
   * board, which lives behind `useBoardConnectors` — a per-board request the
   * configurator does not make and has no business making forty times to fill
   * in a form. So: OFFER the tab and let the board page's existing re-check do
   * the rest (`resolveView` validates the default against the tabs that
   * actually resolved, and an allowlist can only subtract), rather than pretend
   * this list is exact.
   *
   * `certain: false` is how the form says so on screen instead of guessing.
   * The labels are the registry's FALLBACKS — the real tab titles itself from
   * the provider's own label, which is, again, not loaded here.
   */
  {
    value: 'connector',
    label: 'Data',
    shows: (b) => boardTypeOf(b) === 'tracker',
    certain: false,
  },
  {
    value: 'seo',
    label: 'SEO',
    shows: (b) => boardTypeOf(b) === 'tracker',
    certain: false,
  },
];

/** Every tab value the board page knows, in tab-bar order. */
export const BOARD_TAB_VALUES = TAB_CATALOG.map((t) => t.value);

/**
 * Is this a board document we can actually read a type off?
 *
 * The configurator holds board OBJECTS for the boards the admin can read and
 * nothing at all for the rest — an admin configuring a board they cannot
 * themselves open is unusual but entirely legal, since the target's grants are
 * not the admin's. A bare id, an undefined, or a stub with no `boardType` all
 * mean the same thing: we do not know what this board can show.
 */
const isReadableBoard = (board) =>
  !!board && typeof board === 'object' && !!board.boardType;

/**
 * The tabs a board could plausibly show, as `{ value, label, certain }`.
 *
 * `certain` is narrow and means one thing: whether the board DOCUMENT alone
 * settles that this tab can exist. It is false for the two connector tabs,
 * whose existence depends on a per-board request this screen does not make.
 *
 * It is deliberately NOT about capabilities. Every tab below still answers to
 * the target's role on that board, which no screen an admin is looking at can
 * resolve — so that caveat belongs in one footnote under the form, not as a
 * doubt marker on nine rows out of ten.
 *
 * AN UNREADABLE BOARD GETS THE WHOLE CATALOG, all of it uncertain. Offering
 * everything is the safe direction: `resolveViewTabs` can only subtract from
 * what the gate allowed, so a tab offered here that the board turns out not to
 * have costs nothing, while a list narrowed by a guess would silently refuse
 * somebody the one preset they came here to set.
 */
export const tabsForBoard = (board) => {
  const unknown = !isReadableBoard(board);
  return TAB_CATALOG.filter((tab) => unknown || tab.shows(board)).map((tab) => ({
    value: tab.value,
    label: tab.label,
    certain: unknown ? false : tab.certain !== false,
  }));
};

/**
 * A preset the server will accept and the board page can honour.
 *
 * Takes the raw `{ defaultTab, tabs }` off an entry (or off a half-edited form)
 * and the board it belongs to; returns the same two fields, repaired. Every
 * control in `components/executive/BoardPresetFields.jsx` reports through here,
 * so the shape leaving either screen is one the validator cannot refuse — a
 * form whose output has to be checked by a 400 is a form that will eventually
 * show somebody a red banner for a checkbox they ticked.
 *
 * The repairs, in order:
 *
 *   - an unknown tab value is dropped (a stale link, a hand-written PUT, a tab
 *     that was removed from the product);
 *   - a tab this BOARD cannot show is dropped — which is what makes a preset
 *     survive a board changing type instead of quietly pointing at nothing;
 *   - `BASE_TAB` is put back if the filters took it, and put in if it was never
 *     there, because an allowlist without it is a board nobody can open;
 *   - an allowlist that arrives EMPTY (or as a non-array) becomes `null`. That
 *     is the one repair that is not simply "keep it openable", and the reason
 *     is the difference between a restriction that lost its contents and no
 *     restriction at all: `['goals']` on a board with no Goals is somebody
 *     saying "narrow this board", so it narrows to `['board']` and the form
 *     shows them what survived; `[]` says nothing at all, and reading silence
 *     as "hide everything" would quietly strip a board down on the strength of
 *     a field that was never filled in. Neither is ever read as "every tab was
 *     chosen" — see the section header for why that distinction is load-bearing.
 *   - `defaultTab` is cleared when the board cannot show it, or when the
 *     allowlist does not carry it. The board page would fall back to 'board'
 *     anyway; storing the dead value would only make the dropdown lie back to
 *     whoever opens the form next.
 *
 * Order follows `TAB_CATALOG`, i.e. the tab bar, so two people ticking the same
 * boxes in a different sequence store the same array.
 *
 * ---- THE BOARD IS OPTIONAL, AND LEAVING IT OUT IS A REAL DECISION ----------
 *
 * With no board in hand `tabsForBoard` offers the whole catalog, so the pass
 * repairs the SHAPE and narrows nothing. That is what both screens want while
 * the board list is still in flight, and permanently for a board the host
 * cannot read — narrowing on a guess would delete a preset that is perfectly
 * good.
 *
 * The corollary is the part that is easy to miss: a board-less pass on the way
 * IN is not a substitute for a board-aware pass on the way OUT. The form and
 * the row summary both describe a preset as this board would apply it, so a
 * `defaultTab` the board can no longer show is DRAWN as cleared — and if the
 * value that gets stored has not been through here again with the board, the
 * document keeps a setting no screen anywhere says it has, ready to come back
 * to life the day the board changes type again. Both save paths run this pass
 * a second time for exactly that reason.
 */
export const normalisePreset = (entry, board) => {
  const allowed = new Set(tabsForBoard(board).map((t) => t.value));

  // Length checked HERE rather than after the filter: an allowlist that named
  // tabs and lost them all still means "narrow this board", while one that
  // named none never meant anything. See the doc comment above.
  const raw =
    Array.isArray(entry?.tabs) && entry.tabs.length > 0 ? entry.tabs : null;
  let tabs = null;
  if (raw) {
    const picked = new Set(
      raw.map((value) => String(value)).filter((value) => allowed.has(value))
    );
    // 'board' is not optional, whether it was ticked, filtered out, or never
    // sent. This is the client-side half of the server's "must keep the board
    // tab" rule and of `resolveViewTabs`' render-side half.
    picked.add(BASE_TAB);
    tabs = BOARD_TAB_VALUES.filter((value) => picked.has(value));
  }

  const wanted = entry?.defaultTab ? String(entry.defaultTab) : null;
  const defaultTab =
    wanted && allowed.has(wanted) && (!tabs || tabs.includes(wanted)) ? wanted : null;

  return { defaultTab, tabs };
};

/**
 * Do two presets say the same thing?
 *
 * Both screens compare what is on screen against the stored document to decide
 * whether Save has anything to do, and `null` versus a list is exactly the
 * distinction a `===` on two arrays cannot make and a `JSON.stringify` would
 * get wrong the moment the order differed.
 *
 * IT EXPECTS BOTH SIDES TO HAVE BEEN THROUGH `normalisePreset`, which is what
 * fixes the order and folds the shapes that are not really allowlists (`[]`,
 * and a list missing 'board') into ones that are. Comparing a raw stored entry
 * against a normalised one would report a change nobody made.
 */
export const samePreset = (a, b) => {
  if ((a?.defaultTab || null) !== (b?.defaultTab || null)) return false;
  const left = Array.isArray(a?.tabs) ? a.tabs : null;
  const right = Array.isArray(b?.tabs) ? b.tabs : null;
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

/**
 * Would storing `preset` change anything about the entry that is already there?
 *
 * The THIRD preset comparison in this file, and the only one that reads the
 * stored shape RAW rather than through `normalisePreset`. The three answer
 * three different questions and must not be folded into one:
 *
 *   `samePreset(edited, normalisePreset(stored))`  — "has somebody EDITED this?"
 *       Both sides repaired, neither narrowed by the board. This is what lights
 *       the Save button, and it must stay blind to a stored shape that is merely
 *       stale or illegal: a page that arrives already claiming unsaved changes
 *       is a page whose Save button stops meaning anything.
 *
 *   `presetAlreadyStored(sent, stored)` — "is there anything to WRITE?"
 *       `sent` is the value the form has been drawing and the save path would
 *       store (so: repaired AND narrowed against the board). `stored` is what
 *       the document literally holds. They differ when somebody edited the
 *       preset, AND in the two cases the first comparison is deliberately blind
 *       to: a `defaultTab` the board can no longer show, and a shape the server
 *       would now refuse (`tabs: []` — which a Mongoose array default can land
 *       as, and which the board page reads as "hide everything but the main
 *       tab", so leaving it in place is not harmless).
 *
 * Why a caller needs the second question at all: on the admin plane a PUT
 * REPLACES `boards[]`, and the array that screen can rebuild is missing every
 * entry the target can no longer read. So a save that has nothing to say about
 * boards must not send them — and something has to decide "nothing to say"
 * without being fooled by an `[]` that does need repairing.
 *
 * `null` for `stored` (no such entry yet) is a difference by construction: an
 * entry that does not exist cannot already hold what is being stored.
 */
export const presetAlreadyStored = (preset, stored) =>
  !!stored &&
  samePreset(preset, {
    defaultTab: stored.defaultTab || null,
    // Read as it sits in the document: an `[]` stays an `[]` here precisely so
    // that it reads as different from the `null` the save path would send.
    tabs: Array.isArray(stored.tabs) ? stored.tabs.map((v) => String(v)) : null,
  });

/**
 * One line describing a preset, for a collapsed row.
 *
 * Both screens list boards as rows and open the preset form on demand, so the
 * row itself has to say whether there is anything inside worth opening. "Opens
 * on Board · Every tab" is the do-nothing default and reads as one.
 *
 * It summarises the preset AS THIS BOARD WOULD APPLY IT — through the same
 * `normalisePreset` the form and the save path use — so a stored allowlist that
 * outlived a board changing type does not describe itself as still doing
 * something. It stops there: saying "3 tabs" for an allowlist whose third tab a
 * CAPABILITY hides would be this line claiming to know something only the
 * target's own board page can resolve.
 */
export const presetSummary = (entry, board) => {
  const { defaultTab, tabs } = normalisePreset(entry, board);
  const label =
    TAB_CATALOG.find((t) => t.value === (defaultTab || BASE_TAB))?.label || 'Board';
  const opensOn = `Opens on ${label}`;
  if (!tabs) return `${opensOn} · Every tab`;
  return `${opensOn} · ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`;
};

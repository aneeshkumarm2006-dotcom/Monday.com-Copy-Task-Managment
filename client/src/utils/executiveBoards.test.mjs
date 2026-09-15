/**
 * executiveBoards.test.mjs — the two ways a curated board list goes wrong.
 *
 * ONE: the order silently reverts. The profile's order is a different number
 * from `Board.order`, and every path that forgets which one it is holding ends
 * with the person's list snapping back to the workspace's order after a drag.
 * The tests below pin the profile's order as the one that wins, including when
 * the stored numbers disagree with the array's own positions.
 *
 * TWO: a board appears in both groups, or in neither. "Listed" and "other" are
 * a partition of what the server sent, and the interesting cases are the ones
 * where they might not be: an entry for a board that was never sent (the grant
 * is gone), two entries for one board, and no profile at all — where the split
 * must be a passthrough so that nobody who is not an Executive can tell this
 * file exists.
 *
 * THREE: the card and the search box disagree about what a board is called. The
 * card is titled with the profile's label and the search box was matching the
 * board's real name, so a board labelled "Q4 Retainer" over a real name of
 * "Acme Digital — 2026" answered "Nothing found" to somebody typing the only
 * name they had ever seen it under. `labelsByBoardId` is the index that fixes
 * that, and the test below pins the thing that actually has to hold: what a
 * card is TITLED is what the search can MATCH.
 *
 * FOUR and FIVE are the per-board presets, and they have their own preamble
 * down beside the tests that pin them — the short version is that an allowlist
 * can strand a board, and that "every tab" and "all ten tabs ticked" are two
 * different sentences that must not be folded into one.
 *
 * SIX is the one that only shows up at the seam between the two screens and the
 * document: a preset is repaired on the way IN without a board (the board list
 * has not landed, or this admin cannot read the board) and drawn on screen WITH
 * one. Those two passes do not produce the same value, so the pass that decides
 * what gets stored has to be the second kind — and something has to be able to
 * tell "this document already says that" from "this document says something
 * stale". Its preamble is beside its tests too.
 *
 * Run from the client directory:
 *     node --test src/utils/executiveBoards.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  orderBoardsForProfile,
  displayName,
  boardIdOf,
  labelsByBoardId,
  tabsForBoard,
  normalisePreset,
  samePreset,
  presetAlreadyStored,
  presetSummary,
} from './executiveBoards.js';

/** A board as `GET /api/boards` ships it — only the fields this file reads. */
const board = (id, name) => ({ _id: id, name });

/** A profile entry as the server stores it: an id, a nickname, a slot. */
const entry = (id, order, label = '') => ({ board: id, label, order });

const A = board('a1', 'Alpha');
const B = board('b2', 'Beta');
const C = board('c3', 'Gamma');

// ---------------------------------------------------------------------------
// The order the profile says, not the order the workspace says
// ---------------------------------------------------------------------------

test('listed follows the profile order, not the order the server sent', () => {
  // The server sends the workspace order (A, B, C). The profile says C, A.
  const { listed } = orderBoardsForProfile([A, B, C], {
    boards: [entry('c3', 0), entry('a1', 1)],
  });

  assert.deepEqual(
    listed.map((row) => row.board._id),
    ['c3', 'a1']
  );
  // `order` is the position in THIS list, so a caller can index straight into
  // an accent palette without re-deriving it.
  assert.deepEqual(
    listed.map((row) => row.order),
    [0, 1]
  );
});

test('the stored `order` wins over the entry array position', () => {
  // A save that renumbered without re-sorting, or an append that guessed its
  // index: the numbers are the claim, the array position is only a tiebreak.
  const { listed } = orderBoardsForProfile([A, B, C], {
    boards: [entry('a1', 2), entry('b2', 0), entry('c3', 1)],
  });

  assert.deepEqual(
    listed.map((row) => row.board._id),
    ['b2', 'c3', 'a1']
  );
});

test('two entries claiming one slot keep the order they arrived in', () => {
  const { listed } = orderBoardsForProfile([A, B], {
    boards: [entry('b2', 0), entry('a1', 0)],
  });

  assert.deepEqual(
    listed.map((row) => row.board._id),
    ['b2', 'a1']
  );
});

// ---------------------------------------------------------------------------
// Listed + other is a partition of what the server sent
// ---------------------------------------------------------------------------

test('an entry for a board the server did not send is dropped', () => {
  // The grant was revoked, or the board was deleted. `GET /api/boards` filters
  // on canRead, so its absence IS the answer — there is nothing to render and
  // nothing to apologise for on this person's own screen.
  const { listed, other } = orderBoardsForProfile([A, C], {
    boards: [entry('a1', 0), entry('ghost', 1), entry('c3', 2)],
  });

  assert.deepEqual(
    listed.map((row) => row.board._id),
    ['a1', 'c3']
  );
  assert.deepEqual(other, []);
});

test('other holds exactly the remainder, in the order the server sent it', () => {
  const { listed, other } = orderBoardsForProfile([A, B, C], {
    boards: [entry('b2', 0)],
  });

  assert.deepEqual(
    listed.map((row) => row.board._id),
    ['b2']
  );
  assert.deepEqual(
    other.map((b) => b._id),
    ['a1', 'c3']
  );
});

test('a duplicated entry lists the board once and never leaves it in other', () => {
  const { listed, other } = orderBoardsForProfile([A, B], {
    boards: [entry('a1', 0), entry('a1', 1)],
  });

  assert.deepEqual(
    listed.map((row) => row.board._id),
    ['a1']
  );
  assert.deepEqual(
    other.map((b) => b._id),
    ['b2']
  );
});

test('every board the server sent lands in exactly one group', () => {
  const sent = [A, B, C];
  const { listed, other } = orderBoardsForProfile(sent, {
    boards: [entry('c3', 0), entry('a1', 1)],
  });

  const seen = [...listed.map((row) => row.board._id), ...other.map((b) => b._id)];
  assert.equal(seen.length, sent.length);
  assert.deepEqual([...seen].sort(), ['a1', 'b2', 'c3']);
});

// ---------------------------------------------------------------------------
// The non-executive path: nothing happens at all
// ---------------------------------------------------------------------------

test('a null profile hands the same array straight back', () => {
  const sent = [A, B, C];
  const { listed, other } = orderBoardsForProfile(sent, null);

  assert.deepEqual(listed, []);
  // Identity, not just equality: this array is what the page renders for
  // everybody who is not an Executive, and it must not be copied, reordered or
  // re-keyed on the way past.
  assert.equal(other, sent);
});

test('a profile with no boards yet is the same passthrough', () => {
  const sent = [A, B];
  const { listed, other } = orderBoardsForProfile(sent, { boards: [] });

  assert.deepEqual(listed, []);
  assert.deepEqual(
    other.map((b) => b._id),
    ['a1', 'b2']
  );
});

test('no boards at all is empty, not a crash', () => {
  assert.deepEqual(orderBoardsForProfile(undefined, null), { listed: [], other: [] });
  assert.deepEqual(orderBoardsForProfile([], { boards: [entry('a1', 0)] }), {
    listed: [],
    other: [],
  });
});

// ---------------------------------------------------------------------------
// displayName — a nickname, and only when there is one
// ---------------------------------------------------------------------------

test('displayName prefers the profile label', () => {
  assert.equal(displayName(A, { label: 'SEO' }), 'SEO');
});

test("an empty label means the board's own name, not a blank title", () => {
  // '' is the stored default and the model documents it as "use the board's
  // own name". A card titled with an empty string is the failure this pins.
  assert.equal(displayName(A, { label: '' }), 'Alpha');
  assert.equal(displayName(A, {}), 'Alpha');
  assert.equal(displayName(A, null), 'Alpha');
  assert.equal(displayName(A, undefined), 'Alpha');
});

// ---------------------------------------------------------------------------
// boardIdOf — one comparison, both shapes
// ---------------------------------------------------------------------------

test('boardIdOf reads a board, a populated ref and a bare id the same way', () => {
  // The profile arrives as JSON, so `entry.board` is a string; the same entry
  // out of a store that populated it is an object. A helper that only handles
  // one of them puts every board in the wrong group, silently.
  assert.equal(boardIdOf(A), 'a1');
  assert.equal(boardIdOf({ _id: 'a1', name: 'whatever' }), 'a1');
  assert.equal(boardIdOf('a1'), 'a1');
});

test('boardIdOf answers an empty string for nothing, never "undefined"', () => {
  // The failure this guards is `String(undefined)` — the string "undefined",
  // which is truthy, compares equal to itself, and therefore matches every
  // other missing id it meets.
  assert.equal(boardIdOf(undefined), '');
  assert.equal(boardIdOf(null), '');
  // A ref that is present but shaped wrong is deliberately NOT special-cased:
  // `byId.get` finds no board for whatever string comes out of it, so the entry
  // is dropped before it can claim anything and no two broken entries ever meet
  // in the `claimed` set. A guard here would be dead code pretending to be a
  // safety net.
});

// ---------------------------------------------------------------------------
// labelsByBoardId — what the card says is what the search matches
// ---------------------------------------------------------------------------

test('the label a card is titled with is the label the search can match', () => {
  // The rule, stated as the two functions agreeing. A label that shares no
  // letters with the real name is the whole point: this is the case a name-only
  // search box could not find.
  const profile = { boards: [entry('a1', 0, 'Q4 Retainer'), entry('b2', 1)] };
  const labels = labelsByBoardId(profile);
  const { listed } = orderBoardsForProfile([A, B], profile);

  for (const row of listed) {
    const shown = displayName(row.board, { label: row.label });
    const searchable = labels.get(row.board._id) || row.board.name;
    assert.equal(shown, searchable);
  }
  assert.equal(labels.get('a1'), 'Q4 Retainer');
});

test('an unlabelled entry is left out rather than mapped to the board name', () => {
  // The caller tests the real name itself. Writing it in here as well would
  // make '' — which MEANS "use the board's own name" — look like a nickname.
  const labels = labelsByBoardId({ boards: [entry('a1', 0), entry('b2', 1, 'SEO')] });

  assert.equal(labels.has('a1'), false);
  assert.equal(labels.get('b2'), 'SEO');
  assert.equal(labels.size, 1);
});

test('a populated board ref is keyed by its id, not by the object', () => {
  const labels = labelsByBoardId({ boards: [{ board: A, label: 'SEO', order: 0 }] });

  assert.equal(labels.get('a1'), 'SEO');
});

test('two entries for one board: the label the card gets is the label indexed', () => {
  // `orderBoardsForProfile` keeps the FIRST entry in profile order, so the index
  // has to resolve the duplicate the same way or the search matches a nickname
  // that is nowhere on screen. The stored `order` — not the array position — is
  // what decides which one is first, which is why this case is worth a test.
  const profile = { boards: [entry('a1', 1, 'Second'), entry('a1', 0, 'First')] };
  const { listed } = orderBoardsForProfile([A], profile);
  const labels = labelsByBoardId(profile);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, 'First');
  assert.equal(labels.get('a1'), 'First');
});

test('no profile is an empty index, not a crash', () => {
  assert.equal(labelsByBoardId(null).size, 0);
  assert.equal(labelsByBoardId(undefined).size, 0);
  assert.equal(labelsByBoardId({}).size, 0);
  assert.equal(labelsByBoardId({ boards: 'nonsense' }).size, 0);
});

// ---------------------------------------------------------------------------
// Per-board presets
//
// FOUR: a preset strands a board, or points at a tab that is not there.
//
// The allowlist is the dangerous half. `tabs: []` and `tabs: ['goals']` on a
// board with no Goals tab both resolve to a board with nothing to open, and the
// failure is silent on every side — the board page falls back, the URL
// validates against an empty list, and the person sees a blank pane with no
// explanation. The server refuses those shapes and `resolveViewTabs` repairs
// them again on the render side; the tests below pin the THIRD guard, the one
// that stops either screen composing such a shape in the first place.
//
// FIVE: `null` quietly becomes "all ten". They are different sentences — "every
// tab this board has" versus "these ten tabs" — and they only diverge later,
// when an eleventh tab ships and one of them freezes. A helper that folded a
// full list into null (or null into a full list) would make that divergence
// unrepresentable, so the tests assert the two survive each other's company.
// ---------------------------------------------------------------------------

/** Board documents as `GET /api/boards` ships them, only the fields read here. */
const standardBoard = { _id: 's1', name: 'Standard', boardType: 'standard' };
const trackerBoard = { _id: 't1', name: 'Tracker', boardType: 'tracker' };
const clientBoard = { _id: 'c1', name: 'Client', boardType: 'client' };
const adsBoard = {
  _id: 't2',
  name: 'Tracker with ads',
  boardType: 'tracker',
  adsBudget: { enabled: true },
};

const values = (board) => tabsForBoard(board).map((t) => t.value);

test('a standard board is offered only the tabs a standard board has', () => {
  // The whole point of deriving the list: a Goals default on a standard board
  // is a stored setting that can never do anything.
  assert.deepEqual(values(standardBoard), ['board', 'vault']);
});

test('a client board is offered its chat surface and nothing tracker-shaped', () => {
  assert.deepEqual(values(clientBoard), ['board', 'chat', 'vault']);
});

test('a tracker board is offered the tracker tabs, in tab-bar order', () => {
  assert.deepEqual(values(trackerBoard), [
    'board',
    'delivery',
    'goals',
    'people',
    'vault',
    'addons',
    'connector',
    'seo',
  ]);
});

test('Ads Budget appears only once the board switch is on', () => {
  // The one add-on whose switch lives on the board document, which is what
  // makes it knowable from a list read rather than a per-board request.
  assert.equal(values(trackerBoard).includes('adsbudget'), false);
  assert.equal(values(adsBoard).includes('adsbudget'), true);
});

test('a board nobody here can read is offered everything, uncertainly', () => {
  // An admin may configure a board they cannot themselves open. Narrowing the
  // list by a guess would refuse them the one preset they came for; offering
  // everything costs nothing, because an allowlist can only ever subtract from
  // what the target's own gate already allowed.
  const unknown = tabsForBoard(undefined);
  assert.equal(unknown.length, tabsForBoard(trackerBoard).length + 2);
  assert.equal(
    unknown.every((t) => t.certain === false),
    true
  );
  // A bare id is the same answer as nothing at all.
  assert.deepEqual(values('t1'), values(undefined));
});

test('the connector tabs are the only uncertain ones on a board we can read', () => {
  const uncertain = tabsForBoard(trackerBoard)
    .filter((t) => !t.certain)
    .map((t) => t.value);
  // Their existence needs `useBoardConnectors`, a request neither screen makes.
  // Everything else on a tracker board is settled by the board document.
  assert.deepEqual(uncertain, ['connector', 'seo']);
});

// ---- the allowlist may never strand the board ----------------------------

test("'board' survives an allowlist that never mentioned it", () => {
  const { tabs } = normalisePreset({ tabs: ['goals', 'delivery'] }, trackerBoard);
  assert.deepEqual(tabs, ['board', 'delivery', 'goals']);
});

test("'board' survives an allowlist that was nothing but unknown tabs", () => {
  // Every named tab is filtered out, and what is left is still openable.
  const { tabs } = normalisePreset({ tabs: ['nonsense', 'goals'] }, standardBoard);
  assert.deepEqual(tabs, ['board']);
});

test('an empty allowlist is every tab, not no tabs', () => {
  // `[]` is the one shape that makes a board unreachable, and the server
  // refuses it outright. The UI cannot produce it — the main tab's box is
  // ticked and disabled — so it only arrives as a field nobody filled in, and
  // silence must not be read as "hide everything". Contrast the test above,
  // where an allowlist that NAMED tabs and lost them all keeps its narrowing.
  assert.equal(normalisePreset({ tabs: [] }, trackerBoard).tabs, null);
  assert.equal(normalisePreset({ tabs: 'nonsense' }, trackerBoard).tabs, null);
  assert.equal(normalisePreset({}, trackerBoard).tabs, null);
  assert.equal(normalisePreset(null, trackerBoard).tabs, null);
});

test('only the main tab is a legal allowlist, and stays one', () => {
  // Unticking everything else is allowed — a board reduced to its own view is a
  // tidier screen, not a broken one.
  assert.deepEqual(normalisePreset({ tabs: ['board'] }, trackerBoard).tabs, ['board']);
});

test('an unknown tab is filtered out and takes nothing with it', () => {
  const { tabs } = normalisePreset(
    { tabs: ['board', 'timeline', 'goals'] },
    trackerBoard
  );
  assert.deepEqual(tabs, ['board', 'goals']);
});

test('ticking the boxes in a different order stores the same array', () => {
  const a = normalisePreset({ tabs: ['goals', 'board', 'vault'] }, trackerBoard);
  const b = normalisePreset({ tabs: ['vault', 'goals', 'board'] }, trackerBoard);
  assert.deepEqual(a.tabs, b.tabs);
  assert.deepEqual(a.tabs, ['board', 'goals', 'vault']);
});

// ---- null and a full list are two different sentences --------------------

test('a full list stays a list and is never folded into null', () => {
  // The day an eleventh tab ships, one of these keeps up and the other does
  // not. A helper that collapsed them would make that choice unrepresentable.
  const every = values(trackerBoard);
  const { tabs } = normalisePreset({ tabs: every }, trackerBoard);
  assert.deepEqual(tabs, every);
  assert.notEqual(tabs, null);
});

test('null and a full list are distinguishable after a round trip', () => {
  const every = values(standardBoard);
  const open = normalisePreset({ tabs: null }, standardBoard);
  const frozen = normalisePreset({ tabs: every }, standardBoard);

  assert.equal(open.tabs, null);
  assert.deepEqual(frozen.tabs, every);
  assert.equal(samePreset(open, frozen), false);
});

test('samePreset tells a null allowlist from a listed one, order-insensitively', () => {
  assert.equal(samePreset({ tabs: null }, { tabs: null }), true);
  assert.equal(samePreset({ tabs: null }, { tabs: ['board'] }), false);
  assert.equal(samePreset({ tabs: ['board'] }, { tabs: ['board'] }), true);
  assert.equal(
    samePreset({ tabs: ['board'], defaultTab: 'goals' }, { tabs: ['board'] }),
    false
  );
});

// ---- a preset for a tab the board cannot show degrades safely -------------

test('a Goals preset on a standard board degrades to nothing at all', () => {
  // The case this whole derivation exists for, and the case a board converted
  // from tracker back to standard actually produces.
  const preset = normalisePreset(
    { defaultTab: 'goals', tabs: ['board', 'goals', 'delivery'] },
    standardBoard
  );
  assert.equal(preset.defaultTab, null);
  assert.deepEqual(preset.tabs, ['board']);
});

test('an Ads Budget preset dies with the add-on switch', () => {
  const stored = { defaultTab: 'adsbudget', tabs: ['board', 'adsbudget'] };
  assert.deepEqual(normalisePreset(stored, adsBoard), {
    defaultTab: 'adsbudget',
    tabs: ['board', 'adsbudget'],
  });
  // Same board, switch off: the preset has nothing left to point at.
  assert.deepEqual(normalisePreset(stored, trackerBoard), {
    defaultTab: null,
    tabs: ['board'],
  });
});

test('a default the allowlist does not carry is cleared, not smuggled in', () => {
  // The board page would fall back to 'board' anyway. Storing the dead value
  // would only make the dropdown lie to whoever opens the form next — and it
  // must NOT be "fixed" by widening the allowlist, which would be a preset
  // granting itself a tab.
  const preset = normalisePreset(
    { defaultTab: 'goals', tabs: ['board', 'delivery'] },
    trackerBoard
  );
  assert.equal(preset.defaultTab, null);
  assert.deepEqual(preset.tabs, ['board', 'delivery']);
});

test('a default with no allowlist at all is kept when the board can show it', () => {
  assert.deepEqual(normalisePreset({ defaultTab: 'goals' }, trackerBoard), {
    defaultTab: 'goals',
    tabs: null,
  });
});

test('a preset on a board we cannot read is carried, never destroyed', () => {
  // A configurator that could not load a board must not silently wipe the
  // preset an admin set on it last week.
  assert.deepEqual(
    normalisePreset({ defaultTab: 'goals', tabs: ['board', 'goals'] }, undefined),
    { defaultTab: 'goals', tabs: ['board', 'goals'] }
  );
});

test('the do-nothing preset reads as one', () => {
  assert.equal(presetSummary({ defaultTab: null, tabs: null }, trackerBoard), 'Opens on Board · Every tab');
  assert.equal(
    presetSummary({ defaultTab: 'goals', tabs: ['board', 'goals'] }, trackerBoard),
    'Opens on Goals · 2 tabs'
  );
  // Summarised through the same normaliser, so a dead preset does not describe
  // itself as a live one.
  assert.equal(
    presetSummary({ defaultTab: 'goals', tabs: ['board', 'goals'] }, standardBoard),
    'Opens on Board · 1 tab'
  );
});

// ---------------------------------------------------------------------------
// SIX: the load pass and the save pass are not the same pass
//
// Both screens repair a stored preset on the way in WITHOUT a board — the board
// list is fetched separately and an admin may not be able to read the board at
// all, so narrowing there could delete a preset that is perfectly good. Every
// screen then DRAWS the preset with the board in hand.
//
// Which means the two disagree the moment a board changes what it can show: a
// tracker board converted to a standard one leaves `defaultTab: 'goals'` in
// state and "Opens on Board" on screen. If the save path sends what is in state
// rather than what is on screen, the document keeps a setting nothing anywhere
// says it has — invisible until somebody converts that board back and it opens
// on a tab they were shown as cleared.
//
// `presetAlreadyStored` is the other half: once the save path narrows, it has to
// be possible to ask "would writing this change anything?" without that question
// being answered by the same comparison that decides whether somebody EDITED
// anything. The two comparisons are deliberately different, and the tests below
// pin the two cases where they disagree — a stale default, and an `[]` that the
// repair calls "no allowlist" but the document still literally holds.
// ---------------------------------------------------------------------------

test('the repair pass and the board pass do not produce the same preset', () => {
  const storedOnATrackerBoardThatIsNowStandard = {
    defaultTab: 'goals',
    tabs: null,
  };

  // On the way in, with no board: the shape is legal, so nothing is touched.
  assert.deepEqual(normalisePreset(storedOnATrackerBoardThatIsNowStandard), {
    defaultTab: 'goals',
    tabs: null,
  });

  // On screen, and on the way out, with the board: the board cannot show Goals.
  assert.deepEqual(
    normalisePreset(storedOnATrackerBoardThatIsNowStandard, standardBoard),
    { defaultTab: null, tabs: null }
  );

  // The summary a row draws agrees with the second, which is why the second is
  // the one that must be stored.
  assert.equal(
    presetSummary(storedOnATrackerBoardThatIsNowStandard, standardBoard),
    'Opens on Board · Every tab'
  );
});

test('a document that already says this is not a reason to write', () => {
  const stored = { defaultTab: 'goals', tabs: ['board', 'goals'] };
  assert.equal(
    presetAlreadyStored(normalisePreset(stored, trackerBoard), stored),
    true
  );
  // The do-nothing preset against a do-nothing entry: still nothing to write.
  assert.equal(
    presetAlreadyStored(normalisePreset({}, trackerBoard), {
      defaultTab: null,
      tabs: null,
    }),
    true
  );
});

test('a stale default is a reason to write, and not an edit', () => {
  const stored = { defaultTab: 'goals', tabs: null };
  const sent = normalisePreset(stored, standardBoard);

  // Nobody edited anything — the Save button must not light up on arrival.
  assert.equal(samePreset(stored, normalisePreset(stored)), true);
  // But storing what the screen has been drawing WOULD change the document.
  assert.equal(presetAlreadyStored(sent, stored), false);
});

test('an empty allowlist in the document is a reason to write', () => {
  // The shape a Mongoose array default can land as. The repair reads it as "no
  // allowlist", so the two normalised sides look identical and no edit is
  // reported — but the document still literally holds `[]`, which the board
  // page reads as "hide everything but the main tab". Somebody has to notice.
  const stored = { defaultTab: null, tabs: [] };
  assert.equal(samePreset(normalisePreset(stored), normalisePreset(stored)), true);
  assert.equal(
    presetAlreadyStored(normalisePreset(stored, trackerBoard), stored),
    false
  );
});

test('an allowlist stored out of tab-bar order is written once, then left alone', () => {
  const stored = { defaultTab: null, tabs: ['goals', 'board'] };
  const sent = normalisePreset(stored, trackerBoard);
  assert.deepEqual(sent.tabs, ['board', 'goals']);
  assert.equal(presetAlreadyStored(sent, stored), false);
  // Converges: what was written IS what is stored next time round, so this
  // cannot become a save that repeats itself for ever.
  assert.equal(presetAlreadyStored(sent, sent), true);
});

test('no stored entry at all is always a reason to write', () => {
  assert.equal(presetAlreadyStored({ defaultTab: null, tabs: null }, null), false);
  assert.equal(
    presetAlreadyStored({ defaultTab: null, tabs: null }, undefined),
    false
  );
});

test('a preset on a board nobody here can read is never a reason to write', () => {
  // The case that would be data loss: an admin who cannot read the board must
  // not have their save quietly narrow somebody else's preset to nothing.
  const stored = { defaultTab: 'goals', tabs: ['board', 'goals'] };
  assert.equal(presetAlreadyStored(normalisePreset(stored, null), stored), true);
});

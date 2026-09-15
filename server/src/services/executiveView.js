const mongoose = require('mongoose');

const ExecutiveView = require('../models/ExecutiveView');
const Board = require('../models/Board');
const { resolveAccess } = require('../utils/permissions');
const { normaliseLevel } = require('../utils/capabilities');
// The section types and their per-type config normalisers. They were defined
// HERE while `executiveHome.js` did not exist yet, with a note saying they would
// move to it; phase 2 made that move, because a section handler and the shape of
// the config it reads are one decision and drift apart the moment they are two.
// This file still EXPORTS `SECTION_TYPES` (below) so the controller, the client
// and every test that imported it from the profile service keep working.
const { SECTION_TYPES, CONFIG_NORMALISERS } = require('./executiveHome');
const boardGrants = require('./boardGrants');

/**
 * executiveView.js — THE reader and writer of an `ExecutiveView` document.
 *
 * An executive view is one person's curated SHAPE of one workspace: which
 * boards are on their list and in what order, what their home page is composed
 * of, which rail entries they kept. Two planes write it — an admin in the
 * configurator, and the person themselves from their own home or Settings tab —
 * and they are the same document, saved through the same validator, differing
 * in exactly one flag. That is why this file exists: put the rules in one place
 * or they exist twice and drift once.
 *
 * ---- SHAPE IS NOT REACH ---------------------------------------------------
 *
 * Invariant 1 of the spec, and the sentence to keep in mind while reading every
 * function below: NOTHING STORED HERE GRANTS ANYTHING. Reach is the two-layer
 * AND — org role AND board grant — resolved only by `resolveAccess`, and the
 * only writer of a grant in this codebase is `services/boardGrants.js`. A board
 * on somebody's list is a statement about their SCREEN.
 *
 * Three consequences run through this file:
 *
 *  1. A listed board the person cannot read is SKIPPED, NEVER ERRORED.
 *     `resolveForViewer` drops it and names it in `skipped[]` so the
 *     configurator can flag it. Somebody revoking a grant from the board's own
 *     share dialog is allowed and routine; it must not 500 an executive's home
 *     page, and it must not silently delete their entry either — the entry is
 *     how an admin sees what was lost and puts it back.
 *  2. `upsert` NEVER writes a grant, on either plane. The admin plane widens
 *     reach through `addBoard`, which is a separate call with a separate
 *     authorisation check, so a PUT of a whole profile cannot become a
 *     privilege escalation by listing a board id.
 *  3. On the self plane (`allowReachChange: false`) an entry for a board the
 *     subject cannot read is not theirs to write AT ALL, in either direction.
 *     A NEW one is dropped from the save and REPORTED — dropping it silently
 *     would show a person a form that saves without complaint and a list that
 *     comes back one board shorter, which reads as data loss rather than as a
 *     permission boundary. An entry ALREADY on the list is kept exactly as
 *     stored: that person was never shown it (`resolveForViewer` elided it), so
 *     its absence from the body they sent back cannot be a removal they meant.
 *     Without that second half, rule 1 above lasts only until the executive's
 *     next save — they drag one tile on My Boards, the page rebuilds `boards[]`
 *     out of the list it was given, and the skipped entry is gone from the
 *     document for good. See `reachFilteredBoards`.
 *
 * ---- A SAVE SPEAKS ONLY ABOUT THE KEYS IT CARRIES --------------------------
 *
 * `boards`, `home` and `nav` are three independent parts of one document, and
 * the screens that write them are separate: My Boards drags a tile, the home
 * page's section editor moves a section, Settings flips a rail switch. A body
 * that omits a key therefore means "I did not touch that part", NOT "make it
 * empty" — `validateShape` returns only the keys the caller actually sent and
 * `upsert` assigns only those. Clearing a part is still possible and still
 * explicit: send `[]`, or `null` for the nav defaults.
 *
 * The alternative (absent = empty) turns the most ordinary partial save into a
 * silent wipe of two thirds of the profile, and leaves the history row lying
 * about it — the controller's `changedParts` already logs only the keys the
 * body carried, so "changed: home" would be written over a save that also
 * deleted every board on the list.
 *
 * ---- WHY THIS FILE WRITES NO ACTIVITY ROWS --------------------------------
 *
 * `services/executiveActivity.js` has the five writers, and the CONTROLLER
 * calls them — not this service. An activity row carries the actor's identity,
 * their type (a signed-in user, or a script with a label) and the name the row
 * will be read by long after the profile is deleted; only the layer holding the
 * request knows all three. A service that logged on its own behalf would have
 * to be handed a fake request context by every internal caller — the migration
 * script, phase 4's copy-from — and the first one to pass the wrong one writes
 * history naming the wrong person. So: this file returns what happened, and the
 * controller says who did it.
 *
 * ---- REFUSALS ARE RETURN VALUES, NOT EXCEPTIONS ---------------------------
 *
 * Every mutator returns either its result or `{ error, status }`, so a
 * controller can translate a refusal into an HTTP status without a try/catch
 * that cannot tell "you may not share that board" from "mongo is down".
 * EXPECTED refusals are values; unexpected failures still throw, and the
 * controller's outer handler turns those into a 500 the way it already does
 * everywhere else. `validateShape` follows the same rule and additionally never
 * throws at all.
 */

/**
 * The tab values a board page can open on, in tab-bar order.
 *
 * THIS LIST MIRRORS `VIEW_TABS` IN `client/src/pages/BoardDetailPage.jsx`.
 * Adding a tab there means editing this array too — there is no import that
 * could keep them in step, because that registry is a client module carrying
 * React icons and visibility predicates over client-side gate state, and the
 * server has no business loading any of it. The honest thing is to NAME the
 * coupling here rather than hide it behind a shared constants file that would
 * still have to be edited twice.
 *
 * It lives server-side because this is the only side that can refuse a bad
 * value: `defaultTab` and `tabs` are STORED, and a typo saved today opens a
 * blank pane for somebody months from now. The client may read these names back
 * through the API rather than keeping a third copy.
 */
const BOARD_TABS = [
  'board',
  'chat',
  'delivery',
  'goals',
  'people',
  'vault',
  'addons',
  'adsbudget',
  'connector',
  'seo',
];

/**
 * The one tab an allowlist must always contain.
 *
 * A board with no tabs is a board that cannot be opened, and `board` is the view
 * every board type has. Phase 3 enforces the same rule a second time on the
 * render side (`resolveViewTabs`, where a tab the capability gate hid can never
 * be shown back and `board` always survives); this is the write-side half, so an
 * allowlist that would strand the board is refused at the door rather than
 * quietly repaired on every render.
 */
const BASE_TAB = 'board';

/** Why a listed board did not make it into the resolved view. */
const SKIP_REASONS = {
  /** The board document is gone — deleted out from under the profile. */
  DELETED: 'deleted',
  /** It still exists; this person can no longer read it. */
  NO_ACCESS: 'no-access',
};

/** Why `removeBoard` left a grant standing. Same vocabulary rules. */
const KEEP_REASONS = {
  BOARD_MISSING: 'board-missing',
  CANNOT_MANAGE_ACCESS: 'cannot-manage-access',
};

/**
 * The rung a board is granted at when the configurator does not say.
 *
 * "All access like an admin" (decision 1 of the spec): `edit` plus `canManage`,
 * so an Executive on their own boards can do everything an admin could, sharing
 * included. The configurator may lower it per board, which is why this is a
 * default rather than a constant callers cannot reach past.
 */
const DEFAULT_LEVEL = 'edit';

/**
 * Caps and switch names come off the MODEL and are never retyped here. The
 * schema refuses to STORE more than `MAX_BOARDS`; this file refuses to ACCEPT
 * more, with a readable message. Two numbers that have to agree should be one
 * number.
 */
const { NAV_KEYS, WIDTHS, MAX_BOARDS, MAX_SECTIONS, MAX_LABEL } = ExecutiveView;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a ref that may be an id string, an ObjectId, or a POPULATED document
 * to its id string. `String(doc)` on a populated Mongoose document is its
 * inspect string, never the hex id — the trap `idOf` in utils/permissions.js
 * exists for — and every path in here is handed documents somebody else loaded.
 */
const idOf = (ref) => String(ref?._id || ref || '');

const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(v);

// The id-list, id-or-null, empty-to-null and month-or-null coercions moved to
// `services/executiveHome.js` with the config table that was their only caller.

const clampText = (value, max) => {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
};

const finiteOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Coerce a switch to a Boolean, with the one special case that matters.
 *
 * `Boolean('false')` is TRUE, and these values arrive as JSON written by a form,
 * by a query string, or by a client that stringified a checkbox. A rail entry
 * that reappears because somebody sent the string "false" is a bug report nobody
 * can reproduce, so the falsey spellings are handled by name.
 */
const toBool = (value) => {
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return !(s === '' || s === 'false' || s === '0' || s === 'no');
  }
  return !!value;
};

/** All eight switches on, which is what being declared an Executive means. */
const navDefaults = () =>
  NAV_KEYS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {});

/**
 * The section types, RE-EXPORTED from `services/executiveHome.js`.
 *
 * The table that defines them — one normaliser per type, whose keys ARE the
 * list — moved there in phase 2 along with the handlers. It is imported rather
 * than duplicated for the obvious reason and one less obvious one: a validator
 * that accepted a type the composer has no handler for would store a section
 * that renders as permanently unavailable, and a composer with a handler the
 * validator rejects would be dead code nobody could reach. Deriving both from
 * one table makes each of those unrepresentable.
 *
 * `CONFIG_NORMALISERS` is used by `validateSection` below; `SECTION_TYPES` is
 * re-exported from this module because the controller and the phase-1 tests
 * already import it from here.
 */

/**
 * Renumber `order` into a dense 0..n-1 sequence, in the order the numbers
 * currently imply.
 *
 * The client never has to do this, which is the point: a drag list that sends
 * `[0, 1, 1.5, 2]`, a removal that leaves `[0, 2, 3]`, and an append that
 * guessed at the next index all come back out of here as `[0, 1, 2, 3]`. Every
 * later append can then use `array.length` as its order and be right, and every
 * reader sorts the two arrays identically.
 *
 * The sort is by `order` with the original index as the tiebreaker, so two
 * entries claiming the same slot keep the order they were sent in instead of
 * swapping unpredictably between saves.
 */
const withDenseOrder = (rows) =>
  rows
    .map((row, index) => ({ row, index, order: finiteOr(row.order, index) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ row }, index) => ({ ...row, order: index }));

/**
 * A stored board entry as a plain object.
 *
 * Spreading a Mongoose subdocument copies `$__` and `_doc`, not the fields, so
 * anything that REBUILDS `boards[]` off a loaded document goes through here
 * first. Board-entry `_id`s are not preserved across such a rebuild because an
 * entry's identity is its `board` ref — one entry per board, deduplicated on the
 * way in. Home sections are the opposite case and are handled in `validateShape`.
 */
const plainBoardEntry = (entry) => ({
  board: idOf(entry.board),
  label: entry.label || '',
  order: entry.order,
  defaultTab: entry.defaultTab || null,
  // An empty array reads back as `null`: an allowlist of "no tabs at all" is
  // refused on the way in, so an empty one in storage can only be mongoose
  // casting a null default, and "every tab" is what it was standing in for.
  tabs:
    Array.isArray(entry.tabs) && entry.tabs.length > 0
      ? entry.tabs.map(String)
      : null,
});

// ---------------------------------------------------------------------------
// validateShape — the one gate both planes save through
// ---------------------------------------------------------------------------

/**
 * One board entry: an id, a nickname, a slot, and the two phase-3 presets.
 *
 * The presets are validated NOW even though nothing reads them until phase 3 —
 * see the model header for why the fields ship early. A `defaultTab` stored as
 * "Goals" instead of "goals" is invisible until the day the page starts reading
 * it, and then it is a board that opens on a blank pane for one person.
 */
const validateBoardEntry = (raw, index, knownTabs) => {
  const at = `Board entry ${index + 1}`;
  if (!isPlainObject(raw)) return { error: `${at} is not an object.` };

  const board = idOf(raw.board);
  if (!isId(board)) return { error: `${at} needs a valid board id.` };

  // `null`, absent and '' all mean "the board page's own default". Only a
  // non-empty string is a claim about a tab, and a claim has to be true.
  const defaultTab =
    raw.defaultTab == null || raw.defaultTab === '' ? null : String(raw.defaultTab);
  if (defaultTab !== null && !knownTabs.includes(defaultTab)) {
    return { error: `${at} names "${defaultTab}", which is not a board tab.` };
  }

  // `tabs: null` is EVERY tab. `tabs: []` is a different sentence — "no tabs" —
  // and it is the one shape that makes a board unreachable, so it is refused
  // rather than silently read as null. The two cases being distinguishable is
  // the whole reason the field defaults to null instead of an empty array.
  let tabs = null;
  if (raw.tabs != null) {
    if (!Array.isArray(raw.tabs)) {
      return { error: `${at} has a tab list that is not an array.` };
    }
    if (raw.tabs.length === 0) {
      return {
        error: `${at} has an empty tab list. Use null for every tab.`,
      };
    }
    const list = [];
    for (const value of raw.tabs) {
      const tab = String(value);
      if (!knownTabs.includes(tab)) {
        return { error: `${at} names "${tab}", which is not a board tab.` };
      }
      if (!list.includes(tab)) list.push(tab);
    }
    if (!list.includes(BASE_TAB)) {
      return { error: `${at} must keep the "${BASE_TAB}" tab.` };
    }
    tabs = list;
  }

  return {
    value: {
      board,
      // Clamped, not rejected: a nickname quietly cut short is a better answer
      // to a long paste than a form that refuses to save. The model's
      // `maxlength` is the backstop behind this same number.
      label: clampText(raw.label, MAX_LABEL),
      order: finiteOr(raw.order, index),
      defaultTab,
      tabs,
    },
  };
};

/**
 * One home section.
 *
 * The `_id` is PRESERVED when the client sends one back. That id is the `id` of
 * the composed envelope and the only stable identity a section has — two `note`
 * sections are otherwise identical — so re-minting it on every save would break
 * any client keyed on it the moment somebody reorders the list, which is the
 * one thing an id is there to survive.
 */
const validateSection = (raw, index, seenIds) => {
  const at = `Home section ${index + 1}`;
  if (!isPlainObject(raw)) return { error: `${at} is not an object.` };

  const type = String(raw.type == null ? '' : raw.type).trim();
  if (!SECTION_TYPES.includes(type)) {
    return { error: `"${type}" is not a home section type.` };
  }

  const width = raw.width == null ? 'full' : String(raw.width);
  if (!WIDTHS.includes(width)) {
    return { error: `${at} has an unknown width "${width}".` };
  }

  const config = raw.config == null ? {} : raw.config;
  if (!isPlainObject(config)) {
    return { error: `${at} has a config that is not an object.` };
  }

  const value = {
    type,
    order: finiteOr(raw.order, index),
    width,
    // Per-type, and unknown keys are dropped by construction: each normaliser
    // builds a NEW object out of the keys it knows.
    config: CONFIG_NORMALISERS[type](config),
  };

  // A duplicate id would put two subdocuments in one array under one identity,
  // so the second one loses its `_id` and mongoose mints a fresh one instead.
  const id = idOf(raw._id == null ? raw.id : raw._id);
  if (isId(id) && !seenIds.has(id)) {
    seenIds.add(id);
    value._id = id;
  }

  return { value };
};

/** The eight switches, whitelisted by name. */
const validateNav = (raw) => {
  if (raw == null) return { value: navDefaults() };
  if (!isPlainObject(raw)) return { error: 'Navigation must be an object.' };

  // Rejected, not dropped. A misspelled switch is a client that believes it
  // turned something off; answering "saved" would be a lie it cannot detect.
  for (const key of Object.keys(raw)) {
    if (!NAV_KEYS.includes(key)) {
      return { error: `"${key}" is not a navigation switch.` };
    }
  }

  const value = {};
  for (const key of NAV_KEYS) {
    // Missing means ON. The document should always SAY what the person will
    // see rather than leave a reader to infer it from an absent path.
    value[key] = raw[key] === undefined ? true : toBool(raw[key]);
  }
  return { value };
};

/**
 * Validate and normalise a profile shape. Returns `{ value }` or `{ error }`,
 * and NEVER throws — it runs on request bodies from two different planes, and a
 * validator that can throw is a 500 waiting for the first malformed save.
 *
 * ONLY THE KEYS THE BODY CARRIES COME BACK. A shape that omits `home` has no
 * `home` key in its `value`, and `upsert` leaves that part of the document
 * alone — see the header. `undefined` is the only spelling of "not sent" that
 * matters, because it is the only one JSON produces (an omitted key) and it is
 * the same test the controller's `changedParts` writes its history row by. An
 * explicit `null` is a statement, and it means the empty value for that part:
 * no boards, no sections, the eight nav defaults.
 *
 * `body` itself may be null, which is the legal EMPTY SHAPE — all three parts,
 * spelled out. That is the one call with no client behind it: `declare` asks
 * for it by name so the document it creates says what the person will see,
 * rather than leaning on schema defaults that a `.lean()` read never re-applies.
 *
 * `knownTabs` is an argument rather than a hard reference to `BOARD_TABS` so a
 * caller can narrow the list (a board-type-aware configurator, a test that
 * wants to pin the CLASS of mistake without naming real tabs). It can only ever
 * narrow: an unknown value is refused either way.
 */
const validateShape = (body, { knownTabs = BOARD_TABS } = {}) => {
  try {
    if (body == null) {
      return { value: { boards: [], home: [], nav: navDefaults() } };
    }
    if (!isPlainObject(body)) return { error: 'The executive view must be an object.' };

    // Built key by key: a part the body did not mention never appears here, and
    // `upsert` then never assigns it. This is the whole of the partial-save
    // rule — there is no flag and no second return value to keep in step.
    const value = {};

    // ---- boards -----------------------------------------------------------
    if (body.boards !== undefined) {
      const rawBoards = body.boards == null ? [] : body.boards;
      if (!Array.isArray(rawBoards)) return { error: 'Boards must be an array.' };
      if (rawBoards.length > MAX_BOARDS) {
        return { error: `An executive view holds at most ${MAX_BOARDS} boards.` };
      }

      const boards = [];
      const seenBoards = new Set();
      for (let i = 0; i < rawBoards.length; i += 1) {
        const result = validateBoardEntry(rawBoards[i], i, knownTabs);
        if (result.error) return { error: result.error };
        // A repeated board is DROPPED rather than refused. One entry per board
        // is the model's rule, and a duplicate is a client bug (a double-click
        // on "add", a copy-from that overlapped) rather than a decision somebody
        // made — refusing the save would leave them staring at a list they
        // cannot fix from the screen they are on. The first entry wins, because
        // it is the one carrying whatever label and preset were already set.
        if (seenBoards.has(result.value.board)) continue;
        seenBoards.add(result.value.board);
        boards.push(result.value);
      }
      value.boards = boards;
    }

    // ---- home -------------------------------------------------------------
    if (body.home !== undefined) {
      const rawHome = body.home == null ? [] : body.home;
      if (!Array.isArray(rawHome)) return { error: 'Home must be an array.' };
      if (rawHome.length > MAX_SECTIONS) {
        return { error: `An executive home holds at most ${MAX_SECTIONS} sections.` };
      }

      const home = [];
      const seenIds = new Set();
      for (let i = 0; i < rawHome.length; i += 1) {
        const result = validateSection(rawHome[i], i, seenIds);
        if (result.error) return { error: result.error };
        home.push(result.value);
      }
      value.home = home;
    }

    // ---- nav --------------------------------------------------------------
    if (body.nav !== undefined) {
      const nav = validateNav(body.nav);
      if (nav.error) return { error: nav.error };
      value.nav = nav.value;
    }

    return { value };
  } catch (err) {
    // Belt and braces for the promise above. A validator that throws would turn
    // a bad save into a 500 and hide which field was wrong.
    return { error: 'That executive view could not be read.' };
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The raw profile document for one (org, user), or null.
 *
 * A hydrated document, not a lean object, because its callers are the mutators
 * below — they save it. Readers that only render want `resolveForViewer`, which
 * additionally answers the question this one cannot: whether the boards on the
 * list are still reachable.
 */
const getForUser = async (orgId, userId) => {
  const org = idOf(orgId);
  const user = idOf(userId);
  if (!isId(org) || !isId(user)) return null;
  return ExecutiveView.findOne({ organisation: org, user });
};

/**
 * Load every board named in a profile, in ONE query, keyed by id string.
 *
 * Scoped to the organisation deliberately. A board id from another workspace
 * would otherwise be resolved against THIS org's roles and grants — the wrong
 * question entirely, and one that could answer "yes" — so a cross-org id simply
 * does not resolve and lands in `skipped[]` beside a deleted one, which is the
 * truthful answer: that board is not on this workspace's list.
 */
const loadBoardsById = async (orgId, ids) => {
  const unique = [...new Set(ids.map(idOf).filter(isId))];
  if (unique.length === 0) return new Map();
  const docs = await Board.find({ _id: { $in: unique }, organisation: idOf(orgId) });
  return new Map(docs.map((b) => [idOf(b._id), b]));
};

/**
 * The profile as this person should actually see it, plus what was left out.
 *
 * Takes the LOADED org document rather than an id, so the caller controls
 * loading and the `ensureSystemRoles` heal — `loadOrgContext` has already done
 * both by the time a controller reaches here, and re-loading would run that
 * lazy migration a second time on every read.
 *
 * `skipped[]` carries `{ board, name, reason }`: enough for the configurator to
 * render "SEO Tracker 2026 — this person can no longer open this board" without
 * a second round trip. The name comes off the board document while it exists
 * and falls back to the profile's own label, which is the only trace left of a
 * board that has been deleted outright — and a deleted board must land in
 * `skipped`, not throw, because deleting a board is something anybody with the
 * capability may do on any afternoon.
 *
 * The read is LEAN on purpose. The returned profile has had entries removed
 * from `boards[]`, and a hydrated document in that state is one stray `.save()`
 * away from making the drop permanent — turning "somebody revoked a grant" into
 * "the board fell off their list forever", which is exactly the data loss the
 * skip-never-delete rule exists to prevent.
 *
 * The lean read only stops THIS function from writing the elision back. The
 * client it is sent to can still hand the elided list straight back on its next
 * save, and would — a page can only rebuild the list it was given. That second
 * half is closed on the write side, in `reachFilteredBoards`: a stored entry the
 * subject cannot read is re-attached rather than taken at face value. Neither
 * half is sufficient alone, so if this read ever stops eliding, or that write
 * ever stops restoring, invariant 4 goes with it.
 */
const resolveForViewer = async (org, userId) => {
  const orgId = idOf(org);
  const user = idOf(userId);
  if (!isId(orgId) || !isId(user)) return { profile: null, skipped: [] };

  const profile = await ExecutiveView.findOne({ organisation: orgId, user }).lean();
  if (!profile) return { profile: null, skipped: [] };

  const entries = Array.isArray(profile.boards) ? profile.boards : [];
  const byId = await loadBoardsById(orgId, entries.map((e) => e.board));

  const boards = [];
  const skipped = [];
  for (const entry of entries) {
    const board = idOf(entry.board);
    const doc = byId.get(board);
    if (!doc) {
      skipped.push({
        board,
        // The label is all that is left of a board nobody can look up.
        name: entry.label || '',
        reason: SKIP_REASONS.DELETED,
      });
      continue;
    }
    // THE re-check. Every executive path asks this question again rather than
    // trusting the list, because the list is a description and this is the fact.
    if (!resolveAccess(doc, org, user).canRead) {
      skipped.push({
        board,
        name: doc.name || entry.label || '',
        reason: SKIP_REASONS.NO_ACCESS,
      });
      continue;
    }
    boards.push(entry);
  }

  return { profile: { ...profile, boards }, skipped };
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The profile for this pair, creating an empty one if there is none.
 *
 * Two writes on the first save (an empty document, then the shape) buys one
 * creation path for every caller, and makes the UNIQUE INDEX — rather than this
 * function — the thing that decides who won a race. The 11000 retry is that
 * decision being honoured: two admins pressing Save at the same moment is not a
 * failure, it is two saves, and the loser reloads the winner's document and
 * writes its own shape on top. Last write wins, as the spec says it does.
 */
const loadOrCreate = async (orgId, userId, actorId) => {
  const existing = await ExecutiveView.findOne({ organisation: orgId, user: userId });
  if (existing) return { profile: existing, created: false };

  try {
    const made = await ExecutiveView.create({
      organisation: orgId,
      user: userId,
      createdBy: actorId || null,
      updatedBy: actorId || null,
    });
    return { profile: made, created: true };
  } catch (err) {
    if (err && err.code === 11000) {
      const raced = await ExecutiveView.findOne({ organisation: orgId, user: userId });
      if (raced) return { profile: raced, created: false };
    }
    throw err;
  }
};

/**
 * The `boards[]` a SELF save is allowed to write, and what it could not.
 *
 * On this plane the person may only speak about boards they can actually read,
 * and that cuts BOTH WAYS — which is the half that is easy to miss, because
 * only one direction has a visible symptom.
 *
 *  - A board they cannot read that is NOT already on the list is dropped, and
 *    named in `dropped[]`. That is the obvious direction: it stops the self PUT
 *    being a way to list (and, one grant later, quietly inherit) any board id in
 *    the workspace, and reporting it stops a form saving something other than
 *    what was on screen.
 *  - A board they cannot read that IS already on the list is KEPT, exactly as
 *    stored, whether or not the body mentioned it. This is the direction with no
 *    symptom. `resolveForViewer` elided that entry from the profile this person
 *    was handed, so the list they edited never contained it; rebuilding
 *    `boards[]` out of what came back would delete it — permanently, from the
 *    one document that remembers the board was ever curated for them. Their
 *    first drag on My Boards would do it. An entry they were never shown cannot
 *    be an entry they chose to remove.
 *
 * The consequence worth stating plainly: on this plane a hidden entry is also
 * not EDITABLE. If a body does name one, the stored entry wins and the submitted
 * label, order and presets are ignored — the caller could not see what they were
 * changing, so the only safe reading of it is "left alone".
 *
 * Stored entries keep their stored `order` and are re-attached at the end of the
 * array; `withDenseOrder` then sorts them back roughly into the slot they held,
 * rather than piling them at the bottom of somebody's board list.
 *
 * Both halves need the board documents, so it is ONE query over the union of
 * what was sent and what is stored, never one per entry.
 */
const reachFilteredBoards = async (org, user, profile, requested) => {
  const orgId = idOf(org);

  const stored = new Map(
    (profile.boards || []).map(plainBoardEntry).map((e) => [e.board, e])
  );
  const ids = [...new Set([...requested.map((e) => idOf(e.board)), ...stored.keys()])];
  const byId = await loadBoardsById(orgId, ids);

  // A board that no longer resolves (deleted, or from another workspace) is
  // "cannot read" here for the same reason it is `skipped` in the reader: the
  // person cannot open it, so the same rule applies to both directions.
  const readable = (id) => {
    const doc = byId.get(id);
    return !!doc && resolveAccess(doc, org, user).canRead;
  };

  const boards = [];
  const dropped = [];
  for (const entry of requested) {
    const id = idOf(entry.board);
    if (readable(id)) {
      boards.push(entry);
      continue;
    }
    // Only a board they were not already carrying is a refusal to report. One
    // that is stored is re-attached below, so calling it "dropped" would be a
    // message about something that did not happen.
    if (!stored.has(id)) dropped.push(id);
  }
  for (const [id, entry] of stored) {
    // Readable and left out of the body IS a removal — that is the person
    // taking a board off their own list, which this plane exists to allow.
    if (readable(id)) continue;
    boards.push(entry);
  }

  // The cap, checked here rather than left to the schema. `validateShape` caps
  // what was SENT, and the entries re-attached above were never in that count,
  // so a full list plus a hidden entry would otherwise reach `save()` and come
  // back as a mongoose ValidationError — a 500 on an ordinary drag. Refusing is
  // recoverable (remove a board and the save goes through); truncating would
  // put us straight back into deleting entries nobody chose to delete.
  if (boards.length > MAX_BOARDS) {
    return {
      error: `An executive view holds at most ${MAX_BOARDS} boards.`,
      status: 400,
    };
  }

  return { boards, dropped };
};

/**
 * Save a shape over this person's profile, creating it if there is none.
 *
 * `shape` is the `value` out of `validateShape` — the caller runs the validator
 * so it can return the message to whoever typed it, and this function assumes
 * what it is handed is already legal.
 *
 * ONLY THE PARTS THE SHAPE CARRIES ARE WRITTEN. `boards`, `home` and `nav` are
 * edited from three different screens; a shape with one key is a save about one
 * of them and leaves the other two exactly as they were (header, and
 * `validateShape`). `{}` is therefore a legal no-op rather than a wipe.
 *
 * THIS NEVER WRITES A GRANT, on either plane. Reach moves through `addBoard`
 * and `removeBoard`, which each authorise the actor against the board itself.
 * A PUT is a description of a screen; if listing a board id here could hand out
 * access, the self plane would be a self-service permission system.
 *
 * `allowReachChange: false` is the self plane, where `boards[]` is filtered by
 * what the SUBJECT can read — the subject rather than the actor because the
 * entry describes the subject's own list, and on this plane the two are the same
 * person by construction. `reachFilteredBoards` has the rules and the reasons;
 * `dropped[]` is what it refused. The admin plane skips all of it: an admin may
 * list a board the person cannot read yet, because they are about to grant it.
 */
const upsert = async (org, userId, shape, { actor = null, allowReachChange = false } = {}) => {
  const orgId = idOf(org);
  const user = idOf(userId);
  const actorId = idOf(actor);
  if (!isId(orgId) || !isId(user)) {
    return { error: 'Invalid organisation or user.', status: 400 };
  }
  if (!isPlainObject(shape)) return { error: 'Nothing to save.', status: 400 };

  // The document is loaded FIRST now, because deciding what `boards[]` may
  // become needs to know what it already is — an entry this person cannot see
  // is one only the stored document remembers.
  const { profile, created } = await loadOrCreate(orgId, user, actorId || null);

  let dropped = [];
  if (shape.boards !== undefined) {
    const requested = Array.isArray(shape.boards) ? shape.boards : [];
    if (allowReachChange) {
      profile.boards = withDenseOrder(requested);
    } else {
      const decided = await reachFilteredBoards(org, user, profile, requested);
      if (decided.error) return decided;
      profile.boards = withDenseOrder(decided.boards);
      dropped = decided.dropped;
    }
  }
  if (shape.home !== undefined) {
    profile.home = withDenseOrder(Array.isArray(shape.home) ? shape.home : []);
  }
  if (shape.nav !== undefined) {
    profile.nav = isPlainObject(shape.nav) ? shape.nav : navDefaults();
  }

  // `createdBy` is set by `loadOrCreate` and never rewritten — it records who
  // declared this person an Executive, which a later edit does not change.
  profile.updatedBy = actorId || null;
  await profile.save();

  return { profile, dropped, created };
};

/**
 * Put a board on somebody's list AND give them access to it.
 *
 * The refusal in the middle is the point of the whole function. An Executive
 * holds `org.manage_executive_views` (so they can set up the next Executive),
 * and without this check that capability would be a way to reach any board in
 * the workspace: add it to your own profile, take the grant that comes with it.
 * So the ACTOR's `canManageAccess` on THAT board is what authorises the grant —
 * the same question the Share dialog asks — and an actor who cannot share a
 * board cannot hand it to anybody through this route either.
 *
 * ORDER OF OPERATIONS: the entry is written first, the grant second. If the
 * grant then fails, what is left is a listed board with no reach — a state the
 * design already handles everywhere (the reader skips it, the configurator
 * flags it). The other order leaves reach with no entry, which is a widened
 * permission nothing on this screen records. Never widen reach silently.
 *
 * Idempotent: adding a board already on the list updates the GRANT (which is
 * how the configurator changes a level) and leaves the entry, its label and its
 * presets exactly where they were.
 */
const addBoard = async (
  org,
  userId,
  boardId,
  { level = DEFAULT_LEVEL, canManage = true, actor = null, notify = true } = {}
) => {
  const orgId = idOf(org);
  const user = idOf(userId);
  const board = idOf(boardId);
  const actorId = idOf(actor);

  if (!isId(orgId) || !isId(user)) {
    return { error: 'Invalid organisation or user.', status: 400 };
  }
  if (!isId(board)) return { error: 'Invalid board id.', status: 400 };
  if (!isId(actorId)) {
    return { error: 'Only a signed-in person can share a board.', status: 400 };
  }

  // Refused rather than defaulted: the level arrives from a fixed dropdown, so
  // a value off that list is a bug, and quietly granting `edit` instead of
  // whatever was meant is the wrong way to find out about it.
  const rung = normaliseLevel(level);
  if (!rung) return { error: `"${level}" is not an access level.`, status: 400 };

  const doc = await Board.findOne({ _id: board, organisation: orgId });
  if (!doc) return { error: 'Board not found in this workspace.', status: 404 };

  if (!resolveAccess(doc, org, actorId).canManageAccess) {
    return {
      error: 'You cannot manage access on that board.',
      status: 403,
    };
  }

  const { profile } = await loadOrCreate(orgId, user, actorId);
  const entries = profile.boards || [];
  const already = entries.some((e) => idOf(e.board) === board);
  if (!already) {
    profile.boards.push({
      board,
      label: '',
      // `boards[]` is kept dense by every write in this file, so the length IS
      // the next free slot.
      order: profile.boards.length,
      defaultTab: null,
      tabs: null,
    });
  }
  profile.updatedBy = actorId;
  await profile.save();

  // `canManage` is meaningless below `edit` and `boardGrants.grant` clears it
  // there anyway; passed through as asked so there is one place that decides.
  const result = await boardGrants.grant({
    board: doc,
    targetUserId: user,
    level: rung,
    canManage: canManage === true,
    actorId,
    notify,
  });

  return {
    profile,
    board: doc,
    level: rung,
    added: !already,
    // Whether they already had a grant — the difference between "shared with
    // you" and "your access changed", which cannot be recomputed afterwards.
    existed: result.existed,
  };
};

/**
 * Take a board off somebody's list, and optionally take the grant with it.
 *
 * The two halves are deliberately separable. Removing the entry is a change to
 * a SCREEN and needs no board-level authority at all; revoking the grant is a
 * change to REACH and needs the same `canManageAccess` the Share dialog needs.
 * An actor who has the first and not the second gets the first: the entry goes,
 * the grant stays, and `grantLeft` says so. Failing the whole call instead would
 * mean an admin who cannot share one board is unable to tidy a list — and the
 * board would sit there flagged, which teaches people to ignore the flag.
 */
const removeBoard = async (org, userId, boardId, { revoke = false, actor = null } = {}) => {
  const orgId = idOf(org);
  const user = idOf(userId);
  const board = idOf(boardId);
  const actorId = idOf(actor);

  if (!isId(orgId) || !isId(user)) {
    return { error: 'Invalid organisation or user.', status: 400 };
  }
  if (!isId(board)) return { error: 'Invalid board id.', status: 400 };

  const profile = await ExecutiveView.findOne({ organisation: orgId, user });
  if (!profile) {
    return { error: 'This person does not have an executive view.', status: 404 };
  }

  const before = (profile.boards || []).length;
  // Rebuilt as plain entries and re-densified, so the hole this leaves in the
  // order sequence closes and the next `addBoard` can keep using `length`.
  profile.boards = withDenseOrder(
    (profile.boards || []).map(plainBoardEntry).filter((e) => e.board !== board)
  );
  const removed = profile.boards.length < before;
  if (actorId) profile.updatedBy = actorId;
  await profile.save();

  let revoked = false;
  let grantLeft = false;
  let reason = null;

  if (revoke) {
    const doc = await Board.findOne({ _id: board, organisation: orgId });
    if (!doc) {
      // Nothing to revoke: the grant lived on the board and went with it.
      reason = KEEP_REASONS.BOARD_MISSING;
    } else if (!isId(actorId) || !resolveAccess(doc, org, actorId).canManageAccess) {
      grantLeft = true;
      reason = KEEP_REASONS.CANNOT_MANAGE_ACCESS;
    } else {
      // The revoke cleanup (follows, notifications) lives in `boardGrants` and
      // is never reimplemented here — see that file's header for why losing it
      // is a silent failure.
      await boardGrants.revoke({ board: doc, targetUserId: user });
      revoked = true;
    }
  }

  return { profile, removed, revoked, grantLeft, reason };
};

/**
 * Delete the profile.
 *
 * ONLY the profile. Not the grants, not the role. Both are separate facts with
 * separate lifecycles, and the caller is the one having the conversation about
 * them: "stop curating this person's screen" is not the same request as "take
 * their boards away", and an admin who meant the first and got the second has
 * no way back. Invariant 3 is what makes this safe — removing the profile
 * restores the standard app with nothing to migrate, because the document only
 * ever described a view.
 *
 * The deleted document is returned so the controller can name the person in the
 * activity row it writes (this file writes none — see the header). `actor` is
 * accepted for signature symmetry with the other mutators and deliberately
 * unused: there is nothing left to stamp it on.
 */
const remove = async (org, userId, { actor = null } = {}) => {
  const orgId = idOf(org);
  const user = idOf(userId);
  if (!isId(orgId) || !isId(user)) {
    return { error: 'Invalid organisation or user.', status: 400 };
  }

  const profile = await ExecutiveView.findOneAndDelete({
    organisation: orgId,
    user,
  });
  return { removed: !!profile, profile: profile || null };
};

module.exports = {
  BOARD_TABS,
  SECTION_TYPES,
  SKIP_REASONS,
  KEEP_REASONS,
  DEFAULT_LEVEL,
  getForUser,
  resolveForViewer,
  validateShape,
  upsert,
  addBoard,
  removeBoard,
  remove,
};

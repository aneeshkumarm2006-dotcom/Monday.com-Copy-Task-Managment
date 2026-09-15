/**
 * executiveSections.js — the arithmetic behind editing an executive home.
 *
 * An executive's home page is an ordered list of SECTIONS on their
 * `ExecutiveView` profile: `[{ _id, type, order, width, config }]`
 * (`server/src/models/ExecutiveView.js`). Two different screens edit that list —
 * the admin's configurator and the person's own "Edit home" — through ONE
 * component, `components/executive/SectionEditor.jsx`. This file is everything
 * that component does to the array, pulled out of it so it can be tested
 * without React, and so both screens provably do the same thing to the same
 * document.
 *
 * Same split, same reason, as `executiveNav.js` and `executiveBoards.js`: no
 * React, no JSX, no icons in here. What is left in the editor is dnd wiring,
 * a menu and a form, none of which has an opinion about what a list of sections
 * means.
 *
 * ---- EVERY HELPER IS PURE, AND THAT IS LOAD-BEARING ------------------------
 *
 * Each one takes the list, returns a NEW list, and never mutates what it was
 * given — not the array, not a section object, not a section's `config`. Two
 * things depend on it and neither is optional:
 *
 *   1. **Cancel.** The editor is explicitly Save/Cancel (an editor that saved
 *      on every drag makes "I was only trying it out" impossible). Cancel is
 *      implemented as "go back to the array we started from", which is only a
 *      restore if nothing in the meantime reached into that array and changed
 *      a section in place. A single `section.width = 'half'` anywhere below
 *      would turn Cancel into a lie that is invisible until somebody reloads.
 *   2. **Optimistic saving.** The home page shows the edited list immediately
 *      and reconciles with whatever the server answers. The pre-edit value has
 *      to survive the edit for that to be recoverable.
 *
 * A helper asked to do something it cannot — an unknown id, an illegal width, a
 * type the registry does not know — returns the array it was GIVEN, unchanged
 * and by identity. A caller can therefore tell "nothing happened" from "this
 * happened and produced an identical-looking list" with `===`, which is what
 * the editor's dirty flag and React's memoisation both want.
 *
 * ---- WHY ORDER IS DENSIFIED ON EVERY OPERATION -----------------------------
 *
 * `order` comes back out of `withDenseOrder` in
 * `server/src/services/executiveView.js` as a dense 0..n-1 run on EVERY save.
 * So if the client left holes — `[0, 2, 3]` after a removal, `[0, 1, 1.5, 2]`
 * after an insert — the numbers on screen and the numbers in the document would
 * differ from the moment of the edit until the next load, at which point the
 * list would silently renumber itself under the person who made it. Nothing
 * would look broken; the list would just stop being the one they built when
 * some later append used `home.length` for its order and landed on top of an
 * existing section.
 *
 * Densifying here means the array the editor holds is always exactly what the
 * server will store, every append can safely use `length` as its order, and the
 * two sides sort an identical list into an identical sequence. It is four lines
 * to keep in step with four lines, and the alternative is a class of bug that
 * only shows up after a reload.
 *
 * ---- WHERE THE SECTION TYPES COME FROM -------------------------------------
 *
 * Not from here. The types, their labels, their icons, their renderers and
 * their default configs are all one table —
 * `components/executive/sectionRegistry.js` on the client,
 * `SECTION_TYPES` + `CONFIG_NORMALISERS` + `HANDLERS` in
 * `server/src/services/executiveHome.js` on the server. Every function below
 * that needs to know about a type takes the registry as an ARGUMENT rather
 * than importing it, which keeps this file free of React (the registry holds
 * components) and keeps the number of places that list section types at one
 * per side of the wire.
 */

/**
 * The two widths a section may claim. Mirrors the `enum` on the model's `home`
 * subdocument and the `WIDTHS` the server's validator rejects against; a third
 * value here would be a save that comes back 400 with a message about a width
 * nobody typed.
 */
export const WIDTHS = Object.freeze(['full', 'half']);

/**
 * WHERE THE CONFIG VOCABULARIES ARE, AND WHY THEY ARE NOT HERE.
 *
 * The range list for `workspaceNumbers`, the due list for `myWork`, and the
 * three clamps on `myWork.limit` / `note.title` / `note.text` all live in
 * `components/executive/sectionRegistry.js`
 * (`ANALYTICS_RANGE_OPTIONS`, `MY_WORK_DUE_OPTIONS`, `MY_WORK_LIMIT_MAX`,
 * `NOTE_TITLE_MAX`, `NOTE_TEXT_MAX`), beside the `defaultConfig` values they
 * pair with. They are mirrors of `VALID_RANGES` in
 * `server/src/services/analyticsReport.js` and `MY_WORK_DUE` / `MAX_MY_WORK` /
 * `MAX_NOTE_*` in `server/src/services/executiveHome.js`.
 *
 * A copy of them here would be a THIRD statement of the same facts — server,
 * registry, util — and the failure mode is specific and silent: an option a
 * form offers that the server does not accept is normalised away on save, so a
 * section configured for "Last 90 days" would quietly report thirty. One list
 * per side of the wire; the config form reads the registry's.
 */

/**
 * The prefix on a section that exists only in this browser so far.
 *
 * A stored section is identified by its Mongoose `_id`, which is the `id` of
 * the composed envelope and the only stable identity a section has (two `note`
 * sections are otherwise identical — see `validateSection` in
 * `services/executiveView.js`). A section somebody has just added has no such
 * id yet, and it must not borrow the shape of one: the server keeps a client's
 * `_id` only when it is a real ObjectId and mints a fresh one otherwise, so a
 * local key deliberately cannot be mistaken for one.
 *
 * It travels to the server on `key`, which `validateSection` drops on the way
 * in — it builds a new object out of the keys it knows — so a local id can
 * never be stored.
 */
const LOCAL_KEY_PREFIX = 'new-';

const isPlainObject = (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** `Number('')` is 0, so this tests the coerced value rather than truthiness. */
const finiteOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * How a section is addressed by every helper here and keyed by React.
 *
 * `_id` for a section the server has stored, `key` for one added in this
 * editor and not saved yet. `id` is accepted in the middle because the composed
 * home envelope (`GET /api/me/executive-home`) spells the same value `id` — so
 * a caller holding a composed section rather than a stored one addresses it
 * with the identifier it actually has, instead of having to know which endpoint
 * its copy came from.
 *
 * Never `ref.toString()`: an `_id` can arrive as an ObjectId, and `String(x)`
 * is the idiom this codebase uses everywhere for exactly that reason.
 */
export const sectionKey = (section) =>
  String(section?._id ?? section?.id ?? section?.key ?? '');

/**
 * A local key no section in this list already holds.
 *
 * Derived from the list rather than from a module-level counter or a random
 * value, so the helpers stay pure and a test can assert what it gets. Reusing a
 * key freed by a removal is harmless — the only requirement is that no two
 * sections in one list share one, because that is what React and every helper
 * below key on.
 */
const nextLocalKey = (sections) => {
  let n = 0;
  for (const section of sections) {
    const key = sectionKey(section);
    if (!key.startsWith(LOCAL_KEY_PREFIX)) continue;
    const suffix = Number(key.slice(LOCAL_KEY_PREFIX.length));
    if (Number.isFinite(suffix) && suffix > n) n = suffix;
  }
  return `${LOCAL_KEY_PREFIX}${n + 1}`;
};

/**
 * Renumber `order` into a dense 0..n-1 run, in the order the STORED NUMBERS
 * imply — the client half of `withDenseOrder` in
 * `server/src/services/executiveView.js`, down to the tiebreaker.
 *
 * The tiebreaker (the position in the incoming array) matters for the one case
 * the server cannot renumber away: two sections claiming one slot. "Keep the
 * order they arrived in" beats "swap unpredictably between renders", and it is
 * what makes the client's sort and the server's sort agree about a list neither
 * of them wrote.
 *
 * ONLY `normaliseHome` MAY USE THIS, and the reason is worth stating because
 * getting it wrong is silent: this sorts by `order`, so running it after a DRAG
 * — where the array position is the new truth and `order` is still the old one
 * — would sort the moved section straight back to where it came from. The list
 * would simply refuse to reorder, with no error to explain why. Once a list has
 * been through here, its position IS its order, and everything after it
 * renumbers by position (`renumbered`).
 *
 * Every section object is REPLACED rather than edited, which is where most of
 * this module's purity actually comes from.
 */
const withDenseOrder = (sections) =>
  sections
    .map((section, index) => ({ section, index, order: finiteOr(section?.order, index) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ section }, index) => ({ ...section, order: index }));

/**
 * Renumber `order` from the array's own positions — for the helpers that have
 * just MOVED something, where the array is the answer and `order` is stale.
 * See the warning on `withDenseOrder`.
 */
const renumbered = (sections) =>
  sections.map((section, index) =>
    (section.order === index ? section : { ...section, order: index }));

/**
 * The list as the editor should hold it: sorted by `order` and densified.
 *
 * Call this ONCE on whatever the store handed over, then keep using the
 * helpers below — they all normalise their input and return a dense list, so
 * the editor's array is always already in the shape the server stores.
 *
 * A non-array (no profile yet, a half-loaded store) is an empty list rather
 * than a crash: an executive with no home sections and an executive whose
 * profile has not arrived both have nothing to draw, and only one of them is
 * worth an error somewhere else.
 */
export const normaliseHome = (home) =>
  withDenseOrder(Array.isArray(home) ? home : []);

/**
 * Copy a config blob one level deep.
 *
 * The registry's `defaultConfig` is a shared object literal on a module-level
 * table. Handing the same object to every section somebody adds would mean one
 * config edited in place — by a renderer, a form, anything — silently changing
 * the default for every section added afterwards, in every editor, for the rest
 * of the session. Arrays are copied too (`boardTiles`' `boards: []` is the live
 * case), because a `push` into a shared array is the same bug with a shorter
 * fuse.
 *
 * One level is enough: every config in the contract's table is flat — ids,
 * strings, numbers, and one array of ids.
 */
const copyConfig = (config) => {
  const out = {};
  for (const key of Object.keys(config)) {
    const value = config[key];
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
};

/**
 * The config a freshly added section of this type starts with.
 *
 * LENIENT ON PURPOSE, unlike `addSection`. This is also asked about sections
 * that ALREADY EXIST — the config form merges it under the stored config so a
 * section saved before a key existed still renders a complete form — and a
 * stored section whose type the registry no longer lists must still be
 * openable, removable and saveable rather than crashing the editor it appears
 * in. So an unknown type, a missing registry, or a `defaultConfig` that is not
 * an object all come back as `{}`: nothing to fill in, which is exactly right
 * for a type whose fields nobody can name.
 *
 * @param {string} type
 * @param {Object} registry - `components/executive/sectionRegistry.js`
 * @returns {Object} a fresh object, never the registry's own
 */
export const configDefaultsFor = (type, registry) => {
  const defaults = registry?.[type]?.defaultConfig;
  return isPlainObject(defaults) ? copyConfig(defaults) : {};
};

/** The registry's width for a type, falling back to the model's own default. */
const defaultWidthFor = (type, registry) => {
  const width = registry?.[type]?.defaultWidth;
  return WIDTHS.includes(width) ? width : 'full';
};

/**
 * Append a section of `type`, with the registry's defaults, at the end.
 *
 * STRICT about the type, where `configDefaultsFor` is lenient: this MINTS a
 * section, and a type the registry does not know is one the server's
 * `validateShape` will refuse — with a 400 that fails the whole save, taking
 * the seven sections that were fine down with it. The editor's "add" menu is
 * itself built from the registry, so this cannot happen from the UI; refusing
 * is for the caller that builds a section from something else.
 *
 * Appended, never inserted: a new section belongs at the bottom, where the
 * person can see it and then drag it. An insert at the top would move
 * everything they had already arranged.
 *
 * @param {Array} home
 * @param {string} type
 * @param {Object} registry
 * @param {Object} [options]
 * @param {string} [options.key] - a local id to use instead of the derived one.
 *        For a caller that has its own idea of identity (a paste, a copy-from);
 *        it is not validated here beyond being a string, because the server
 *        drops anything that is not a real ObjectId anyway.
 * @returns {Array} a new dense list, or `home` itself when the type is unknown
 */
export const addSection = (home, type, registry, { key } = {}) => {
  const sections = normaliseHome(home);
  if (!type || !registry?.[type]) return home;

  const section = {
    // The local identity. See LOCAL_KEY_PREFIX: it is deliberately not an
    // ObjectId, and the server drops it rather than storing it.
    key: key || nextLocalKey(sections),
    type,
    order: sections.length,
    width: defaultWidthFor(type, registry),
    config: configDefaultsFor(type, registry),
  };

  // `sections` is already dense and the new one's order is already `length`, so
  // this changes nothing today — it is here so there is exactly one answer in
  // this file to "what does a returned list look like".
  return renumbered([...sections, section]);
};

/** Index of the section addressed by `id`, or -1. */
const indexOf = (sections, id) => {
  const want = String(id ?? '');
  if (!want) return -1;
  return sections.findIndex((section) => sectionKey(section) === want);
};

/**
 * Drop one section.
 *
 * No confirmation anywhere near this: the editor is Save/Cancel, so a removal
 * is undone by cancelling, and a modal in front of an action that is already
 * reversible is furniture. The row does not come back once saved, which is what
 * the Save button is for.
 */
export const removeSection = (home, id) => {
  const sections = normaliseHome(home);
  const at = indexOf(sections, id);
  if (at < 0) return home;
  return renumbered(sections.filter((_, i) => i !== at));
};

/**
 * Move the section `fromId` to where `toId` currently sits.
 *
 * This is the drag RESULT, spelled the way `@dnd-kit`'s `onDragEnd` reports it
 * — `active.id` and `over.id` — so the editor's handler is two lines and has no
 * arithmetic of its own to get wrong.
 *
 * The move itself is `arrayMove`'s semantics exactly (remove, then insert at the
 * target index in the shortened array), which is what every other sortable list
 * in this app does, and it is what makes a drag downwards land where the
 * placeholder was rather than one row short of it.
 *
 * @returns {Array} a new dense list, or `home` itself when either id is not in
 *          the list or they are the same section (a drag that went nowhere)
 */
export const reorderSections = (home, fromId, toId) => {
  const sections = normaliseHome(home);
  const from = indexOf(sections, fromId);
  const to = indexOf(sections, toId);
  if (from < 0 || to < 0 || from === to) return home;

  const next = sections.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  // By POSITION. The `order` numbers riding along are the ones from before the
  // drag; sorting by them here would put the section straight back.
  return renumbered(next);
};

/**
 * Set one section's width.
 *
 * Only `full` and `half` — see `WIDTHS`. Anything else is refused rather than
 * coerced: a coercion would put a width on screen that nobody chose, whereas a
 * refusal leaves the control showing the value it already had, which is the
 * truth.
 *
 * Setting the width a section already has returns the same array. The editor's
 * dirty flag is an identity comparison, and "I clicked Full on something that
 * was already Full" must not arm a Save button.
 */
export const setWidth = (home, id, width) => {
  if (!WIDTHS.includes(width)) return home;
  const sections = normaliseHome(home);
  const at = indexOf(sections, id);
  if (at < 0) return home;
  if (sections[at].width === width) return home;

  // No renumbering: a width change moves nothing, and `normaliseHome` above
  // already densified. Every untouched section keeps its object identity, so a
  // row that did not change does not re-render.
  return sections.map((section, i) => (i === at ? { ...section, width } : section));
};

/**
 * MERGE `patch` into one section's config.
 *
 * Merge, not replace, and that is the whole reason this function exists rather
 * than callers assigning `config` themselves. Not every key of a config is
 * editable in the form: `goalScores` carries `groups` (which clients this
 * section is narrowed to), and narrowing it needs the BOARD's group list, which
 * needs a request, which this editor does not make. A form that replaced the
 * config every time somebody changed the month would delete that narrowing
 * silently — the section would quietly widen from three clients to forty, on a
 * page whose whole purpose is the three.
 *
 * So a form sends only the keys it owns, and everything else survives. The
 * merge is shallow, matching the flat configs in the contract's table; a patch
 * value of `null` is a real value (`month: null` means "always the current
 * month") and is written like any other.
 *
 * A non-object patch is refused rather than spread — `{ ...'abc' }` is
 * `{0:'a',1:'b',2:'c'}`, which would be stored, dropped by the server's
 * normaliser, and leave nobody any the wiser.
 */
export const setConfig = (home, id, patch) => {
  if (!isPlainObject(patch)) return home;
  const sections = normaliseHome(home);
  const at = indexOf(sections, id);
  if (at < 0) return home;

  // Same as `setWidth`: nothing moved, so nothing is renumbered and untouched
  // sections keep their identity.
  return sections.map((section, i) =>
    (i === at
      // A NEW config object. Editing `section.config` in place would reach
      // through every copy of this list the caller is still holding, Cancel's
      // included.
      ? { ...section, config: { ...(isPlainObject(section.config) ? section.config : {}), ...patch } }
      : section));
};

/**
 * The boards a section's board picker may offer, from whatever the caller has.
 *
 * ---- WHY THIS TAKES TWO SHAPES --------------------------------------------
 *
 * The two screens that host the editor hold the same list in different shapes.
 * The executive's own home has `orderBoardsForProfile(boards, profile).listed`,
 * which is `[{ board, label, order }]` — the profile's entries resolved against
 * boards the server actually sent. The configurator holds the target's profile
 * entries beside the boards IT can see. Both are "the boards on this view";
 * making one of them convert before calling would be a conversion written
 * twice, and the copy that was written second is the one that gets it wrong.
 *
 * ---- WHY ONLY THE PROFILE'S BOARDS ----------------------------------------
 *
 * The picker inside this editor lists the boards on the VIEW, never every board
 * the person can read. A home section naming a board that is not on their
 * curated list would put that board's client names and numbers on the front
 * page of an app built to show them a handful of boards and nothing else — and
 * on the admin's side it would let a configurator point somebody's home at a
 * board only the ADMIN can open, which composes to "You no longer have access
 * to this board" on a tile the person never chose.
 *
 * The server enforces the same thing from the other end (every section's board
 * is re-checked with `resolveAccess(...).canRead` before its handler runs —
 * `services/executiveHome.js`, invariant 1), and the self PUT strips a board id
 * out of a section config the caller cannot read. Both saying it is the point:
 * the server's check is what makes it SAFE, and this one is what makes it make
 * SENSE, because an option that saves and then renders "unavailable" is a worse
 * answer than an option that was never offered.
 *
 * @param {Array} source - `[{ board, label }]` entries, or bare board objects
 * @returns {Array<{id: string, name: string, label: string}>} deduplicated, in
 *          the order given. `name` is the board's real name (possibly '' when
 *          the caller only had an id); `label` is the profile's nickname, '' if
 *          there is none — kept apart because a label is a nickname for finding
 *          a board in a list, never a rename (see `executiveBoards.js`).
 */
export const pickableBoards = (source) => {
  const rows = Array.isArray(source) ? source : [];
  const out = [];
  const seen = new Set();

  for (const row of rows) {
    // A row has to be an object: an entry, or a board. A bare string in this
    // list is junk from somewhere, and `String('nonsense')` is a perfectly
    // usable-looking id that would put a phantom board in the picker.
    if (!isPlainObject(row)) continue;
    // An entry (`{ board, label }`) or a bare board. `row.board` is the tell,
    // and it may itself be a populated document or a bare id string.
    const hasEntry = Object.prototype.hasOwnProperty.call(row, 'board');
    const board = hasEntry ? row.board : row;
    const id = String(board?._id ?? board ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(board?.name ?? ''),
      // The label lives on the ENTRY, never on the board — that separation is
      // what stops a nickname from ever reaching `board.name`.
      label: String((hasEntry ? row.label : row?.label) ?? ''),
    });
  }

  return out;
};

/**
 * What to call one pickable board on screen: the view's nickname, else the
 * board's real name, else an honest placeholder.
 *
 * The flattened twin of `displayName` in `executiveBoards.js`, which answers the
 * same question for a `(board, entry)` pair. Both exist because a label is a
 * NICKNAME for finding a board in a list and never a rename — `board.name` is
 * what everybody else calls it and what the board page's own heading shows — so
 * the two values travel side by side and are collapsed only at the moment
 * something is drawn.
 *
 * Here rather than inside a component because the picker and the row that
 * summarises what the picker chose both need this answer, and two spellings of
 * it are how a section ends up titled differently from the field that
 * configured it.
 */
export const boardTitle = (board) =>
  board?.label || board?.name || 'Untitled board';

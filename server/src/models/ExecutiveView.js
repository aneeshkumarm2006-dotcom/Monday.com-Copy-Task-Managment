const mongoose = require('mongoose');

/**
 * ExecutiveView — one person's curated SHAPE of this workspace.
 *
 * An Executive is a member whose screen is deliberately smaller than the
 * workspace: a handful of boards instead of forty, a home page of the scores
 * they actually check instead of the generic dashboard, and a navigation rail
 * they can trim. This document is that shape, and NOTHING BUT that shape.
 *
 * ---- Why this is its own collection, not a field on Organisation -----------
 *
 * The cheap-looking version is an array on `Organisation`. Two reasons it is
 * the wrong shape.
 *
 * First, the Organisation model deliberately refuses a settings blob. Read the
 * comment above its `holidays` field: the workspace calendar is a plain array
 * of subdocuments precisely because "a bag named `settings` invites everything
 * else to move in beside it". A per-person view profile is exactly the second
 * tenant that argument was written to keep out, and it is a much heavier one
 * than a list of dates — boards, home sections, nav switches and an audit pair.
 *
 * Second, the lifecycles do not match. The Organisation document is the root of
 * trust: it carries `admin`, `roles[]` and `memberRoles[]`. This profile is
 * created when one person is declared, and is then edited BY THAT PERSON — the
 * self path in `services/executiveView.js` lets an Executive rearrange their
 * own home and rail. Last write wins, which is fine for a small per-person
 * document and unacceptable on the document that also holds the permission
 * matrix: a routine "I turned Productivity off" save would become a
 * read-modify-write of the org's roles, and a lost update there is a security
 * incident rather than a lost preference.
 *
 * It is also what makes "several executives later" free (decision 9 of the
 * spec, invariant 9): a second Executive is a second document and a copy-from.
 * There is no singleton anywhere, no array to grow, and nothing in this file
 * knows or cares how many profiles exist.
 *
 * ---- This document NEVER grants anything -----------------------------------
 *
 * Invariant 1. Reach is the two-layer AND — org role AND board grant — resolved
 * only by `resolveAccess` in `utils/permissions.js`. That function does not
 * read this collection and must never learn to. What lives here DESCRIBES a
 * view; it does not authorise one.
 *
 * The practical consequence is the rule every reader of this document must
 * honour: a board listed in `boards[]` that the person cannot read is SKIPPED,
 * NOT ERRORED. `resolveForViewer` drops it and reports it in `skipped[]` so the
 * configurator can flag it; the home composer degrades that section to
 * `state: 'unavailable'` rather than throwing. A stale entry is a stale entry —
 * somebody revoked a grant from the board's own share dialog, which is allowed
 * and must not break this person's home page.
 *
 * That rule is what makes the self path safe (an Executive may rearrange their
 * shape all they like and can never widen their reach), and it is why deleting
 * this document is a complete undo with nothing to migrate: the standard app
 * comes back because the profile was only ever a description.
 *
 * `services/executiveView.js` is the ONLY reader and writer of these documents.
 * Both the admin plane and the self plane go through it, so the validation
 * rules exist in one place rather than once per route.
 *
 * ---- Why `defaultTab` and `tabs` are here before anything reads them -------
 *
 * Per-board presets are phase 3. The two fields ship in the shape NOW, and are
 * simply never set until then, because of how the writer works: `validateShape`
 * is shared by the admin PUT and the self PUT and it DROPS keys it does not
 * know. If the shape gained these fields only in phase 3, a client that already
 * sends them would have them silently swallowed by an older server — the worst
 * kind of failure, because the UI shows the preset saved and the board keeps
 * opening on the wrong tab.
 *
 * `null` also carries meaning here — `tabs: null` is "every tab", which is a
 * different statement from "this profile predates tab allowlists" — and once
 * the field exists those two cases are indistinguishable on a document written
 * before it did. Writing the fields from the first save means every profile
 * ever stored has an explicit answer, so phase 3 turns the feature on by
 * reading a field that is already there instead of backfilling documents people
 * have hand-edited since. Two unread fields cost nothing; that backfill would.
 *
 * ---- Why `nav` is eight explicit Booleans, not an array of hidden keys ------
 *
 * Invariant 6: a switch can only HIDE an entry the capability already allows.
 * The rail is capability-gated first (`SideRail.jsx` already hides Members,
 * Analytics and Productivity without the matching capability) and these
 * switches are applied on top, so they can only ever subtract. Neither shape
 * changes that — but the Boolean shape is the honest one to store.
 *
 *  - An explicit `true` is the default because "all on" is what being declared
 *    an Executive means. The document then SAYS what the person will see, which
 *    is exactly what an admin reading the configurator needs; with a hidden-key
 *    array they would have to know the full entry list by heart to interpret an
 *    absence.
 *  - An unknown key can never creep in. `validateShape` whitelists these eight
 *    names and rejects anything else, so a typo is refused at the door. In an
 *    array a stale or misspelled key sits there forever, meaning nothing, and
 *    nothing can tell it from a key for an entry that has not shipped yet.
 *  - The switches describe INTENT, not the client's current rail. Calendar and
 *    Notifications are not rail entries in this app today; the nav helper only
 *    ever hides entries that exist, so those two switches are simply inert
 *    until such an entry does. That is deliberate — the profile should not have
 *    to be rewritten the day the rail grows an entry.
 *
 * ---- Why `home[].config` is Mixed ------------------------------------------
 *
 * Same treatment, and the same reason, as a goal's `config` (see `Goal.js`):
 * it is a PER-TYPE blob whose keys cannot be enumerated across types.
 * `boardTiles` takes `{ boards: [] }`, `goalScores` takes
 * `{ board, month, groups }`, `workspaceNumbers` takes `{ range, board }`,
 * `note` takes `{ title, text }`. Mongoose cannot express "these keys, but only
 * when `type` is that one", so it holds the blob and the per-type normalisation
 * lives with the handler that consumes it, in `services/executiveHome.js`.
 *
 * `type` itself is a plain required String rather than an enum for a related
 * reason: the section registry (`SECTION_TYPES`) lives beside the handlers in
 * `services/executiveHome.js`, because adding a section type is adding a
 * handler and a renderer and nothing else. The model must not reach up into the
 * service to validate a value — scripts and migrations load the models on their
 * own and would end up pulling in the composer and every scorer behind it — and
 * an enum here would additionally make an existing document unloadable the day
 * a type is retired. The service rejects unknown types; this field just stores
 * the answer.
 */

/**
 * Section widths. A full-width section spans the home grid; a half-width one
 * shares a row with the next half. That is the whole layout language — the
 * spec rejected a free-form drag canvas (section 9), and two values are what
 * "fully customizable" costs here.
 */
const WIDTHS = ['full', 'half'];

/**
 * The eight rail switches, in rail order. This list IS the `nav` subschema
 * below — the schema is built from it rather than typed out a second time, so
 * the array the validator whitelists against and the paths mongoose will
 * actually store cannot drift apart.
 *
 * Grouped as: the curated board list; the four unconditional entries; the three
 * that already require a capability. Home and Settings are deliberately absent
 * — they are never hideable, so there is no switch to store for them.
 */
const NAV_KEYS = [
  'boards',
  'myWork',
  'chat',
  'calendar',
  'notifications',
  'members',
  'analytics',
  'productivity',
];

/**
 * Caps on the two arrays.
 *
 * Both are hand-composed by a person, and the whole document is read on every
 * sign-in and on every home compose. The caps are far above any real use — a
 * forty-board workspace cannot fill a hundred entries — and exist so a scripted
 * or fat-fingered PUT cannot turn one person's page load into a megabyte read.
 *
 * They are exported (below) rather than duplicated into `validateShape`, so the
 * number the service rejects at and the number the schema refuses to store are
 * the same number by construction.
 */
const MAX_BOARDS = 100;
const MAX_SECTIONS = 50;

/**
 * The per-board display label, clamped by the service rather than rejected —
 * "SEO Tracker 2026" called simply "SEO". 60 characters is a nickname; anything
 * longer is the board's own name, which is what an empty label already means.
 */
const MAX_LABEL = 60;

/**
 * One board in the curated list.
 *
 * The `board` ref is the entry's identity: one entry per board, deduplicated by
 * the service. Nothing here is a permission — see the header. A grant is
 * written separately, on the board, by `services/boardGrants.js`, and this entry
 * survives that grant being revoked (the reader skips it).
 */
const executiveBoardSchema = new mongoose.Schema({
  board: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Board',
    required: true,
  },
  // '' means "use the board's own name". Not null, because the label is
  // rendered directly and `label || name` is the one read everywhere.
  //
  // `maxlength` is a backstop that should never fire: the service CLAMPS to the
  // same number rather than rejecting, because a nickname quietly cut short is
  // a better answer to a long paste than a saved form that throws.
  label: {
    type: String,
    default: '',
    trim: true,
    maxlength: MAX_LABEL,
  },
  // The Executive's OWN order for their board list. Never `Board.order`, which
  // is workspace-wide and rewritten for everybody by `reorderBoards` — dragging
  // a tile on this person's My Boards must write here and nowhere else.
  order: {
    type: Number,
    default: 0,
  },
  // Phase 3, shipped now — see the header. A `?view=` value, or null for the
  // board page's own default. Validated against the known tab names by the
  // service; the model does not own that list because the tabs are a client
  // registry (`utils/boardViewTabs.js`).
  defaultTab: {
    type: String,
    default: null,
  },
  // Phase 3, shipped now. `null` means EVERY tab the gate already allows — an
  // allowlist of none would be an empty array, which is a different and
  // deliberately unreachable statement (the service requires a non-empty list
  // containing 'board'). Hiding here is about noise, not secrecy: a hidden tab
  // is still reachable by URL, and secrecy is the role's job.
  tabs: {
    type: [String],
    default: null,
  },
});

/**
 * One section of the executive home, in order.
 *
 * Subdocument `_id`s are kept on purpose: the composed envelope every handler
 * returns is `{ id, type, order, width, config, state, data, error }`, and this
 * `_id` is that `id`. It is what lets the client key a section that has no
 * other stable identity — two `note` sections are otherwise identical — and
 * survives a reorder, which an array index would not.
 */
const executiveSectionSchema = new mongoose.Schema(
  {
    // One of SECTION_TYPES, which lives in `services/executiveHome.js`. Not an
    // enum here — see the header.
    type: {
      type: String,
      required: true,
      trim: true,
    },
    order: {
      type: Number,
      default: 0,
    },
    width: {
      type: String,
      enum: WIDTHS,
      default: 'full',
    },
    // Per-type blob — see the header. A function default, not a literal, so
    // every section gets its own object rather than sharing one across
    // documents.
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    // `minimize: false` so an EMPTY config survives the round trip. Mongoose's
    // default strips empty objects on the way out, which would store a
    // configless section (a `myWork` left on its defaults, a `boardTiles`
    // meaning "all of them") with no `config` path at all — and a `.lean()`
    // read, which the composer wants, does not re-apply defaults. Every
    // handler would then need `(config || {})` and the one that forgot would
    // throw inside a section that is supposed to degrade, never crash.
    minimize: false,
  }
);

/**
 * The eight switches, built from NAV_KEYS so the two cannot disagree.
 *
 * `_id: false` because this is a fixed record of named flags, not a row.
 */
const executiveNavSchema = new mongoose.Schema(
  NAV_KEYS.reduce((paths, key) => {
    paths[key] = { type: Boolean, default: true };
    return paths;
  }, {}),
  { _id: false }
);

const executiveViewSchema = new mongoose.Schema(
  {
    /**
     * Which workspace this profile is for. A person can be an Executive in one
     * organisation and an ordinary member in another; the pair is the identity
     * of the profile, which is what the unique index below says.
     *
     * No standalone index on this field. The compound index at the bottom
     * starts with `organisation`, so the admin plane's "every profile in this
     * org" list already reads through it; a second index on the same prefix
     * would only tax writes. Same call `ActivityLog.group` makes about not
     * paying for an index nobody's query needs.
     */
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
    },
    /**
     * Whose view this is. Indexed on its own because the compound index cannot
     * serve a read keyed on the person alone — its leading field is the
     * organisation — and those reads exist: "does this person have a profile
     * anywhere", asked when a member is removed or an account is deleted.
     */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    /**
     * The curated board list, in the Executive's own order.
     *
     * The cap is enforced here as well as in `validateShape` — the service is
     * the real validator and returns a readable error, this is the backstop
     * that makes the two numbers literally the same one.
     */
    boards: {
      type: [executiveBoardSchema],
      default: () => [],
      validate: {
        validator: function boardsWithinCap(v) {
          return !Array.isArray(v) || v.length <= MAX_BOARDS;
        },
        message: `An executive view holds at most ${MAX_BOARDS} boards.`,
      },
    },
    /** The home page, as an ordered list of sections. Same cap reasoning. */
    home: {
      type: [executiveSectionSchema],
      default: () => [],
      validate: {
        validator: function homeWithinCap(v) {
          return !Array.isArray(v) || v.length <= MAX_SECTIONS;
        },
        message: `An executive home holds at most ${MAX_SECTIONS} sections.`,
      },
    },
    /**
     * The rail switches. A function default so a profile created with no `nav`
     * still stores all eight as `true` rather than an empty object — "all on"
     * is what the document should say on the day it is created, not something a
     * reader has to infer from missing paths.
     */
    nav: {
      type: executiveNavSchema,
      default: () => ({}),
    },
    /**
     * The audit pair. Who declared this person an Executive, and who last
     * changed their view — which is often the Executive themselves, since the
     * self path writes the same document. Null-able: neither is load-bearing,
     * and a profile written by a script has nobody behind it.
     */
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

/**
 * One profile per person per workspace.
 *
 * Unique rather than merely compound: every path into this collection is an
 * upsert on the pair, and a duplicate would make "is this person an Executive"
 * — the question the whole client shell branches on — answerable two ways
 * depending on document order.
 */
executiveViewSchema.index({ organisation: 1, user: 1 }, { unique: true });

const Model = mongoose.model('ExecutiveView', executiveViewSchema);

// Attached to the model, the way `ActivityLog` attaches ACTIVITY_TYPES, so the
// service's validator and the schema cannot hold different opinions about the
// widths, the switch names or the caps. SECTION_TYPES is deliberately NOT here:
// it belongs with the handlers in `services/executiveHome.js`, and this file
// must not depend on that one. See the header.
Model.WIDTHS = WIDTHS;
Model.NAV_KEYS = NAV_KEYS;
Model.MAX_BOARDS = MAX_BOARDS;
Model.MAX_SECTIONS = MAX_SECTIONS;
Model.MAX_LABEL = MAX_LABEL;

module.exports = Model;

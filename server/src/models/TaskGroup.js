const mongoose = require('mongoose');
const { MONTH_KEY_RE } = require('../utils/monthKey');

/**
 * One entry in a group's ownership timeline. `fromMonth` IS the key — a per-entry
 * `_id` would be 12 bytes of noise and would invite a "delete entry by id"
 * endpoint, which is not how this is edited.
 */
const ownerEntrySchema = new mongoose.Schema(
  {
    // 'YYYY-MM' in the BOARD's timezone. Same regex Goal.monthKey validates
    // against, so the two models cannot disagree about the format.
    fromMonth: { type: String, required: true, match: MONTH_KEY_RE },
    // null is a TOMBSTONE, not an absence — see the field comment below.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    setAt: { type: Date, default: Date.now },
  },
  { _id: false, timestamps: false }
);

const taskGroupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  board: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Board',
  },
  order: {
    type: Number,
    default: 0,
  },
  // Who made this group. Set once, at creation, and never written again — a
  // rename or a reorder does not change authorship, and there is deliberately no
  // endpoint that reassigns it (unlike `Board.createdBy`, which IS ownership and
  // therefore transferable; this is a byline, and confers nothing).
  //
  // Absent on every group that predates this field, and that is a permanent
  // state rather than a migration waiting to happen: the information was never
  // recorded, so nothing can backfill it. Every reader must tolerate null.
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Group tags — ids into the parent board's `groupTags` catalog, the group-level
  // counterpart of a task's tags. Stored as ids rather than names so a rename or
  // recolour on the board propagates without touching a single group.
  //
  // An id that no longer exists in the catalog is not an error, just noise: the
  // delete endpoint $pulls it from every group, and the client skips anything it
  // cannot resolve. Writes are gated on BOTH `group.manage` and the writer's own
  // `features.groupTags` opt-in — see utils/userFeatures.js.
  tags: [
    {
      type: mongoose.Schema.Types.ObjectId,
    },
  ],
  /**
   * Which SERVICE this group is, on a client board — a slug into the
   * organisation's service catalog (`models/ServiceCatalogEntry.js`).
   *
   * A SLUG, deliberately NOT an ObjectId ref. A ref would create a cascade
   * obligation nobody wants (delete a catalog entry -> what happens to every
   * group pointing at it?), would let a group point at another org's entry, and
   * would turn "the catalog row is gone" into a dangling pointer. A slug
   * degrades to a group with a name, which is exactly what a client board group
   * already was. Same reasoning as `Board.statuses[].key`.
   *
   * The catalog supplies the COLOUR and nothing else. `name` remains the
   * identity within the board — case-insensitively unique, enforced by
   * `groupController.resolveGroupName` — and the slug is only how "SEO" on
   * Acme's board and "SEO" on Globex's board are recognised as the same service.
   *
   * NULL on every group that predates this field, on every standard and tracker
   * board group, and on any client group somebody renamed to something the
   * catalog has never seen. EVERY READER MUST TOLERATE NULL.
   *
   * No index: `{ board: 1 }` already prefixes every query that touches this, and
   * there is no "find every SEO group across boards" read. Add one the day
   * somebody builds a cross-board service report, not before.
   */
  serviceKey: {
    type: String,
    default: null,
    trim: true,
    lowercase: true,
    maxlength: 60,
  },

  // ---- Group owner, TRACKER BOARDS ONLY (the controller gates every write on
  // board.boardType === 'tracker'). ----
  //
  // A SPARSE TIMELINE, not an audit log and not a row per month. Each entry says
  // "from this month onward, this person owns this group", and the owner for
  // month M is the LAST entry whose `fromMonth` is <= M. Carry-forward is
  // therefore free and structural: set it once in March and it holds for April,
  // May and every month after, until a later entry exists. Nothing runs monthly,
  // nothing is materialised, and there is no rollover job that can fail.
  //
  // The point of a timeline rather than a single `owner` field is HISTORY.
  // Reassigning a client today must not rewrite who is credited with March —
  // otherwise every past scoreboard silently changes under you.
  //
  // WHY EMBEDDED, when Goal.js explicitly refused to embed per-(group x month)
  // data: Goal stores a row per MONTH (8 goals x 12 months x 3 years = ~3,000
  // rows). This stores a row per CHANGE of owner, and a group's owner changes
  // once or twice a year. The two look alike and are three orders of magnitude
  // apart. OWNER_TIMELINE_LIMIT in utils/groupOwner.js is what keeps that
  // assertion true even when a client misbehaves. Embedding also means the
  // timeline dies with its group for free — a separate collection would have
  // needed a deleteMany in BOTH deleteGroup and orgCascade.js.
  //
  // `user: null` is a TOMBSTONE, not an absence: "deliberately unassigned from
  // this month onward". Without it you could never un-inherit an owner set in
  // some earlier month.
  //
  // NEVER read this array directly, and NEVER send it to a client.
  // utils/groupOwner.js is the only resolver — the same rule goalTypes.js has
  // for scoring — and groupController strips the array from every response,
  // returning only the resolved owner for the month asked about. You cannot
  // re-derive what you were never given.
  //
  // No migration: a group written before this field existed reads back without
  // the key, and the resolver's empty path answers "nobody".
  ownerTimeline: [ownerEntrySchema],
  // ---- Client Portal ------------------------------------------------------
  //
  // A group on a client board used to BE the client: it carried portalToken,
  // portalEnabled and portalClientName, and the shareable link was minted here
  // at group creation.
  //
  // Those three fields now live on `Board`. A client board IS one client
  // company, and its groups are that client's WORKSTREAMS (SEO, Ads, Web
  // Development) — so the link, the contact roster and the portal task filter
  // are all board-scoped. See utils/clientBoard.js and, for how the existing
  // tokens were carried upward without breaking a single live client link,
  // scripts/migratePortalToBoard.js.
  //
  // The values may still be present in MongoDB on pre-migration documents: the
  // `$unset` is the last phase and waits for the rollback window to close. The
  // surviving `portalToken_1` index there is inert, because nothing writes the
  // field any more.
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Every "the groups on this board" read — board load, analytics' live-group
// filter, the tracker grid — was scanning the whole collection without this.
//
// There is deliberately NO index on `ownerTimeline.user`. Ownership is resolved
// in memory from documents this index already loads, so a multikey index would
// tax every group write to serve a query that does not exist. Add one the day
// someone builds a cross-board "groups I own" view, not before.
taskGroupSchema.index({ board: 1 });

module.exports = mongoose.model('TaskGroup', taskGroupSchema);

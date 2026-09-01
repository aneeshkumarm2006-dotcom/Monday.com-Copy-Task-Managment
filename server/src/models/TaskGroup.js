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
  // ---- Client Portal fields (only meaningful when the parent board is a
  // 'client' board — the controller gates every write on board.boardType). A
  // group in a client board represents one client company; the link is minted
  // the moment the group is created and the invite goes out by email. ----
  //
  // Whether the shareable client link is currently live. Disabling instantly
  // closes the portal without discarding the token.
  portalEnabled: {
    type: Boolean,
    default: false,
  },
  // The public link id (crypto.randomBytes hex). Present in the URL the client
  // opens: `${CLIENT_URL}/portal/${portalToken}`. Regenerating rotates it and
  // invalidates the old link.
  //
  // NO `default` on purpose: the field must be ABSENT (not null) on groups
  // without a portal. A sparse index skips absent fields but DOES index null
  // values, so a `default: null` would put every group's null into the unique
  // index and the second such group would collide (E11000). Absent → not indexed.
  portalToken: {
    type: String,
  },
  // Friendly client/company label shown on the client's dashboard header.
  // Falls back to the group `name` when empty.
  portalClientName: {
    type: String,
    default: '',
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Unique only among groups that actually carry a token; null tokens are exempt.
taskGroupSchema.index({ portalToken: 1 }, { unique: true, sparse: true });

// Every "the groups on this board" read — board load, analytics' live-group
// filter, the tracker grid — was scanning the whole collection without this.
//
// There is deliberately NO index on `ownerTimeline.user`. Ownership is resolved
// in memory from documents this index already loads, so a multikey index would
// tax every group write to serve a query that does not exist. Add one the day
// someone builds a cross-board "groups I own" view, not before.
taskGroupSchema.index({ board: 1 });

module.exports = mongoose.model('TaskGroup', taskGroupSchema);

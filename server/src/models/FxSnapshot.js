const mongoose = require('mongoose');
const { FX_BASE, DAY_KEY_RE } = require('../utils/money');

/**
 * ONE DAY'S EXCHANGE RATES — the whole table, as published.
 *
 * ---- Why a snapshot per day, and not one "current rates" row ---------------
 *
 * An invoice raised in March is a fact about March. Converting it at today's
 * rate would make its dollar value drift every night, which means the Ledger's
 * "Billed" total moves on its own — and that is a number people reconcile
 * against their books.
 *
 * So every fetch is KEPT, dated, and a record converts against the newest
 * snapshot at or before its own day. A March invoice reads the same in
 * September as it did in March, without a rate having to be stamped onto every
 * invoice row.
 *
 * ---- Why this is NOT org-scoped --------------------------------------------
 *
 * A rate is a public fact. What one pound bought in dollars on 3 March does not
 * depend on who is asking, so one row serves every workspace. Only the FETCH is
 * per-org, and only when a workspace has chosen a provider that needs its own
 * key.
 *
 * The alternative — a table per organisation — would mean N workspaces issuing
 * N byte-identical requests a day against a shared, free, unmetered endpoint,
 * which is how a keyless provider starts rate-limiting you. It would also store
 * the same numbers N times for no gain.
 *
 * ---- Why the day key is a string -------------------------------------------
 *
 * Same reasoning as `Organisation.holidays` and `Tracker.daysOff`: a rate
 * belongs to a CALENDAR DATE with no time and no zone, and a `Date` would
 * silently attach both. ISO day keys also sort lexicographically, which is what
 * makes "the newest at or before this one" a plain string comparison.
 */
const fxSnapshotSchema = new mongoose.Schema(
  {
    /**
     * The unit every rate here is quoted against — USD, always, today.
     *
     * Stored rather than assumed because it is the one thing that would make
     * every number in `rates` mean something different, and a row that does not
     * say what it is quoted against is a row you cannot safely read later.
     *
     * A PRECISION choice: the provider returns five decimal places, so quoting
     * against USD gives INR 95.82 (five significant figures) where quoting
     * against INR would give USD 0.01044 (three). See `utils/money.js`.
     */
    base: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      default: FX_BASE,
    },

    /**
     * 'YYYY-MM-DD' — the day these rates were PUBLISHED FOR, which is not
     * necessarily the day we fetched them.
     *
     * The provider publishes on business days only, so there is no row for a
     * Saturday. Nothing special-cases that: "the newest snapshot at or before
     * the record's day" resolves a Saturday invoice to Friday's rates on its
     * own, and the absence of a weekend row is correct rather than a gap.
     */
    dayKey: {
      type: String,
      required: true,
      match: DAY_KEY_RE,
    },

    /**
     * `{ INR: 95.82, CAD: 1.3991, ... }` — how many of each currency one unit
     * of `base` buys.
     *
     * The provider's WHOLE table, not just the codes our pickers offer. That is
     * not thoroughness for its own sake: `Board.adsBudget.currency` accepts any
     * ISO 4217 code and only validates the length, so a board can already be
     * denominated in JPY or BRL. A snapshot limited to the eight codes in the
     * two pickers would silently fail to convert such a board — and one keyless
     * request returns all ~171 currencies anyway, so the narrow version would
     * cost the same and do less.
     *
     * Always includes `base: 1`, asserted by `sanitizeRates`. The provider
     * quotes every OTHER currency and omits the base itself, but conversion
     * divides by `rates[from]` — so without it, every figure already in USD
     * would refuse to convert.
     */
    rates: {
      type: Map,
      of: Number,
      required: true,
    },

    /** Which provider said so. Kept because two of them can disagree slightly. */
    provider: { type: String, required: true },

    /**
     * When WE asked, as opposed to the day the rates are for.
     *
     * The two differ whenever a snapshot is backfilled — a row for 2026-03-01
     * fetched in September is correct history, and the gap between these two
     * fields is what says so rather than looking like a stale row.
     */
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/**
 * One row per base per day, and re-fetching the same day is a no-op.
 *
 * This is what makes the backfill script safe to re-run: the unique key turns a
 * second pass into a collision rather than a duplicate, so nobody has to track
 * which months were already done.
 */
fxSnapshotSchema.index({ base: 1, dayKey: 1 }, { unique: true });

/** Resolution always reads the newest rows first. */
fxSnapshotSchema.index({ base: 1, dayKey: -1 });

module.exports = mongoose.model('FxSnapshot', fxSnapshotSchema);

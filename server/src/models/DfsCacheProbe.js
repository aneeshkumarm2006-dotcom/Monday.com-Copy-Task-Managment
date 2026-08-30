const mongoose = require('mongoose');

/**
 * THE MEASUREMENT PHASE 11 IS GATED ON.
 *
 * ---- Why this is a collection and not a `console.log` -----------------------
 *
 * Phase 2 shipped `probeCacheHits` as one log line, and the file said so in as
 * many words: "one `console.log`, on purpose - it will probably tell you not to
 * build phase 11." That was the right call for a phase whose job was to make the
 * hash exist. It is the wrong artefact to make a decision from:
 *
 *   A LOG LINE CANNOT BE DIVIDED. The number that matters is a RATE - hits over
 *     units - and a rate needs its denominator kept beside it. A line that fires
 *     only when `hit.size` is non-zero records the numerator and throws the
 *     denominator away, so the log says "we would have saved 40 keywords" and
 *     nothing at all about whether that was 40 of 60 or 40 of 40,000.
 *   A LOG LINE IS NOT PER KIND. Phase 10 was explicit: `movement` saves a tenth
 *     of what `positions` saves per hit because it is bought at `depth: 10`, and
 *     Backlinks is one call per DOMAIN rather than one per keyword per market.
 *     An average across kinds describes none of them.
 *   A LOG LINE IS NOT ON RENDER. Nobody reads a year of stdout from a hosted
 *     dyno to settle an architecture question, so in practice the measurement
 *     would not exist when the decision was taken - which is exactly how "only
 *     if measured" becomes "we guessed".
 *
 * So the probe writes a row. One per `(project, kind, variant, UTC day)`,
 * incremented rather than replaced, read back by `serpCache.summarise` and drawn
 * on Usage & Spend beside the threshold it is being compared against.
 *
 * ---- What is deliberately NOT stored ---------------------------------------
 *
 * THE OTHER TENANT'S IDENTITY. `otherOrgs` is a COUNT and never a list. The
 * whole reason phase 11 is delicate is that "is anyone else tracking this
 * keyword" is competitive intelligence; a measurement that answered "yes, and it
 * was org 64f2..." would be the leak the cache is being careful about, written
 * into our own database by the code that exists to decide whether to risk it.
 */

const dfsCacheProbeSchema = new mongoose.Schema(
  {
    /**
     * The ASKING workspace, and REQUIRED for `services/orgCascade.js` - the same
     * argument every other row in this provider makes. A probe row names this
     * org's keyword volume and market mix, which is competitive intelligence
     * even without the keywords themselves, so it must not outlive the workspace.
     */
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
    },

    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConnectorAccount',
      default: null,
    },

    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConnectorProject',
      required: true,
    },

    provider: { type: String, default: 'dataforseo' },

    /** `positions` / `movement`. PER KIND is the whole point - see the header. */
    kind: { type: String, required: true },

    /** `location_code|language_code|device`, from `sites.variantKeyFor`. */
    variant: { type: String, required: true },

    /** What was bought at, so a rate can be turned back into dollars. */
    depth: { type: Number, default: null },

    /**
     * The UTC DAY the measurement was taken on.
     *
     * A day rather than a month, because the reuse window is a day: two boards
     * refreshing the same keyword on the same UTC day is the entire opportunity,
     * and rolled up monthly the number would silently include pairs that could
     * never have shared anything.
     */
    periodKey: { type: String, required: true },

    /** How many buying decisions this row rolls up. */
    probes: { type: Number, default: 0 },

    /** How many billable units those decisions were about to buy. THE DENOMINATOR. */
    units: { type: Number, default: 0 },

    /**
     * Units another tenant had ALREADY COLLECTED today - result in hand, free to
     * copy. THE STRICT RULE, and the only one the shipped cache serves on.
     */
    readyHits: { type: Number, default: 0 },

    /**
     * Units another tenant had merely POSTED today and not yet collected.
     *
     * Counted APART, and the split is the point. Serving these needs a pre-post
     * claim, which converts a double charge into cross-tenant liveness coupling -
     * org B's rank tracker waiting on org A's task, for hours, with no way to say
     * why. Phase 11 refused that (see `serpCache.js`), and keeping the number
     * means the refusal can be revisited arithmetically rather than by taste.
     */
    openHits: { type: Number, default: 0 },

    /** Whole (project, kind, market) batches measured, and how many were FULLY covered. */
    batches: { type: Number, default: 0 },
    coveredBatches: { type: Number, default: 0 },

    /**
     * Units inside FULLY COVERED batches. THE NUMERATOR THE THRESHOLD USES.
     *
     * The shipped cache is all-or-nothing per batch - a snapshot is one
     * measurement of one market on one day, and half of it served now with half
     * bought four hours later is two measurements in one row with one
     * `collectedAt`. So `readyHits` is the upper bound a partial-serving cache
     * could reach and this is what THIS one can actually serve. Recording both is
     * what stops the threshold being checked against a number the feature cannot
     * deliver.
     */
    servableUnits: { type: Number, default: 0 },

    /** What those servable units would have cost. Dollars, not keywords. */
    wouldSaveUsd: { type: Number, default: 0 },

    /**
     * Units ACTUALLY served from the cache. Zero while the allowlist is empty,
     * which is the default - so `servableUnits > 0, servedUnits === 0` is the
     * normal reading and means "this would have worked, and it is switched off".
     */
    servedUnits: { type: Number, default: 0 },
    savedUsd: { type: Number, default: 0 },

    /**
     * How many DISTINCT OTHER TENANTS contributed to the overlap, at its highest
     * during the day. A COUNT AND NEVER A LIST - see the header.
     */
    otherOrgs: { type: Number, default: 0 },

    observedAt: { type: Date, default: null },

    /** 400 days out. The measurement is small and the decision may be seasonal. */
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * ONE ROW PER (project, kind, variant, day), incremented rather than replaced.
 *
 * The alternative - a row per probe - would be a row per site per kind per
 * market per hour, forever, to answer a question that is a sum. Unique so two
 * concurrent buying passes cannot mint two rows for one day and halve the rate
 * by splitting its denominator across them.
 */
dfsCacheProbeSchema.index(
  { project: 1, kind: 1, variant: 1, periodKey: 1 },
  { unique: true }
);

/** The rollup Usage & Spend draws: this board's sites, newest days first. */
dfsCacheProbeSchema.index({ project: 1, periodKey: -1 });

/** The deployment-wide question: what is the rate for THIS KIND right now. */
dfsCacheProbeSchema.index({ kind: 1, periodKey: -1 });

/** The 400-day sweep. `expireAfterSeconds: 0` expires AT the stored date. */
dfsCacheProbeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** `services/orgCascade.js` deletes by this and nothing else. */
dfsCacheProbeSchema.index({ organisation: 1 });

module.exports = mongoose.model('DfsCacheProbe', dfsCacheProbeSchema);

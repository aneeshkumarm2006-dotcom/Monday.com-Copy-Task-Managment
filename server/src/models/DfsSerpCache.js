const mongoose = require('mongoose');

/**
 * ONE SERP, SHARED BY THE TENANTS THAT AGREED TO SHARE IT.
 *
 * The only cross-tenant data path in this provider, and the one collection here
 * that carries no `organisation` field. Everything below is arranged around the
 * four complications the plan named as the reason phase 11 might never happen.
 *
 * ---- 1. It breaks `orgCascade`, and the fix is a REFCOUNT ------------------
 *
 * `services/orgCascade.js` deletes every connector collection by `organisation`.
 * A body shared by two workspaces cannot carry one, which the plan called out as
 * "a real compliance decision, not something to settle while building a task
 * queue". Both offered answers were refcounting or a written policy; this is the
 * refcount, because a policy saying "SERP bodies are public, we keep them" is an
 * answer to a question nobody asked - the concern was never the ten blue links,
 * it is that THE KEYWORD IS THE WORKSPACE'S COMPETITIVE INTELLIGENCE and the row
 * names one.
 *
 * `orgs[]` is the refcount, and it is a SET OF IDS rather than an integer on
 * purpose: `$pull` is idempotent and `$inc: -1` is not, so a cascade that is
 * retried after a partial failure cannot drive a live row's count below its real
 * referrers and delete a body two other workspaces are still using. `orgCascade`
 * pulls the departing workspace and then deletes every row whose `orgs` is
 * empty, so the last workspace out takes the body with it.
 *
 * The compliance position this states, deliberately and in one sentence: A SHARED
 * ROW SURVIVES A TEARDOWN ONLY WHILE ANOTHER PARTICIPATING WORKSPACE IS STILL
 * ASKING THE SAME QUESTION - at which point the keyword is that workspace's
 * intelligence as much as it was the departing one's, and the body itself is a
 * public search result. It survives at most 48 hours regardless, because of the
 * TTL below.
 *
 * ---- 2. The freshness window is the day, and is NOT widened ----------------
 *
 * `periodKey` is part of the key. Reusing a six-day-old SERP inside a rank
 * tracker breaks the product's core claim, so safe reuse is same-`periodKey`
 * only - which the plan already predicted would eat most of the hit rate, and
 * does. The row's `collectedAt` is DataForSEO's own datetime and travels to the
 * serving org's snapshot, so a served reading is filed under the day the SERP was
 * actually crawled rather than the day it was copied.
 *
 * ---- 3. `depth` is in the key, which costs hit rate on purpose -------------
 *
 * A `depth: 100` census body CONTAINS the top ten, so it could answer a
 * `depth: 10` movement request and roughly double the hit rate. It is refused.
 * `comparability.js`'s depth guard exists because "a rank bought to depth 10
 * reports every keyword outside the top ten as unranked", and a movement row
 * secretly bought at depth 100 would be the one reading in the series that could
 * see further - a discontinuity in a chart, arriving from a cache, with nothing
 * in the payload to notice it by.
 *
 * ---- 4. What is NOT here ---------------------------------------------------
 *
 * No domain, no project, no keyword LIST, no board. A row is one keyword in one
 * market on one day, which is the smallest unit that can answer anybody's
 * question, and the smallest unit that can leak. Whose rank was read out of it is
 * a fact that lives on the reading org's own `DfsTask` row, never here.
 */

const dfsSerpCacheSchema = new mongoose.Schema(
  {
    /**
     * sha256 over `[endpoint, depth, locationCode, languageCode, device, keyword]`.
     *
     * ---- Why this is NOT `DfsTask.requestHash`, said loudly -----------------
     *
     * Phase 2 computed `requestHash` and recorded that it was "the exact value a
     * phase-11 cross-tenant cache would key on". BUILDING IT SHOWED THAT IS
     * WRONG, and the correction matters more than the inconvenience.
     *
     * `tasks.buildRequest` hashes the whole JOB: endpoint, depth, priority,
     * market, DOMAIN and the FULL KEYWORD ARRAY. Two workspaces tracking "best
     * crm for agencies" in US-desktop hash differently unless they track the
     * identical keyword list for the identical domain - which is to say
     * `requestHash` can never collide across tenants at all. Keyed on it, the
     * cache would have a structurally guaranteed hit rate of zero, and the
     * measurement built to gate the decision would have measured the key rather
     * than the world.
     *
     * So the cache keys on a NARROWER hash of the fields that are genuinely
     * shared, and `requestHash` keeps its phase-2 shape untouched - it is still
     * what proves a repost identical to its original, which is the job it has
     * actually been doing. `serpCache.cacheKeyFor` is the only minter.
     */
    cacheKey: { type: String, required: true },

    /**
     * The UTC day, from the provider's own `collectedAt`. Half the key, and the
     * entire freshness policy. See complication 2 in the header.
     */
    periodKey: { type: String, required: true },

    /** The six inputs the key is minted from, kept legible for an operator. */
    keyword: { type: String, required: true },
    locationCode: { type: Number, default: 0 },
    languageCode: { type: String, default: 'any' },
    device: { type: String, default: 'desktop' },
    depth: { type: Number, default: null },
    endpoint: { type: String, default: '' },

    /** DataForSEO's own datetime for the crawl. Travels onto the served snapshot. */
    collectedAt: { type: Date, default: null },

    /**
     * The provider's SERP blocks, UNTRIMMED.
     *
     * `DfsSerpResult` keeps twenty because that is what a table draws. This keeps
     * everything that was bought, and the difference is not an oversight: a
     * serving workspace's domain may rank at 45, and a cache that had thrown
     * items 21-100 away would answer "not in the top 100" for it - confidently,
     * with no error, on the one screen the whole product is about. Bounded by
     * `serpResults.fitToCeiling` against the same 4 MB measurement, which a
     * ~150 KB depth-100 body cannot approach.
     */
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },

    /** The SERP-feature census, carried so a served reading has the same shape. */
    itemTypes: { type: [String], default: [] },
    seResultsCount: { type: Number, default: null },

    bytes: { type: Number, default: 0 },
    /** The measurement forced the body out. Stored empty rather than not at all. */
    oversized: { type: Boolean, default: false },

    /**
     * THE REFCOUNT. Every participating workspace that has paid for or read this
     * row. `orgCascade` `$pull`s and then deletes the empties - see the header.
     */
    orgs: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Organisation' }],
      default: [],
    },

    /** Diagnostics for the measurement, never for a screen. */
    reads: { type: Number, default: 0 },

    /**
     * 48 hours out. NEVER NULL - unlike `DfsSerpResult`, there is no pinning
     * here, because a shared row is nobody's evidence: the workspace that wants
     * to keep a page as it looked keeps it in its OWN `DfsSerpResult`, under its
     * own organisation, where a pin is a decision its own operator made.
     */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

/**
 * ONE ROW PER (cacheKey, day).
 *
 * Unique, so two participating workspaces collecting the same keyword minutes
 * apart converge on one row rather than storing the same page twice under two
 * refcounts - which would leave a body alive after its last real referrer had
 * gone.
 */
dfsSerpCacheSchema.index({ cacheKey: 1, periodKey: 1 }, { unique: true });

/** The cascade's `$pull`, and the only query that ever names an organisation here. */
dfsSerpCacheSchema.index({ orgs: 1 });

/** The 48-hour sweep. `expireAfterSeconds: 0` expires AT the stored date. */
dfsSerpCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('DfsSerpCache', dfsSerpCacheSchema);

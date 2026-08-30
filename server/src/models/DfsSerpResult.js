const mongoose = require('mongoose');

/**
 * The SERP body for one keyword, for one collection.
 *
 * ---- Why this collection exists, in one number ------------------------------
 *
 * One organic item is ~1-2 KB. `depth: 100` is therefore ~100-200 KB per
 * keyword, and a 200-keyword Site is **20-40 MB — over Mongo's 16 MB document
 * ceiling by 2x.**
 *
 * The failure mode is the expensive part, not the size. The driver rejects the
 * write AFTER DataForSEO has been paid and AFTER `task_get` has consumed the
 * result — and `task_get` is not idempotent in any way that helps, because the
 * money is already spent and the batch has already been closed. Money out, data
 * lost, and a stack trace about a document being too large.
 *
 * So the split is deliberate and permanent:
 *
 *   `ConnectorSnapshot.data` — the AGGREGATE ONLY. ~80 bytes a keyword, 16 KB
 *     for two hundred. `raw` stays null, exactly as `ConnectorSnapshot.js`
 *     already prescribes for the batched kinds. This is the irreplaceable half:
 *     a rank on a day that has passed can never be re-bought.
 *   `DfsSerpResult`            — the bulky evidence, ONE DOCUMENT PER KEYWORD, so
 *     the ceiling is per keyword rather than per batch and 200 keywords is 200
 *     small documents rather than one impossible one.
 *
 * ---- The three rules, and why each is a rule --------------------------------
 *
 * 1. ITEMS ARE CAPPED AT RENDER DEPTH, NOT PURCHASE DEPTH. Buying 100 results is
 *    defensible — `rank_absolute` is only accurate to the depth you bought, and
 *    the competitive census, the SERP-feature census and cannibalization
 *    detection all come out of the deep crawl for free. STORING 100 when the UI
 *    draws 20 is not. `storedCount` and `truncated` are what keep that honest:
 *    without them a later reader cannot tell "there were only 8 results" from
 *    "we threw the rest away".
 *
 * 2. THE SIZE IS MEASURED, NOT DISCOVERED. `Buffer.byteLength` of the serialised
 *    items, against a 4 MB ceiling, BEFORE the write. Four rather than sixteen
 *    because the ceiling applies to the whole BSON document and our measurement
 *    covers only the biggest field of it — a margin, not a limit, and one wide
 *    enough that no plausible SERP can cross it by accident.
 *
 * 3. `expiresAt` IS NULLABLE AND HAS A TTL. Evidence ages out at 90 days; a
 *    pinned result (an audit, a client report, a dispute) sets it to null and
 *    lives forever. A TTL index skips documents whose field is not a date, which
 *    is what makes "nullable" the whole implementation of "pinned".
 */

const dfsSerpResultSchema = new mongoose.Schema(
  {
    /**
     * REQUIRED, for `services/orgCascade.js` — the same argument as
     * `DfsTask.organisation`. A SERP body is a public search result, but the
     * KEYWORD it answers is competitive intelligence, and it must not outlive
     * the workspace it was bought for.
     *
     * It is also the field phase 11 would have to give up. A cross-tenant cache
     * cannot carry an organisation, which is the first of the four reasons that
     * phase may never happen.
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

    /**
     * The job that bought this. The audit trail from a stored SERP back to the
     * money that paid for it, and the join a re-delivery would use.
     */
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DfsTask',
      default: null,
    },

    provider: { type: String, default: 'dataforseo' },

    /** `positions` or `movement` — the same key the snapshot carries. */
    kind: { type: String, required: true },

    /** `location_code|language_code|device`, from `sites.variantKeyFor`. */
    variant: { type: String, required: true },

    /**
     * The DAY, from the provider's own datetime — the same `periodKey` the
     * snapshot was filed under, so a row here and a row there are joinable
     * without a second lookup.
     */
    periodKey: { type: String, required: true },

    /** The keyword this SERP answers, exactly as posted. */
    keyword: { type: String, required: true },

    /** DataForSEO's own datetime for the crawl. */
    collectedAt: { type: Date, default: null },

    /** What we paid for: 100 for the weekly census, 10 for the daily check. */
    purchasedDepth: { type: Number, default: null },

    /** What we kept. See rule 1. */
    renderDepth: { type: Number, default: null },

    /** How many items DataForSEO actually returned, before any trimming. */
    returnedCount: { type: Number, default: 0 },

    /** How many are in `items` below. */
    storedCount: { type: Number, default: 0 },

    /**
     * True when `storedCount < returnedCount`.
     *
     * The honesty flag. A reader that finds eight items has to be able to tell
     * "the SERP was short" from "we kept eight of a hundred", and no count on
     * its own can say which.
     */
    truncated: { type: Boolean, default: false },

    /**
     * The trimmed SERP blocks, in the provider's own order.
     *
     * `Mixed`, and for the same reason `ConnectorProject.raw` is: DataForSEO's
     * advanced payload carries a dozen block types whose fields their docs
     * describe loosely, and a field the normaliser failed to anticipate should
     * be a change to `normalise.js` rather than a period of history nobody can
     * recover.
     */
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },

    /** The SERP-feature census for this keyword. Diffing it is free volatility. */
    itemTypes: { type: [String], default: [] },

    /** `Buffer.byteLength` of the serialised `items`, as measured before writing. */
    bytes: { type: Number, default: 0 },

    /**
     * True when the measurement forced items out beyond the render cap.
     *
     * Should never fire — 20 items cannot approach 4 MB — and exists because the
     * whole point of measuring is to find out rather than to assume. A row
     * flagged here is a payload nobody predicted, and it is better to store an
     * empty body that says so than to attempt a write that loses the reading.
     */
    oversized: { type: Boolean, default: false },

    /**
     * Kept forever, by a person who needs it kept.
     *
     * Sets `expiresAt` to null. The rank on the snapshot never expires either
     * way; this is about the EVIDENCE — the page as it looked, for an audit or a
     * dispute.
     */
    pinned: { type: Boolean, default: false },

    /**
     * When the bulky half ages out. NULL MEANS NEVER.
     *
     * A TTL index ignores a document whose indexed field is not a date, so
     * nulling this is the entire implementation of `pinned` — no second
     * collection, no sweep of our own, no archival job.
     */
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * ONE ROW PER (project, kind, variant, periodKey, keyword).
 *
 * Unique so a RE-DELIVERED result writes the same row rather than a second one.
 * That is not hypothetical: phase 4's `tasks_ready` is a destructive read, so
 * the repair path for a crashed collection is to `task_get` ids we may already
 * have collected — and results live 30 days, so the same body can legitimately
 * arrive twice. Without this index the second delivery doubles the collection.
 *
 * Keyed on `periodKey` rather than on `task`, deliberately: two attempts of the
 * same job are two tasks and one measurement, and the measurement is what the
 * row is.
 */
dfsSerpResultSchema.index(
  { project: 1, kind: 1, variant: 1, periodKey: 1, keyword: 1 },
  { unique: true }
);

/** Everything one job bought — the audit trail, and the phase-4 join. */
dfsSerpResultSchema.index({ task: 1 });

/** The dashboard's own query: one keyword's SERP through time. */
dfsSerpResultSchema.index({ project: 1, keyword: 1, periodKey: -1 });

/**
 * The 90-day sweep.
 *
 * `expireAfterSeconds: 0` means "expire AT the stored date" rather than that
 * many seconds after it, which is what lets the writer choose the horizon per
 * row. Documents whose `expiresAt` is null are skipped by the TTL monitor
 * entirely — that is the pinning mechanism, not a happy accident.
 */
dfsSerpResultSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** `services/orgCascade.js` deletes by this and nothing else. */
dfsSerpResultSchema.index({ organisation: 1 });

module.exports = mongoose.model('DfsSerpResult', dfsSerpResultSchema);

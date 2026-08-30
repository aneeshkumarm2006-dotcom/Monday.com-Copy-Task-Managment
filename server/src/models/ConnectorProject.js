const mongoose = require('mongoose');
const { CONNECTOR_PROVIDERS } = require('../utils/connectorProviders');

/**
 * One project as the provider holds it, mirrored locally, plus the group it
 * feeds.
 *
 * ---- Why mirror at all, rather than listing live ---------------------------
 *
 * Every call to Ubersuggest is drawn against a quota shared by the whole
 * workspace, and `list_projects` is not free of that. Rendering the Add-ons tab
 * straight from the provider would spend it on every page load, every tab
 * switch and every back-button press — and would put a third-party outage
 * between a user and a mapping they already made. The tab reads THIS collection;
 * only the Refresh button and the weekly runner reach out.
 *
 * The mirror is also what makes a mapping stable. A binding has to point at
 * something in our database, because the group it feeds and the snapshots it
 * will accumulate are here too.
 *
 * ---- Why the binding is to a GROUP -----------------------------------------
 *
 * One Ubersuggest project is one domain. The tracker boards carry one client per
 * GROUP — twenty-four of them on DAVNOOT SEO, twenty-four separate domains — so
 * a project-to-board mapping could only ever address one of them. The board is
 * denormalised alongside for the cascade and for the per-board query; the group
 * is the meaning.
 *
 * ---- Why `raw` is stored ---------------------------------------------------
 *
 * `llms.md` documents the project tools' response as "the raw Ubersuggest API
 * payload (fields defined by the backend)" and nothing further. Phases 3-5 are
 * built on these shapes, so the payload is kept exactly as it arrived: a field
 * the normaliser failed to anticipate is then a normaliser change rather than a
 * re-sync of every account, and a shape that changes under us is visible by
 * comparison instead of by inference. Display only — nothing branches on it.
 */

/**
 * A (language, location) pair the project tracks rankings for.
 *
 * Stored because `project_position_info` REQUIRES a matching `locId`/`language`
 * to filter by, and refuses combinations the project does not track. Phase 3
 * would otherwise need a round trip per project to discover them.
 */
const trackedLocaleSchema = new mongoose.Schema(
  {
    locId: { type: Number, default: null },
    lang: { type: String, default: null },
    label: { type: String, default: null },
  },
  { _id: false }
);

/**
 * One market a LOCALLY AUTHORED project is collected in.
 *
 * ---- Why this is not `trackedLocaleSchema` ---------------------------------
 *
 * That one is a MIRROR of what a provider says a project already tracks, and its
 * every field is nullable because an undocumented payload might not carry them.
 * This one is an INSTRUCTION: it is what we will put on the wire, so all three
 * parts are required in practice, `device` is part of the identity rather than a
 * separate axis, and the codes are the provider's own integers rather than
 * whatever a listing happened to spell them as.
 *
 * They also mean different things to money. A mirrored locale is free
 * information about somebody else's project; a target multiplies the cost of
 * every keyword on this one by another full collection.
 *
 * `_id: false` because a target has a natural key —
 * `location_code|language_code|device` — and a Mongo-assigned one would be a
 * second identity that shifts when the array is rewritten. From phase 2 the
 * variant key derives from those three fields and NOTHING ELSE, which is what
 * keeps an open task findable across an edit that only renamed a label.
 */
const collectionTargetSchema = new mongoose.Schema(
  {
    /** DataForSEO's `location_code`: 2840 is the United States. */
    locationCode: { type: Number, required: true },
    /** Their `language_code`: `en`, `en-GB`. Lowercased on the way in. */
    languageCode: { type: String, required: true, trim: true, lowercase: true },
    /** What the SERP is read on. Providers accept desktop and mobile. */
    device: { type: String, required: true, trim: true, lowercase: true, default: 'desktop' },
    /** Display only — "United States, English (desktop)". Never part of the key. */
    label: { type: String, default: null },
  },
  { _id: false }
);

const connectorProjectSchema = new mongoose.Schema(
  {
    // Which connected account this project belongs to. The pool is plural — an
    // Ubersuggest account caps at 15 domains — so a project is only ever
    // identifiable as (account, externalId), never by its id alone.
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConnectorAccount',
      required: true,
      index: true,
    },
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: CONNECTOR_PROVIDERS,
      required: true,
    },

    /** The provider's own id. A string even where the provider sends a number. */
    externalId: { type: String, required: true },

    // ---- Mirrored description ----------------------------------------------
    name: { type: String, default: '' },
    domain: { type: String, default: null },
    keywordCount: { type: Number, default: null },
    competitorCount: { type: Number, default: null },
    locations: { type: [trackedLocaleSchema], default: [] },
    hasBrand: { type: Boolean, default: false },

    /** The payload verbatim. See the header. */
    raw: { type: mongoose.Schema.Types.Mixed, default: null },

    // ---- The authored half -------------------------------------------------
    //
    // Everything above this line MIRRORS a provider. Everything below it is
    // ours, and exists because the second provider has nothing to mirror:
    // DataForSEO is a stateless billing API with no concept of a project, so a
    // "Site" is authored here and `externalId` is set to our own id.
    //
    // A provider that does have projects simply leaves these empty. Nothing
    // generic reads them, and the mirror's `$set` never names them — which is
    // what stops a routine reconciliation from overwriting the authored half of
    // a row with a stale copy of itself.

    /**
     * The keywords this project is collected for.
     *
     * A REAL FIELD, deliberately, rather than a corner of `raw`.
     *
     * `snapshotService.planProjectWork` gates a kind on `project[kind.requires]`,
     * so this has to be somewhere a generic planner can dereference. And it is
     * the quantity that decides what a collection COSTS — one paid task per
     * keyword per target — so "how many keywords is this workspace about to buy"
     * has to be answerable with a query rather than by loading every document
     * and counting inside a `Mixed` blob that is not indexed, not queryable and
     * not normalised on the way in. `__sketch__/ads.js` recorded exactly that
     * cost from the other side when it reached for `raw` as an escape hatch.
     *
     * Stored lowercased and whitespace-collapsed by the provider's own reader,
     * because Google is case-insensitive and "Best CRM" and "best crm" are one
     * keyword that would otherwise be bought twice.
     *
     * THE ONE TRAP: an empty array is TRUTHY in JavaScript, so `requires:
     * 'trackedKeywords'` does NOT skip a project whose list is empty. Any kind
     * declaring it must check the length itself.
     */
    trackedKeywords: { type: [String], default: [] },

    /**
     * The (location, language, device) markets to collect in. See
     * `collectionTargetSchema` — each one multiplies the cost of every keyword
     * by another full collection, which is why it is capped in the provider's
     * own reader rather than left open.
     */
    targets: { type: [collectionTargetSchema], default: [] },

    /**
     * Domains to compare against. Display and analysis only — nothing here is
     * collected for on its own, so a competitor costs nothing until a screen
     * asks a question about one.
     */
    competitors: { type: [String], default: [] },

    /**
     * The Google Business Profile this site belongs to, if it has one.
     *
     * A name ("Acme Plumbing, Leeds"), or a `cid:` / `place_id:` value copied
     * off the listing itself. Optional, and the emptiness is load-bearing rather
     * than cosmetic: it is the GATE on a billable kind.
     *
     * ---- Why this is the one `requires` gate in the catalog that works -------
     *
     * `snapshotService.planProjectWork` skips a kind when `project[kind.requires]`
     * is falsy, and every existing use of that gate names an ARRAY — where an
     * empty one is truthy and the gate does nothing, which is recorded twice in
     * `dataforseo/kinds.js`. This is a STRING, and an empty string is falsy, so
     * `requires: 'businessName'` genuinely stops the collection.
     *
     * What it stops is money. `BoardConnector.kinds` is unioned across every
     * board mapping a project and an empty selection means everything, so a
     * billable kind with no gate is bought for every Site the day it ships. A
     * Maps lookup for a business nobody has named is a guaranteed empty answer
     * with a real price on it.
     *
     * NOT derived from the domain, deliberately. `my_business_info` fuzzy-matches
     * a text query, so a domain query returns a card for whatever Google decides
     * is closest — and a confident card for the WRONG business is stored,
     * charted and put in front of a client, which is much worse than no card.
     */
    businessName: { type: String, default: '' },

    /**
     * This row was authored here rather than mirrored from a provider.
     *
     * The flag that makes the difference visible in a shell six months from now,
     * and the one an edit endpoint checks before rewriting a row: a mirrored
     * project must not become editable just because a second provider's rows
     * live in the same collection.
     */
    locallyAuthored: { type: Boolean, default: false },

    // ---- The binding -------------------------------------------------------

    /**
     * The group this project feeds, and the board that group is on.
     *
     * Both null until somebody maps it. An unmapped project is not a problem to
     * be fixed — an agency's Ubersuggest account holds projects for clients who
     * are not on this board, and prospects who are not clients at all.
     */
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
      default: null,
      index: true,
    },
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      default: null,
      index: true,
    },
    boundBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    boundAt: { type: Date, default: null },

    // ---- Mirror bookkeeping ------------------------------------------------

    /** When this row last matched something in a `list_projects` response. */
    lastSeenAt: { type: Date, default: Date.now },

    /**
     * When a snapshot run last WORKED on this project — distinct from
     * `lastSeenAt`, which only says it was still in the listing.
     *
     * Stamped whether or not any snapshot was written, because "we tried and
     * everything was already current" and "we have never tried" are different
     * states and only one of them is worth a Refresh. The per-kind freshness
     * decision reads the snapshot rows themselves; this is for the UI.
     */
    lastFetchedAt: { type: Date, default: null },

    /**
     * The project was NOT in the last listing — deleted at the provider, or
     * moved to another account.
     *
     * A flag rather than a delete, and the distinction matters: this row is
     * the parent of every ConnectorSnapshot ever taken for that domain.
     * Deleting it to tidy up would silently discard the month-over-month history
     * that is the entire reason the feature exists, and it would do so in
     * response to somebody else's action inside a third-party product. The tab
     * greys these out and offers to unmap them; nothing removes them.
     */
    missing: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// The mirror upserts against this. Unique so two concurrent refreshes of the
// same account cannot produce two rows for one project.
connectorProjectSchema.index({ account: 1, externalId: 1 }, { unique: true });

/**
 * A group holds at most ONE project per provider.
 *
 * Without this, two projects could quietly feed the same group and phase 5's
 * writeback would have two sources for one cell, with the winner decided by
 * document order. Partial, because `group: null` is the normal state for most
 * rows and a plain unique index would allow exactly one unmapped project.
 */
connectorProjectSchema.index(
  { provider: 1, group: 1 },
  {
    unique: true,
    partialFilterExpression: { group: { $type: 'objectId' } },
  }
);

// The Add-ons tab's own query: every project reachable from this board's org,
// for this provider.
connectorProjectSchema.index({ organisation: 1, provider: 1, missing: 1 });

/**
 * "Who tracks this keyword?" — a multikey index over the authored list.
 *
 * The reason `trackedKeywords` is a field rather than a corner of `raw`, made
 * enforceable. Two things need it and neither can load every document to find
 * out: the phase-3 budget, which has to size a collection before buying it, and
 * the phase-11 measurement, which is the question "are two boards paying twice
 * for the same keyword in the same market" and which the plan says to MEASURE
 * before building anything. Provider-first so it also serves a plain
 * "every Site" scan.
 */
connectorProjectSchema.index({ provider: 1, trackedKeywords: 1 });

module.exports = mongoose.model('ConnectorProject', connectorProjectSchema);

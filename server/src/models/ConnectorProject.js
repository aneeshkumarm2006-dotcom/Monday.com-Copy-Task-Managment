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

module.exports = mongoose.model('ConnectorProject', connectorProjectSchema);

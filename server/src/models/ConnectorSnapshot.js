const mongoose = require('mongoose');
const { CONNECTOR_PROVIDERS } = require('../utils/connectorProviders');

/**
 * One reading of one kind of provider data, for one project, at one point in
 * time. NOTHING HERE IS EVER OVERWRITTEN WITH OLDER OR WORSE DATA.
 *
 * ---- Why this collection is the point of the whole feature -----------------
 *
 * Per-keyword rank history DOES NOT EXIST in the Ubersuggest API.
 * `project_position_info` returns exactly two points per keyword —
 * `old_position.position` and `new_position.position` — and there is no
 * `keywords[].history` and no tool that exposes the "See Trend" view the product
 * shows in its own UI. The only series in the entire response is
 * `average_positions.positions`, which is the PROJECT-AGGREGATE mean.
 *
 * So this is not a cache. Storing a row every week is the only mechanism by
 * which "what did this keyword rank in March" can ever be answerable. Three
 * further facts make that non-negotiable:
 *
 *   - the provider retains rank data for 3 years, and only from the date each
 *     KEYWORD was added — not the project;
 *   - 30 days of account inactivity pauses tracking, and their documentation
 *     says "any missed data cannot be recovered";
 *   - a project deleted at the provider takes its history with it, which is why
 *     `ConnectorProject` flags a departed project instead of deleting it — these
 *     rows hang off it.
 *
 * Gaps at Ubersuggest are permanent. Gaps here are not, and that asymmetry is
 * the reason to write rather than to re-read.
 *
 * ---- The identity of a row -------------------------------------------------
 *
 * (project, kind, variant, periodKey). All four are load-bearing:
 *
 *   - `project` rather than group or board, because the mapping to a group is
 *     optional and changeable and the history must survive being re-pointed;
 *   - `kind`, because a project produces several unrelated series;
 *   - `variant`, because `project_position_info` is the one device-aware tool
 *     and filters by a (locId, language) pair — a US-desktop rank and a
 *     UK-desktop rank for the same keyword on the same day are two facts, and
 *     collapsing them would make a series flip between markets week to week;
 *   - `periodKey`, which comes from THE PROVIDER'S OWN `updated_at` wherever it
 *     gives one. That is the authoritative SERP-collection time, so two polls in
 *     the same week resolve to the same row instead of inventing a second
 *     data point out of our own clock.
 *
 * ---- What is deliberately absent -------------------------------------------
 *
 * There is no `status: 'failed'`. A failure would have to claim a periodKey, and
 * the only one available for a failure is today's — which would then be sitting
 * in the slot the real snapshot needs when the provider recovers, and the unique
 * index would keep the good data out. Failures are recorded on the RUN instead
 * (`ConnectorAccount.lastSyncReport`) where they belong: they are facts about an
 * attempt, not about a period.
 *
 * `partial` is different and is kept. A crawl that is 47 pages into 150, or a
 * rank report that timed out with 80 of 120 keywords resolved, returned real
 * data for a real period. It is stored, labelled, and replaced in place when the
 * finished version of the SAME period arrives — see `snapshotService.write`.
 */

const connectorSnapshotSchema = new mongoose.Schema(
  {
    // Denormalised from the project so an org teardown is one query and does not
    // have to load every project first. Same reasoning as BoardConnector.
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConnectorAccount',
      required: true,
    },
    /**
     * The project this reading is about.
     *
     * NOT the group and NOT the board. A project's binding to a group is
     * optional, changeable, and can be cleared by deleting either the group or
     * the board — none of which is a statement about the client's rank history.
     * Hanging the history off the project is what lets a client be re-mapped to
     * a new group with every week we ever collected intact.
     */
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConnectorProject',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: CONNECTOR_PROVIDERS,
      required: true,
    },

    /**
     * Which series this is — `positions`, `site_audit`, and so on.
     *
     * A free string rather than an enum ON PURPOSE. The kinds are declared by
     * the PROVIDER DESCRIPTOR (`services/connectors/ubersuggest/kinds.js`), and
     * a mongoose enum here would mean the second connector could not add one of
     * its own without a schema change in shared code — which is exactly the
     * seam the registry exists to keep open. The controller validates against
     * the descriptor before anything reaches this model.
     */
    kind: { type: String, required: true },

    /**
     * Which shape of request produced this. `default` for kinds that take only
     * a subject; `desktop|en|2840` for a rank report.
     *
     * Readable rather than hashed, deliberately. The design plan called this
     * `requestHash`; a hash gives the same collision guarantee but cannot be
     * read off a document in a shell, and "why did this project's history split
     * into two series" is a question somebody will be asking with a shell open.
     */
    variant: { type: String, required: true, default: 'default' },

    /**
     * The period this reading belongs to, `YYYY-MM-DD`.
     *
     * From the provider's own `updated_at` when it gives one, and from our clock
     * only when it does not. Getting this from the provider is what makes a
     * second poll in the same week a no-op rather than a duplicate point on
     * every chart.
     */
    periodKey: { type: String, required: true },

    /**
     * When the data was collected AT THE PROVIDER, as it reported it. Null when
     * the tool exposes no such field — the domain and backlink reports do not.
     * Distinct from `fetchedAt`, which is our clock, and it is the difference
     * between the two that tells you how stale a reading was when we took it.
     */
    collectedAt: { type: Date, default: null },

    /** What was actually asked about — `project:5512`, `domain:acme.com`. */
    subject: { type: String, default: '' },

    /** The normalised body. Shape is per-kind; see the descriptor's normalisers. */
    data: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * The provider payload verbatim, where it is small enough to be worth it.
     *
     * Same argument as `ConnectorProject.raw`: most of these responses are
     * documented only as "the raw Ubersuggest API payload (fields defined by the
     * backend)", so a field the normaliser failed to anticipate should be a
     * change to `normalise.js` rather than a period of history nobody can
     * recover. Omitted for the batched kinds, where the raw form is several
     * payloads and the normalised rows are the better record.
     */
    raw: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * `ok` — final, per the provider.
     * `partial` — real data for a real period, but the provider said it was not
     *   finished (a crawl still running, a rank report that timed out).
     *
     * There is no `failed`; see the header.
     */
    status: {
      type: String,
      enum: ['ok', 'partial'],
      default: 'ok',
      index: true,
    },

    /** A sentence for the UI when `partial`, or a caveat when `ok`. */
    note: { type: String, default: '' },

    /** Our clock, when the call returned. */
    fetchedAt: { type: Date, default: Date.now },

    /**
     * Who pressed the button, or null for the weekly runner. Null is the normal
     * case and is the value that says "nobody was watching".
     */
    fetchedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

/**
 * One row per (project, kind, variant, period).
 *
 * This index is what makes a re-run idempotent instead of duplicative, and it is
 * the last line of defence: the runner also checks freshness before spending a
 * call, but two app instances waking at the same minute would both pass that
 * check and only this stops them writing two points onto one week.
 */
connectorSnapshotSchema.index(
  { project: 1, kind: 1, variant: 1, periodKey: 1 },
  { unique: true }
);

/** The history query: one series, newest first. */
connectorSnapshotSchema.index({ project: 1, kind: 1, collectedAt: -1 });

/**
 * The tab's own query — the latest reading of every kind for a set of projects.
 * `fetchedAt` rather than `collectedAt` because the domain reports never carry a
 * provider timestamp, and a sort on a mostly-null field puts them in an
 * arbitrary order.
 */
connectorSnapshotSchema.index({ project: 1, fetchedAt: -1 });

/** The org teardown, and the "has this workspace ever collected anything" check. */
connectorSnapshotSchema.index({ organisation: 1, provider: 1 });

module.exports = mongoose.model('ConnectorSnapshot', connectorSnapshotSchema);

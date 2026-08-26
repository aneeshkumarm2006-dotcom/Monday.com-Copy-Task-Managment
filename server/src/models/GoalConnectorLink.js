const mongoose = require('mongoose');
const { CONNECTOR_PROVIDERS } = require('../utils/connectorProviders');

/**
 * "This goal is about THIS tracked keyword, on THIS project."
 *
 * The last piece of wiring the writeback needs, and the one that carries
 * PROVENANCE — who last wrote each cell, and what the connector would say about
 * a cell it is no longer allowed to touch.
 *
 * ---- Why a link is needed at all, when the group already names a project ----
 *
 * A `ConnectorProject` is bound to a GROUP, so the writeback already knows whose
 * numbers a goal's group is about. That is enough for a PROJECT-scoped field —
 * organic traffic is a fact about the whole domain. It is not enough for a
 * KEYWORD-scoped one: "Current rank" is a fact about one phrase, and a group's
 * project tracks two hundred of them. Without this row the writeback would have
 * to guess which keyword a goal named "Rank for best crm for agencies" meant, by
 * matching its name against the provider's list — and a fuzzy match that is
 * wrong produces a perfectly plausible-looking number in the wrong row, which is
 * the single worst failure this whole feature can have.
 *
 * `scope` on the field catalog is what makes that distinction storable, and this
 * is its other half. A goal may be linked with NO keyword: that is a link to the
 * project alone, and it fills the project-scoped fields and nothing else.
 *
 * ---- Why provenance lives here and not on the value -------------------------
 *
 * The tempting shape is to wrap every cell — `{ v, src, provider, at }` instead
 * of a bare number. It is also the expensive one: `Goal.actual` and
 * `columnValues` are read by `goalTypes.js`, `scoreGoal`, `scoreGroup`,
 * `missingFinalValues`, `checkRequiredColumns`, the month-close logic, the
 * trend query, and the SHARED `cellComponentFor` registry that renders goal
 * columns and task columns from the same components. Changing the shape means
 * every one of those learns to unwrap, and every one of them has to tolerate
 * both forms forever because the existing rows are bare.
 *
 * So the values stay exactly as they are and the provenance sits beside them, in
 * `applied` — one entry per SOURCE FIELD, because ownership is per cell rather
 * than per goal. The rank may be connector-owned while somebody has taken manual
 * control of the volume on the same row, and a per-goal flag could not say that.
 *
 * ---- The rule the two maps encode ------------------------------------------
 *
 *   `applied[field]`   — what the connector last wrote, and when. The next run
 *                        may overwrite the cell only if what is in it still
 *                        EQUALS this. That is the whole ownership test: if the
 *                        cell has moved, a human moved it.
 *
 *   `suggested[field]` — what the connector would have written but did not,
 *                        because a human owns the cell. Rendered on the row as
 *                        "Ubersuggest says 1,400 — accept?". Accepting writes it
 *                        and hands ownership back.
 *
 * `claimedAt` is the answer to the day-one problem. Every existing goal on these
 * boards was typed by hand, so a pure never-overwrite rule would fill nothing at
 * all and the feature would look broken. The FIRST run after a link is made
 * claims what is there regardless; every run after that respects the test above.
 * It is stamped once, so re-pointing a link at a different keyword does not
 * silently re-claim cells a human has since corrected.
 */

/** What the connector last wrote into one cell, or would like to. */
const cellValueSchema = new mongoose.Schema(
  {
    /** The value itself — a number, a string, or a day key. Never wrapped. */
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Where it went, in `fieldMapping.js`'s wire form. Kept so a suggestion
     *  can be accepted even after the mapping has been re-pointed, and so the
     *  row can name the column without re-resolving the mapping. */
    targetId: { type: String, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const goalConnectorLinkSchema = new mongoose.Schema(
  {
    /**
     * The goal this link is for. UNIQUE — a goal reports one thing, so it is
     * about one keyword.
     *
     * Note this is per (group × month) like the goal itself, which is what makes
     * "the same keyword, every month" many links rather than one. That is
     * correct and deliberate: a month's link records what the connector did to
     * THAT month's row, and August's provenance must not be rewritten by
     * September's run.
     */
    goal: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Goal',
      required: true,
      unique: true,
    },

    // Denormalised for the cascades and for the board-wide query. Same
    // reasoning as ConnectorFieldMapping.
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
      index: true,
    },
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    /** The goal's group. What resolves the project on every run — see below. */
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
      required: true,
    },
    /** The goal's month, copied so a run can scope itself without a join. */
    monthKey: { type: String, required: true },

    provider: {
      type: String,
      enum: CONNECTOR_PROVIDERS,
      required: true,
    },

    /**
     * The project this link last read from.
     *
     * Stamped by the writeback on every run, from the GROUP's current mapping
     * rather than trusted from here. A group that gets re-pointed at a different
     * project is a statement about whose numbers this client's rows carry, and a
     * link still reading the old domain would keep filling cells with somebody
     * else's ranks — silently, and with entirely plausible numbers. Storing it
     * anyway is what lets the UI say which domain a row is reading without a
     * second query.
     */
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConnectorProject',
      default: null,
      index: true,
    },

    /**
     * The tracked phrase, verbatim as the person entered it. NULL is a valid
     * link — see the header.
     *
     * Not validated against the project's keyword list on the way in. A keyword
     * added at the provider after our last collection does not appear in any
     * snapshot yet, and refusing it would mean a new keyword cannot be linked
     * until the next weekly pull. Matching is case-insensitive at read time
     * (`rowFor` in the provider's field catalog), so the stored casing is
     * display only.
     */
    keyword: { type: String, default: null, trim: true, maxlength: 300 },

    /**
     * Which rank-tracking series to read — `desktop|en|2840`, the snapshot's own
     * `variant`.
     *
     * One string rather than the (device, language, locId) triple the provider
     * filters by, because that triple is the PROVIDER's spelling of a market and
     * this file must not know it. `ConnectorSnapshot.variant` already carries it
     * in readable form, so matching on it is one string compare and no provider
     * knowledge. Null means "whichever series is newest", which is the right
     * answer for a project that only tracks one market.
     */
    variant: { type: String, default: null },

    /**
     * Whether an unattended run may fill this row at all.
     *
     * Separate from the per-field `autoFill` on the mapping: that one says "this
     * VALUE fills itself everywhere", this one says "this ROW fills itself". A
     * team mid-dispute about one client's numbers turns the row off without
     * unpicking the board's wiring.
     */
    autoFill: { type: Boolean, default: true },

    /**
     * sourceField → the value the connector put there. See the header.
     *
     * A Map for the same reason `Goal.columnValues` is: the keys are a
     * provider's vocabulary, unbounded and not known to this schema. Same sharp
     * edge too — `.get(key)` on a document, a plain object after `.lean()`.
     */
    applied: {
      type: Map,
      of: cellValueSchema,
      default: () => ({}),
    },

    /** sourceField → what the connector would write if it still owned the cell. */
    suggested: {
      type: Map,
      of: cellValueSchema,
      default: () => ({}),
    },

    /**
     * When the first run claimed this row's existing values. Null until then.
     * Stamped ONCE — see the header.
     */
    claimedAt: { type: Date, default: null },

    /** When a run last looked at this link, whether or not it wrote anything. */
    lastSyncAt: { type: Date, default: null },
    /**
     * One sentence about the last run, for the row. Carries the answers that
     * are not values: "not in the top 100", "no rank tracking collected for
     * August yet".
     */
    lastNote: { type: String, default: '' },

    linkedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

/** The Goals tab's own read: every link for one board's month. */
goalConnectorLinkSchema.index({ board: 1, monthKey: 1 });

/**
 * The writeback's read: everything one group's project feeds, one month at a
 * time. Group rather than project, because the project is re-resolved from the
 * group on every run and may legitimately be null between remappings.
 */
goalConnectorLinkSchema.index({ group: 1, monthKey: 1 });

module.exports = mongoose.model('GoalConnectorLink', goalConnectorLinkSchema);

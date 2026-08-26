const mongoose = require('mongoose');
const { CONNECTOR_PROVIDERS } = require('../utils/connectorProviders');

/**
 * "On this board, the connector's `<sourceField>` fills `<target>`."
 *
 * ---- Why this is a row and not a constant ----------------------------------
 *
 * The obvious implementation of the whole feature is a writeback service that
 * says `goal.actual = position` and `columnValues[volume] = volume`. That works
 * exactly once, on one board, for one trade — and the three SEO boards already
 * in this workspace disagree with each other. They use disjoint goal-column
 * ObjectIds, and the difficulty column is spelled `keyword_difficultly` on
 * DAVNOOT SEO and `keyword_difficulty` on Gsolutions SEO and Davnoot Tech SEO.
 * A hardcoded binding would fill one board and silently skip two, and the skip
 * would be indistinguishable from "the sync has not run yet".
 *
 * It also would not survive the second tenant. The Ads boards run the same
 * tracker+goals machinery over ad metrics, and their goal names are task
 * descriptions rather than keywords. Per the standing rule that tracker boards
 * stay generic, trade vocabulary lives in board configuration and never in code
 * — so the binding between a provider's vocabulary and a board's is data, and
 * this is the collection it lives in.
 *
 * ---- Why the target is `columnId` and never a key --------------------------
 *
 * `Board.goalColumns[]` carries a readable `key` slug, and it is the tempting
 * thing to store. It is also per-board, user-derived and — as above — already
 * misspelled on a live board. `Goal.columnValues` is keyed by `_id` for exactly
 * this reason, which is what makes renaming a column free. The mapping follows
 * it, and `services/connectors/fieldMapping.js` is where that rule is written
 * down in full.
 *
 * ---- Why it is per BOARD and not per group or per org ----------------------
 *
 * A goal column IS a property of one board — the whole point of the shared
 * column schema is that every group on the board reports the same things, so
 * one client's month is comparable with another's. A mapping onto a column
 * therefore cannot mean anything outside that board. That also decides the
 * cascade: unlike `ConnectorProject` and `ConnectorSnapshot`, which survive a
 * board being deleted because they belong to the org's external account, these
 * rows go with the board. They describe columns that no longer exist.
 */

/**
 * Where on a goal the value lands.
 *
 * Exactly one of `columnId` / `builtin` is set, enforced below rather than by
 * mongoose — a subdocument cannot express "one of these two", and a row with
 * both would be a target the writeback could read two ways.
 */
const mappingTargetSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['goalColumn', 'goalBuiltin'],
      required: true,
    },
    /** → `Board.goalColumns[]._id`. Set when kind is 'goalColumn'. */
    columnId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /**
     * `actual` | `actualDayKey` | `config.baseline` | `config.target`.
     *
     * A free string validated against `services/connectors/fieldMapping.js`
     * rather than a mongoose enum, for the same reason `ConnectorSnapshot.kind`
     * is: the catalog is declared in a service, and duplicating it as an enum
     * here would mean two lists that agree until the day they quietly do not.
     */
    builtin: { type: String, default: null },
  },
  { _id: false }
);

const connectorFieldMappingSchema = new mongoose.Schema(
  {
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
      index: true,
    },
    // Denormalised from the board so an org teardown is one query and does not
    // have to load every board first. Same reasoning as BoardConnector.
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

    /**
     * A key from the provider's own field catalog — `rank`, `volume`,
     * `health_score`. Validated against the descriptor before it reaches here.
     *
     * A free string for the same reason `ConnectorSnapshot.kind` is: the catalog
     * belongs to the provider directory, and an enum in shared code would mean
     * connector #2 could not add a field of its own without a schema change to a
     * file it has no business touching.
     */
    sourceField: { type: String, required: true },

    target: { type: mappingTargetSchema, required: true },

    /**
     * Whether the weekly run may fill this by itself.
     *
     * Off means the mapping still resolves and still shows what the connector
     * would say, but nothing is written until somebody accepts it. That is the
     * setting a team reaches for on `config.target` — where an automatic write
     * would be changing what was promised rather than recording what happened.
     */
    autoFill: { type: Boolean, default: true },

    createdBy: {
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

/**
 * One mapping per (board, provider, sourceField).
 *
 * Upserted against, so re-pointing a field at a different column REPLACES the
 * binding rather than adding a second one — which is what makes "remap it and
 * the old column stops updating" true by construction rather than by the
 * controller remembering to delete first.
 */
connectorFieldMappingSchema.index(
  { board: 1, provider: 1, sourceField: 1 },
  { unique: true }
);

/**
 * A goal column is filled by at most ONE connector field.
 *
 * Without this, two fields could both claim a column and the winner would be
 * decided by document order — the same class of ambiguity `ConnectorProject`'s
 * partial index on `(provider, group)` already forecloses. Scoped to the BOARD
 * rather than to (board, provider) on purpose: the column belongs to the board,
 * so two different connectors fighting over it is the same bug as one connector
 * fighting with itself.
 *
 * Partial, because `columnId` is null on every builtin mapping and a plain
 * unique index would allow exactly one of those per board.
 */
connectorFieldMappingSchema.index(
  { board: 1, 'target.columnId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'target.columnId': { $type: 'objectId' } },
  }
);

/** The same rule for the built-in targets. */
connectorFieldMappingSchema.index(
  { board: 1, 'target.builtin': 1 },
  {
    unique: true,
    partialFilterExpression: { 'target.builtin': { $type: 'string' } },
  }
);

/**
 * Exactly one of `columnId` / `builtin`, and the one that matches `kind`.
 *
 * Defence in depth: the controller resolves and validates a target before it
 * gets here, but a row with both set would be a target the phase-5 writeback
 * could read two ways, and a row with neither would be a mapping that names
 * nowhere. Both are cheaper to refuse than to diagnose.
 */
connectorFieldMappingSchema.pre('validate', function enforceOneTarget() {
  const t = this.target;
  if (!t) return;
  if (t.kind === 'goalColumn') {
    if (!t.columnId) {
      this.invalidate('target.columnId', 'A goal-column mapping needs a column id.');
    }
    // Cleared rather than left alongside, so the partial index on
    // `target.builtin` cannot see a stale value from a re-pointed mapping.
    t.builtin = null;
  } else if (t.kind === 'goalBuiltin') {
    if (!t.builtin) {
      this.invalidate('target.builtin', 'A built-in mapping needs a field name.');
    }
    t.columnId = null;
  }
});

module.exports = mongoose.model('ConnectorFieldMapping', connectorFieldMappingSchema);

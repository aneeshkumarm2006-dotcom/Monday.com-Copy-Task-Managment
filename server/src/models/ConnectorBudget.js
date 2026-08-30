const mongoose = require('mongoose');

/**
 * The money ceiling for one scope, for one month.
 *
 * ---- Why the ledger is a document and not a sum over the tasks --------------
 *
 * Because the question a gate asks is "may I spend this NOW", and answering it
 * by summing a collection is a read-then-write with no atomicity anywhere in
 * this system to lean on — the same hole `DfsTask`'s partial unique index was
 * built to close, one layer up. Two passes both sum $4.90 against a $5 cap, both
 * decide there is room, and both post.
 *
 * So the running total lives on ONE document and the reserve is a single atomic
 * `findOneAndUpdate` whose filter carries the cap check. Mongo evaluates the
 * filter and applies the update as one operation on one document, so exactly one
 * of two racing reserves can win.
 *
 * ---- The trap in the version everybody writes first ------------------------
 *
 * The natural one-liner is wrong and FAILS OPEN:
 *
 *     findOneAndUpdate(
 *       { …key, $expr: { $lte: [{ $add: ['$reservedUsd', estimate] }, '$capUsd'] } },
 *       { $inc: { reservedUsd: estimate } },
 *       { upsert: true, new: true })
 *
 * With `upsert: true`, a FAILED cap check matches no document — so Mongo tries
 * to insert one, built from the filter's equalities. `$expr` contributes none of
 * them. Without a unique index that mints a SECOND budget document with a fresh
 * `reservedUsd`, so the cap silently resets and both racers proceed; with one it
 * raises E11000, which now means two completely different things ("somebody else
 * created the period" and "the cap refused you") that the caller cannot tell
 * apart.
 *
 * The fix is to separate EXISTENCE from the GUARD — see
 * `services/connectors/budget.js`, which is the only writer of this collection.
 * The unique index below is what makes step one idempotent.
 *
 * ---- Why `$expr` must add `spentUsd` too ------------------------------------
 *
 * A reservation is released the moment it settles, moving the money from
 * `reservedUsd` to `spentUsd`. A guard that compares only `reservedUsd + estimate`
 * against the cap therefore sees an empty pot after every settle, and a month of
 * settled spend escapes the ceiling entirely. The guard compares
 * `reserved + spent + estimate`.
 *
 * ---- Why the settle is UNGUARDED -------------------------------------------
 *
 * Because by the time it runs the money is GONE. DataForSEO bills at POST, so a
 * settle that refused to record an overshoot would not prevent it — it would
 * only stop us knowing about it. Overshoot is RECORDED, not prevented. That is
 * the honest semantics of a provider that charges before it answers.
 */

const connectorBudgetSchema = new mongoose.Schema(
  {
    /**
     * REQUIRED, for `services/orgCascade.js`. A budget row that could carry a
     * null would outlive the workspace whose spending it caps.
     */
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
    },

    /** Money is per provider account, so a cap is per provider. */
    provider: { type: String, required: true },

    /**
     * `org` — the real ceiling. Money is held at ONE DataForSEO account owned by
     *   us, and that account is what runs dry, so this is the number that
     *   actually stops work.
     * `board` — an ALLOCATION, not a ceiling. It answers "how much of the org's
     *   money may this client's board consume", which is a billing question
     *   rather than a solvency one. Reserved second and rolled back first.
     */
    scope: { type: String, enum: ['org', 'board'], required: true },

    /**
     * The organisation id for `org`, the board id for `board`.
     *
     * Carried separately from `organisation` rather than reusing it, so the two
     * scopes have the same shape and one query pattern serves both. An `org` row
     * therefore repeats its own id here, on purpose.
     */
    scopeId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    /**
     * `YYYY-MM`, in UTC. A MONTH, not a day.
     *
     * Deliberately coarser than `ConnectorSnapshot.periodKey`, which is a day:
     * a cap is a budgeting concept and budgets are monthly. It is computed from
     * OUR clock rather than from a provider datetime, which is the one place in
     * this integration where that is correct — the money leaves our account when
     * we post, not when DataForSEO finishes.
     */
    periodKey: { type: String, required: true },

    /**
     * The ceiling, in USD, for this scope in this month.
     *
     * Written once by `$setOnInsert` and never moved by the reserve path, so a
     * cap change is an explicit administrative act rather than something a busy
     * pass can drift. Raising it mid-month is a plain `updateOne` from an
     * operator; nothing in the collection path does it.
     */
    capUsd: { type: Number, required: true },

    /**
     * Money promised but not yet charged — a RECOMPUTABLE CACHE.
     *
     * That phrase is load-bearing and is a contract, not a description. The
     * authoritative value is the sum of `estimateUsd` over the tasks that
     * currently hold a reservation against this document; this field is the
     * eagerly-maintained copy that makes the guard a one-document operation.
     * A crash between reserve and settle orphans a reservation and shrinks the
     * budget until the month rolls, so the reconciler
     * (`services/connectors/dataforseo/budget.js`) sweeps stale holders and
     * RECOMPUTES this field from the tasks rather than trusting a decrement it
     * cannot prove happened.
     */
    reservedUsd: { type: Number, default: 0 },

    /** Money DataForSEO said it actually took. Only ever goes up. */
    spentUsd: { type: Number, default: 0 },

    /**
     * Money reserved and then given back — a post that failed, a cap that
     * refused a sibling scope, a reconciler sweep.
     *
     * Not part of any arithmetic. It exists so "the budget looks smaller than
     * the spend suggests" has an answer in the row rather than in the logs.
     */
    releasedUsd: { type: Number, default: 0 },

    /** Diagnostics: when the ledger last moved, and how. */
    lastReserveAt: { type: Date, default: null },
    lastSettleAt: { type: Date, default: null },
    lastReleaseAt: { type: Date, default: null },
    /** Set by the reconciler when it rewrote `reservedUsd` from the tasks. */
    lastRecomputeAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * THE IDENTITY, and the reason step one of the reserve can be idempotent.
 *
 * Unique so two processes racing to create the month's document produce one row
 * and one E11000 — which, because the create carries NO cap logic, means exactly
 * one thing ("somebody else got there first") and is safe to swallow. Every
 * other 11000 in this system means something else, and that is only true because
 * the guarded update below it never upserts.
 */
connectorBudgetSchema.index(
  { organisation: 1, provider: 1, scope: 1, scopeId: 1, periodKey: 1 },
  { unique: true }
);

/** `services/orgCascade.js` deletes by this and nothing else. */
connectorBudgetSchema.index({ organisation: 1 });

module.exports = mongoose.model('ConnectorBudget', connectorBudgetSchema);

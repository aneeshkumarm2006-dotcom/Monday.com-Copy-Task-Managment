const ConnectorBudget = require('../../models/ConnectorBudget');

/**
 * The money gate — the ONLY writer of `ConnectorBudget`.
 *
 * Generic on purpose. Nothing here knows what a SERP costs, what a keyword is,
 * or that DataForSEO exists; it knows scopes, months and three arithmetic
 * operations. The provider decides what to reserve and when. That separation is
 * what makes this reusable by the next per-call-billed connector rather than a
 * DataForSEO file wearing a generic name.
 *
 * ---- Reserve, settle, release ----------------------------------------------
 *
 * RESERVE is guarded and atomic. It is the only operation that can say no.
 * SETTLE is unguarded, because by then the money is gone — DataForSEO bills at
 *   POST, so refusing to record an overshoot would not prevent it, only hide it.
 * RELEASE is unguarded compensation, used when a reservation turns out not to be
 *   spent: a post that threw, a sibling scope that refused, a reconciler sweep.
 *
 * ---- Why there are no transactions -----------------------------------------
 *
 * `config/db.js` connects with a bare URI and does not require a replica set, so
 * `session.withTransaction` cannot be assumed to exist at runtime. A two-document
 * reservation therefore uses COMPENSATION: reserve the org, reserve the board,
 * and on the board's refusal give the org's back. That is weaker than a
 * transaction in exactly one way — a crash between the two leaves the org's
 * reservation held — and the reconciler is what closes that, which is the same
 * mechanism that has to exist anyway for a crash between reserve and settle.
 */

/** `YYYY-MM` in UTC. A cap is a monthly concept; the snapshot's key is daily. */
const monthKeyFor = (now = new Date()) => {
  const d = now instanceof Date ? now : new Date(now);
  const at = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Money, to the cent-of-a-cent DataForSEO actually bills in. */
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * The five fields that identify one budget document.
 *
 * Built by one function so the ensure, the guard, the settle and the recompute
 * cannot drift apart — a reserve and a settle that disagreed about the key would
 * hold money on one row and give it back on another, and the ledger would look
 * correct on both.
 *
 * @param {Object} scope
 * @returns {Object} a Mongo filter
 */
const keyFor = ({ organisation, provider, scope, scopeId, periodKey }) => ({
  organisation,
  provider,
  scope,
  scopeId,
  periodKey,
});

/**
 * Step one of two: make sure the month's document exists.
 *
 * IDEMPOTENT AND CAP-FREE, and both halves matter. `$setOnInsert` means a second
 * caller in the same month changes nothing — in particular it cannot reset
 * `reservedUsd`, which is the failure the two-step split exists to prevent. And
 * because this operation carries NO cap logic, an E11000 from it means exactly
 * one thing: a concurrent creator won the race. That is safe to swallow, and it
 * is only unambiguous because the guarded update in `reserve` never upserts.
 *
 * @returns {Promise<void>}
 */
const ensureBudget = async ({
  organisation,
  provider,
  scope,
  scopeId,
  periodKey,
  capUsd,
}) => {
  try {
    await ConnectorBudget.updateOne(
      keyFor({ organisation, provider, scope, scopeId, periodKey }),
      {
        $setOnInsert: {
          capUsd: round6(capUsd),
          reservedUsd: 0,
          spentUsd: 0,
          releasedUsd: 0,
        },
      },
      { upsert: true }
    );
  } catch (err) {
    // A concurrent creator won. The document we needed exists, which is the
    // whole postcondition of this function.
    if (err?.code !== 11000) throw err;
  }
};

/**
 * Step two of two: take the money, or refuse.
 *
 * ---- Read the options, they are the entire design --------------------------
 *
 * NO `upsert`. With one, a failed cap check matches nothing, Mongo builds an
 * insert from the filter's equalities, `$expr` contributes none of them, and you
 * get a second budget document with a fresh `reservedUsd` — THE CAP SILENTLY
 * RESETS AND BOTH RACERS PROCEED. Without it, `null` means one thing and one
 * thing only: the cap said no.
 *
 * `$expr` adds `spentUsd`. A reservation moves to `spentUsd` the instant it
 * settles, so a guard that watched `reservedUsd` alone would see an empty pot
 * after every settle and a whole month of spend would escape the ceiling. The
 * comparison is `reserved + spent + estimate <= cap`.
 *
 * @param {Object} args
 * @param {number} args.estimateUsd
 * @returns {Promise<Object|null>} the updated document, or null when refused
 */
const reserve = async ({
  organisation,
  provider,
  scope,
  scopeId,
  periodKey,
  estimateUsd,
  now = new Date(),
}) => {
  const amount = round6(estimateUsd);

  const reserved = await ConnectorBudget.findOneAndUpdate(
    {
      ...keyFor({ organisation, provider, scope, scopeId, periodKey }),
      $expr: {
        $lte: [{ $add: ['$reservedUsd', '$spentUsd', amount] }, '$capUsd'],
      },
    },
    {
      $inc: { reservedUsd: amount },
      $set: { lastReserveAt: now },
    },
    { new: true }
  ).lean();

  return reserved || null;
};

/**
 * Give a reservation back. Unguarded compensation.
 *
 * `releasedUsd` is a record rather than an input to anything: it is what makes
 * "the ledger moved and nothing was bought" answerable from the row instead of
 * from a log file six weeks later.
 */
const release = async ({
  organisation,
  provider,
  scope,
  scopeId,
  periodKey,
  estimateUsd,
  now = new Date(),
}) => {
  const amount = round6(estimateUsd);
  if (!amount) return;

  await ConnectorBudget.updateOne(
    keyFor({ organisation, provider, scope, scopeId, periodKey }),
    {
      $inc: { reservedUsd: -amount, releasedUsd: amount },
      $set: { lastReleaseAt: now },
    }
  );
};

/**
 * Turn a reservation into a charge. UNGUARDED, and that is not an oversight.
 *
 * The money left the account at POST. A settle that refused to record an
 * overshoot would not un-spend it; it would only mean the ledger no longer knows
 * what the account is worth. So an actual that exceeds its estimate is recorded
 * in full, and the NEXT reserve is the one that finds the pot empty and stops.
 *
 * Overshoot is bounded by construction anyway: the estimate comes from the
 * account's own price book and the actual comes from the same price book applied
 * by the provider, so they differ only when prices move mid-month.
 */
const settle = async ({
  organisation,
  provider,
  scope,
  scopeId,
  periodKey,
  estimateUsd,
  actualUsd,
  now = new Date(),
}) => {
  const held = round6(estimateUsd);
  const spent = round6(actualUsd);

  await ConnectorBudget.updateOne(
    keyFor({ organisation, provider, scope, scopeId, periodKey }),
    {
      $inc: { reservedUsd: -held, spentUsd: spent },
      $set: { lastSettleAt: now },
    }
  );
};

/**
 * Reserve against several scopes at once, or against none of them.
 *
 * Ordered, and the order is the policy: the ORG document is the real ceiling
 * (money is held at one provider account) and a board document is an allocation
 * of it, so the org is taken first and given back last. A board that refuses
 * must not leave the org's money held — that would let one over-allocated board
 * shrink every other board's budget by failing repeatedly.
 *
 * Compensation rather than a transaction, because `config/db.js` connects with a
 * bare URI and a replica set cannot be assumed.
 *
 * @param {Object[]} scopes - `{organisation, provider, scope, scopeId, periodKey, capUsd}`,
 *   most authoritative first
 * @param {number} estimateUsd
 * @returns {Promise<{ok: boolean, blocked: Object|null, held: Object[]}>}
 */
const reserveAll = async ({ scopes, estimateUsd, now = new Date() }) => {
  const held = [];

  for (const entry of scopes) {
    // eslint-disable-next-line no-await-in-loop
    await ensureBudget(entry);
    // eslint-disable-next-line no-await-in-loop
    const got = await reserve({ ...entry, estimateUsd, now });

    if (!got) {
      // Unwind, most recent first. Unguarded, so it cannot itself fail the way
      // the reserve can.
      for (const done of [...held].reverse()) {
        // eslint-disable-next-line no-await-in-loop
        await release({ ...done, estimateUsd, now });
      }
      return { ok: false, blocked: entry, held: [] };
    }

    held.push(entry);
  }

  return { ok: true, blocked: null, held };
};

/** Settle every scope a job held. Never refuses; see `settle`. */
const settleAll = async ({ scopes, estimateUsd, actualUsd, now = new Date() }) => {
  for (const entry of scopes) {
    // eslint-disable-next-line no-await-in-loop
    await settle({ ...entry, estimateUsd, actualUsd, now });
  }
};

/** Release every scope a job held. */
const releaseAll = async ({ scopes, estimateUsd, now = new Date() }) => {
  for (const entry of scopes) {
    // eslint-disable-next-line no-await-in-loop
    await release({ ...entry, estimateUsd, now });
  }
};

/**
 * Rewrite `reservedUsd` from the truth.
 *
 * ---- Why this exists, and why the field is documented as a cache ------------
 *
 * `reservedUsd` is maintained by `$inc`, which is fast, atomic and unprovable: a
 * process that dies between the increment and the settle leaves money held by
 * nobody, and no amount of care inside the happy path can fix that — the failure
 * IS the absence of the happy path. So the field is declared a recomputable
 * cache and this function is what makes that declaration true rather than
 * aspirational.
 *
 * The caller supplies the sum, because the collection that holds the
 * reservations is provider-specific and this file must not learn about it. See
 * `services/connectors/dataforseo/budget.js`, which computes it from `DfsTask`.
 *
 * @param {number} outstandingUsd - the authoritative sum of live reservations
 * @returns {Promise<void>}
 */
const recomputeReserved = async ({
  organisation,
  provider,
  scope,
  scopeId,
  periodKey,
  outstandingUsd,
  now = new Date(),
}) => {
  await ConnectorBudget.updateOne(
    keyFor({ organisation, provider, scope, scopeId, periodKey }),
    {
      $set: {
        reservedUsd: round6(Math.max(0, outstandingUsd)),
        lastRecomputeAt: now,
      },
    }
  );
};

/**
 * What one scope has left, for display.
 *
 * NEVER a gate. The gate is `reserve`, which is atomic; anything computed by
 * reading and then acting is the read-then-write this whole file exists to
 * avoid. This is for a "you have spent $212 of $318" line and nothing else.
 *
 * @returns {Promise<Object|null>}
 */
const describeBudget = async ({
  organisation,
  provider,
  scope,
  scopeId,
  periodKey,
}) => {
  const row = await ConnectorBudget.findOne(
    keyFor({ organisation, provider, scope, scopeId, periodKey })
  ).lean();
  if (!row) return null;

  const committed = round6((row.reservedUsd || 0) + (row.spentUsd || 0));
  return {
    periodKey: row.periodKey,
    capUsd: row.capUsd,
    reservedUsd: row.reservedUsd || 0,
    spentUsd: row.spentUsd || 0,
    releasedUsd: row.releasedUsd || 0,
    committedUsd: committed,
    remainingUsd: round6(Math.max(0, (row.capUsd || 0) - committed)),
    usedPct: row.capUsd ? Math.round((committed / row.capUsd) * 1000) / 10 : null,
  };
};

module.exports = {
  monthKeyFor,
  round6,
  keyFor,
  ensureBudget,
  reserve,
  release,
  settle,
  reserveAll,
  settleAll,
  releaseAll,
  recomputeReserved,
  describeBudget,
};

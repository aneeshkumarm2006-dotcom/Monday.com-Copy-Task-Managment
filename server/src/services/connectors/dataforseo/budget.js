const DfsTask = require('../../../models/DfsTask');
const BoardConnector = require('../../../models/BoardConnector');
const B = require('../budget');
const C = require('./constants');

/**
 * The DataForSEO half of the money gate: which scopes a job reserves against,
 * and the reconciler that gives back what a crash left held.
 *
 * The arithmetic lives next door in `services/connectors/budget.js`, which knows
 * nothing about SERPs. This file knows which documents a job answers to, where
 * the caps come from, and how to find a reservation nobody is holding any more.
 *
 * ---- Where a budget stop goes, and where it must NOT --------------------------
 *
 * `err.quotaExhausted` already exists and stops the account for the whole run:
 * `syncAccount` catches it and `break`s out of the project loop. That is right
 * for DataForSEO's own refusals — a `40200` (no funds) or a `40203` (their daily
 * cost limit) means nothing on this account can work, so grinding through
 * twenty-nine more projects to collect the same answer helps nobody.
 *
 * IT IS EXACTLY WRONG FOR OUR OWN CAP. The `break` abandons every remaining
 * project, INCLUDING THEIR FREE `task_get` POLLS FOR RESULTS WE HAVE ALREADY
 * PAID FOR. Hitting the cap on project 3 of 30 would strand twenty-seven
 * projects' worth of purchased data — the money is already spent and the results
 * expire in thirty days, so that is not a delay, it is a loss.
 *
 * So our cap routes through phase 0's `pending` sentinel instead:
 *
 *   {status: 'pending', note: 'Monthly budget reached — nothing new was requested.'}
 *
 * plus a per-run flag on the ACCOUNT-SCOPED CLIENT that suppresses further posts
 * for the rest of the pass. Free collection continues everywhere; nothing new is
 * bought anywhere. One flag, set once, checked before every would-be purchase.
 *
 * ---- How `reserving` coexists with the claim --------------------------------
 *
 * THE DECISION, because the plan leaves it open and the reconciler depends on it.
 *
 * The claim is an INSERT in `state: 'open'`, and it cannot be anything else: the
 * partial unique index that arbitrates two racing posters covers `state: 'open'`
 * and nothing else. A row inserted as `state: 'reserving'` is not covered by that
 * index, so two processes could both insert one, both reserve, and both post —
 * the exact double charge the index exists to prevent, reintroduced by the
 * safety mechanism.
 *
 * So `reserving` is a SUB-STATE ON THE SAME ROW, carried in `budgetState`, and
 * `state: 'reserving'` is now unreachable (the enum value is kept so a legacy row
 * still loads). One row, two orthogonal questions:
 *
 *   `state`       — where the WORK is: open, done, abandoned, dead, failed.
 *   `budgetState` — where the MONEY is: none, reserving, settled, released.
 *
 * That keeps the claim under the index, and it keeps the reservation FINDABLE,
 * which is the whole precondition of "sweep `reserving` rows older than ten
 * minutes". A second row would have satisfied the second requirement and broken
 * the first.
 *
 * ---- Why the row records its budget documents BEFORE incrementing them ------
 *
 * Because `ConnectorBudget.reservedUsd` is declared a recomputable cache, and a
 * cache is only recomputable if the thing it caches can be enumerated. The
 * definition is "the sum of `estimateUsd` over the tasks currently holding a
 * reservation against this document", so a task must NAME the document before it
 * increments it. Written the other way round, a crash between the two produces a
 * document whose counter moved and a task that cannot be traced to it — an
 * orphan invisible to the reconciler.
 *
 * Written this way round, the same crash produces a task that names a document
 * it never incremented. The recompute then counts it and the counter goes UP,
 * which errs toward reserving too much: we under-spend rather than over-spend,
 * and the ten-minute sweep clears it either way.
 */

/**
 * The budget documents one job answers to, most authoritative first.
 *
 * ORG FIRST, and the order is policy rather than convenience. Money is held at
 * ONE DataForSEO account owned by us — they have no sub-accounts and no reseller
 * programme, so per-tenant metering is entirely our problem — which makes the org
 * document the only real ceiling. A board budget is an ALLOCATION of that: it
 * answers "how much of the workspace's money may this client's board consume",
 * which is a billing question and not a solvency one.
 *
 * So the org is reserved first and released last, and a board that refuses can
 * never leave the org's money held (see `reserveAll`'s unwind). The alternative
 * lets one over-allocated board shrink every other board's budget by failing
 * repeatedly.
 *
 * @param {Object} project - a ConnectorProject row
 * @returns {Promise<Object[]>} scope descriptors for `services/connectors/budget.js`
 */
const scopesFor = async (project, { periodKey }) => {
  const base = { organisation: project.organisation, provider: 'dataforseo', periodKey };

  const scopes = [
    {
      ...base,
      scope: 'org',
      scopeId: project.organisation,
      capUsd: C.DEFAULT_MONTHLY_CAP_USD,
    },
  ];

  if (!project.board) return scopes;

  /**
   * The board's allocation, if somebody set one.
   *
   * Absent by default and absent is the normal state: a board with no allocation
   * is bounded by the org cap like everything else, which is the behaviour that
   * existed before this file. Only an explicit positive number creates a second
   * document, so the two-document path — and its compensation — is opt-in rather
   * than a cost every job pays.
   */
  let allocation = null;
  try {
    const row = await BoardConnector.findOne({
      board: project.board,
      provider: 'dataforseo',
    })
      .select('budget')
      .lean();
    const asked = Number(row?.budget?.monthlyUsd);
    if (Number.isFinite(asked) && asked > 0) allocation = asked;
  } catch (err) {
    /**
     * A board we could not read must not stop a collection the org has already
     * paid to be able to make. The org cap still applies, so the failure mode of
     * this catch is "the allocation was not enforced this pass", never "money was
     * spent with no ceiling at all".
     */
    console.warn(
      `[connectors/dataforseo] could not read the board budget for ${project.board}: ${err.message}`
    );
  }

  if (allocation === null) return scopes;

  scopes.push({
    ...base,
    scope: 'board',
    scopeId: project.board,
    capUsd: allocation,
  });
  return scopes;
};

/**
 * Take the money for one job, or say why not.
 *
 * @returns {Promise<{ok: boolean, scopes: Object[], blocked: Object|null}>}
 */
const reserveForJob = async ({ project, estimateUsd, now = new Date() }) => {
  const periodKey = B.monthKeyFor(now);
  const scopes = await scopesFor(project, { periodKey });
  const { ok, blocked } = await B.reserveAll({ scopes, estimateUsd, now });
  return { ok, scopes, blocked };
};

/** The sentence a person reads when their own cap refused a purchase. */
const CAP_NOTE = 'Monthly budget reached — nothing new was requested.';

/**
 * What a refused scope should say. Provider-neutral about WHOSE cap it was,
 * because "the org is out" and "this board is out" are different actions.
 */
const noteForBlocked = (blocked) => {
  if (blocked?.scope === 'board') {
    return `${CAP_NOTE} This board's own monthly allocation of $${blocked.capUsd} is used up.`;
  }
  return `${CAP_NOTE} The workspace's $${blocked?.capUsd ?? C.DEFAULT_MONTHLY_CAP_USD} monthly cap for DataForSEO is used up.`;
};

// ---------------------------------------------------------------------------
// The reconciler
// ---------------------------------------------------------------------------

/**
 * The authoritative value of one budget document's `reservedUsd`.
 *
 * The definition, executed: the sum of `estimateUsd` over the tasks that still
 * hold a reservation against this document. `$elemMatch` rather than three dotted
 * equalities, because dotted paths on an array match across DIFFERENT elements —
 * `{'budgetDocs.scope': 'org', 'budgetDocs.scopeId': X}` matches a row whose org
 * entry has a different id and whose board entry has this one.
 *
 * @returns {Promise<number>}
 */
const outstandingFor = async (scope) => {
  const rows = await DfsTask.find({
    organisation: scope.organisation,
    provider: scope.provider,
    budgetState: 'reserving',
    budgetDocs: {
      $elemMatch: {
        scope: scope.scope,
        scopeId: scope.scopeId,
        periodKey: scope.periodKey,
      },
    },
  })
    .select('estimateUsd')
    .lean();

  return B.round6(rows.reduce((sum, r) => sum + (r.estimateUsd || 0), 0));
};

/**
 * Rewrite one budget document's `reservedUsd` from its tasks.
 *
 * Exported so a test can assert the phrase "recomputable cache" is true rather
 * than aspirational: derange the counter, run this, and the counter agrees with
 * the collection again.
 */
const recompute = async (scope, { now = new Date() } = {}) => {
  const outstandingUsd = await outstandingFor(scope);
  await B.recomputeReserved({ ...scope, outstandingUsd, now });
  return outstandingUsd;
};

/**
 * Give back every reservation nobody is holding any more.
 *
 * ---- The two ways a reservation goes stale, and why they settle differently -
 *
 * Reserve, post, settle is three steps and seconds long, so a row still marked
 * `reserving` ten minutes later is a process that died. WHERE it died decides
 * what is owed:
 *
 *   NOTHING WAS POSTED (`postedAt` is null, `costUsd` is 0) — no money left the
 *     account. The reservation is released in full and the row is closed as
 *     `failed`, because an open row nobody posted would suppress collection for
 *     twelve hours in exchange for nothing.
 *
 *   SOMETHING WAS POSTED (`costUsd` > 0) — that money is GONE, and the ledger has
 *     to say so or the month's spend is understated by exactly the amount a crash
 *     cost. The row is SETTLED at whatever it managed to record, and it stays
 *     `open`: the tasks are real, they are paid for, and `task_get` will collect
 *     them for free on the next tick. Losing a paid-for result to a bookkeeping
 *     sweep would be the most expensive possible reading of "reconcile".
 *
 * Then every touched document is RECOMPUTED, which is what makes `reservedUsd` a
 * cache rather than a number that drifts one crash at a time until the month
 * rolls over.
 *
 * Never throws. It runs at the top of a sync pass, and a reconciler that could
 * fail a collection would be a safety mechanism that costs more than it saves.
 *
 * @returns {Promise<{swept: number, releasedUsd: number, settledUsd: number,
 *   recomputed: number}>}
 */
const reconcileReservations = async ({
  now = new Date(),
  staleAfterMs = C.RESERVATION_STALE_MS,
  limit = 500,
} = {}) => {
  const summary = { swept: 0, releasedUsd: 0, settledUsd: 0, recomputed: 0 };

  let stale;
  try {
    stale = await DfsTask.find({
      budgetState: 'reserving',
      reservedAt: { $lt: new Date(now.getTime() - staleAfterMs) },
    })
      .limit(limit)
      .lean();
  } catch (err) {
    console.warn(`[connectors/dataforseo] reservation sweep could not run: ${err.message}`);
    return summary;
  }

  if (!stale.length) return summary;

  /** Every document touched, deduplicated, so the recompute runs once each. */
  const touched = new Map();

  for (const row of stale) {
    const scopes = Array.isArray(row.budgetDocs) ? row.budgetDocs : [];
    const estimateUsd = row.estimateUsd || 0;
    const actualUsd = row.costUsd || 0;

    try {
      if (actualUsd > 0) {
        // eslint-disable-next-line no-await-in-loop
        await B.settleAll({ scopes, estimateUsd, actualUsd, now });
        summary.settledUsd = B.round6(summary.settledUsd + actualUsd);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await B.releaseAll({ scopes, estimateUsd, now });
        summary.releasedUsd = B.round6(summary.releasedUsd + estimateUsd);
      }

      const set = {
        budgetState: actualUsd > 0 ? 'settled' : 'released',
        settledAt: now,
      };
      /**
       * An unposted claim is also released as WORK, not only as money. It is
       * holding the anti-repost identity for a purchase that never happened, and
       * twelve hours of that is twelve hours the Site collects nothing.
       */
      if (!row.postedAt && row.state === 'open') {
        set.state = 'failed';
        set.closedAt = now;
        set.note = 'The reservation expired before the post completed. Nothing was bought.';
      }

      // eslint-disable-next-line no-await-in-loop
      await DfsTask.updateOne({ _id: row._id }, { $set: set });
      summary.swept += 1;

      for (const scope of scopes) {
        touched.set(
          `${scope.scope}|${scope.scopeId}|${scope.periodKey}`,
          {
            organisation: row.organisation,
            provider: row.provider || 'dataforseo',
            scope: scope.scope,
            scopeId: scope.scopeId,
            periodKey: scope.periodKey,
          }
        );
      }
    } catch (err) {
      console.warn(
        `[connectors/dataforseo] could not reconcile task ${row._id}: ${err.message}`
      );
    }
  }

  for (const scope of touched.values()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await recompute(scope, { now });
      summary.recomputed += 1;
    } catch (err) {
      console.warn(
        `[connectors/dataforseo] could not recompute ${scope.scope} budget: ${err.message}`
      );
    }
  }

  return summary;
};

module.exports = {
  scopesFor,
  reserveForJob,
  reconcileReservations,
  recompute,
  outstandingFor,
  noteForBlocked,
  CAP_NOTE,
};

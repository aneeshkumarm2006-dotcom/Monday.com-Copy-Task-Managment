const DfsTask = require('../../../models/DfsTask');
const C = require('./constants');
const T = require('./tasks');
const P = require('./pricing');
const Budget = require('./budget');
const B = require('../budget');
const { DfsError } = require('./errors');

/**
 * Claim, reserve, call, settle, close — one live collection, start to finish.
 *
 * ---- Why this is a file rather than a function inside `labs.js` ------------
 *
 * It was one, for the length of phase 6, and the header it carried said so:
 * "a phase-7 Backlinks kind (also live-only) declares `'live'` and needs no new
 * machinery." Phase 7 arrived and that turned out to be true of the MACHINERY
 * and false of the FILE — `runLabsJob` was the machinery, and importing it into
 * `backlinks.js` under a name with "Labs" in it would have been the wrong shape
 * for the next reader while copying it would have been the wrong shape for the
 * money.
 *
 * And copying is what this exists to prevent, specifically. Every line below is
 * about somebody's dollars: the claim that stops two processes buying the same
 * rows, the reservation the monthly cap is checked against, the incremental
 * cost write that stops `reconcileReservations` refunding money that was spent.
 * A second copy of that would not fail loudly. It would drift — one copy gains
 * a fix, the other keeps the bug, and the symptom is a budget document that
 * disagrees with an invoice by an amount nobody can trace.
 *
 * ---- What "live" means, against the SERP family ----------------------------
 *
 * The SERP family is a QUEUE: `task_post` charges, the result arrives minutes
 * later, and `task_get` collects it for free — which is what turns an hourly
 * cron from 168 charges a week into one charge and 167 free polls. All of
 * `tasks.js`, `ready.js` and `collect.js` exist for that gap.
 *
 * DATAFORSEO LABS AND BACKLINKS HAVE NO QUEUE AT ALL. One HTTP call goes out,
 * the answer comes back inside it, and the charge lands on the way. Every safety
 * mechanism in `tasks.js` is aimed at a gap between paying and collecting that
 * does not exist here.
 *
 * What DOES carry over, and why none of it is optional:
 *
 *   THE CLAIM. A `DfsTask` row in `state: 'open'` under the partial unique
 *   index, taken before the call. Two processes are a live possibility — the
 *   hourly cron, a manual refresh, a second Render instance — and without the
 *   claim two of them make the same billable call in the same second. The row is
 *   open for the seconds one HTTP call takes rather than for hours, which is the
 *   only difference.
 *
 *   THE RESERVATION, AFTER THE CLAIM. Money reserved before the row exists is
 *   money nothing can be traced to, and `reconcileReservations` finds
 *   reservations by reading rows.
 *
 *   THE SETTLE, FROM THE ENVELOPE'S OWN `cost`. Not from the estimate, not from
 *   a constant, not from a price book — from the number DataForSEO puts in the
 *   response saying what it charged. That is what makes an unpublished price
 *   (Labs Bing, and anything they add later) correct in this ledger on its first
 *   call, and it is the plan's outstanding item #4 answered structurally rather
 *   than by a number somebody has to maintain.
 *
 * The one thing that differs from `postJob`: the row is CLOSED in the same
 * function that opened it, because there is nothing to come back for.
 */

/** The `items[]` ledger entry for one live call. */
const itemFor = (request, answer, error) => ({
  keyword: request.label,
  tag: request.endpoint,
  /** A live call returns no task id to collect later — there is nothing to collect. */
  externalId: null,
  cost: answer?.cost || 0,
  statusCode: answer?.statusCode ?? null,
  statusMessage: error ? String(error.message).slice(0, 300) : answer?.statusMessage || '',
  readyAt: null,
  /** True the moment the answer is in hand, because for a live call it is. */
  collected: !error,
});

/**
 * Pull the rows out of one answer, whatever went wrong.
 *
 * A `20000` envelope can still carry a task that failed, and one failed target
 * out of three must not discard the two that worked — the same rule
 * `client.readTask` already applies one level down.
 *
 * ---- Why the caller supplies the reader ------------------------------------
 *
 * Because the two live families disagree about where the answer is, and the
 * disagreement is not cosmetic. A Labs endpoint returns
 * `tasks[0].result[0].items` — a list. `backlinks/summary` returns
 * `tasks[0].result[0]` as ONE OBJECT with no `items` at all, because the whole
 * profile is one row. A reader hardcoded to `items` would read `undefined` off
 * every summary call, conclude the answer was empty, and mark a paid collection
 * failed.
 *
 * So the contract this function establishes is "the ROWS this answer carried",
 * with a one-row answer being a list of one, and each family supplies the two
 * lines that get from its own payload shape to that.
 *
 * @param {Object} answer
 * @param {(row: any) => any[]} rowsOf - `result[0]` to the rows it carried
 * @returns {{rows: any[], error: Error|null}}
 */
const readAnswer = (answer, rowsOf) => {
  const task = answer.tasks.find((t) => t.ok) || answer.tasks[0] || null;
  if (!task) return { rows: [], error: new DfsError('DataForSEO returned no task.') };
  if (task.error) return { rows: [], error: task.error };

  const row = Array.isArray(task.result) ? task.result[0] : task.result;
  const rows = rowsOf(row);
  return { rows: Array.isArray(rows) ? rows : [], error: null };
};

/** The Labs shape: `result[0].items`. */
const itemsOf = (row) => (Array.isArray(row?.items) ? row.items : []);

/** The one-object shape: `result[0]` IS the row. Used by `backlinks/summary`. */
const singleOf = (row) => (row && typeof row === 'object' ? [row] : []);

/**
 * Buy one live collection.
 *
 * ---- The ordering, which is `postJob`'s and is not negotiable --------------
 *
 * 1. THE ROW GOES IN FIRST, in `state: 'open'`, the only state the partial
 *    unique index covers. A concurrent caller takes an E11000 and returns
 *    `pending` having spent nothing.
 * 2. THE RESERVATION COMES AFTER THE CLAIM. Money reserved before the row exists
 *    is money nothing can be traced to, and `reconcileReservations` finds
 *    reservations by reading rows.
 * 3. `budgetDocs` IS WRITTEN BEFORE THE COUNTERS MOVE, because `reservedUsd` is
 *    defined as the sum over the tasks naming a document.
 *
 * @param {Object} args
 * @param {Object} args.session
 * @param {Object} args.client
 * @param {Object} args.project
 * @param {Object} args.kind
 * @param {string} args.variant
 * @param {Array<{label: string, endpoint: string, rows: number, payload: Object}>} args.requests
 * @param {Date} args.now
 * @param {(args: {request: Object, kind: Object, quota: any}) => number} args.estimateFor
 *   what to reserve for one request, in USD. Family-specific; never recorded.
 * @param {(row: any) => any[]} [args.rowsOf] - see `readAnswer`
 * @param {(request: Object) => string[]} [args.unitsOf] - what this request BOUGHT,
 *   for the Usage screen's "keywords bought" column
 * @returns {Promise<{ok: boolean, capped: boolean, note: string,
 *   results: Array<Object>, failures?: Array<Object>, costUsd: number,
 *   collectedAt: Date|null}>}
 */
const runLiveJob = async ({
  session,
  client,
  project,
  kind,
  variant,
  requests,
  now,
  estimateFor,
  rowsOf = itemsOf,
  unitsOf = null,
}) => {
  const quota = P.quotaFromSession(session);
  let estimateUsd = 0;
  for (const request of requests) {
    estimateUsd = P.round6(estimateUsd + estimateFor({ request, kind, quota }));
  }

  const request = { endpoint: kind.endpoint, calls: requests.map((r) => r.payload) };
  const requestHash = T.requestHashFor(request);
  const periodKey = B.monthKeyFor(now);
  const budgetDocs = await Budget.scopesFor(project, { periodKey, capUsd: session.getMonthlyCapUsd?.() });
  const expiresAt = new Date(now.getTime() + C.TASK_EXPIRY_HOURS * 3_600_000);

  /**
   * WHAT THIS JOB ACTUALLY BOUGHT, for the Usage screen's "keywords bought"
   * column — the payload's own list where there is one, and the request labels
   * otherwise.
   *
   * Not `requests.map(r => r.label)`. `keyword_overview` sends two hundred
   * keywords in ONE request, so labelling the job with one entry per request
   * would report a 200-keyword purchase as "1 keyword bought" while charging for
   * two hundred rows — a ledger that understates the thing it exists to account
   * for. A gap job's labels ARE its units (one call per competitor), and so are
   * a Backlinks job's, so those travel through unchanged.
   */
  const defaultUnits = (r) =>
    Array.isArray(r.payload?.keywords) && r.payload.keywords.length
      ? r.payload.keywords
      : [r.label];

  let job;
  try {
    job = await DfsTask.create({
      organisation: project.organisation,
      account: project.account || session.accountId,
      project: project._id,
      provider: 'dataforseo',
      kind: kind.key,
      variant,
      endpoint: kind.endpoint,
      request,
      keywords: requests.flatMap(unitsOf || defaultUnits),
      requestHash,
      tag: requestHash.slice(0, 16),
      state: 'open',
      attempt: 1,
      maxAttempts: C.MAX_TASK_ATTEMPTS,
      estimateUsd,
      budgetState: 'reserving',
      reservedAt: now,
      budgetDocs,
      expiresAt,
      items: [],
    });
  } catch (err) {
    if (err?.code === 11000) {
      return {
        ok: false,
        capped: false,
        note: 'This collection is already running.',
        results: [],
        costUsd: 0,
      };
    }
    throw err;
  }

  const reserved = await B.reserveAll({ scopes: budgetDocs, estimateUsd, now });
  if (!reserved.ok) {
    job.state = 'failed';
    job.budgetState = 'released';
    job.settledAt = now;
    job.closedAt = now;
    job.note = Budget.noteForBlocked(reserved.blocked);
    await job.save().catch(() => {});
    return { ok: false, capped: true, note: job.note, results: [], costUsd: 0 };
  }

  const results = [];
  const failures = [];
  let costUsd = 0;

  try {
    /**
     * Concurrent, and bounded by the SHARED pool rather than by anything here.
     *
     * `client.send` routes every `dataforseo_labs/…`, `backlinks/…` and
     * `on_page/…` call through `pool.withDbBackedSlot`, which is ONE ceiling of
     * twenty-five for all three families because DataForSEO's own ceiling of
     * thirty is one ceiling for all three. A limiter in this file would be one
     * of three limiters against one ceiling — see `./pool.js`.
     *
     * EACH ANSWER IS RECORDED ON THE ROW AS IT LANDS, not once at the end. The
     * same discipline `postJob` applies to a two-post batch, and for the same
     * reason: a gap report is three billable calls, and if the third throws, the
     * first two are money already gone. A crash between the last call and a
     * single write at the end leaves `costUsd: 0` on a row that cost real money —
     * and `reconcileReservations` reads exactly that field to decide whether to
     * settle or to release, so it would give back money that was spent and
     * understate the month by precisely what the crash cost.
     */
    const answers = await Promise.all(
      requests.map(async (req) => {
        let answer = null;
        let error = null;
        try {
          answer = await client.call(req.endpoint, [req.payload], req.opts || {});
        } catch (err) {
          if (err.quotaExhausted || err.needsReauth) throw err;
          error = err;
        }

        /** THE COST COMES OFF THE ENVELOPE, ALWAYS. See the file header. */
        const cost = answer?.cost || 0;
        costUsd = P.round6(costUsd + cost);

        await DfsTask.updateOne(
          { _id: job._id },
          {
            $push: { items: itemFor(req, answer, error) },
            $inc: { costUsd: cost },
            $set: {
              postedAt: now,
              statusCode: answer?.statusCode ?? null,
              statusMessage: answer?.statusMessage || '',
            },
          }
        ).catch((err) => {
          /**
           * Swallowed rather than thrown, and LOUDLY. The money is already
           * spent, so failing the collection over a bookkeeping write would lose
           * the data as well as the cash. The budget ledger is still corrected —
           * `settleJobBudget` below runs off the local accumulator, not off this
           * row — so what a lost write costs is the Usage screen's spend column
           * for one job, which is worth a log line and not a failure.
           */
          console.warn(
            `[connectors/dataforseo] could not record the cost of ${req.endpoint}: ${err.message}`
          );
        });

        return { req, answer, error };
      })
    );

    for (const { req, answer, error } of answers) {
      if (error || !answer) {
        failures.push({ label: req.label, message: error?.message || 'No answer.' });
        results.push({ request: req, rows: [], error: error || new DfsError('No answer.') });
        continue;
      }

      const { rows, error: taskError } = readAnswer(answer, req.rowsOf || rowsOf);
      if (taskError) failures.push({ label: req.label, message: taskError.message });
      results.push({ request: req, rows, error: taskError, answer });
    }
  } catch (err) {
    /**
     * An account-level stop, thrown out of the map above. The claim is released
     * and whatever was charged before the throw is settled — the same
     * "record what it took" reading `postJob` applies, because a throw that took
     * half the batch with it has still spent that half.
     */
    job.costUsd = costUsd;
    await T.settleJobBudget(job, { actualUsd: costUsd, now }).catch(() => {});
    await DfsTask.updateOne(
      { _id: job._id },
      { $set: { state: 'failed', closedAt: now, note: String(err.message).slice(0, 300) } }
    ).catch(() => {});
    throw err;
  }

  /**
   * `costUsd` is mirrored onto the in-memory row rather than re-read, because
   * `settleJobBudget` is the only thing that looks at it and the two numbers are
   * the same sum. Nothing below calls `job.save()`: the row's `items` live in
   * the database from the incremental writes above, and a full save would send a
   * stale empty array over the top of them.
   */
  job.costUsd = costUsd;
  await T.settleJobBudget(job, { actualUsd: costUsd, now });

  const produced = results.filter((r) => !r.error);
  if (!produced.length) {
    const note = failures[0]?.message || 'DataForSEO returned nothing.';
    await DfsTask.updateOne(
      { _id: job._id },
      { $set: { state: 'failed', closedAt: now, note: note.slice(0, 300) } }
    );
    return {
      ok: false,
      capped: false,
      note: `DataForSEO returned nothing for this site: ${note}`,
      results: [],
      costUsd,
    };
  }

  await DfsTask.updateOne(
    { _id: job._id },
    {
      $set: {
        state: 'done',
        closedAt: now,
        readyAt: now,
        /**
         * `periodKey` from NOW, and for a live call that is honest rather than a
         * compromise. A live call's reading is taken at the moment it is made;
         * there is no provider datetime to prefer, because there is no queue for
         * one to describe. Where the underlying INDEX has its own age, that is a
         * separate field on the snapshot body — `indexUpdatedAt` for Labs, which
         * is the whole point of the free `/status` read.
         */
        periodKey: now.toISOString().slice(0, 10),
        note: failures.length
          ? `${failures.length} of ${requests.length} calls failed.`
          : '',
      },
    }
  );

  return {
    ok: true,
    capped: false,
    note: failures.length
      ? `${failures.length} of ${requests.length} requests could not be collected.`
      : '',
    results: produced,
    failures,
    costUsd,
    collectedAt: now,
  };
};

module.exports = { runLiveJob, readAnswer, itemFor, itemsOf, singleOf };

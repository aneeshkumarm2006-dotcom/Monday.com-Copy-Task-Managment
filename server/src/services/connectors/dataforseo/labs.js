const C = require('./constants');
const T = require('./tasks');
const P = require('./pricing');
const { DfsError } = require('./errors');
const { pending } = require('./collect');
const { runLiveJob, itemsOf } = require('./liveJob');
const { findSearchOperators, operatorRefusal } = require('./operators');
const N = require('./labsNormalise');

/**
 * DataForSEO Labs — the competitive index, bought live.
 *
 * ---- Why this is a second transport and not a second kind ------------------
 *
 * The SERP family is a QUEUE: `task_post` charges, `task_get` collects for free
 * minutes later, and the whole of `tasks.js` exists to make sure the second
 * through hundred-and-sixty-eighth hourly tick is a free poll rather than a
 * second purchase.
 *
 * LABS HAS NO QUEUE AT ALL. There is no `task_post`, no `tasks_ready`, no
 * `task_get` — one HTTP call goes out and the answer comes back inside it,
 * charged on the way. Every safety mechanism in `tasks.js` is aimed at a gap
 * between paying and collecting that does not exist here, and applying them
 * unchanged would be theatre.
 *
 * What DOES carry over lives in `./liveJob.js` — extracted there in phase 7,
 * when Backlinks turned out to need the same claim, the same reservation and the
 * same settle, and a second copy of any of them would have been a second copy of
 * somebody's money. This file keeps the two Labs-specific arguments to it: what
 * a request costs, and where the rows are in the answer.
 *
 *   THE CLAIM. `DfsTask` in `state: 'open'` under the partial unique index,
 *   taken before the call. Two processes are a live possibility — the hourly
 *   cron, a manual refresh, and a second Render instance — and without the claim
 *   two of them make the same billable call in the same second. The row is open
 *   for the duration of one HTTP call rather than for hours, which is the only
 *   difference.
 *
 *   THE RESERVATION. Same order as `postJob`: claim, then reserve, then spend.
 *   A reservation taken before the row exists is money held by nothing, which is
 *   invisible to `reconcileReservations` and shrinks the month's cap until it
 *   rolls over.
 *
 *   THE SETTLE, FROM THE ENVELOPE'S OWN `cost`. This is the load-bearing one for
 *   phase 6 and the answer to the plan's outstanding item #4 — see the block on
 *   Bing pricing below.
 *
 * ---- The three constraints this file is built around -----------------------
 *
 * 1. LABS IS STALE AND WE CANNOT KNOW HOW STALE. DataForSEO's own docs say both
 *    "weekly" and "30-90 days". So every Labs snapshot carries `indexUpdatedAt`
 *    from the free `/status`, the screens label it "competitive index, updated
 *    weekly", and the word LIVE is reserved for SERP and Backlinks. `collectedAt`
 *    (when WE asked) and `indexUpdatedAt` (when THEY last rebuilt) are two
 *    different facts and the UI shows both.
 *
 * 2. ONE 30-SIMULTANEOUS CEILING, SHARED WITH BACKLINKS AND ONPAGE. Enforced at
 *    the TRANSPORT (`client.send` → `pool.withDbBackedSlot`), not here, so
 *    phases 7 and 8 inherit it by existing rather than by remembering.
 *
 * 3. `include_clickstream_data: true` SILENTLY DOUBLES THE COST on ~15 Labs
 *    endpoints. Guarded below, at the one seam every Labs payload passes
 *    through.
 *
 * ---- Bing pricing, and why no constant here can be wrong -------------------
 *
 * Labs' eleven Bing mirrors have no published price: DataForSEO's pricing page
 * renders as a nav shell for them and the only figure in existence is a search
 * snippet claiming $0.01/task + $0.0001/item. The plan's outstanding item #4 is
 * to settle it with one 10-keyword `bing/bulk_keyword_difficulty` call.
 *
 * WE CANNOT MAKE THAT CALL — there is no live credential (outstanding item #1).
 * So the code is built so that the answer never needs to be typed into it:
 *
 *   the ESTIMATE (what the monthly cap is reserved against) comes from
 *   `pricing.labsEstimateFor`, which reads the account's own price book and
 *   falls back to the HIGHER Google figures — an unknown price can only
 *   over-reserve, never under;
 *
 *   the LEDGER is settled from `answer.cost`, the envelope field DataForSEO
 *   fills in with what it actually charged.
 *
 * A Bing kind added later is therefore priced correctly on its very first call,
 * whatever the number turns out to be, and `describeUsage` reports it under
 * `byKind` with no further change. The human's one-line experiment is still
 * worth running — it tells us the number in advance — but nothing here depends
 * on the result.
 */

// ---------------------------------------------------------------------------
// The clickstream guard
// ---------------------------------------------------------------------------

/**
 * Refuse a Labs payload carrying `include_clickstream_data: true`.
 *
 * ---- Why this THROWS rather than quietly stripping the flag ----------------
 *
 * Because the flag is never an accident that a silent fix would help. It reads
 * as an innocuous "include a bit more data", it defaults to false everywhere, it
 * changes nothing about the response shape that anybody would notice — and it
 * doubles the price of the request. The only ways it can appear in a payload
 * this directory built are somebody pasting a request example out of the docs,
 * or somebody adding it deliberately without adding the cost model to go with
 * it. Stripping it silently turns the first case into a feature that mysteriously
 * does not work and the second into a change that mysteriously does nothing.
 *
 * A kind that genuinely wants clickstream data declares `clickstream: true`,
 * and then the ESTIMATE DOUBLES — which is the only arrangement in which the
 * cap still means what it says. Nothing declares it today, so the guard is a
 * refusal in practice; the multiplier exists so that the day something does, the
 * money is already accounted for rather than discovered on an invoice.
 *
 * ---- And why it is checked on the payload rather than at the call site ------
 *
 * Because a call site can be copied. This is the single seam every Labs request
 * in this file passes through on its way out, so a request shape added in phase
 * 7 or 10 is covered by having been built here at all.
 *
 * @param {Object} args
 * @param {string} args.endpoint
 * @param {Object} args.payload - one task object
 * @param {boolean} [args.allowed] - the kind's `clickstream` flag
 * @returns {number} the cost multiplier this payload implies
 * @throws {DfsError} when the flag is set and the kind did not ask for it
 */
const guardClickstream = ({ endpoint, payload, allowed = false }) => {
  const asked = payload && payload[C.CLICKSTREAM_KEY] === true;
  if (!asked) return 1;

  if (!allowed) {
    throw new DfsError(
      `${endpoint} was built with ${C.CLICKSTREAM_KEY}: true, which DOUBLES what ` +
        'DataForSEO charges for the request. No collection declares clickstream ' +
        'data, so this is a mistake rather than a choice — remove the flag, or ' +
        'add `clickstream: true` to the kind so the estimate doubles with it.',
      { endpoint }
    );
  }
  return C.CLICKSTREAM_MULTIPLIER;
};

// ---------------------------------------------------------------------------
// What a Labs kind asks for
// ---------------------------------------------------------------------------

/**
 * The keywords a Labs call may carry, and what was dropped on the way.
 *
 * ---- Why the operator check runs AGAIN here --------------------------------
 *
 * `sites.readKeywords` already refuses a keyword carrying a search operator at
 * save time, using this same `findSearchOperators` — that is the gate, and it is
 * in the right place. This is not a second gate; it is the same rule applied to
 * a list that may predate it. `ConnectorProject.trackedKeywords` is an ordinary
 * array on an ordinary document: a row written before the validator existed, a
 * hand-edited document, or an import path added later all reach this function
 * without having passed that one.
 *
 * The answer is to DROP the keyword and say so, not to refuse the batch. On
 * Labs an operator does not multiply anything — Labs bills per row, not per SERP
 * — so the cost argument that makes `readKeywords` refuse outright does not
 * apply. What applies is that `site:acme.com` has no search volume, no
 * difficulty and no intent, so the row comes back empty and we paid $0.00012 for
 * a null. Dropping it is cheaper and the note names it.
 *
 * @param {Object} project
 * @param {number} [limit]
 * @returns {{keywords: string[], dropped: string[], note: string}}
 */
const labsKeywords = (project, limit = C.MAX_LABS_KEYWORDS_PER_CALL) => {
  const list = Array.isArray(project?.trackedKeywords) ? project.trackedKeywords : [];
  const keywords = [];
  const dropped = [];
  const seen = new Set();

  for (const raw of list) {
    const keyword = String(raw ?? '').trim();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);

    const operators = findSearchOperators(keyword);
    if (operators.length) {
      dropped.push(operatorRefusal(keyword, operators));
      continue;
    }

    keywords.push(keyword);
    if (keywords.length >= Math.min(limit, C.MAX_TRACKED_KEYWORDS)) break;
  }

  let note = '';
  if (!keywords.length) {
    note = dropped.length
      ? `Every tracked keyword on this site carries a search operator, and Labs has ` +
        `no index entry for one. ${dropped[0]}`
      : 'No keywords are tracked on this site yet, so nothing was collected.';
  } else if (dropped.length) {
    note =
      `${dropped.length} keyword${dropped.length === 1 ? '' : 's'} carrying a search ` +
      'operator were left out — Labs has no index entry for those.';
  }

  return { keywords, dropped, note };
};

/**
 * The competitors a gap report compares against.
 *
 * `domain_intersection` takes exactly TWO targets, so a Site listing ten
 * competitors is ten billable calls per market per collection. The Site's own
 * list decides the order and the cap decides how far down it we go.
 *
 * @param {Object} project
 * @returns {{competitors: string[], note: string}}
 */
const gapCompetitors = (project) => {
  const list = Array.isArray(project?.competitors) ? project.competitors : [];
  const competitors = [];
  const seen = new Set();
  for (const raw of list) {
    const host = String(raw ?? '').trim().toLowerCase();
    if (!host || host === String(project?.domain || '').toLowerCase()) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    competitors.push(host);
    if (competitors.length >= C.MAX_GAP_COMPETITORS) break;
  }

  if (!competitors.length) {
    return {
      competitors,
      note:
        'A keyword gap needs somebody to compare against. Add a competitor to ' +
        'this site and the gap is collected on the next run.',
    };
  }
  return { competitors, note: '' };
};

/**
 * Every request one Labs collection sends, as data.
 *
 * ---- The one that is easy to build backwards -------------------------------
 *
 * `domain_intersection` with `intersections: false` answers "keywords `target1`
 * ranks for that `target2` does not". THE COMPETITOR IS `target1` AND WE ARE
 * `target2`. Swap them and the same call returns a perfectly plausible table of
 * keywords we rank for and they do not — the opposite report, with nothing in
 * the response that says so, on a screen headed "keyword gap". It is written out
 * here and named again in `labsNormalise.normaliseGapRow` so the two can be
 * checked against each other.
 *
 * @param {Object} args
 * @param {Object} args.kind
 * @param {Object} args.project
 * @param {Object} args.variant - `{locationCode, languageCode, device}`
 * @returns {{requests: Array<Object>, note: string}}
 */
const planLabsRequests = ({ kind, project, variant }) => {
  const location = { location_code: variant.locationCode, language_code: variant.languageCode };
  const domain = String(project.domain || '');

  if (kind.key === 'keyword_metrics') {
    const { keywords, note } = labsKeywords(project);
    if (!keywords.length) return { requests: [], note };
    return {
      note,
      requests: [
        {
          label: `${keywords.length} keyword${keywords.length === 1 ? '' : 's'}`,
          endpoint: kind.endpoint,
          rows: keywords.length,
          payload: { ...location, keywords },
        },
      ],
    };
  }

  if (kind.key === 'competitors') {
    return {
      note: '',
      requests: [
        {
          label: domain,
          endpoint: kind.endpoint,
          rows: C.LABS_COMPETITOR_LIMIT,
          payload: {
            ...location,
            target: domain,
            /**
             * Strips the Wikipedia/Amazon/YouTube class of domain that shares
             * keywords with everybody and competes with nobody. Without it the
             * top of every competitor table for every client is the same five
             * sites.
             */
            exclude_top_domains: true,
            limit: C.LABS_COMPETITOR_LIMIT,
            order_by: ['intersections,desc'],
          },
        },
      ],
    };
  }

  if (kind.key === 'keyword_gap') {
    const { competitors, note } = gapCompetitors(project);
    if (!competitors.length) return { requests: [], note };
    return {
      note,
      requests: competitors.map((competitor) => ({
        label: competitor,
        endpoint: kind.endpoint,
        rows: C.LABS_GAP_LIMIT,
        payload: {
          ...location,
          /** THEM. See the block above — this order is the report. */
          target1: competitor,
          /** US. */
          target2: domain,
          /** `false` IS the gap report. `true` would be the overlap. */
          intersections: false,
          limit: C.LABS_GAP_LIMIT,
          order_by: ['keyword_data.keyword_info.search_volume,desc'],
        },
      })),
    };
  }

  if (kind.key === 'top_pages') {
    return {
      note: '',
      requests: [
        {
          label: domain,
          endpoint: kind.endpoint,
          rows: C.LABS_TOP_PAGES_LIMIT,
          payload: {
            ...location,
            target: domain,
            limit: C.LABS_TOP_PAGES_LIMIT,
            order_by: ['metrics.organic.etv,desc'],
          },
        },
      ],
    };
  }

  return { requests: [], note: `No Labs request is defined for "${kind.key}".` };
};

// ---------------------------------------------------------------------------
// The freshness oracle
// ---------------------------------------------------------------------------

/**
 * When DataForSEO last rebuilt the Labs index. FREE, once per account per pass.
 *
 * Memoised on the client through `runOnce` — the same seam `tasks_ready` and the
 * reservation reconciler use, and for the same reason: `syncAccount` builds
 * exactly one client per account, so thirty Sites is one `/status` call.
 *
 * ---- Why a failure here is a null and not an error -------------------------
 *
 * It is a CAPTION. The panel says "competitive index, updated weekly" either
 * way; the date makes that claim checkable and its absence makes it merely
 * unverified. Failing a collection we are about to pay for because a free
 * caption endpoint was unavailable would be the most expensive possible reading
 * of "be careful about staleness".
 *
 * @param {Object} client
 * @returns {Promise<string|null>} an ISO instant, or null
 */
const labsIndexDate = async (client) => {
  if (typeof client?.runOnce !== 'function') return null;

  const status = await client.runOnce('labs-status', async () => {
    const answer = await client.call(C.ENDPOINT_LABS_STATUS, null, { method: 'GET' });
    const task = answer.tasks.find((t) => t.ok) || answer.tasks[0] || null;
    const row = Array.isArray(task?.result) ? task.result[0] : task?.result;
    return N.normaliseLabsStatus(row);
  });

  return status?.google || null;
};

// ---------------------------------------------------------------------------
// Buying one collection
// ---------------------------------------------------------------------------

/**
 * What one Labs request reserves against the monthly cap.
 *
 * Two things happen here and neither may be dropped: the clickstream guard runs
 * on the payload — the ONE seam every Labs request passes through on its way out
 * — and its multiplier is carried into the estimate, so a kind that ever opts in
 * reserves twice as much because it will be charged twice as much.
 *
 * @param {{request: Object, kind: Object, quota: any}} args
 * @returns {number} USD
 */
const labsEstimateFor = ({ request, kind, quota }) => {
  const multiplier = guardClickstream({
    endpoint: request.endpoint,
    payload: request.payload,
    allowed: !!kind.clickstream,
  });
  return P.labsEstimateFor({
    quota,
    endpoint: request.endpoint,
    rows: request.rows,
    multiplier,
  }).estimateUsd;
};

/**
 * Claim, reserve, call, settle, close — one Labs collection.
 *
 * The whole of it lives in `./liveJob.js`, which phase 7's Backlinks kinds run
 * through unchanged. What is Labs-specific is the two arguments below: what a
 * request costs (the clickstream guard rides in on that one) and where the rows
 * are in the answer.
 */
const runLabsJob = (args) =>
  runLiveJob({ ...args, estimateFor: labsEstimateFor, rowsOf: itemsOf });

// ---------------------------------------------------------------------------
// The fetch contract
// ---------------------------------------------------------------------------

/**
 * Turn the raw Labs answers into the snapshot body for this kind.
 *
 * @returns {Object}
 */
const aggregateFor = (kind, results, { project, collectedAt, indexUpdatedAt }) => {
  const meta = { domain: project.domain, collectedAt, indexUpdatedAt };

  if (kind.key === 'keyword_metrics') {
    const rows = results.flatMap((r) => r.rows.map(N.normaliseKeywordOverview));
    return N.aggregateKeywordMetrics(rows, meta);
  }
  if (kind.key === 'competitors') {
    const rows = results.flatMap((r) => r.rows.map(N.normaliseCompetitor));
    return N.aggregateCompetitors(rows, meta);
  }
  if (kind.key === 'top_pages') {
    const rows = results.flatMap((r) => r.rows.map(N.normaliseRelevantPage));
    return N.aggregateTopPages(rows, meta);
  }
  if (kind.key === 'keyword_gap') {
    /**
     * ONE ENTRY PER COMPETITOR, not one flat list.
     *
     * A gap is a statement about a PAIR of domains, and flattening three
     * competitors into one table produces a keyword that appears three times
     * with three different "their rank" values and no column saying whose. The
     * screen renders one comparison at a time and lets a person switch between
     * them, which is the only reading that is not ambiguous.
     */
    const comparisons = results.map((r) => {
      const rows = r.rows.map(N.normaliseGapRow);
      return N.aggregateGap(rows, {
        ...meta,
        competitor: r.request.label,
      });
    });
    return {
      domain: project.domain || null,
      collectedAt,
      indexUpdatedAt,
      comparisons,
      totals: {
        competitors: comparisons.length,
        missing: comparisons.reduce((sum, c) => sum + c.totals.missing, 0),
      },
    };
  }
  return { collectedAt, indexUpdatedAt };
};

/**
 * Collect one Labs kind for one Site, in one market.
 *
 * Returns the same `{data, raw, status, note, collectedAt}` contract
 * `snapshotService` already reads off the SERP fetcher — the generic engine must
 * not learn that this provider has two transports.
 *
 * `raw` is null for the same reason it is null on the SERP side: a Labs answer
 * at `limit: 300` across three competitors is hundreds of kilobytes of nested
 * SERP elements, and `ConnectorSnapshot.data` is already the shape a screen
 * draws. Nothing here is irreplaceable evidence the way a stored SERP is.
 *
 * @param {Object} kind
 * @param {Object} ctx - `snapshotService`'s fetch context
 * @returns {Promise<Object>}
 */
const runLabsKind = async (kind, ctx) => {
  const { project, client, session, now = new Date() } = ctx;
  const variant = ctx.variant?.key || '';

  const { requests, note } = planLabsRequests({ kind, project, variant: ctx.variant });
  if (!requests.length) return pending(note);

  /**
   * THE BUDGET STOP, before anything that can spend and before a database round
   * trip. Set by an earlier project in this pass whose reservation the cap
   * refused; a per-run flag rather than a thrown `quotaExhausted`, because the
   * throw would `break` `syncAccount`'s project loop and strand every remaining
   * project's free SERP collection. Same flag, same client, second payoff.
   */
  if (typeof client?.postingSuppressed === 'function' && client.postingSuppressed()) {
    return pending(client.postingSuppressedNote() || 'Monthly budget reached.');
  }

  /**
   * An open row means another process is mid-call on this exact collection.
   *
   * On the SERP side an open row is a job to POLL. Here it is a lock that should
   * only ever be held for the seconds one HTTP call takes — so a row still open
   * past `expiresAt` is a crash, and it is retired rather than waited on.
   */
  const open = await T.findOpenJob({ project, kind, variant });
  if (open) {
    const expired = open.expiresAt && new Date(open.expiresAt).getTime() <= now.getTime();
    if (!expired) return pending('This collection is already running.');
    const { attempt, dead } = await T.expireJob(open, { now });
    if (dead) {
      return pending(
        `This Labs collection has failed ${attempt} times and will not be bought ` +
          'again automatically. Press Refresh and confirm to try once more.'
      );
    }
  }

  /**
   * THE FRESHNESS STAMP, read before the purchase and free.
   *
   * Before rather than after, so a collection that fails still leaves the index
   * date memoised for the next kind in the same pass — and so the number on the
   * panel describes the index the data came out of rather than the index as it
   * stood some seconds later.
   */
  const indexUpdatedAt = await labsIndexDate(client);

  const outcome = await runLabsJob({
    session,
    client,
    project,
    kind,
    variant,
    requests,
    now,
  });

  if (outcome.capped && typeof client?.suppressPosting === 'function') {
    client.suppressPosting(outcome.note);
  }
  if (!outcome.ok) return pending(outcome.note);

  const data = aggregateFor(kind, outcome.results, {
    project,
    collectedAt: outcome.collectedAt,
    indexUpdatedAt,
  });

  const notes = [note, outcome.note].filter(Boolean);

  return {
    data,
    raw: null,
    status: outcome.failures?.length ? 'partial' : 'ok',
    note: notes.join(' '),
    collectedAt: outcome.collectedAt,
  };
};

module.exports = {
  guardClickstream,
  labsKeywords,
  gapCompetitors,
  planLabsRequests,
  labsIndexDate,
  labsEstimateFor,
  runLabsJob,
  aggregateFor,
  runLabsKind,
};

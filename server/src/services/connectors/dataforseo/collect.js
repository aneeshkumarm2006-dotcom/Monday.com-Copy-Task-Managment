const ConnectorProject = require('../../../models/ConnectorProject');
const DfsTask = require('../../../models/DfsTask');
const C = require('./constants');
const T = require('./tasks');
const { getKind, isTaskKind, familyOf } = require('./kinds');
const { DfsError } = require('./errors');
const { aggregatePositions } = require('./normalise');
const { storeSerpBodies } = require('./serpResults');
const { sweepReady, sweepErrors } = require('./ready');
const { createDfsClient } = require('./client');
const serpCache = require('./serpCache');

/**
 * Collecting work that has already been bought — and nothing else.
 *
 * ---- Why this is its own file, and its own cron -----------------------------
 *
 * The hourly `'17 * * * *'` pass is the one that decides to BUY. It walks
 * boards, resolves cadences, asks whether a reading is stale, and — when it is —
 * spends money. It also, incidentally, collects. Tying collection to that clock
 * meant a task DataForSEO finished five minutes after a tick sat there for
 * fifty-five more, so median latency on a queue that answers in ~5 minutes was
 * ~30 minutes.
 *
 * This is the other half, on a ten-minute cron: it starts from rows that are
 * ALREADY `state: 'open'` — work already paid for — asks `tasks_ready` which of
 * them finished, collects those, and writes the snapshot. Nothing about a board,
 * a cadence or a keyword list is consulted, because none of those questions can
 * be answered without the possibility of "…so buy it".
 *
 * ---- "Cannot spend money by construction" — what makes that true ------------
 *
 * Not a flag. Three independent structural facts, in the order they would have
 * to be defeated:
 *
 *   1. THE TRANSPORT REFUSES. `collectOnlyClient` wraps the account client and
 *      throws on any endpoint that is not free. `task_post` is the only billable
 *      path in this directory, and it does not survive the wrapper. This holds
 *      even if a future edit imports `postJob` into this file by accident.
 *   2. THE CALL GRAPH HAS NO PATH TO A PURCHASE. Money is spent in exactly one
 *      function, `tasks.postJob`, reachable from exactly one caller,
 *      `fetchers.runTaskKind`'s third branch, reachable from exactly one entry
 *      point, `fetchers.fetchKind`. This file imports none of them.
 *   3. THERE IS NOTHING TO BUY. A purchase needs a keyword list, a variant and a
 *      request, all resolved from a `ConnectorProject` and a board's
 *      configuration. This pass reads a `DfsTask` row and a project's DOMAIN,
 *      and never touches a keyword list at all.
 *
 * The wrapper also reports `postingSuppressed() === true`, so even a wiring
 * mistake that routed a fetch through this client would return the `pending`
 * sentinel before reaching a claim. That one IS a flag — it is the fourth line
 * of defence, not the first.
 */

/**
 * `snapshotService` and `session` are required LAZILY, and the reason is a cycle.
 *
 * Both destructure from `services/connectors/index.js` at load time, and that
 * registry `require`s this provider's descriptor eagerly — descriptor →
 * fetchers → collect → snapshotService → registry → descriptor. Node would hand
 * the last link a half-built module and `getConnector` would be `undefined` at
 * destructure time, which fails at the first sync of the day rather than at
 * boot. Deferring the two requires to first call breaks the cycle at the only
 * point where nothing needs the answer yet.
 */
let generic = null;
const shared = () => {
  if (!generic) {
    generic = {
      writeSnapshot: require('../snapshotService').writeSnapshot,
      openSession: require('../session').openSession,
    };
  }
  return generic;
};

/** `{status:'pending'}` — the phase-0 sentinel, spelled once. */
const pending = (note) => ({
  data: null,
  raw: null,
  status: 'pending',
  note,
  collectedAt: null,
});

/**
 * Endpoints that cannot be billed, named individually.
 *
 * An ALLOWLIST rather than a denylist, which is the whole point: a new billable
 * endpoint added in phase 6, 7 or 8 is refused here by default and has to be
 * deliberately admitted. A denylist would admit it silently.
 *
 * @param {string} endpoint
 * @returns {boolean}
 */
const isFreeEndpoint = (endpoint) => {
  const path = String(endpoint || '');
  return (
    path === C.ENDPOINT_SERP_TASKS_READY ||
    path === C.ENDPOINT_SERP_ERRORS ||
    path === C.ENDPOINT_USER_DATA ||
    /**
     * Labs' freshness oracle, admitted in phase 6 because it is genuinely free —
     * and because admitting it deliberately is the whole discipline this list
     * exists for. Its FOUR BILLABLE SIBLINGS (`keyword_overview`,
     * `competitors_domain`, `domain_intersection`, `relevant_pages`) are
     * absent, so this transport refuses them, which is exactly what the
     * allowlist was written to do to anything phases 6-8 added.
     */
    path === C.ENDPOINT_LABS_STATUS ||
    /**
     * The Backlinks footnote, admitted in phase 7 on exactly the same terms.
     *
     * `backlinks/index` reports how large the live link index is and costs
     * nothing. Its SIX BILLABLE SIBLINGS (`summary`, `timeseries_summary`,
     * `timeseries_new_lost_summary`, `referring_domains`, `anchors`,
     * `bulk_ranks`) are absent, so this transport refuses them — which is the
     * whole reason this is an allowlist and not a denylist. A denylist would
     * have admitted every one of them the day phase 7 landed, silently.
     */
    path === C.ENDPOINT_BACKLINKS_INDEX ||
    /**
     * Phase 8's two OnPage RESULT endpoints, admitted on the same terms - and
     * this is the first time the allowlist has admitted the endpoints a kind is
     * actually collected through rather than a footnote.
     *
     * OnPage's economics are the reason: the CRAWL is the entire bill and every
     * read of its output is free with thirty-day retention. So `summary` (which
     * carries the score, every counter and the crawl's own progress) and `pages`
     * (the per-page rows) are both free and are both named here, while
     * `on_page/task_post` - the one billable path in the family - is
     * deliberately ABSENT and this transport refuses it.
     *
     * That refusal is the point of the list. `task_post` is what a wiring
     * mistake in the ten-minute collector would reach for, and a denylist would
     * have admitted it the day this landed, silently, on a pass whose whole
     * premise is that it cannot spend.
     */
    path === C.ENDPOINT_ONPAGE_SUMMARY ||
    path.startsWith(`${C.ENDPOINT_ONPAGE_SUMMARY}/`) ||
    path === C.ENDPOINT_ONPAGE_PAGES ||
    path === C.ENDPOINT_SERP_TASK_GET ||
    path.startsWith(`${C.ENDPOINT_SERP_TASK_GET}/`)
  );
};

/**
 * The same account client, with the money taken out at the transport.
 *
 * Everything else is carried through by reference — including `runOnce`, which
 * shares the wrapped client's per-pass memo, so `tasks-ready` really is read
 * once per account per pass whichever half of the pass asked for it.
 *
 * @param {Object} client - from `createDfsClient`
 * @returns {Object} a client that can only read
 */
const collectOnlyClient = (client) => {
  /**
   * A REJECTED PROMISE rather than a synchronous throw, so the wrapper is
   * indistinguishable from the transport it wraps. `client.call` always returns
   * a promise, and a refusal that threw synchronously would escape a caller that
   * only handles rejections — turning a safety mechanism into a crash.
   */
  const refuse = (endpoint) =>
    Promise.reject(
      new DfsError(
        `The collection pass may not call ${endpoint}: it collects work that has ` +
          'already been paid for and can spend nothing.',
        { endpoint }
      )
    );

  return {
    ...client,
    call: (endpoint, payload = null, opts = {}) =>
      isFreeEndpoint(endpoint)
        ? client.call(endpoint, payload, opts)
        : refuse(endpoint),
    send: (endpoint, opts = {}) =>
      isFreeEndpoint(endpoint) ? client.send(endpoint, opts) : refuse(endpoint),

    /** The fourth line of defence. See this file's header. */
    postingSuppressed: () => true,
    postingSuppressedNote: () =>
      'This pass only collects results already bought; nothing new was requested.',
  };
};

/**
 * Which module collects a finished job of this family.
 *
 * Required LAZILY and memoised, for the same cycle `shared()` above breaks:
 * `onpage.js` needs this file's `pending` sentinel, so a top-level require here
 * would hand it a half-built module and `pending` would be `undefined` at
 * destructure time - a failure at the first collection of the day rather than at
 * boot.
 *
 * The dispatch itself is not optional. `collectJob` below reads a SERP batch;
 * handed a crawl it would find one item, ask `task_get` for it on the wrong
 * path, and normalise a crawl summary as a SERP - producing an empty snapshot
 * that then looks current for a month. An unknown family is SKIPPED here rather
 * than thrown, because this pass must never let one provider's new kind stop
 * every other organisation's already-purchased results from being collected.
 */
let taskCollectors = null;
const collectorFor = (family) => {
  if (!taskCollectors) {
    taskCollectors = {
      serp: collectJob,
      onpage: require('./onpage').collectCrawlJob,
    };
  }
  return taskCollectors[family] || null;
};

/**
 * Poll one open job, and if it is finished, store it and close it.
 *
 * The whole of what used to be `runTaskKind`'s first branch, lifted out so the
 * ten-minute collector and the hourly fetcher run THE SAME CODE. Two
 * implementations of "a job finished, now what" is how the SERP bodies end up
 * being written by one path and not the other — and that failure is invisible,
 * because the snapshot still writes.
 *
 * Returns the fetch contract's own shape, so `runTaskKind` can return it
 * unchanged and the collector can hand it straight to `writeSnapshot`.
 *
 * @returns {Promise<{data: any, raw: null, status: string, note: string,
 *   collectedAt: Date|null}>}
 */
const collectJob = async ({ client, job, kind, project, readySet = null, now }) => {
  const { ready, rows, bodies, collectedAt, failed, pendingCount } = await T.pollJob({
    client,
    job,
    kind,
    project,
    readySet,
    /**
     * ---- Phase 11's write-through, and why it hangs off THIS path ----------
     *
     * `collectJob` is the ONE implementation of "a job finished, now what",
     * shared by the hourly fetcher and the ten-minute sweep — which is exactly
     * the property that makes it the right place to contribute to the shared
     * corpus. Hung off either caller instead, a body collected by one runner
     * would be shared and a body collected by the other would not, and the
     * failure is invisible: the snapshot still writes, the rank is still right,
     * and the corpus simply stops filling with nothing to notice it by.
     *
     * NULL — no callback at all — unless this workspace is named in
     * `DATAFORSEO_SERP_CACHE_ORGS`, which is empty by default. `publisherFor`
     * also refuses every kind whose family is not `serp`, because phase 10 was
     * explicit that a shared BACKLINK or GBP body is not a public search result
     * and the argument that makes this defensible does not reach them.
     */
    publish: serpCache.publisherFor({ project, kind, variant: job.variant, now }),
    now,
  });

  if (!ready) {
    return pending(
      `Waiting on DataForSEO for ${pendingCount} of ${job.items.length} keywords.`
    );
  }

  if (!rows.length) {
    /**
     * Every task answered, none with usable data — the sandbox's `40404` shape,
     * or a batch that failed per-task after being accepted. The job is finished
     * either way, so it is closed rather than left open; the attempt it consumed
     * is what stops the next tick buying the same nothing an hour later.
     */
    job.state = 'failed';
    job.closedAt = now;
    job.note = failed[0]?.message || 'No results were returned.';
    for (const item of job.items) item.collected = true;
    await job.save();
    return pending(
      `DataForSEO returned no usable results for ${failed.length} keyword(s): ${job.note}`
    );
  }

  const data = aggregatePositions(rows, {
    domain: project.domain,
    depth: kind.depth,
    collectedAt,
  });

  /**
   * `collectedAt` is THE PROVIDER'S OWN datetime, and it is what `writeSnapshot`
   * turns into `periodKey`. A job posted at 23:50 whose results land at 00:05
   * belongs to the new day, which is correct and is a different question from
   * whether it should be reposted — that one is answered by the open-job key,
   * which carries no date at all.
   */
  const periodKey = collectedAt ? new Date(collectedAt).toISOString().slice(0, 10) : null;

  /**
   * The bulky evidence, into its own collection, BEFORE the job is closed.
   *
   * Best effort and deliberately so. The rank is the irreplaceable half — a
   * position on a day that has passed can never be re-bought — and it lives on
   * the snapshot the caller writes from what this function returns. A storage
   * failure here must lose the SERP body and never the measurement, which is
   * precisely why the two are in different collections and why this line is not
   * allowed to throw.
   *
   * Before `closeJob` because `closeJob` is what marks the items collected, and
   * an ordering that closed first would make a crash in between look like a
   * finished collection with no evidence.
   */
  if (periodKey && bodies?.length) {
    try {
      await storeSerpBodies({ project, job, kind, variant: job.variant, periodKey, bodies, now });
    } catch (err) {
      console.warn(
        `[connectors/dataforseo] could not store SERP bodies for ${project.domain}: ${err.message}`
      );
    }
  }

  await T.closeJob(job, { collectedAt, periodKey, now });

  return {
    data,
    /**
     * AGGREGATE ONLY, and `raw` stays null forever. The SERP bodies are 100-200
     * KB per keyword at depth 100 — two hundred of them is 20-40 MB, over
     * Mongo's 16 MB ceiling by 2x.
     */
    raw: null,
    status: failed.length ? 'partial' : 'ok',
    note: failed.length
      ? `${failed.length} of ${rows.length + failed.length} keywords did not collect.`
      : '',
    collectedAt: collectedAt || null,
  };
};

/**
 * Read the two free feeds once for this account and make them durable.
 *
 * Memoised on the CLIENT through `runOnce`, which is already scoped to one
 * account for one pass — the same seam the reservation reconciler hangs off, and
 * the reason this is not a second cron entry to forget about.
 *
 * The ORDER is not decorative. `tasks_ready` is destructive and must be
 * persisted before anything is collected; the errors feed is idempotent and can
 * follow. Neither is allowed to fail the pass: `runOnce` swallows and logs, and
 * a null ready set falls back to polling everything.
 *
 * @returns {Promise<Set<string>|null>}
 */
const readySetFor = async (client, { now }) => {
  const swept = await client.runOnce('tasks-ready', () => sweepReady({ client, now }));
  await client.runOnce('task-errors', () => sweepErrors({ client, now }));
  return swept?.ids || null;
};

/**
 * One collection pass over every account holding open work.
 *
 * Accounts are derived from the TASK LEDGER rather than from the account pool,
 * which is what keeps this pass proportional to the work outstanding: an
 * organisation with a connected account and nothing in flight costs zero calls.
 *
 * Never throws. One account's dead credential says nothing about the next one's,
 * and a collector that fell over on the first `needs_reauth` would strand every
 * other workspace's already-purchased results.
 *
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @param {Function} [opts.sessionFactory] - injected by the tests
 * @param {Function} [opts.clientFactory] - injected by the tests
 * @returns {Promise<{accounts: number, jobs: number, collected: number,
 *   written: number, failed: number, pending: number, projectIds: string[],
 *   errors: string[]}>}
 */
const collectAllReady = async ({
  now = new Date(),
  sessionFactory = null,
  clientFactory = createDfsClient,
} = {}) => {
  const report = {
    accounts: 0,
    jobs: 0,
    collected: 0,
    written: 0,
    failed: 0,
    pending: 0,
    projectIds: [],
    errors: [],
  };

  const openSession = sessionFactory || shared().openSession;
  const { writeSnapshot } = shared();

  const accountIds = await DfsTask.distinct('account', {
    provider: 'dataforseo',
    state: 'open',
  });
  if (!accountIds.length) return report;

  const touched = new Set();

  for (const accountId of accountIds) {
    let session;
    try {
      // eslint-disable-next-line no-await-in-loop
      session = await openSession(accountId);
    } catch (err) {
      // A dead credential is the hourly pass's problem to report — it is the
      // one that owns `lastSyncReport`. Here it is simply an account with
      // nothing collectable.
      report.errors.push(err.message);
      continue;
    }

    report.accounts += 1;
    const client = collectOnlyClient(clientFactory(session));

    let readySet;
    try {
      // eslint-disable-next-line no-await-in-loop
      readySet = await readySetFor(client, { now });
    } catch (err) {
      report.errors.push(err.message);
      continue;
    }

    /**
     * Loaded AFTER the sweeps, deliberately: the sweeps write `items[].readyAt`,
     * and rows loaded before them would carry a stale copy that the poll gate
     * would then read as "not announced".
     *
     * `expiresAt` is deliberately NOT consulted. Expiry is a decision about
     * REPOSTING — abandon the row so the buying pass may try again — and this
     * pass cannot repost anything. An expired job whose result turns up is the
     * best possible outcome here: results live thirty days, so collecting it for
     * free is exactly what stops the hourly pass buying it a second time.
     *
     * Two collectors racing one job is benign by construction. `closeJob` is
     * idempotent, `writeSnapshot` upserts on `(project, kind, variant, period)`,
     * and `DfsSerpResult` is keyed on the MEASUREMENT rather than the task — so a
     * result collected twice rewrites one row instead of doubling the
     * collection. That key was chosen in phase 3 for precisely this phase.
     */
    // eslint-disable-next-line no-await-in-loop
    const jobs = await DfsTask.find({
      account: accountId,
      provider: 'dataforseo',
      state: 'open',
    });
    if (!jobs.length) continue;

    // eslint-disable-next-line no-await-in-loop
    const projects = await ConnectorProject.find({
      _id: { $in: jobs.map((j) => j.project) },
    }).lean();
    const byProject = new Map(projects.map((p) => [String(p._id), p]));

    for (const job of jobs) {
      const kind = getKind(job.kind);
      const project = byProject.get(String(job.project));
      if (!kind || !project) continue;

      /**
       * A LIVE kind's row is a LOCK, not a job to collect.
       *
       * Phase 6 added Labs, which has no task queue at all: `labs.runLabsJob`
       * opens a `DfsTask` row purely so two processes cannot make the same
       * billable call, and closes it seconds later in the same function. There
       * are no task ids on its items and nothing at DataForSEO to ask about.
       *
       * Skipped rather than handled, and the difference matters. `pollJob` would
       * find no item carrying an `externalId`, conclude the batch was finished
       * with zero results, and mark a row FAILED that is at this moment mid-call
       * in another process — burning an attempt and writing a note about a
       * failure that did not happen. A row genuinely orphaned by a crash is
       * cleaned up by its own `expiresAt` in the buying pass, where the decision
       * to try again belongs.
       */
      if (!isTaskKind(kind)) continue;

      /**
       * WHICH READER. Phase 8 added a second queued family, and the two are not
       * interchangeable - see `collectorFor`. A family this build has no
       * collector for is left open for the buying pass to reason about rather
       * than being marked failed here.
       */
      const collect = collectorFor(familyOf(kind));
      if (!collect) continue;

      report.jobs += 1;

      let result;
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await collect({ client, job, kind, project, readySet, now });
      } catch (err) {
        report.failed += 1;
        report.errors.push(err.message);
        // The two account-level stops end THIS ACCOUNT, exactly as they do in
        // `syncAccount` — nothing else on it can work either.
        if (err?.quotaExhausted || err?.needsReauth) break;
        continue;
      }

      if (result.status === 'pending') {
        report.pending += 1;
        continue;
      }

      report.collected += 1;

      try {
        // eslint-disable-next-line no-await-in-loop
        const wrote = await writeSnapshot({
          project,
          provider: 'dataforseo',
          kind,
          // `writeSnapshot` reads `variant.key` and nothing else, and the job
          // stored that key verbatim from `sites.variantKeyFor` at post time.
          // Re-deriving it from the project's targets would be a second
          // spelling of the identity — and a second spelling is a second row.
          variant: { key: job.variant },
          result,
          actorId: null, // nobody was watching
          now,
        });
        if (wrote.written) {
          report.written += 1;
          touched.add(String(project._id));
        }
      } catch (err) {
        report.failed += 1;
        report.errors.push(err.message);
      }
    }
  }

  report.projectIds = [...touched];
  return report;
};

module.exports = {
  pending,
  collectorFor,
  isFreeEndpoint,
  collectOnlyClient,
  collectJob,
  readySetFor,
  collectAllReady,
};

const DfsTask = require('../../../models/DfsTask');
const C = require('./constants');
const T = require('./tasks');
const { getKind, isTaskKind, familyOf } = require('./kinds');
const { variantKeyFor } = require('./sites');
const { createDfsClient } = require('./client');
const { reconcileReservations } = require('./budget');
const { pending, collectJob, readySetFor } = require('./collect');
const { runLabsKind } = require('./labs');
const { runBacklinksKind } = require('./backlinks');
const { runOnPageKind } = require('./onpage');
const { runBusinessKind } = require('./business');
const serpCache = require('./serpCache');

/**
 * Which module buys a live kind, keyed by `kind.family`.
 *
 * ---- Why `family` and not `endpoint.startsWith(…)` -------------------------
 *
 * `transport` says HOW a kind is bought — queued and collected later, or
 * answered inside the call. `family` says WHO buys it, and the two are
 * genuinely independent: phase 6 shipped four live Labs kinds and phase 7 adds
 * four live Backlinks ones, and phase 8's OnPage crawl will be a `task` kind in
 * a third family. Dispatching on a path prefix would work today and would tie
 * the routing to a URL somebody may reasonably rewrite.
 *
 * An unknown family THROWS rather than defaulting. A default here would send a
 * Backlinks payload to the Labs builder, which would plan no requests, answer
 * `pending` with "No Labs request is defined for …", and look exactly like a
 * provider that had not collected anything yet.
 */
const LIVE_RUNNERS = {
  labs: runLabsKind,
  backlinks: runBacklinksKind,
  /**
   * Phase 10's fourth family, and the third time "no new machinery" has held.
   *
   * Business Data is live-only in exactly the shape Labs and Backlinks are, so
   * this is one table entry and a request builder. What is different about it is
   * the SUBJECT rather than the transport: a Google Business Profile is a place
   * with reviews, not a domain with links, which is why it has its own module
   * rather than a fifth branch inside `backlinks.js`.
   */
  business: runBusinessKind,
};

/**
 * And the same table for the QUEUED transport, which phase 8 made necessary.
 *
 * Phase 7 predicted this would not be needed - "`runTaskKind` already handles
 * queued kinds" - and that was true of the LIFECYCLE and false of the READER.
 * A SERP job posts one task per keyword and is finished when every one of them
 * has answered; a crawl posts ONE task and is finished when `crawl_progress`
 * says so. `runTaskKind` would chunk a keyword list the crawl kind does not
 * have, join answers on an echoed tag nothing echoes, and hand a crawl summary
 * to `normaliseSerpResult`, which would find no `items` and write a snapshot of
 * nothing. None of that throws.
 *
 * So the dispatch is on `family` for BOTH transports now, and the two tables
 * stay separate rather than merging into one keyed by `${transport}:${family}`:
 * they answer different questions with different signatures, and a merged table
 * would let a `live` family be reached down the queued path by a typo.
 *
 * An unknown family THROWS on both, for the reason phase 7 recorded: a default
 * would answer `pending` with a note about a request that was never defined,
 * which is indistinguishable from a provider that has not collected anything
 * yet.
 */
const TASK_RUNNERS = {
  serp: (kind, ctx) => runTaskKind(kind, ctx),
  onpage: runOnPageKind,
};

/**
 * The three-branch fetcher: find the open job, poll it for free, or buy one.
 *
 * ---- What the generic engine expects, and what this returns ----------------
 *
 * `snapshotService.syncProject` calls `connector.fetch(kindKey, ctx)` and hands
 * whatever comes back to `writeSnapshot`. The two return shapes that matter
 * here:
 *
 *   {status:'ok', data, collectedAt}  — a reading exists. Stored under a period
 *                                       derived FROM `collectedAt`.
 *   {status:'pending', note}          — asked for, not yet available. Phase 0's
 *                                       sentinel: `writeSnapshot` stores
 *                                       NOTHING, the run counts it as `queued`
 *                                       rather than ok/failed/skipped, and the
 *                                       note survives to a person.
 *
 * The `pending` branch writing nothing is load-bearing. `syncProject` calls
 * `writeSnapshot` unconditionally, so a "still queued" reading stored as a
 * `partial` would mint an orphan row under TODAY'S key once per UTC day the job
 * stays open — and the tab sorts `periodKey: -1` and takes the first row, so a
 * Tuesday orphan would hide Monday's real result. `trend` would gain holes and
 * dependent kinds would starve on a `null` body.
 *
 * Throwing a soft error instead is also wrong: `syncAccount` copies the first
 * error into `ConnectorAccount.lastSyncReport.error`, so an operator would read
 * "queued at DataForSEO" as a permanent account failure.
 *
 * ---- The three branches ----------------------------------------------------
 *
 *   1. AN OPEN JOB EXISTS AND HAS NOT EXPIRED → `task_get`, which is FREE.
 *      Ready  → normalise, close the job, return `ok` with the PROVIDER'S own
 *               datetime as `collectedAt`.
 *      Queued → return `pending`, and post nothing at all.
 *   2. AN OPEN JOB EXISTS AND HAS EXPIRED → abandon it and fall through to (3),
 *      unless its attempts are spent, in which case it is `dead` and the answer
 *      is `pending` with a note somebody can act on — never a fourth charge.
 *   3. NO OPEN JOB → claim the identity with an insert the partial unique index
 *      arbitrates, post the batch, and return `pending`.
 *
 * The hourly tick is therefore one purchase per cadence and free polls in
 * between, rather than 168 purchases a week.
 */

/**
 * The keyword list this job would buy, or an explanation of why there is none.
 *
 * ---- The empty-array trap --------------------------------------------------
 *
 * `planProjectWork` skips a kind when `project[kind.requires]` is falsy, and AN
 * EMPTY ARRAY IS TRUTHY. So `requires: 'trackedKeywords'` catches a project with
 * no such field and sails straight past one whose list is empty — which would
 * reach `task_post` with an empty payload and take a `40501` for it. The length
 * check has to live here, and the answer has to be `pending` with a note,
 * because a note is the only channel from a fetcher that reaches a person
 * without being reported as a fault.
 *
 * @param {Object} project
 * @returns {{keywords: string[], note: string}}
 */
const keywordsFor = (project) => {
  const list = Array.isArray(project?.trackedKeywords) ? project.trackedKeywords : [];
  const keywords = [];
  const seen = new Set();
  for (const raw of list) {
    const keyword = String(raw ?? '').trim();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
    if (keywords.length >= C.MAX_TRACKED_KEYWORDS) break;
  }

  if (!keywords.length) {
    return {
      keywords,
      note: 'No keywords are tracked on this site yet, so nothing was collected.',
    };
  }
  return { keywords, note: '' };
};

/**
 * The provider's own floor under a board's cadence.
 *
 * MOVED to `./tasks.js` in phase 8 and re-exported here, so nothing that
 * imported it from this module had to change. It lives there because it is a
 * "may we spend at all" question asked by more than one family's runner, and
 * `onpage.js` cannot import it from here without a require cycle through this
 * file's runner table.
 *
 * It used to sit beside `liveGuardNote`, the per-project live allowlist, which
 * was deleted when this stopped being a single-tenant rollout — see the note in
 * `./constants.js`. This one stays: it is a FRESHNESS floor that stops us
 * re-buying a reading we already hold, not a permission gate, so it saves a
 * tenant money rather than standing between them and their own key.
 */
const rebuyGuard = T.rebuyGuard;

/**
 * Collect one (kind, variant) for one Site.
 *
 * @param {Object} kind - from `./kinds`
 * @param {Object} ctx - `snapshotService`'s fetch context
 * @returns {Promise<{data: any, raw: any, status: string, note: string,
 *   collectedAt: Date|null}>}
 */
const runTaskKind = async (kind, ctx) => {
  const { project, client, session, existing = null, force = false, now = new Date() } = ctx;

  /**
   * The variant key, from `sites.variantKeyFor` VERBATIM.
   *
   * Half of the open-job identity. A second spelling of it here — a label, an
   * array index, a re-derivation that lowercases differently — is a permanent
   * miss on the anti-repost gate, and a miss on that gate is a second charge for
   * work already paid for. So it is either the key the planner handed us or the
   * one function that mints them, never a third thing.
   */
  const variant = ctx.variant?.key || variantKeyFor(ctx.variant || {});

  const { keywords, note: emptyNote } = keywordsFor(project);
  if (!keywords.length) return pending(emptyNote);

  const request = T.buildRequest({
    kind,
    variant: ctx.variant,
    domain: project.domain,
    keywords,
  });
  const requestHash = T.requestHashFor(request);

  // ---- Branch 1 and 2: there is already a job ------------------------------
  const open = await T.findOpenJob({ project, kind, variant });

  if (open) {
    const expired = open.expiresAt && new Date(open.expiresAt).getTime() <= now.getTime();

    if (!expired) {
      /**
       * ONE implementation of "a job finished, now what", shared with the
       * ten-minute collection cron — see `./collect.js`.
       *
       * Two copies of this is how the SERP bodies end up being written by one
       * path and not the other, and that failure is silent: the snapshot still
       * writes, the rank is still right, and the evidence simply stops
       * accumulating with nothing to notice it by.
       *
       * `readySet` is the phase-4 gate. An item nobody announced is not asked
       * about until the grace window opens, which is what makes a ten-minute
       * cadence affordable on a 200-keyword Site.
       */
      return collectJob({ client, job: open, kind, project, readySet: ctx.readySet, now });
    }

    // Expired.
    const { attempt, dead } = await T.expireJob(open, { now });
    if (dead) {
      return pending(
        `DataForSEO never returned a result for these ${keywords.length} keywords after ` +
          `${attempt} attempts. Nothing further will be bought for them automatically. ` +
          'Press Refresh and confirm to buy them again.'
      );
    }
  }

  // ---- Branch 3: buy one ---------------------------------------------------

  /**
   * THE PROVIDER'S OWN FLOOR, checked before anything else in this branch —
   * before the budget stop, and before a single database round trip.
   *
   * Deliberately first, because it is both the cheapest check here (arithmetic
   * on a row the planner already handed us) and the most SPECIFIC answer. Behind
   * it, "the monthly budget is exhausted" would be a true sentence about the
   * wrong problem, and the person reading it would go and raise a cap that was
   * never the reason nothing happened.
   *
   * Everything already bought is unaffected: this branch is only reached when
   * there is NO open job, so nothing free is being skipped.
   */
  const guard = rebuyGuard(kind, existing, now);
  if (guard.refuse && !force) return pending(guard.note);

  /**
   * THE BUDGET STOP, checked before anything else that can spend.
   *
   * Set by an earlier project in the same pass whose reservation the monthly cap
   * refused. It is a per-run flag on the ACCOUNT-SCOPED client rather than a
   * thrown `quotaExhausted`, and the difference is the most expensive line in
   * this phase: `syncAccount` catches `quotaExhausted` and `break`s out of the
   * project loop, which would abandon every remaining project INCLUDING THEIR
   * FREE `task_get` POLLS FOR RESULTS ALREADY PAID FOR. Hitting the cap on
   * project 3 of 30 would strand twenty-seven projects' worth of purchased data,
   * and those results expire in thirty days.
   *
   * So the pass continues everywhere, collecting everything already bought, and
   * buys nothing new. Reached here rather than inside `postJob` so the check
   * costs no database round trip at all once the flag is set.
   */
  if (typeof client?.postingSuppressed === 'function' && client.postingSuppressed()) {
    return pending(client.postingSuppressedNote() || 'Monthly budget reached.');
  }

  /**
   * A job that has already used up its attempts stays dead.
   *
   * Without this the `dead` state would be decorative: marking a row dead takes
   * it out of `state: 'open'`, so the very next tick would find no open job and
   * buy a FOURTH one — the exact charge the attempt cap exists to prevent. The
   * refusal is scoped to the same `requestHash`, so editing the keyword list is
   * a different question and is allowed through; and `force` overrides it,
   * because a person who has read the note and asked for it anyway is the escape
   * hatch the note is pointing at.
   *
   * `force` is a narrower thing here than it was in phase 2. This provider
   * declares `forceRefetchIsFree: false`, so a plain Refresh no longer sets it —
   * only an explicit `{force: true}` does, because on a provider that bills at
   * POST this branch both re-buys the batch and resets the attempt chain.
   */
  const priorTerminal = await T.findTerminalJob({ project, kind, variant, requestHash });

  if (priorTerminal?.state === 'dead' && !force) {
    return pending(
      'DataForSEO never returned a result for this collection, and it has been given ' +
        'up on. Press Refresh and confirm to buy it again.'
    );
  }

  /**
   * ---- Phase 11: can somebody else's paid reading answer this? --------------
   *
   * OFF BY DEFAULT. `serpCache.serve` returns null immediately — before any
   * database round trip — unless this workspace is named in
   * `DATAFORSEO_SERP_CACHE_ORGS`, which is empty and means nobody. With it unset
   * this branch is one function call returning null and the purchase below is
   * byte-for-byte what phase 10 shipped.
   *
   * ---- `!force`, and it is the whole answer to the timing side-channel ------
   *
   * A shared cache makes "is anyone else tracking this keyword" observable by
   * how fast an answer arrives — type a rival's keyword, press Refresh, and time
   * it. So the human's own button never reads the cache. `force` is the ONLY way
   * a person orders a collection on this provider (the descriptor declares
   * `forceRefetchIsFree: false`, so a plain Refresh does not set it), and here it
   * means BUY: the operator gets a fresh purchase, and learns nothing about
   * anybody else's keyword list by having asked. The only actor that can observe
   * a hit is the hourly cron, which has nobody to tell.
   *
   * ---- Where it sits, and why every guard above it still applies ------------
   *
   * AFTER the rebuy floor, the budget stop and the dead-job check, and before
   * `postJob`. A cache hit is still a collection, so it must not re-collect more
   * often than `minRebuyHours` allows — otherwise the hourly tick would rewrite
   * the same day's snapshot every hour for free, which is cheap and still wrong.
   * A batch is served only if EVERY keyword in it is present for today; a
   * partial hit falls through and buys the whole batch. See `serpCache.serve`.
   */
  if (!force) {
    const served = await serpCache.serve({
      project,
      kind,
      variant,
      keywords,
      session,
      now,
    });
    if (served) return served;
  }

  const attempt = force ? 1 : (priorTerminal?.attempt || 0) + 1;

  if (attempt > C.MAX_TASK_ATTEMPTS) {
    if (priorTerminal && priorTerminal.state !== 'dead') {
      priorTerminal.state = 'dead';
      priorTerminal.note = `Given up after ${priorTerminal.attempt} attempts.`;
      await priorTerminal.save();
    }
    return pending(
      `Given up after ${C.MAX_TASK_ATTEMPTS} attempts. Press Refresh and confirm to buy it again.`
    );
  }

  const { note, capped } = await T.postJob({
    session,
    client,
    project,
    kind,
    variant,
    keywords,
    request,
    requestHash,
    attempt,
    now,
  });

  /**
   * Our own cap refused this one. Raise the flag so the remaining twenty-nine
   * projects in this pass skip straight past their purchase branch — and only
   * their purchase branch. Everything already bought is still collected.
   */
  if (capped && typeof client?.suppressPosting === 'function') {
    client.suppressPosting(note);
  }

  return pending(note);
};

/**
 * The descriptor's `fetch`.
 *
 * Same signature as the first provider's, and it must stay that way: the
 * snapshot service looks up `connector.fetch` and knows nothing else about
 * either of them.
 *
 * @param {string} kindKey
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
const fetchKind = async (kindKey, ctx) => {
  const kind = getKind(kindKey);
  if (!kind) throw new Error(`Unknown DataForSEO snapshot kind "${kindKey}"`);

  const { session, clientFactory = createDfsClient } = ctx;
  const client = ctx.client || clientFactory(session);
  const now = ctx.now || new Date();

  /**
   * ---- The LIVE branch, added in phase 6 ------------------------------------
   *
   * DataForSEO Labs has no task queue: one HTTP call goes out and the answer
   * comes back inside it, charged on the way. So there is no open job to poll,
   * no `tasks_ready` to consult and nothing for the ten-minute collector to
   * come back for — every mechanism below this line is aimed at a gap between
   * paying and collecting that does not exist for these kinds.
   *
   * The rebuy floor is checked HERE rather than inside `runLabsKind`'s purchase
   * branch, and the asymmetry with the task transport is deliberate. There, the
   * floor sits after the open-job check because the first branch collects work
   * ALREADY PAID FOR and must never be skipped. Here there is no such branch —
   * every path through a live kind either buys or refuses — so the cheapest and
   * most specific check goes first.
   */
  const kindIsLive = !isTaskKind(kind);

  /**
   * GIVE BACK WHAT A CRASH LEFT HELD, once per account per pass.
   *
   * A reserve-post-settle sequence is three steps and takes seconds, so a task
   * still marked `budgetState: 'reserving'` ten minutes later is a process that
   * died holding money — and money held by nobody shrinks the month's budget
   * until it rolls over. Left unswept, one crash a week silently narrows the cap
   * for the rest of the month and the only symptom is collections quietly
   * stopping early.
   *
   * Hung off the client's `runOnce` rather than a cron entry of its own, because
   * the client's lifetime is ALREADY the unit we want: `syncAccount` builds
   * exactly one per account per pass. A sweep on its own schedule would be a
   * second thing to remember to start, and a sweep per fetch would be thirty
   * identical queries on a thirty-project account.
   *
   * Not awaited into the result and never allowed to throw — `runOnce` swallows
   * its failures. A bookkeeping sweep that could fail a collection would be a
   * safety mechanism costing more than it saves.
   *
   * It runs for BOTH transports. A Labs call reserves and settles through the
   * same `budgetState: 'reserving'` sub-state, so a crash mid-call leaves the
   * same orphaned reservation and needs the same sweep.
   */
  if (typeof client?.runOnce === 'function') {
    await client.runOnce('reservation-reconcile', () =>
      reconcileReservations({ now })
    );
  }

  /**
   * ---- The LIVE branch, added in phase 6 -----------------------------------
   *
   * DataForSEO Labs has no task queue: one HTTP call goes out and the answer
   * comes back inside it, charged on the way. So there is no open job to poll,
   * no `tasks_ready` to consult and nothing for the ten-minute collector to
   * come back for — every mechanism below this line is aimed at a gap between
   * paying and collecting that does not exist for these kinds. Reading
   * `tasks_ready` for them would be a free call whose answer nothing consults.
   *
   * The rebuy floor is checked HERE rather than inside `runLabsKind`'s purchase
   * branch, and the asymmetry with the task transport is deliberate. There, the
   * floor sits after the open-job check because the first branch collects work
   * ALREADY PAID FOR and must never be skipped. Here there is no such branch —
   * every path through a live kind either buys or refuses — so the cheapest and
   * most specific check goes first.
   */
  if (kindIsLive) {
    const guard = rebuyGuard(kind, ctx.existing || null, now);
    if (guard.refuse && !ctx.force) return pending(guard.note);

    const run = LIVE_RUNNERS[familyOf(kind)];
    if (!run) {
      throw new Error(
        `No DataForSEO live runner for the "${familyOf(kind)}" family (kind "${kind.key}").`
      );
    }
    return run(kind, { ...ctx, client, now });
  }

  /**
   * WHICH TASKS ARE FINISHED — one free call for the whole account, in front of
   * every poll in this pass.
   *
   * The seam the plan asked for, and it needs no generic change at all:
   * `syncAccount` already builds exactly one client per account and hands it to
   * every `fetch`, so `runOnce` makes the read once and every later fetch reads
   * the answer out of memory. Thirty Sites on one account is one `tasks_ready`
   * call, not thirty.
   *
   * `tasks_ready` is a DESTRUCTIVE READ, so `sweepReady` persists what it
   * announces onto the rows BEFORE returning — an id we read and then lost is
   * gone from the list forever. The Set handed back is a convenience over that
   * durable write, never a substitute for it.
   *
   * Null when the read failed, which polls everything: phase 3's behaviour,
   * always correct, merely expensive. A broken announcement channel must cost
   * calls and never data.
   */
  /**
   * Read ONLY for the family that has an announcement feed.
   *
   * `tasks_ready` is `serp/google/organic/tasks_ready` - a SERP feed, listing
   * SERP task ids. A crawl id will never appear in it, so consulting it for an
   * OnPage kind would spend a free call to learn nothing and then hold the crawl
   * behind `READY_GRACE_HOURS` before its first poll. `on_page/tasks_ready`
   * exists and is also free, and it is deliberately not read either: a crawl is
   * ONE task and `on_page/summary` answers "are you finished" and "here is
   * everything" in the same call.
   */
  const readySet =
    familyOf(kind) === 'serp' && typeof client?.runOnce === 'function'
      ? await readySetFor(client, { now })
      : null;

  const runTask = TASK_RUNNERS[familyOf(kind)];
  if (!runTask) {
    throw new Error(
      `No DataForSEO queued runner for the "${familyOf(kind)}" family (kind "${kind.key}").`
    );
  }

  return runTask(kind, { ...ctx, client, readySet, now });
};

/**
 * How many jobs are in flight for one Site.
 *
 * ---- Why this is on the descriptor and not in the controller ---------------
 *
 * The one thing a separate `DfsTask` collection loses is the snapshot row's
 * ability to say "queued", and the tab genuinely needs to say it — otherwise a
 * board that just enabled the connector shows an empty section with no
 * explanation for hours. Serving it costs one `countDocuments` on
 * `{project: 1, state: 1}`, which keeps intact the rule the data controller
 * exists to hold: THE READ ENDPOINT NEVER CONTACTS A PROVIDER.
 *
 * It hangs off the descriptor rather than being a `DfsTask` import inside
 * `connectorDataController` because the generic controller must not learn that
 * this provider has a task queue. A provider without one simply does not declare
 * the hook and the controller reports zero.
 *
 * @param {Object} project - a ConnectorProject row
 * @returns {Promise<number>}
 */
const queuedCount = async (project) => {
  if (!project?._id) return 0;
  return DfsTask.countDocuments({ project: project._id, state: 'open' });
};

module.exports = { fetchKind, queuedCount, keywordsFor, runTaskKind, rebuyGuard, pending };

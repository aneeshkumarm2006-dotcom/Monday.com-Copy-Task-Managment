const crypto = require('node:crypto');

const DfsTask = require('../../../models/DfsTask');
const C = require('./constants');
const { DfsError, isNotReady } = require('./errors');
const { parseDfsTime, normaliseSerpResult, aggregatePositions } = require('./normalise');
const P = require('./pricing');
const Budget = require('./budget');
const B = require('../budget');
const { trimItems } = require('./serpResults');
const { isPollable } = require('./ready');
const serpCache = require('./serpCache');

/**
 * The `DfsTask` lifecycle: claim, post, poll, close, expire.
 *
 * ---- The one rule everything here is arranged around -----------------------
 *
 * DATAFORSEO BILLS AT POST, AND THE RUNNER RE-ENTERS EVERY HOUR.
 *
 * `isFresh` returns false for anything whose status is not `ok`, and the cron is
 * `'17 * * * *'`. A fetcher that posts a task every time it is called is charged
 * 168 TIMES PER WEEKLY DATAPOINT. Everything below exists to make the second
 * through hundred-and-sixty-eighth call a free `task_get`.
 *
 * ---- Why the claim is an INSERT and not a read-then-write ------------------
 *
 * `connectorSyncRunner`'s `running` flag is module-level and per-process,
 * `refreshConnectorData` bypasses it entirely by calling `collectSnapshots`
 * direct, and Render can run two instances. There is no lock in this system to
 * lean on. So the claim is `DfsTask.create({... state: 'open'})` and the
 * PARTIAL UNIQUE INDEX decides the winner: the loser takes an E11000, reads it
 * as "somebody else already posted this", and returns `pending`. Nothing here
 * ever asks "is there an open row?" and then acts on the answer as if it were
 * still true.
 *
 * The claim also goes in BEFORE the HTTP call, which is the only ordering that
 * works. Claim-then-post can leave an open row that never got posted, and the
 * expiry sweep collects it twelve hours later. Post-then-claim can charge twice
 * in the same second, and nothing collects that.
 *
 * ---- Why an expired task is not simply reposted ---------------------------
 *
 * Both obvious answers are wrong in opposite directions. Never expiring an open
 * row means one dropped task suppresses that keyword's collection FOREVER,
 * silently — no error, no gap anybody can see, just a line that stops moving.
 * Expiring and reposting unconditionally re-buys a task DataForSEO will never
 * answer every twelve hours forever, which is worse than the 168-a-week this
 * design set out to prevent. So: expired → `abandoned` → one more post, up to
 * `maxAttempts`, and then `dead` with an actionable note and no fourth charge.
 */

// ---------------------------------------------------------------------------
// The canonical request, and its hash
// ---------------------------------------------------------------------------

/**
 * JSON with every object key in a fixed order.
 *
 * A hash is only an identity if the same request always produces the same bytes,
 * and `JSON.stringify` preserves INSERTION order — so `{depth, keyword}` and
 * `{keyword, depth}` describe one request and hash to two values. That is not a
 * theoretical worry: the difference between "this repost is provably the
 * original" and "these look similar" is the whole reason the field exists.
 *
 * Arrays keep their order, because a keyword list's order is part of what was
 * sent even when it is not part of what was meant.
 *
 * @param {any} value
 * @returns {string}
 */
const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    .join(',')}}`;
};

/**
 * The request this job would send, complete enough to resend without the project.
 *
 * ---- Why the project is not consulted again on a repost --------------------
 *
 * Twelve hours can pass between a post and its expiry, and somebody may have
 * edited the Site in between. A "retry" that quietly buys a different basket of
 * keywords is not a retry — it is a second purchase wearing the first one's
 * attempt counter, and its result lands in a snapshot that claims to be the
 * same measurement as the one before it. So the request is frozen onto the row
 * at claim time and the repost reads it from there.
 *
 * `tag` and `attempt` are deliberately ABSENT. They change on every attempt, and
 * a hash that changes with them could never prove two attempts asked the same
 * question.
 *
 * @param {Object} args
 * @param {Object} args.kind
 * @param {Object} args.variant - from `sites.variantsFor`
 * @param {string} args.domain
 * @param {string[]} args.keywords
 * @returns {Object}
 */
const buildRequest = ({ kind, variant, domain, keywords }) => ({
  endpoint: kind.postEndpoint,
  getEndpoint: kind.getEndpoint,
  depth: kind.depth,
  priority: C.TASK_PRIORITY_STANDARD,
  locationCode: variant.locationCode,
  languageCode: variant.languageCode,
  device: variant.device,
  domain,
  keywords,
});

/**
 * sha256 over the canonical request.
 *
 * READ BY NOTHING TODAY, and computed anyway. It is what makes a repost provably
 * identical to the original, and it is the exact value a phase-11 cross-tenant
 * cache would key on — so computing it now turns "should we build that?" into a
 * measurement instead of a guess, at the cost of one hash per post.
 *
 * @param {Object} request
 * @returns {string}
 */
const requestHashFor = (request) =>
  crypto.createHash('sha256').update(canonicalJson(request)).digest('hex');

/**
 * The `tag` DataForSEO echoes back in `tasks[].data.tag`.
 *
 * The join between what we asked for and what came back. The provider may
 * reorder its response and its echo is the only thing carrying OUR reference, so
 * the tag — never the array position — maps a returned id onto a keyword.
 * Derived from the request hash, so it is reproducible from the row alone and
 * carries no id anybody could enumerate.
 *
 * @param {string} requestHash
 * @param {number} attempt
 * @param {number} index
 * @returns {string}
 */
const tagFor = (requestHash, attempt, index) =>
  `${String(requestHash).slice(0, 16)}.${attempt}.${index}`;

// ---------------------------------------------------------------------------
// Money, roughly
// ---------------------------------------------------------------------------

/**
 * What this job is expected to cost.
 *
 * ---- Phase 2 shipped this against a constant. Phase 3 does not -------------
 *
 * The arithmetic moved to `./pricing.js`, which resolves the unit from the
 * ACCOUNT'S OWN price book — `/v3/appendix/user_data`, free, already read once
 * per account per pass and already stored on `ConnectorAccount.lastSeenQuota`.
 * Two reasons that matters now that there is a gate in front of the post:
 *
 *   DataForSEO moved SERP prices ~20% on 2026-07-01, and a cap enforced against
 *   a stale constant is enforced against the wrong number — in the direction
 *   that costs money, because an estimate 20% low reserves 20% too little and
 *   lets 20% more work through the ceiling than it allows.
 *
 *   The book is ACCOUNT-SPECIFIC. There is no published number that is correct
 *   for us; there is only the one they hand back.
 *
 * `unitUsd` is passed in rather than looked up here, because the lookup needs a
 * session and this function is also called by the cache probe, which has none.
 * An absent unit falls back to the published constant, which is what the whole
 * of phase 2 ran on.
 *
 * @param {Object} args
 * @param {number} args.count - keywords
 * @param {number} args.depth
 * @param {number} [args.unitUsd]
 * @returns {number}
 */
const estimateUsdFor = ({ count, depth, unitUsd }) =>
  P.estimateUsdFor({ count, depth, unitUsd });

// ---------------------------------------------------------------------------
// The cross-tenant cache probe — DURABLE from phase 11, and per kind
// ---------------------------------------------------------------------------

/**
 * Midnight UTC of the day `now` falls in.
 *
 * MOVED to `./serpCache.js` with the rest of the probe and re-exported here, so
 * nothing that imported it from this module had to change and there is exactly
 * one definition of the day boundary the reuse window is measured against.
 */
const startOfUtcDay = serpCache.startOfUtcDay;

/**
 * How many of these keywords somebody else already bought today, in this market.
 *
 * ---- Phase 2 shipped this as ONE `console.log`. Phase 11 did not keep it -----
 *
 * The comment here used to end "it will probably tell you not to build phase 11",
 * and the log line was the whole of the evidence. It could not be the evidence,
 * for three reasons that only became obvious when somebody tried to use it:
 *
 *   A LOG LINE CANNOT BE DIVIDED. The decision needs a RATE, and the line fired
 *     only when the numerator was non-zero — so it recorded the hits and threw
 *     the denominator away.
 *   A LOG LINE IS NOT PER KIND. `movement` is bought at `depth: 10` and saves a
 *     tenth of what `positions` saves per hit; Backlinks is one call per DOMAIN.
 *     Phase 10 said so explicitly: an average across kinds says nothing about
 *     either.
 *   A LOG LINE IS NOT ON RENDER SIX MONTHS LATER, which is when the question
 *     actually gets asked.
 *
 * And the number it did produce was the WRONG ONE. It counted `open` rows as
 * hits — a keyword another tenant has merely POSTED — which is the hit rate of a
 * design WITH a pre-post claim, and phase 11 refused the claim (it converts a
 * double charge into cross-tenant liveness coupling). So the single figure
 * overstated what a claimless cache could deliver, in the direction that argues
 * for building it.
 *
 * All of that moved to `./serpCache.js`, which writes a `DfsCacheProbe` row per
 * (site, kind, market, UTC day), splits ready hits from in-flight ones, records
 * whether the WHOLE batch was covered, and is drawn on Usage & Spend beside the
 * threshold it is compared against. This function is the seam `serpPlan` already
 * called and it stays exactly where it was — after the claim, before the spend —
 * so its behaviour with the cache switched off is unchanged.
 *
 * Never throws and never delays a post. A measurement that can break a purchase
 * is not worth taking.
 *
 * @returns {Promise<{overlap: number, otherOrgs: number}|null>}
 */
const probeCacheHits = async ({
  project,
  kind,
  variant,
  keywords,
  now,
  unitUsd = undefined,
  log = console.log,
}) => {
  const measured = await serpCache.probe({
    project,
    kind,
    variant,
    keywords,
    now,
    unitUsd,
    log,
  });
  if (!measured) return null;
  /**
   * `overlap` is kept as the union of both rules, because that is what the
   * phase-2 shape meant and what the two callers of this return value read. The
   * split that matters is on the stored row, not here.
   */
  return {
    overlap: measured.readyHits + measured.openHits,
    otherOrgs: measured.otherOrgs,
  };
};

// ---------------------------------------------------------------------------
// Finding the job
// ---------------------------------------------------------------------------

/** States a job ends in without having produced a snapshot. */
const TERMINAL_STATES = ['abandoned', 'failed', 'dead'];

/**
 * The open job for this exact identity, if there is one.
 *
 * THE KEY CONTAINS NO DATE, and that is the single most expensive detail in this
 * file. Keying it on `periodKey` looks natural and double-charges every job
 * posted in the last hour of a UTC day: posted Monday 23:50 under `2026-08-31`,
 * the 00:17 tick looks up `2026-09-01`, misses, and buys the whole batch again.
 * That is ~4% of all posts, permanently, plus two jobs racing into one snapshot
 * row.
 *
 * @returns {Promise<Object|null>}
 */
const findOpenJob = ({ project, kind, variant }) =>
  DfsTask.findOne({
    project: project._id,
    kind: kind.key,
    variant,
    state: 'open',
  });

/** The newest job for this identity that ended without a result. */
const findTerminalJob = ({ project, kind, variant, requestHash }) =>
  DfsTask.findOne({
    project: project._id,
    kind: kind.key,
    variant,
    requestHash,
    state: { $in: TERMINAL_STATES },
  }).sort({ createdAt: -1 });

/**
 * Retire an expired job, and say whether another attempt is allowed.
 *
 * @returns {Promise<{attempt: number, dead: boolean}>}
 */
const expireJob = async (job, { now }) => {
  const spent = job.attempt >= job.maxAttempts;

  job.state = spent ? 'dead' : 'abandoned';
  job.closedAt = now;
  job.note = spent
    ? `Given up after ${job.attempt} attempts — DataForSEO never returned a result.`
    : 'Expired without a result.';
  await job.save();

  return { attempt: job.attempt, dead: spent };
};

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/** `[a,b,c,d]`, 2 → `[[a,b],[c,d]]`. */
const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Turn a job's reservation into a charge.
 *
 * ---- Why this is unguarded, and why that is the honest answer ---------------
 *
 * By the time it runs the money is GONE — DataForSEO bills at POST, so a settle
 * that refused to record an overshoot would not un-spend it, it would only mean
 * the ledger no longer knows what the account is worth. Overshoot is RECORDED,
 * not prevented; the NEXT reserve is the one that finds the pot empty and stops.
 *
 * Overshoot is bounded by construction anyway, because the estimate and the
 * actual come from the same account price book — they differ only when
 * DataForSEO moves prices between the pass that cached the book and the post.
 *
 * Best effort on the ledger write and NOT on the row: a job whose money was
 * accounted for must say so, or the reconciler sweeps a settled reservation ten
 * minutes later and gives back money that was spent.
 */
const settleJobBudget = async (job, { actualUsd, now }) => {
  if (job.budgetState !== 'reserving') return;

  await B.settleAll({
    scopes: Array.isArray(job.budgetDocs) ? job.budgetDocs : [],
    estimateUsd: job.estimateUsd || 0,
    actualUsd: actualUsd || 0,
    now,
  });

  job.budgetState = 'settled';
  job.settledAt = now;
  await DfsTask.updateOne(
    { _id: job._id },
    { $set: { budgetState: 'settled', settledAt: now } }
  );
};

/**
 * May this Site post against the LIVE host at all?
 *
 * ---- The second of the two switches that have to be thrown to go live -------
 *
 * A monthly cap bounds the money and not the blast radius. Thirty Sites sharing
 * one newly-live account would each buy a partial batch, each land a fraction of
 * a collection, and the first live pass would produce thirty half-collected
 * projects and an exhausted budget — with nothing to check against a browser,
 * because no project got a complete reading. The plan's line is "first live key
 * runs here, ON ONE PROJECT, with a $5 cap", and this is the "on one project"
 * half.
 *
 * An empty allowlist means NOTHING MAY POST, so pointing
 * `DATAFORSEO_API_ORIGIN` at production is not on its own enough to spend a
 * cent. Not enforced on the sandbox, which is free — restricting it would only
 * stop the integration being tested.
 *
 * @returns {string} a note to return as `pending`, or `''` for "go ahead"
 */
const liveGuardNote = (project) => {
  if (C.IS_SANDBOX) return '';

  const id = String(project?._id ?? '');
  if (C.LIVE_PROJECT_IDS.size === 0) {
    return (
      'DataForSEO is pointed at the live host but no site is cleared to spend on it. ' +
      'Set DATAFORSEO_LIVE_PROJECTS to the site id you want collected first.'
    );
  }
  if (!C.LIVE_PROJECT_IDS.has(id)) {
    return (
      'This site is not on the DataForSEO live allowlist, so nothing was bought for it. ' +
      'Add its id to DATAFORSEO_LIVE_PROJECTS to collect it.'
    );
  }
  return '';
};

/**
 * The provider's own floor under a board's cadence.
 *
 * ---- Why the planner's freshness check is not enough ------------------------
 *
 * `planProjectWork` skips a kind whose newest reading is younger than the
 * resolved cadence, and that cadence is now BOARD-CONFIGURABLE — phase 5 put
 * `intervalHours` on `BoardConnector` and `scheduleForProvider` resolves it as a
 * min across every board mapping the project. One board typing `1` therefore
 * makes the planner plan a `depth: 100` census every hour, for every keyword, in
 * every market, against a provider that bills AT POST. The planner cannot refuse
 * it: it does not know what a call costs. The budget cap does not either — it
 * stops the money only after it has started moving, and it stops it for the
 * whole organisation rather than for the board that asked.
 *
 * So the fetcher has a second, stricter opinion, which is exactly what the
 * `existing` and `force` entries on the fetch ctx were added for:
 *
 *   - `existing` is the newest stored reading for THIS (kind, variant). The
 *     planner already built it and used to throw it away.
 *   - `force` is "a person asked for this in as many words". It overrides,
 *     because a human who has read the note and asked anyway is the escape
 *     hatch the note points at — and on this provider `force` only ever arrives
 *     from an explicit `{force: true}` body, never from a plain Refresh, because
 *     the descriptor declares `forceRefetchIsFree: false`.
 *
 * The answer is `pending` with a note rather than a thrown error, for the reason
 * the whole pending sentinel exists: `syncAccount` copies the first error into
 * `ConnectorAccount.lastSyncReport.error`, and "bought two hours ago" is not an
 * account failure.
 *
 * @param {Object} kind
 * @param {Object|null} existing - the newest snapshot for this (kind, variant)
 * @param {Date} now
 * @returns {{refuse: boolean, hours: number, note: string}}
 */
const rebuyGuard = (kind, existing, now) => {
  const floor = Number(kind?.minRebuyHours);
  if (!Number.isFinite(floor) || floor <= 0) return { refuse: false, hours: 0, note: '' };

  const at = existing?.fetchedAt || existing?.updatedAt || null;
  if (!at) return { refuse: false, hours: 0, note: '' };

  const ageMs = now.getTime() - new Date(at).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return { refuse: false, hours: 0, note: '' };
  if (ageMs >= floor * 3_600_000) return { refuse: false, hours: 0, note: '' };

  // Rounded UP, so "available again in 1h" never means "in nine more minutes".
  const hours = Math.max(1, Math.ceil((floor * 3_600_000 - ageMs) / 3_600_000));
  return {
    refuse: true,
    hours,
    note:
      `${kind.label} was collected ${Math.floor(ageMs / 3_600_000)}h ago and DataForSEO ` +
      `charges at the moment a collection is ordered, so it is available again in ${hours}h. ` +
      'Refresh and confirm to buy it again now.',
  };
};

/**
 * Claim the identity, take the money, then buy the work.
 *
 * ---- The ordering, which is three separate non-negotiables -----------------
 *
 * 1. THE ROW GOES IN FIRST, in `state: 'open'` — the only state the partial
 *    unique index covers. A concurrent poster's insert fails with E11000 and it
 *    returns `pending` having spent nothing. Posting first and claiming second
 *    charges both of them.
 *
 * 2. THE RESERVATION COMES AFTER THE CLAIM, not before. A reservation taken
 *    before the row exists is money held by nothing — invisible to the
 *    reconciler, unreleasable, and it shrinks the month's budget until it rolls
 *    over. Held this way round, the row IS the record of the reservation, which
 *    is the whole precondition of "sweep `reserving` rows older than ten
 *    minutes".
 *
 * 3. `budgetDocs` IS WRITTEN BEFORE THE COUNTERS MOVE. `ConnectorBudget.reservedUsd`
 *    is declared a recomputable cache, and its value is defined as the sum over
 *    the tasks NAMING a document — so a task must name it before it increments
 *    it, or a crash in between leaves a counter nothing can be traced to.
 *
 * Items are pushed onto the row AFTER EACH HTTP CALL rather than once at the
 * end. A 200-keyword Site is two `task_post` calls, and if the second throws,
 * the ids from the first are already money spent — losing them means paying for
 * results that can never be collected. Same discipline phase 4 applies to
 * `tasks_ready`, for the same reason.
 *
 * @returns {Promise<{claimed: boolean, job: Object|null, note: string,
 *   capped: boolean}>}
 */
const serpPlan = ({ session, kind, variant, keywords, requestHash, attempt }) => {
  /**
   * The account's own unit price, read off the session - no HTTP, no second
   * query. See `pricing.quotaFromSession` for why the session and not the row.
   */
  const { unitUsd } = P.resolveUnitPrice({
    quota: P.quotaFromSession(session),
    endpoint: kind.postEndpoint,
  });

  const groups = chunk(keywords, C.MAX_TASKS_PER_POST);

  return {
    estimateUsd: estimateUsdFor({ count: keywords.length, depth: kind.depth, unitUsd }),
    units: keywords,
    batches: groups.map((group, g) => ({
      endpoint: kind.postEndpoint,
      payload: group.map((keyword, i) => ({
        keyword,
        location_code: variant.locationCode,
        language_code: variant.languageCode,
        device: variant.device,
        depth: kind.depth,
        priority: C.TASK_PRIORITY_STANDARD,
        tag: tagFor(requestHash, attempt, g * C.MAX_TASKS_PER_POST + i),
      })),
    })),
    /**
     * `20100` - "Task Created", `result: null`, ALREADY CHARGED FOR.
     *
     * `id`, `cost` and the echoed `data.tag` are the only handles on money that
     * has already left the account, so the item is written from exactly those
     * three and nothing is inferred from position. A task the post refused
     * outright keeps its own code and no id, because it was never charged for
     * and there is nothing to collect.
     */
    itemsFor: (answer, batchIndex) => {
      const offset = batchIndex * C.MAX_TASKS_PER_POST;
      return answer.tasks.map((t, i) => {
        const tag =
          (t.data && typeof t.data.tag === 'string' && t.data.tag) ||
          tagFor(requestHash, attempt, offset + i);
        const index = Number(String(tag).split('.').pop());
        return {
          keyword: keywords[Number.isFinite(index) ? index : offset + i] ?? null,
          tag,
          externalId: t.created || t.ok ? t.id : null,
          cost: t.cost || 0,
          statusCode: t.statusCode,
          statusMessage: t.statusMessage,
          readyAt: null,
          collected: false,
        };
      });
    },
    /**
     * The cross-tenant cache measurement. Taken after the claim so it cannot
     * delay the purchase, and before the spend so the number means "would have
     * saved". SERP-only: there is no such thing as a shared crawl of somebody
     * else's website.
     *
     * Phase 11 left this call exactly where phase 2 put it — a probe that moved
     * would measure a different population than the one the threshold was
     * derived against, and it would no longer be true that the measurement costs
     * nothing when the budget refuses the batch. What changed is what it writes:
     * a `DfsCacheProbe` row rather than a log line. `unitUsd` is passed so
     * "would have saved" is priced from the ACCOUNT'S own book rather than from
     * the published constant.
     */
    probe: ({ project, now: at }) =>
      probeCacheHits({ project, kind, variant, keywords, now: at, unitUsd }),
    noteForNone: (message) =>
      `DataForSEO accepted none of the ${keywords.length} keywords: ${message}`,
    noteForPosted: (posted) =>
      `Queued ${posted} keyword${posted === 1 ? '' : 's'} at DataForSEO - the result arrives on a later poll.`,
  };
};

/**
 * ---- Why `postJob` takes a PLAN rather than being copied ---------------------
 *
 * Phase 8's OnPage crawl is a `task` kind in a third family: it is charged at
 * `task_post` and collected for free later, which is this file's shape and not
 * `liveJob`'s. What it is NOT is a batch of keywords - it is one call, for one
 * domain, priced per page.
 *
 * The tempting move is a second `postCrawl` beside this function. It would be a
 * second copy of the claim, the reservation, the incremental cost write and the
 * settle - and that is precisely the copy phase 7 refused to make when it lifted
 * `runLabsJob` into `liveJob.runLiveJob`. Every line of the sequence below is
 * somebody's dollars: the claim is what stops two processes buying the same
 * crawl, the reservation is what the cap is checked against, and the
 * `$inc: costUsd` after each call is what stops `reconcileReservations`
 * refunding money that was actually spent. A second copy would not fail loudly;
 * it would drift.
 *
 * So the family supplies four things - what to reserve, which calls to make, how
 * to read the answer into `items[]`, and what to say - and the money sequence
 * stays here, once. `serpPlan` above is the default, which is why rank tracking
 * calls this exactly as it did before.
 */
const postJob = async ({
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
  plan = null,
}) => {
  const spec =
    plan || serpPlan({ session, kind, variant, keywords, requestHash, attempt });

  /**
   * A crawl may legitimately run for hours, so the window it is allowed is the
   * KIND'S, falling back to the SERP figure. Expiring a running crawl abandons
   * it and buys a second one - the double charge the expiry mechanism exists to
   * bound, arrived at through the safety valve.
   */
  const expiryHours = kind.expiryHours || C.TASK_EXPIRY_HOURS;
  const expiresAt = new Date(now.getTime() + expiryHours * 3_600_000);

  const blocked = liveGuardNote(project);
  if (blocked) return { claimed: false, job: null, note: blocked, capped: false };

  const estimateUsd = spec.estimateUsd;

  const periodKey = B.monthKeyFor(now);
  const budgetDocs = await Budget.scopesFor(project, { periodKey });

  let job;
  try {
    job = await DfsTask.create({
      organisation: project.organisation,
      account: project.account || session.accountId,
      project: project._id,
      provider: 'dataforseo',
      kind: kind.key,
      variant,
      endpoint: kind.postEndpoint,
      request,
      keywords: spec.units || keywords,
      requestHash,
      tag: `${requestHash.slice(0, 16)}.${attempt}`,
      state: 'open',
      attempt,
      maxAttempts: C.MAX_TASK_ATTEMPTS,
      estimateUsd,
      /**
       * The money phase, as a SUB-STATE of an `open` row rather than a state of
       * its own. `state: 'reserving'` would not be covered by the partial unique
       * index, so using it as the claim would let two processes both insert, both
       * reserve and both post — the double charge the index exists to prevent,
       * reintroduced by the mechanism meant to make posting safer.
       */
      budgetState: 'reserving',
      reservedAt: now,
      budgetDocs,
      expiresAt,
      items: [],
    });
  } catch (err) {
    if (err?.code === 11000) {
      // The index did its job. Somebody else is already holding this identity,
      // which is exactly the outcome we wanted and cost nothing.
      return {
        claimed: false,
        job: null,
        note: 'Already queued at DataForSEO.',
        capped: false,
      };
    }
    throw err;
  }

  // ---- The gate ------------------------------------------------------------
  const reserved = await B.reserveAll({ scopes: budgetDocs, estimateUsd, now });

  if (!reserved.ok) {
    /**
     * OUR OWN CAP said no. Release the CLAIM as well as the money — an open row
     * for a purchase that never happened would suppress this Site's collection
     * for twelve hours in exchange for nothing.
     *
     * Returned as `capped`, never thrown as `quotaExhausted`. That distinction is
     * the most load-bearing line in this file: `syncAccount` `break`s on
     * `quotaExhausted`, which would abandon every remaining project INCLUDING
     * their free polls for results already paid for.
     */
    job.state = 'failed';
    job.budgetState = 'released';
    job.settledAt = now;
    job.closedAt = now;
    job.note = Budget.noteForBlocked(reserved.blocked);
    await job.save().catch(() => {});
    return { claimed: true, job, note: job.note, capped: true };
  }

  if (typeof spec.probe === 'function') await spec.probe({ project, now });

  let posted = 0;
  let cost = 0;
  let lastStatus = null;
  let lastMessage = '';

  try {
    for (let g = 0; g < spec.batches.length; g += 1) {
      const batch = spec.batches[g];

      // eslint-disable-next-line no-await-in-loop
      const answer = await client.call(batch.endpoint, batch.payload);
      lastStatus = answer.statusCode;
      lastMessage = answer.statusMessage;
      cost += answer.cost || 0;

      const items = spec.itemsFor(answer, g);

      posted += items.filter((it) => it.externalId).length;

      // eslint-disable-next-line no-await-in-loop
      await DfsTask.updateOne(
        { _id: job._id },
        {
          $push: { items: { $each: items } },
          $set: {
            postedAt: now,
            statusCode: lastStatus,
            statusMessage: lastMessage,
          },
          $inc: { costUsd: answer.cost || 0 },
        }
      );
    }
  } catch (err) {
    /**
     * The post failed. RELEASE THE CLAIM — an open row nobody posted would
     * block collection for twelve hours for nothing.
     *
     * The attempt is still consumed, and deliberately: a transport failure may
     * mean the post never happened, or it may mean it happened and we lost the
     * answer. The second case is money in flight with no ids, and hammering it
     * hourly forever is precisely the failure this file exists to prevent.
     *
     * And release the MONEY, which is the same ambiguity in the ledger: whatever
     * `cost` came back before the throw is settled as spent, and the rest of the
     * reservation is given back. A throw that took some of the batch with it
     * therefore records what it took rather than either overstating the month
     * (holding the whole estimate) or understating it (releasing the lot).
     */
    job.state = 'failed';
    job.closedAt = now;
    job.note = err.message;
    await settleJobBudget(job, { actualUsd: cost, now }).catch(() => {});
    await job.save().catch(() => {});
    throw err;
  }

  await settleJobBudget(job, { actualUsd: cost, now });

  if (!posted) {
    // Every task in the batch was refused. Nothing is in flight, so nothing will
    // ever arrive, and leaving the row open would waste twelve hours finding
    // that out.
    job.state = 'failed';
    job.closedAt = now;
    job.note = lastMessage || 'DataForSEO accepted none of the tasks.';
    await job.save();
    return {
      claimed: true,
      job,
      note: spec.noteForNone(job.note),
      capped: false,
    };
  }

  return {
    claimed: true,
    job,
    note: spec.noteForPosted(posted),
    capped: false,
  };
};

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** Run `worker` over `list` with at most `limit` in flight. */
const pooled = async (list, limit, worker) => {
  const out = new Array(list.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, list.length)).fill(null).map(async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= list.length) return;
      // eslint-disable-next-line no-await-in-loop
      out[i] = await worker(list[i], i);
    }
  });
  await Promise.all(runners);
  return out;
};

/**
 * Collect a job's results. FREE.
 *
 * `task_get` costs nothing and results live 30 days, which is what turns the
 * hourly tick from a bill into a polling loop. Phase 4 put ONE `tasks_ready` per
 * account in front of it: the calls below are unchanged, and the only difference
 * is that an item nobody has announced is not asked about at all.
 *
 * ---- Why the gate is a SKIP and not a different call ------------------------
 *
 * `tasks_ready` says WHICH tasks are finished; it carries no results. So the
 * bodies still come from `task_get` and this function is still the only place
 * they exist — which is the property phase 3 asked for and phase 4 must not
 * quietly break, because a `bodies` array that stopped being produced would stop
 * SERP evidence being stored while the snapshot kept writing. Nothing looks
 * broken in that failure, which is exactly why the gate skips calls rather than
 * replacing them.
 *
 * A skipped item counts as PENDING, not as absent. One keyword still in the
 * queue means the batch is still in the queue whether we asked about it or not,
 * and treating "not asked" as "not there" would normalise a partial batch into a
 * snapshot that then looks current for a week.
 *
 * A job is finished only when EVERY item has an answer. One keyword still in the
 * queue means the batch is still in the queue, and normalising early would write
 * a snapshot that is missing keywords and then looks current for a week.
 *
 * ---- What comes back, and why the bodies ride out rather than being re-read --
 *
 * Phase 2 threw the SERP items away here, which was correct while there was
 * nowhere to put them. `DfsSerpResult` is now that place, and it has to be fed
 * FROM THIS FUNCTION rather than from a second `task_get`: results are consumed
 * once from our side of the loop, and re-fetching them would be a second call
 * per keyword to recover data we already had in memory and dropped.
 *
 * The trim to render depth also happens HERE, not at write time. Two hundred
 * keywords x 100 items x ~1.5 KB is 30 MB held in JavaScript at once if the full
 * arrays are carried to the writer; trimming as each answer arrives keeps the
 * peak at a twentieth of that, and the byte measurement in `serpResults` then
 * runs against exactly what will be stored.
 *
 * @param {Object} args
 * @param {Set<string>|null} [args.readySet] - the ids `tasks_ready` announced
 *   this pass, already persisted. NULL means "no announcement channel", which
 *   polls everything — phase 3's behaviour, and always correct.
 * @returns {Promise<{ready: boolean, rows: Array<Object>, bodies: Array<Object>,
 *   collectedAt: Date|null, failed: Array<Object>, pendingCount: number,
 *   asked: number, waiting: number}>}
 */
const pollJob = async ({
  client,
  job,
  kind,
  project,
  readySet = null,
  /**
   * Phase 11's write-through hook. NULL unless the shared SERP cache is on for
   * this workspace — see the call site below and `./serpCache.js`.
   */
  publish = null,
  now = new Date(),
}) => {
  const open = job.items.filter((it) => it.externalId && !it.collected);

  /**
   * Split, not filtered. The unasked half still has to be counted, or a batch
   * whose announcements have not all arrived normalises into a short snapshot.
   */
  const askable = [];
  let waiting = 0;
  for (const item of open) {
    if (isPollable(item, { readySet, job, now })) askable.push(item);
    else waiting += 1;
  }

  const answers = await pooled(askable, C.POLL_CONCURRENCY, async (item) => {
    try {
      const answer = await client.call(`${kind.getEndpoint}/${item.externalId}`, null, {
        method: 'GET',
      });
      const task = answer.tasks[0] || null;

      if (!task) {
        return { item, state: 'failed', message: 'DataForSEO returned no task.' };
      }
      if (isNotReady(task.statusCode)) return { item, state: 'pending' };
      if (task.error) {
        // `notReady` also arrives as an error object, because `readTask`
        // classifies anything that is not 20000/20100 as one. It is not a
        // failure and must not close the job.
        if (task.error.notReady) return { item, state: 'pending' };
        return { item, state: 'failed', message: task.error.message };
      }

      const row = Array.isArray(task.result) ? task.result[0] : task.result;
      if (!row) {
        return { item, state: 'failed', message: 'DataForSEO returned an empty result.' };
      }

      const normalised = normaliseSerpResult(row, {
        domain: project.domain,
        keyword: item.keyword,
      });

      /**
       * The evidence, cut to render depth AS IT ARRIVES.
       *
       * The full array is dropped on the floor at the end of this callback,
       * which is the point — see the header. `returnedCount` is captured before
       * the cut so `truncated` can mean "results were thrown away" rather than
       * "the SERP was short", which no count on its own can distinguish.
       */
      const trimmed = trimItems(row.items, C.SERP_RENDER_DEPTH);

      /**
       * The PROVIDER'S OWN datetime, parsed rather than trusted.
       *
       * `"2026-09-01 00:03:12"` with no offset parses as server-local in V8 and
       * lands on the previous day in any timezone east of UTC — and a snapshot
       * is identified by its day. `parseDfsTime` throws rather than guessing,
       * because `periodKeyFrom` silently falls back to today on an
       * `Invalid Date` and would mint a plausible wrong period with no error
       * to find.
       */
      const at = row.datetime ? parseDfsTime(row.datetime, 'result datetime') : null;

      /**
       * ---- Phase 11's write-through, and why it is HERE -------------------
       *
       * NULL unless the shared SERP cache is switched on for this workspace,
       * which it is not by default — `DATAFORSEO_SERP_CACHE_ORGS` is empty and
       * empty means nobody. With no publisher this branch is one `if` against a
       * null and the untrimmed `row` is dropped on the floor exactly as before,
       * which is what makes "the cache off is byte-identical to phase 10" a
       * property of the code rather than a claim about it.
       *
       * Called per keyword AS THE ANSWER ARRIVES rather than once at the end,
       * for the arithmetic in this function's own header: an untrimmed depth-100
       * body is ~150 KB and two hundred of them carried to a writer at the end
       * is 30 MB held at once. It is also the honest ordering — this keyword's
       * SERP is paid for whether or not keyword two hundred ever answers.
       *
       * Never allowed to throw. Losing a share must never lose a collection.
       */
      if (publish && at) {
        try {
          await publish({ keyword: normalised.keyword, row, collectedAt: at });
        } catch (err) {
          console.warn(
            `[connectors/dataforseo] could not share "${normalised.keyword}": ${err.message}`
          );
        }
      }

      return {
        item,
        state: 'ok',
        row: normalised,
        body: {
          keyword: normalised.keyword,
          items: trimmed.items,
          itemTypes: normalised.itemTypes,
          returnedCount: trimmed.returnedCount,
          truncated: trimmed.truncated,
          trimmed: true,
        },
        at,
      };
    } catch (err) {
      if (err.quotaExhausted || err.needsReauth) throw err;
      if (err.notReady) return { item, state: 'pending' };
      return { item, state: 'failed', message: err.message };
    }
  });

  const pendingCount =
    waiting + answers.filter((a) => a && a.state === 'pending').length;
  if (pendingCount) {
    return {
      ready: false,
      rows: [],
      bodies: [],
      collectedAt: null,
      failed: [],
      pendingCount,
      asked: askable.length,
      waiting,
    };
  }

  const rows = [];
  const bodies = [];
  const failed = [];
  let latest = null;

  for (const answer of answers) {
    if (!answer) continue;
    if (answer.state === 'ok') {
      rows.push(answer.row);
      if (answer.body) bodies.push({ ...answer.body, collectedAt: answer.at || null });
      if (answer.at && (!latest || answer.at > latest)) latest = answer.at;
    } else {
      failed.push({ keyword: answer.item.keyword, message: answer.message || '' });
    }
  }

  return {
    ready: true,
    rows,
    bodies,
    collectedAt: latest,
    failed,
    pendingCount: 0,
    asked: askable.length,
    waiting: 0,
  };
};

/**
 * Close a collected job.
 *
 * `periodKey` is written HERE and nowhere earlier — it is the whole reason this
 * collection exists. At post time the only period available is "today", which is
 * a guess that is wrong for every job posted in the last hour of a UTC day.
 */
const closeJob = async (job, { collectedAt, periodKey, now, note = '' }) => {
  job.state = 'done';
  job.closedAt = now;
  job.readyAt = job.readyAt || collectedAt || now;
  job.periodKey = periodKey || null;
  job.note = note;
  for (const item of job.items) item.collected = true;
  await job.save();
  return job;
};

module.exports = {
  canonicalJson,
  rebuyGuard,
  serpPlan,
  buildRequest,
  requestHashFor,
  tagFor,
  estimateUsdFor,
  liveGuardNote,
  settleJobBudget,
  probeCacheHits,
  findOpenJob,
  findTerminalJob,
  expireJob,
  postJob,
  pollJob,
  closeJob,
  aggregatePositions,
  chunk,
  pooled,
  startOfUtcDay,
  TERMINAL_STATES,
};

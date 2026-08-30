const C = require('./constants');
const T = require('./tasks');
const P = require('./pricing');
const N = require('./onpageNormalise');
const { DfsError } = require('./errors');
const { parseDfsTime } = require('./normalise');
const { pending } = require('./collect');
const { variantKeyFor } = require('./sites');

/**
 * The site crawl: a `task` kind in a THIRD family.
 *
 * ---- Why this file exists at all, when `runTaskKind` is right there --------
 *
 * Because `transport` and `family` are independent, and phase 8 is the first
 * place that matters. OnPage has the SERP family's TRANSPORT — `task_post`
 * charges, every result endpoint is free, and the whole of `tasks.js`,
 * `ready.js` and `collect.js` exists for that gap — and it has nothing else in
 * common with it:
 *
 *   a SERP job posts up to two hundred tasks, one per keyword, and is finished
 *   when every one of them has answered;
 *   a CRAWL job posts ONE task, for one domain, and is finished when
 *   `crawl_progress` says `finished` — a field no SERP task has ever carried.
 *
 * `runTaskKind` reads a keyword list, chunks it, joins the answers back on an
 * echoed tag and normalises each one as a SERP. Every one of those is wrong
 * here, and none of them fails loudly: `pollJob` would fetch the crawl summary,
 * hand it to `normaliseSerpResult`, find no `items`, and write a snapshot of
 * nothing.
 *
 * What is NOT duplicated is the money. The claim, the reservation, the
 * incremental cost write and the settle all still happen in `tasks.postJob`,
 * which phase 8 taught to take a PLAN — see the note above it. This file
 * supplies the plan and reads the answer; it does not spend.
 *
 * ---- And the two facts that shape everything below -------------------------
 *
 * THE CRAWL IS THE ENTIRE BILL. `on_page/summary` and `on_page/pages` are free
 * with thirty-day retention. That is the exact opposite of Backlinks, where the
 * calls are the bill and the kinds are split so a board can drop one — here a
 * second kind would buy a second crawl of the same site to draw a second panel.
 * One kind, several free reads, and the ten-minute collector polls it for
 * nothing until it finishes.
 *
 * A CRAWL TAKES AS LONG AS SOMEBODY ELSE'S WEBSITE TAKES. Minutes at best,
 * hours on a slow host, which is why this kind carries its own `expiryHours`.
 */

// ---------------------------------------------------------------------------
// The 34x guard
// ---------------------------------------------------------------------------

/**
 * THROW on `enable_browser_rendering`. Never strip it.
 *
 * ---- Why this is the same shape as `labs.guardClickstream` -----------------
 *
 * `enable_browser_rendering: true` takes the crawl from $0.00015 a page to
 * $0.0051 — thirty-four times — and subsumes `enable_javascript` and
 * `load_resources` on the way. A thousand-page crawl goes from fifteen cents to
 * five dollars and ten cents, which is the entire default monthly cap, spent on
 * one site in one call.
 *
 * It is also uniquely tempting, in a way the clickstream flag was not. LCP, FID
 * and CLS all read 0 without it, so the Core Web Vitals panel looks broken, and
 * the one-word fix is right there in the docs. That is exactly the mistake this
 * throws on: the panel explains the zeroes instead.
 *
 * SILENTLY STRIPPING IT WOULD BE WORSE THAN THROWING. A stripped flag turns a
 * deliberate change into a feature that mysteriously does not work, and the next
 * person debugging it adds it again somewhere the strip does not reach. A throw
 * is a sentence naming the multiplier, and it happens before any money moves.
 *
 * The day site-wide rendering is genuinely wanted, this becomes an opt-in on the
 * kind exactly like `clickstream: true` — and `pricing.crawlMultiplier` already
 * makes the reservation follow it, so the cap would hold on the first crawl.
 *
 * @param {Object} args
 * @param {string} args.endpoint
 * @param {Object} args.payload
 * @param {boolean} [args.allowed]
 * @returns {Object} the payload, unchanged
 */
const guardBrowserRendering = ({ endpoint, payload, allowed = false }) => {
  const asked = payload && payload[C.BROWSER_RENDERING_KEY] === true;
  if (!asked || allowed) return payload;

  throw new DfsError(
    `${endpoint} was built with ${C.BROWSER_RENDERING_KEY}: true, which costs ` +
      `${C.ONPAGE_MULTIPLIERS[C.BROWSER_RENDERING_KEY]}x the base crawl price — a ` +
      `${C.ONPAGE_MAX_CRAWL_PAGES}-page crawl goes from $${(
        C.ONPAGE_MAX_CRAWL_PAGES * C.ONPAGE_PAGE_USD
      ).toFixed(2)} to $${(
        C.ONPAGE_MAX_CRAWL_PAGES *
        C.ONPAGE_PAGE_USD *
        C.ONPAGE_MULTIPLIERS[C.BROWSER_RENDERING_KEY]
      ).toFixed(2)}. It is never enabled site-wide. The Core Web Vitals being ` +
      'zero is not a bug this fixes — the panel says why they are zero.',
    { endpoint }
  );
};

// ---------------------------------------------------------------------------
// What a crawl asks for
// ---------------------------------------------------------------------------

/**
 * The `task_post` payload. One task, one domain.
 *
 * The configuration is `C.ONPAGE_CRAWL_CONFIG` VERBATIM and is not assembled
 * here, because it is also what gets hashed onto the snapshot: a config built at
 * call time from a spread and a couple of overrides is a config that can differ
 * between two crawls of the same site for reasons nobody wrote down, and the
 * hash would then break the trend line without anybody being able to say why.
 *
 * @param {Object} args
 * @param {string} args.domain
 * @param {string} args.tag
 * @returns {Object}
 */
const crawlPayloadFor = ({ domain, tag }) => {
  const payload = {
    target: domain,
    ...C.ONPAGE_CRAWL_CONFIG,
    tag,
  };
  return guardBrowserRendering({ endpoint: C.ENDPOINT_ONPAGE_TASK_POST, payload });
};

/**
 * The request frozen onto the `DfsTask` row.
 *
 * Complete enough to repost without re-reading the project, the same rule
 * `tasks.buildRequest` follows and for the same reason: hours pass between a
 * post and its expiry, and a "retry" that quietly crawled a different
 * configuration would be a second measurement wearing the first one's attempt
 * counter.
 */
const crawlRequestFor = ({ kind, domain }) => ({
  endpoint: kind.postEndpoint,
  getEndpoint: kind.getEndpoint,
  target: domain,
  config: { ...C.ONPAGE_CRAWL_CONFIG },
  configHash: N.configHashFor(C.ONPAGE_CRAWL_CONFIG),
});

/**
 * The plan `tasks.postJob` runs. One call, priced per page.
 *
 * @returns {Object} see `tasks.serpPlan` for the contract
 */
const crawlPlan = ({ session, kind, project, requestHash, attempt }) => {
  const tag = `${String(requestHash).slice(0, 16)}.${attempt}.0`;
  const payload = crawlPayloadFor({ domain: project.domain, tag });

  const { estimateUsd } = P.onpageEstimateFor({
    quota: P.quotaFromSession(session),
    endpoint: kind.postEndpoint,
    /**
     * `max_crawl_pages`, which is the CEILING and not a guess. DataForSEO bill
     * per page actually crawled and refund the rest, so a forty-page site
     * reserves for a thousand and settles for forty — and reserving the likely
     * figure instead would under-reserve on exactly the site that runs away.
     */
    pages: C.ONPAGE_MAX_CRAWL_PAGES,
    config: C.ONPAGE_CRAWL_CONFIG,
  });

  return {
    estimateUsd,
    /**
     * What this job bought, for the Usage screen's units column: one crawl of
     * one domain. The same convention `liveJob` uses for a Backlinks job, whose
     * unit is also a domain rather than a keyword.
     */
    units: [project.domain],
    batches: [{ endpoint: kind.postEndpoint, payload: [payload] }],
    itemsFor: (answer) =>
      answer.tasks.map((t) => ({
        keyword: project.domain,
        tag: (t.data && typeof t.data.tag === 'string' && t.data.tag) || tag,
        externalId: t.created || t.ok ? t.id : null,
        cost: t.cost || 0,
        statusCode: t.statusCode,
        statusMessage: t.statusMessage,
        readyAt: null,
        collected: false,
      })),
    /**
     * NO CACHE PROBE. Phase 11's measurement is about two tenants tracking the
     * same KEYWORD in the same market, where the SERP is a public fact that
     * could in principle be shared. A crawl of somebody's website is not that
     * under any reading, so there is nothing here to count.
     */
    probe: null,
    noteForNone: (message) => `DataForSEO would not start a crawl of this site: ${message}`,
    noteForPosted: () =>
      `A crawl of up to ${C.ONPAGE_MAX_CRAWL_PAGES} pages was ordered — it lands here ` +
      'on a later poll, which costs nothing.',
  };
};

// ---------------------------------------------------------------------------
// Collecting it, for free
// ---------------------------------------------------------------------------

/** The one item on a crawl job, or null if the post never got an id. */
const crawlItemOf = (job) =>
  (job?.items || []).find((it) => it.externalId && !it.collected) || null;

/**
 * Ask the crawl how it is doing, and read it if it is done.
 *
 * ---- Why there is no `tasks_ready` gate here -------------------------------
 *
 * Phase 4's announcement feed earns its place on a two-hundred-task SERP batch,
 * where asking about every task every ten minutes is two hundred calls to learn
 * that none of them finished. A crawl is ONE task, and `summary` answers both
 * "are you finished" and "here is everything" in the same free call — so a ready
 * gate would add a feed to read and a two-hour grace window before the first
 * poll, in exchange for saving nothing.
 *
 * ---- And why `pages` is only fetched after `finished` ----------------------
 *
 * `on_page/pages` answers happily mid-crawl with whatever has been fetched so
 * far. Stored, that would be a snapshot of a partial site — with an
 * `onpage_score` computed over a partial site, which is the sample-size problem
 * this phase exists to guard against, arrived at from the inside.
 *
 * @returns {Promise<{ready: boolean, summaryRow: Object|null,
 *   pageRows: Array<Object>, collectedAt: Date|null, note: string,
 *   failed: boolean}>}
 */
const pollCrawl = async ({ client, job, kind, now = new Date() }) => {
  const item = crawlItemOf(job);
  if (!item) {
    return {
      ready: false,
      failed: true,
      summaryRow: null,
      pageRows: [],
      collectedAt: null,
      note: 'This crawl has no DataForSEO id, so there is nothing to collect.',
    };
  }

  const answer = await client.call(`${kind.getEndpoint}/${item.externalId}`, null, {
    method: 'GET',
  });
  const task = answer.tasks[0] || null;

  if (!task) {
    return {
      ready: false,
      failed: true,
      summaryRow: null,
      pageRows: [],
      collectedAt: null,
      note: 'DataForSEO returned no task for this crawl.',
    };
  }
  if (task.error) {
    if (task.error.notReady) {
      return {
        ready: false,
        failed: false,
        summaryRow: null,
        pageRows: [],
        collectedAt: null,
        note: 'The crawl has not started yet.',
      };
    }
    return {
      ready: false,
      failed: true,
      summaryRow: null,
      pageRows: [],
      collectedAt: null,
      note: task.error.message,
    };
  }

  const summaryRow = Array.isArray(task.result) ? task.result[0] : task.result;
  if (!summaryRow) {
    return {
      ready: false,
      failed: true,
      summaryRow: null,
      pageRows: [],
      collectedAt: null,
      note: 'DataForSEO returned an empty crawl summary.',
    };
  }

  if (!N.isCrawlFinished(summaryRow)) {
    const crawl = N.crawlFrom(summaryRow);
    return {
      ready: false,
      failed: false,
      summaryRow,
      pageRows: [],
      collectedAt: null,
      note:
        `The crawl is still running — ${crawl.pagesCrawled ?? 0} pages so far, ` +
        `${crawl.pagesInQueue ?? 0} in the queue. Polling is free.`,
    };
  }

  /**
   * The worst pages, ordered SERVER-SIDE.
   *
   * Ordered by `onpage_score` ascending so the hundred rows we keep are the
   * hundred worth looking at, rather than the first hundred the crawler
   * happened to reach — which on most sites is the navigation.
   *
   * Best effort, deliberately. The summary is the irreplaceable half: it carries
   * the score, every counter and the whole issue list, and a crawl that has
   * already been paid for must not be lost because a second free read failed.
   */
  let pageRows = [];
  try {
    const pages = await client.call(C.ENDPOINT_ONPAGE_PAGES, [
      {
        id: item.externalId,
        limit: C.ONPAGE_PAGES_LIMIT,
        order_by: ['onpage_score,asc'],
      },
    ]);
    const pageTask = pages.tasks.find((t) => t.ok) || pages.tasks[0] || null;
    const row = pageTask && (Array.isArray(pageTask.result) ? pageTask.result[0] : pageTask.result);
    if (Array.isArray(row?.items)) pageRows = row.items;
  } catch (err) {
    console.warn(
      `[connectors/dataforseo] crawl ${item.externalId} summary collected but its page ` +
        `list did not: ${err.message}`
    );
  }

  /**
   * THE PROVIDER'S OWN datetime, parsed rather than trusted — `parseDfsTime`
   * throws on an unparseable one rather than letting `periodKeyFrom` fall back
   * to today and mint a plausible wrong period.
   *
   * `crawl_end` is preferred over the summary's `datetime`, because the reading
   * is of the site as it was WHEN THE CRAWL RAN, not when we happened to ask.
   * On a crawl that took nine hours those are different days.
   */
  const endedAt =
    summaryRow?.domain_info?.crawl_end || summaryRow?.datetime || null;
  const collectedAt = endedAt ? parseDfsTime(endedAt, 'crawl_end') : now;

  return { ready: true, failed: false, summaryRow, pageRows, collectedAt, note: '' };
};

/**
 * Poll one crawl and, if it has finished, store it and close the job.
 *
 * The exact counterpart of `collect.collectJob`, and it returns the same fetch
 * contract shape for the same reason: the hourly buying pass and the ten-minute
 * collection pass must run THE SAME CODE, or the crawl gets written by one path
 * and not the other and nothing looks broken when it does.
 *
 * @returns {Promise<Object>} the fetch contract
 */
const collectCrawlJob = async ({ client, job, kind, project, now = new Date() }) => {
  const { ready, failed, summaryRow, pageRows, collectedAt, note } = await pollCrawl({
    client,
    job,
    kind,
    now,
  });

  if (failed) {
    /**
     * The crawl answered and the answer was unusable. Closed rather than left
     * open, because an open row suppresses this site's collection until it
     * expires and nothing further is coming; the attempt it consumed is what
     * stops the next tick buying the same nothing.
     */
    job.state = 'failed';
    job.closedAt = now;
    job.note = note;
    for (const item of job.items) item.collected = true;
    await job.save();
    return pending(`This crawl could not be collected: ${note}`);
  }

  if (!ready) return pending(note);

  const data = N.aggregateAudit({
    summaryRow,
    pageRows,
    config: C.ONPAGE_CRAWL_CONFIG,
    domain: project.domain,
    collectedAt,
  });

  const periodKey = collectedAt
    ? new Date(collectedAt).toISOString().slice(0, 10)
    : null;

  await T.closeJob(job, { collectedAt, periodKey, now });

  /**
   * A crawl that stopped early is a reading of a SAMPLE the crawler chose, so it
   * is stored as `partial` rather than `ok`.
   *
   * That is not cosmetic. `connectorDataController` only ever takes an `ok`
   * reading as the baseline for a comparison, so a `limit_exceeded` run can be
   * looked at and can never silently become the thing the next month is measured
   * against. The score would be a score of a different site.
   */
  const truncatedCrawl =
    !!data.crawl.stopReason && data.crawl.stopReason !== 'finished';

  return {
    data,
    /** AGGREGATE ONLY. The hundred stored page rows are the whole detail. */
    raw: null,
    status: truncatedCrawl ? 'partial' : 'ok',
    note: truncatedCrawl
      ? `The crawl stopped early (${data.crawl.stopReason}), so this reading covers ` +
        `${data.crawl.pagesCrawled ?? 0} pages rather than the whole site.`
      : '',
    collectedAt: collectedAt || null,
  };
};

// ---------------------------------------------------------------------------
// The fetch contract
// ---------------------------------------------------------------------------

/**
 * Collect one crawl for one Site — the three branches, in the order that keeps
 * free work free.
 *
 *   1. AN OPEN CRAWL THAT HAS NOT EXPIRED -> poll it. FREE, whatever it says.
 *   2. AN OPEN CRAWL THAT HAS EXPIRED -> abandon it and fall through, unless its
 *      attempts are spent, in which case it is `dead` and the answer is a note.
 *   3. NO OPEN CRAWL -> the rebuy floor, then the budget stop, then claim the
 *      identity and buy one.
 *
 * The ordering is `runTaskKind`'s and is not a style choice: branch 1 collects
 * work ALREADY PAID FOR, so any gate placed in front of it would refuse to
 * collect something we have already been charged for.
 *
 * @param {Object} kind
 * @param {Object} ctx - `snapshotService`'s fetch context
 * @returns {Promise<Object>}
 */
const runOnPageKind = async (kind, ctx) => {
  const { project, client, session, existing = null, force = false, now = new Date() } = ctx;

  const domain = String(project?.domain || '').trim();
  if (!domain) {
    return pending('This site has no domain, so there is nothing to crawl.');
  }

  /**
   * The variant key from `sites.variantKeyFor` VERBATIM — half of the open-job
   * identity, and a second spelling of it is a permanent miss on the anti-repost
   * gate, which is a second charge for work already paid for.
   *
   * `variantScope: 'domain'` collapses it to one key per Site regardless of how
   * many markets the Site tracks, which is right: a crawl takes no location, no
   * language and no device. Scoped to `market` instead, a Site tracking the US
   * and the UK would buy the SAME crawl twice a month and store it as two
   * snapshots that can never disagree.
   */
  const variant = ctx.variant?.key || variantKeyFor(ctx.variant || {});

  const request = crawlRequestFor({ kind, domain });
  const requestHash = T.requestHashFor(request);

  // ---- Branches 1 and 2: there is already a crawl --------------------------
  const open = await T.findOpenJob({ project, kind, variant });

  if (open) {
    const expired = open.expiresAt && new Date(open.expiresAt).getTime() <= now.getTime();
    if (!expired) return collectCrawlJob({ client, job: open, kind, project, now });

    const { attempt, dead } = await T.expireJob(open, { now });
    if (dead) {
      return pending(
        `DataForSEO never finished a crawl of ${domain} after ${attempt} attempts. ` +
          'Nothing further will be bought for it automatically. Press Refresh and ' +
          'confirm to order another crawl.'
      );
    }
  }

  // ---- Branch 3: buy one ---------------------------------------------------

  /** The provider's own floor, checked first because it is the most specific. */
  const guard = T.rebuyGuard(kind, existing, now);
  if (guard.refuse && !force) return pending(guard.note);

  /**
   * The budget stop. A per-run flag on the account client rather than a thrown
   * `quotaExhausted`, because `syncAccount` breaks out of the project loop on
   * that one and would strand every remaining site's FREE polls for results
   * already paid for.
   */
  if (typeof client?.postingSuppressed === 'function' && client.postingSuppressed()) {
    return pending(client.postingSuppressedNote() || 'Monthly budget reached.');
  }

  const priorTerminal = await T.findTerminalJob({ project, kind, variant, requestHash });

  if (priorTerminal?.state === 'dead' && !force) {
    return pending(
      'DataForSEO never finished a crawl of this site, and it has been given up on. ' +
        'Press Refresh and confirm to order another.'
    );
  }

  const attempt = force ? 1 : (priorTerminal?.attempt || 0) + 1;

  if (attempt > C.MAX_TASK_ATTEMPTS) {
    if (priorTerminal && priorTerminal.state !== 'dead') {
      priorTerminal.state = 'dead';
      priorTerminal.note = `Given up after ${priorTerminal.attempt} attempts.`;
      await priorTerminal.save();
    }
    return pending(
      `Given up after ${C.MAX_TASK_ATTEMPTS} crawls that never finished. Press Refresh ` +
        'and confirm to order another.'
    );
  }

  const { note, capped } = await T.postJob({
    session,
    client,
    project,
    kind,
    variant,
    keywords: [domain],
    request,
    requestHash,
    attempt,
    now,
    plan: crawlPlan({ session, kind, project, requestHash, attempt }),
  });

  if (capped && typeof client?.suppressPosting === 'function') {
    client.suppressPosting(note);
  }

  return pending(note);
};

module.exports = {
  guardBrowserRendering,
  crawlPayloadFor,
  crawlRequestFor,
  crawlPlan,
  crawlItemOf,
  pollCrawl,
  collectCrawlJob,
  runOnPageKind,
};

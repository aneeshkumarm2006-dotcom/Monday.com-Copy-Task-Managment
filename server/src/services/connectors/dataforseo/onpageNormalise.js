const crypto = require('node:crypto');

const C = require('./constants');
const K = require('./onpageChecks');

/**
 * A crawl's two free result endpoints, turned into one snapshot body.
 *
 * ---- Three things this file refuses to do ----------------------------------
 *
 * 1. IT NEVER RECOMPUTES `onpage_score`. DataForSEO publish the formula and half
 *    the weights; recomputing from a table that is half ours would produce a
 *    number that disagrees with their own dashboard and looks authoritative.
 *    The score is carried verbatim, and what this file adds is the CONFIG it was
 *    computed under — because the score is sample-size dependent and a number
 *    without its sample size cannot be put on a trend line.
 *
 * 2. IT NEVER COERCES A NULL TO ZERO. `has_misspelling` is null unless the crawl
 *    asked for spell checking; a positive counter with no denominator is null;
 *    an absent metric is null. "No misspellings were found" and "we did not
 *    look" are opposite facts and `|| 0` makes them the same pixel.
 *
 * 3. IT NEVER PRESENTS LAB TIMINGS AS FIELD DATA. See `coreWebVitals`.
 *
 * ---- And the one it exists to get right ------------------------------------
 *
 * The direction of every check counter, which lives in `./onpageChecks.js` and
 * is applied here through `issueCountFor` and nowhere else.
 */

const numberOr = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringOr = (value) => (typeof value === 'string' && value ? value : null);

const boolOr = (value) => (typeof value === 'boolean' ? value : null);

const round = (value, places = 2) => {
  const n = numberOr(value);
  if (n === null) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

// ---------------------------------------------------------------------------
// The crawl configuration, and what makes two readings comparable
// ---------------------------------------------------------------------------

/**
 * A stable fingerprint of the crawl configuration.
 *
 * ---- Why a hash rather than the object -------------------------------------
 *
 * The object IS stored, right beside it, because a person reading a broken
 * trend line needs to see WHAT changed. The hash is what the comparison is made
 * on: a deep-equality check between two stored config objects would answer the
 * same question, but it would answer it in the client, in a function somebody
 * could forget to call, over two objects whose key order is not guaranteed to
 * survive a round trip through Mongo.
 *
 * Sorted keys, so `{a, b}` and `{b, a}` are one configuration and not two. Same
 * rule and the same reason as `tasks.canonicalJson`.
 *
 * @param {Object} config
 * @returns {string} 16 hex characters
 */
const configHashFor = (config) => {
  const source = config && typeof config === 'object' ? config : {};
  const canonical = Object.keys(source)
    .sort()
    .map((key) => `${key}=${JSON.stringify(source[key])}`)
    .join('&');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
};

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

/**
 * How many pages this crawl actually looked at. THE DENOMINATOR.
 *
 * Every positive check is inverted against it, so reading it from the wrong
 * field turns ten counters into ten wrong numbers at once. `crawl_status`
 * carries the live count and `domain_info.total_pages` the finished one; the
 * first is preferred because it is the one that is right while a crawl is still
 * running, and the second is the fallback for a payload that omits it.
 *
 * Zero is returned as null rather than 0, which is what makes `issueCountFor`
 * answer "unknown" instead of inventing a full-site problem.
 *
 * @param {Object} row - `tasks[0].result[0]`
 * @returns {number|null}
 */
const pagesCrawledFrom = (row) => {
  const live = numberOr(row?.crawl_status?.pages_crawled);
  if (live !== null && live > 0) return live;
  const total = numberOr(row?.domain_info?.total_pages);
  if (total !== null && total > 0) return total;
  return null;
};

/**
 * Has the crawl finished?
 *
 * `crawl_progress` is `in_progress` or `finished`. Anything else — an absent
 * field, a value they add later — is read as NOT finished, which costs a free
 * poll and never a wrong snapshot. The opposite default would normalise a
 * half-crawled site into a reading that then looks current for a month.
 *
 * @param {Object} row
 * @returns {boolean}
 */
const isCrawlFinished = (row) => String(row?.crawl_progress || '') === 'finished';

/**
 * The crawl's own account of itself.
 *
 * `stopReason` matters more than it looks: a crawl that stopped at
 * `limit_exceeded` saw the first N pages of a larger site, so its score is a
 * score of a sample AND the sample was chosen by the crawler. The client keeps
 * such a reading out of any comparison — same mechanism as the config hash, and
 * it is carried here so it can.
 */
const crawlFrom = (row) => ({
  progress: stringOr(row?.crawl_progress),
  finished: isCrawlFinished(row),
  pagesCrawled: pagesCrawledFrom(row),
  pagesInQueue: numberOr(row?.crawl_status?.pages_in_queue),
  maxCrawlPages: numberOr(row?.crawl_status?.max_crawl_pages),
  stopReason: stringOr(row?.crawl_stop_reason),
  startedAt: stringOr(row?.domain_info?.crawl_start),
  endedAt: stringOr(row?.domain_info?.crawl_end),
});

/**
 * What the crawl learned about the host itself, as opposed to about its pages.
 *
 * The eleven `domain_info.checks` booleans are a different shape from the page
 * counters — they are one answer for the whole site — so they are carried as
 * booleans and never folded into the issue list, where a `true` would be counted
 * as one affected page.
 */
const domainInfoFrom = (row) => {
  const info = row?.domain_info || {};
  const ssl = info.ssl_info || {};
  const checks = info.checks && typeof info.checks === 'object' ? info.checks : {};

  return {
    name: stringOr(info.name),
    cms: stringOr(info.cms),
    ip: stringOr(info.ip),
    server: stringOr(info.server),
    totalPages: numberOr(info.total_pages),
    ssl: {
      valid: boolOr(ssl.valid_certificate),
      expiresAt: stringOr(ssl.certificate_expiration_date),
      issuer: stringOr(ssl.certificate_issuer),
      subject: stringOr(ssl.certificate_subject),
    },
    notFoundStatusCode: numberOr(info.page_not_found_status_code),
    canonicalizationStatusCode: numberOr(info.canonicalization_status_code),
    /** Site-wide booleans: robots.txt present, sitemap present, and so on. */
    checks: Object.fromEntries(
      Object.entries(checks).filter(([, value]) => typeof value === 'boolean')
    ),
  };
};

/**
 * The totals a person reads before they read anything else.
 *
 * Straight off `page_metrics`, with no inversion anywhere — every one of these
 * is already a count of something wrong. They are listed rather than swept up so
 * that `onpage_score`, `links_internal` and `links_external`, which sit on the
 * same object and are not problems, cannot arrive here by accident.
 */
const totalsFrom = (row, pagesCrawled) => {
  const m = row?.page_metrics || {};
  return {
    pagesCrawled,
    onpageScore: round(m.onpage_score, 2),
    linksInternal: numberOr(m.links_internal),
    linksExternal: numberOr(m.links_external),
    brokenLinks: numberOr(m.broken_links),
    brokenResources: numberOr(m.broken_resources),
    duplicateTitle: numberOr(m.duplicate_title),
    duplicateDescription: numberOr(m.duplicate_description),
    duplicateContent: numberOr(m.duplicate_content),
    linksRelationConflict: numberOr(m.links_relation_conflict),
    redirectLoop: numberOr(m.redirect_loop),
    nonIndexable: numberOr(m.non_indexable),
  };
};

/**
 * Every counter as an issue row, with the direction applied exactly once.
 *
 * ---- `impact`, and why it is not the same as `pages` ------------------------
 *
 * A bucket sorted by affected pages puts "three hundred images with no title"
 * (a notice, weight 0) above "eight canonicals pointing at broken pages" (an
 * error, weight 9). The published scoring formula weighs each issue by its
 * weight and by the SHARE of pages it affects, so `weight x share` is the
 * ordering that matches what actually moves the score — and it is an ORDERING,
 * never a score. `onpage_score` is theirs and is carried verbatim.
 *
 * @param {Object} row - `tasks[0].result[0]`
 * @param {number|null} pagesCrawled
 * @returns {Array<Object>}
 */
const issuesFrom = (row, pagesCrawled) => {
  const counters = K.countersFrom(row?.page_metrics);
  const claimed = new Set();
  const issues = [];

  for (const spec of K.CHECKS) {
    const names = [spec.key, ...(spec.aliases || [])];
    const found = names.find((name) => Object.prototype.hasOwnProperty.call(counters, name));
    if (found === undefined) continue;
    names.forEach((name) => claimed.add(name));

    const raw = counters[found];
    const pages = K.issueCountFor(spec.key, raw, pagesCrawled);
    const share =
      pages !== null && pagesCrawled ? Math.round((pages / pagesCrawled) * 1000) / 1000 : null;

    issues.push({
      key: spec.key,
      label: spec.label,
      severity: spec.severity,
      weight: spec.weight,
      /**
       * TRUE when the raw counter counted successes. On screen it turns the
       * tooltip from "96 pages" into "96 of 120 pages pass; 24 do not", which
       * is the sentence that makes the number checkable by a reader.
       */
      positive: K.isPositiveCheck(spec.key),
      /** What DataForSEO actually returned, kept so the inversion is auditable. */
      rawCount: numberOr(raw),
      pages,
      share,
      /** From the UNROUNDED share, so the ordering is not quantised by the
       *  three decimal places the share is displayed at. */
      impact:
        pages !== null && pagesCrawled
          ? Math.round(spec.weight * (pages / pagesCrawled) * 1000) / 1000
          : null,
      /**
       * The counter that already carries these pages in a weighted bucket.
       * `is_https` inverted is the same population as `is_http`, so one of the
       * two has to be weightless or the error bucket double-counts it.
       */
      mirrors: spec.mirrors || null,
      known: true,
    });
  }

  /**
   * Anything DataForSEO returned that this catalog has never heard of.
   *
   * SHOWN, as an unclassified notice, rather than dropped. A check they add next
   * year is a finding we have not classified, and a screen that silently omits
   * it is a screen that quietly gets less complete over time with nothing to
   * notice it by. `known: false` is what says "nobody has looked at this one" —
   * including, honestly, "nobody has checked whether it is a positive counter".
   */
  for (const [key, raw] of Object.entries(counters)) {
    if (claimed.has(key)) continue;
    const pages = K.issueCountFor(key, raw, pagesCrawled);
    issues.push({
      key,
      label: K.humanise(key),
      severity: 'notice',
      weight: 0,
      positive: false,
      rawCount: numberOr(raw),
      pages,
      share: pages !== null && pagesCrawled ? Math.round((pages / pagesCrawled) * 1000) / 1000 : null,
      impact: 0,
      mirrors: null,
      known: false,
    });
  }

  return issues.sort((a, b) => (b.impact ?? -1) - (a.impact ?? -1) || (b.pages ?? -1) - (a.pages ?? -1));
};

/**
 * How many pages sit in each bucket, and how many distinct findings there are.
 *
 * `pages` sums the affected-page counts, which double-counts a page carrying two
 * problems and is the right number for "how much work is there". `findings`
 * counts the distinct checks that fired, which is the right number for "how many
 * kinds of problem". Both are shown, because either one alone gets misread as
 * the other.
 *
 * A `mirrors` row is excluded from `pages` — see the note on `is_https`.
 */
const issueTotalsFrom = (issues) => {
  const totals = {
    error: { findings: 0, pages: 0 },
    warning: { findings: 0, pages: 0 },
    notice: { findings: 0, pages: 0 },
  };

  for (const issue of issues) {
    const bucket = totals[issue.severity] || totals.notice;
    if (!issue.pages) continue;
    if (issue.mirrors) continue;
    bucket.findings += 1;
    bucket.pages += issue.pages;
  }

  return totals;
};

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * One row from `on_page/pages`, cut to what the table draws.
 *
 * The full row carries five readability indices, three consistency scores, a
 * spell-check payload, social-media tags and sixty booleans. A hundred of those
 * is megabytes, and `ConnectorSnapshot.data` is the wrong place for megabytes —
 * the same argument phase 3 made about SERP bodies, one API over. What is kept
 * is what the worst-pages table shows plus the failing checks that explain the
 * row's score.
 */
const normalisePage = (row) => {
  const meta = row?.meta || {};
  const timing = row?.page_timing || {};
  const checks = row?.checks && typeof row.checks === 'object' ? row.checks : {};

  /**
   * THE SAME TEN INVERSIONS, applied to booleans instead of counters.
   *
   * `checks.canonical === true` means the page HAS a canonical, which is good —
   * so a page-level failure list built by collecting the `true`s would report
   * every correctly-configured page as failing, which is the domain-level trap
   * again in a different data type. `isFailingCheck` is shared with the counter
   * path for exactly that reason.
   */
  const failing = Object.entries(checks)
    .filter(([key, value]) => K.isFailingCheck(key, value))
    .map(([key]) => key);

  return {
    url: stringOr(row?.url),
    statusCode: numberOr(row?.status_code),
    onpageScore: round(row?.onpage_score, 2),
    clickDepth: numberOr(row?.click_depth),
    size: numberOr(row?.size),
    title: stringOr(meta.title),
    titleLength: numberOr(meta.title_length),
    description: stringOr(meta.description),
    descriptionLength: numberOr(meta.description_length),
    inboundLinks: numberOr(meta.inbound_links_count),
    internalLinks: numberOr(meta.internal_links_count),
    externalLinks: numberOr(meta.external_links_count),
    /** CLS lives in `meta`, not in `page_timing`. Their arrangement, not ours. */
    cumulativeLayoutShift: numberOr(meta.cumulative_layout_shift),
    largestContentfulPaint: numberOr(timing.largest_contentful_paint),
    firstInputDelay: numberOr(timing.first_input_delay),
    timeToInteractive: numberOr(timing.time_to_interactive),
    waitingTime: numberOr(timing.waiting_time),
    durationTime: numberOr(timing.duration_time),
    failingChecks: failing,
    failingCount: failing.length,
  };
};

// ---------------------------------------------------------------------------
// Core Web Vitals — the second thing in this phase that ships nonsense
// ---------------------------------------------------------------------------

/**
 * The Core Web Vitals panel's data, and most of what it carries is caveats.
 *
 * ---- Four facts, all of them load-bearing ----------------------------------
 *
 * 1. THERE IS NO FIELD DATA ANYWHERE IN THIS API. No CrUX, no
 *    `loadingExperience`, nothing. Everything below is a LAB measurement from a
 *    simulated load of one page by one crawler. Presented under the heading
 *    "Core Web Vitals" without that said out loud, it reads as the numbers
 *    Google actually ranks on, which it is not and never will be.
 *
 * 2. INP DOES NOT EXIST IN THIS API AT ALL. It replaced FID as a Core Web Vital
 *    in March 2024. If a panel needs it, it comes from Google's free CrUX API
 *    and from nowhere else.
 *
 * 3. DATAFORSEO STILL REPORT FID, and it is retired. It is carried here because
 *    dropping a number the provider returns is its own kind of dishonesty — but
 *    it is flagged `retired: true` and the screen labels it as a legacy metric
 *    rather than as a Core Web Vital.
 *
 * 4. ALL THREE ARE ZERO WITHOUT `enable_browser_rendering`, which costs 34x and
 *    is never enabled. So a zero here carries NO INFORMATION, and reporting
 *    "CLS 0.00" from a crawl that never rendered anything would be a perfect
 *    score awarded for not looking. When rendering is off, every value is null
 *    and `measured` is false — which the screen renders as a sentence, not as a
 *    figure.
 *
 * @param {Array<Object>} pages - normalised page rows
 * @param {Object} config - the crawl config these pages came from
 * @returns {Object}
 */
const coreWebVitals = (pages, config) => {
  const rendered = config?.[C.BROWSER_RENDERING_KEY] === true;

  const shell = {
    /** LAB, always. There is no field data in this API. */
    source: 'lab',
    fieldDataAvailable: false,
    /** INP is not in this API in any form. */
    inpAvailable: false,
    browserRendering: rendered,
    sampleSize: Array.isArray(pages) ? pages.length : 0,
    /**
     * The pages this was computed over are the WORST-SCORING ones, because that
     * is how `on_page/pages` was ordered. Said here so a caption can say it.
     */
    sampleBias: 'lowest onpage_score first',
    lcp: { p75: null, unit: 'ms', measured: false },
    cls: { p75: null, unit: 'score', measured: false },
    fid: { p75: null, unit: 'ms', measured: false, retired: true },
    measuredPages: 0,
    note: rendered
      ? ''
      : 'Browser rendering was off for this crawl, so LCP, CLS and FID are all reported as 0 by DataForSEO and are not measurements.',
  };

  if (!rendered || !Array.isArray(pages) || !pages.length) return shell;

  const p75 = (values) => {
    const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    // Seventy-fifth percentile, which is the threshold Google's own Core Web
    // Vitals assessment uses. A mean would let one fast page hide a slow tail.
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1);
    return sorted[Math.max(0, index)];
  };

  const lcp = p75(pages.map((p) => p.largestContentfulPaint));
  const cls = p75(pages.map((p) => p.cumulativeLayoutShift));
  const fid = p75(pages.map((p) => p.firstInputDelay));

  return {
    ...shell,
    lcp: { p75: lcp, unit: 'ms', measured: lcp !== null },
    cls: { p75: round(cls, 3), unit: 'score', measured: cls !== null },
    fid: { p75: fid, unit: 'ms', measured: fid !== null, retired: true },
    measuredPages: pages.filter(
      (p) =>
        numberOr(p.largestContentfulPaint) ||
        numberOr(p.cumulativeLayoutShift) ||
        numberOr(p.firstInputDelay)
    ).length,
    note: '',
  };
};

// ---------------------------------------------------------------------------
// The snapshot body
// ---------------------------------------------------------------------------

/**
 * One crawl, as the `site_audit` snapshot.
 *
 * @param {Object} args
 * @param {Object} args.summaryRow - `on_page/summary` -> `tasks[0].result[0]`
 * @param {Array<Object>} [args.pageRows] - `on_page/pages` -> `result[0].items`
 * @param {Object} args.config - the crawl configuration, verbatim
 * @param {string} args.domain
 * @param {Date|null} [args.collectedAt]
 * @returns {Object}
 */
const aggregateAudit = ({ summaryRow, pageRows = [], config, domain, collectedAt = null }) => {
  const crawl = crawlFrom(summaryRow);
  const pagesCrawled = crawl.pagesCrawled;
  const issues = issuesFrom(summaryRow, pagesCrawled);
  const pages = (Array.isArray(pageRows) ? pageRows : [])
    .slice(0, C.ONPAGE_PAGES_LIMIT)
    .map(normalisePage);

  return {
    domain: domain || null,
    /**
     * THE CONFIGURATION, stored whole and hashed.
     *
     * `onpage_score` is sample-size dependent by DataForSEO's own admission, so
     * a score without the crawl size it was computed at cannot be compared with
     * anything. The hash is what the client's `comparability` compares; the
     * object is what a person reads when it tells them why there is no delta.
     */
    config: { ...config },
    configHash: configHashFor(config),
    crawl,
    totals: totalsFrom(summaryRow, pagesCrawled),
    domainInfo: domainInfoFrom(summaryRow),
    issues,
    issueTotals: issueTotalsFrom(issues),
    vitals: coreWebVitals(pages, config),
    pages,
    /** True when the crawl saw more pages than the table stores. */
    pagesTruncated:
      Array.isArray(pageRows) && pageRows.length > C.ONPAGE_PAGES_LIMIT,
    collectedAt: collectedAt ? new Date(collectedAt).toISOString() : null,
  };
};

module.exports = {
  configHashFor,
  pagesCrawledFrom,
  isCrawlFinished,
  crawlFrom,
  domainInfoFrom,
  totalsFrom,
  issuesFrom,
  issueTotalsFrom,
  normalisePage,
  coreWebVitals,
  aggregateAudit,
};

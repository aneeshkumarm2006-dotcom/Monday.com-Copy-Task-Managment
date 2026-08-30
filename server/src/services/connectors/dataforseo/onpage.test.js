const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./constants');
const P = require('./pricing');
const T = require('./tasks');
const B = require('../budget');
const Budget = require('./budget');
const DfsTask = require('../../../models/DfsTask');

const K = require('./onpageChecks');
const N = require('./onpageNormalise');
const {
  guardBrowserRendering,
  crawlPayloadFor,
  crawlPlan,
  pollCrawl,
  collectCrawlJob,
  runOnPageKind,
} = require('./onpage');

const { KINDS, getKind } = require('./kinds');
const { SCREENS } = require('./screens');
const { variantsFor, variantKeyFor } = require('./sites');
const { isFreeEndpoint, collectOnlyClient, collectorFor } = require('./collect');
const { createDfsClient } = require('./client');
const { resetPool, DB_BACKED_PREFIXES } = require('./pool');
const { fetchKind } = require('./fetchers');

/**
 * The site audit, and the two ways it ships nonsense.
 *
 * ---- 1. THE POSITIVE CHECKS. This is the first test in the file on purpose --
 *
 * Ten of the sixty counters in `page_metrics.checks` count pages that PASS, and
 * nothing in the payload says which ten. Read the obvious way, a site where
 * every page is on HTTPS reports `is_https: 120` out of 120 pages and renders as
 * "120 pages with an HTTPS problem" — a perfect site shown as the worst one, at
 * the top of a list sorted by severity, on a client report.
 *
 * So the fixture below is built so THE NAIVE ANSWER AND THE TRUE ANSWER ARE
 * DIFFERENT NUMBERS for every one of the ten, and the first test asserts the
 * difference explicitly rather than only asserting the right number — because a
 * test that only asserts 24 would still pass if somebody changed the fixture to
 * make the naive reading give 24.
 *
 * Two independent cross-checks make it self-proving rather than self-consistent:
 * `is_https` inverted must equal `is_http`, and `has_meta_title` inverted must
 * equal `no_title`. Those are DataForSEO's own complementary counters, present
 * in the same payload, and they are what tells us the direction is right rather
 * than merely consistent with itself.
 *
 * ---- 2. `onpage_score` IS SAMPLE-SIZE DEPENDENT ----------------------------
 *
 * DataForSEO say so. The domain score normalises each issue by `N / Ntotal`, so
 * the same site at 100 pages and at 1,000 pages scores differently with nothing
 * in either payload to say so. `max_crawl_pages` is pinned, the whole config is
 * hashed onto every snapshot, and the client's `comparability` refuses a delta
 * across a change — the same mechanism phase 7 built for `statusType`.
 *
 * ---- And the money, which is the reason for the 34x guard ------------------
 *
 * `enable_browser_rendering` is thirty-four times the base crawl price and is
 * the one-word "fix" for a Core Web Vitals panel full of zeroes. It throws.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-03T10:00:00Z');

/** THE DENOMINATOR. Every positive check below is inverted against it. */
const PAGES_CRAWLED = 120;

/**
 * The ten positive counters, as COUNTS OF PAGES THAT PASS, with the issue count
 * each one really means beside it.
 *
 * Every pair is deliberately unequal, and none of them is half the total, so a
 * transposition cannot accidentally produce the right answer.
 */
const POSITIVE_FIXTURE = {
  canonical: [96, 24],
  is_https: [120, 0],
  has_html_doctype: [118, 2],
  has_meta_title: [113, 7],
  meta_charset_consistency: [120, 0],
  seo_friendly_url: [74, 46],
  seo_friendly_url_characters_check: [118, 2],
  seo_friendly_url_dynamic_check: [101, 19],
  seo_friendly_url_keywords_check: [74, 46],
  seo_friendly_url_relative_length_check: [119, 1],
};

const CHECKS = {
  ...Object.fromEntries(Object.entries(POSITIVE_FIXTURE).map(([k, [raw]]) => [k, raw])),

  /**
   * The two NEGATIVE twins of positive counters above. They are what make this
   * fixture self-proving: `is_http` is the population `is_https` inverts to, and
   * `no_title` is the population `has_meta_title` inverts to, and both are
   * DataForSEO's own numbers rather than ours.
   */
  is_http: 0,
  no_title: 7,

  // Ordinary issue counters — read straight, no inversion anywhere.
  no_description: 31,
  no_image_alt: 64,
  no_h1_tag: 9,
  high_loading_time: 4,
  canonical_to_broken: 8,
  recursive_canonical: 2,
  title_too_long: 17,
  low_content_rate: 5,
  is_redirect: 6,
  /** The alias of the top-level `duplicate_title`. Must not become a second row. */
  duplicate_title_tag: 12,
  /** NULL unless `check_spell: true`. Must stay null, never become 0. */
  has_misspelling: null,
  /** A counter this catalog has never heard of. Must be SHOWN, not dropped. */
  something_they_added_in_2027: 5,
};

const SUMMARY = {
  crawl_progress: 'finished',
  crawl_status: {
    max_crawl_pages: 1000,
    pages_in_queue: 0,
    pages_crawled: PAGES_CRAWLED,
  },
  crawl_stop_reason: null,
  domain_info: {
    name: 'acme.com',
    cms: 'wordpress',
    ip: '203.0.113.10',
    server: 'nginx',
    crawl_start: '2026-09-03 04:00:00 +00:00',
    crawl_end: '2026-09-03 04:41:12 +00:00',
    total_pages: PAGES_CRAWLED,
    ssl_info: {
      valid_certificate: true,
      certificate_expiration_date: '2027-01-14 00:00:00 +00:00',
      certificate_issuer: "Let's Encrypt",
      certificate_subject: 'acme.com',
    },
    checks: { sitemap: true, robots_txt: true, test_canonicalization: false },
    page_not_found_status_code: 404,
    canonicalization_status_code: 301,
  },
  page_metrics: {
    /** THEIRS. Carried verbatim, never recomputed here. */
    onpage_score: 82.53,
    /** Not issue counts. Must never appear in the issue list. */
    links_external: 210,
    links_internal: 5400,
    duplicate_title: 12,
    duplicate_description: 19,
    duplicate_content: 3,
    broken_links: 14,
    broken_resources: 3,
    links_relation_conflict: 1,
    redirect_loop: 0,
    non_indexable: 5,
    checks: CHECKS,
  },
};

const IN_PROGRESS = {
  ...SUMMARY,
  crawl_progress: 'in_progress',
  crawl_status: { max_crawl_pages: 1000, pages_in_queue: 640, pages_crawled: 360 },
};

/** Two page rows: one healthy, one not. Both carry the SAME positive booleans. */
const PAGE_ROWS = [
  {
    url: 'https://acme.com/pricing',
    status_code: 200,
    onpage_score: 41.2,
    click_depth: 2,
    size: 214_000,
    meta: {
      title: 'Pricing',
      title_length: 7,
      description: null,
      inbound_links_count: 42,
      internal_links_count: 30,
      external_links_count: 4,
      cumulative_layout_shift: 0,
    },
    page_timing: {
      largest_contentful_paint: 0,
      first_input_delay: 0,
      time_to_interactive: 0,
      waiting_time: 310,
      duration_time: 980,
    },
    checks: {
      // POSITIVE ones, and this page fails two of them by being FALSE.
      canonical: false,
      is_https: true,
      has_html_doctype: true,
      has_meta_title: true,
      meta_charset_consistency: false,
      // ORDINARY ones: true is the failure.
      no_description: true,
      no_image_alt: true,
      high_loading_time: false,
    },
  },
  {
    url: 'https://acme.com/',
    status_code: 200,
    onpage_score: 96.4,
    click_depth: 0,
    size: 88_000,
    meta: {
      title: 'Acme — CRM for agencies',
      title_length: 24,
      description: 'The CRM agencies actually keep using.',
      inbound_links_count: 310,
      internal_links_count: 44,
      external_links_count: 9,
      cumulative_layout_shift: 0,
    },
    page_timing: {
      largest_contentful_paint: 0,
      first_input_delay: 0,
      time_to_interactive: 0,
      waiting_time: 120,
      duration_time: 410,
    },
    checks: {
      canonical: true,
      is_https: true,
      has_html_doctype: true,
      has_meta_title: true,
      meta_charset_consistency: true,
      no_description: false,
      no_image_alt: false,
      high_loading_time: false,
    },
  },
];

const VARIANT = { locationCode: 0, languageCode: 'any', device: 'any' };
const VARIANT_KEY = variantKeyFor(VARIANT);

const project = (overrides = {}) => ({
  _id: 'proj-1',
  externalId: 'proj-1',
  name: 'Acme',
  domain: 'acme.com',
  organisation: 'org-1',
  account: 'acct-1',
  trackedKeywords: ['best crm for agencies'],
  targets: [
    { locationCode: 2840, languageCode: 'en', device: 'desktop' },
    { locationCode: 2840, languageCode: 'en', device: 'mobile' },
    { locationCode: 2826, languageCode: 'en', device: 'desktop' },
    { locationCode: 2826, languageCode: 'en', device: 'mobile' },
  ],
  ...overrides,
});

const session = {
  accountId: 'acct-1',
  getCredentials: () => ({ login: 'l', password: 'p' }),
  getQuota: () => null,
};

const KIND = getKind('site_audit');

// ---------------------------------------------------------------------------
// 1. THE TRAP — written first, and it fails against the naive reading
// ---------------------------------------------------------------------------

test('the positive checks are counts of pages that PASS, and the naive reading is a different number', () => {
  const issues = N.issuesFrom(SUMMARY, PAGES_CRAWLED);
  const by = (key) => issues.find((i) => i.key === key);

  for (const [key, [raw, expected]] of Object.entries(POSITIVE_FIXTURE)) {
    const issue = by(key);
    assert.ok(issue, `${key} must appear in the issue list`);
    assert.equal(issue.positive, true, `${key} must be flagged as a positive counter`);

    // What DataForSEO returned, kept so the inversion stays auditable.
    assert.equal(issue.rawCount, raw);

    // THE ANSWER: pagesCrawled - counter.
    assert.equal(issue.pages, expected, `${key} affects ${expected} pages, not ${raw}`);

    /**
     * THE CONTROL. Without this the test above would still pass on a fixture
     * doctored so the naive reading happened to agree — and the whole point is
     * that the two readings are both plausible and never equal here.
     */
    assert.notEqual(
      issue.pages,
      raw,
      `${key}: the naive reading (${raw}) must not equal the true issue count (${expected})`
    );
  }

  /**
   * The worst single case, stated on its own because it is the one that would
   * reach a client: a site where EVERY page is on HTTPS.
   */
  assert.equal(by('is_https').rawCount, 120);
  assert.equal(by('is_https').pages, 0, 'a fully-HTTPS site has zero HTTPS problems');
});

test("the inversion agrees with DataForSEO's own complementary counters", () => {
  const issues = N.issuesFrom(SUMMARY, PAGES_CRAWLED);
  const by = (key) => issues.find((i) => i.key === key);

  /**
   * `is_http` and `no_title` are THEIR numbers for the same populations, present
   * in the same payload. Agreement between our inversion and their counter is
   * the only evidence in this file that the direction is right rather than
   * merely self-consistent.
   */
  assert.equal(by('is_https').pages, by('is_http').pages);
  assert.equal(by('has_meta_title').pages, by('no_title').pages);
  assert.equal(by('no_title').pages, 7);
});

test('a positive counter with no denominator answers NULL — never a negative, never the raw count', () => {
  // `0 - 96` sorts to the top of an ascending list and renders as -96; `96`
  // renders a perfect site as the worst one. Neither is an answer.
  assert.equal(K.issueCountFor('canonical', 96, 0), null);
  assert.equal(K.issueCountFor('canonical', 96, null), null);
  assert.equal(K.issueCountFor('canonical', 96, undefined), null);

  // An ORDINARY counter needs no denominator and still answers.
  assert.equal(K.issueCountFor('no_description', 31, null), 31);

  // And a counter that is genuinely absent is null on both sides.
  assert.equal(K.issueCountFor('no_description', null, 120), null);
  assert.equal(K.issueCountFor('canonical', null, 120), null);
});

test('a positive counter above the denominator clamps at zero rather than going negative', () => {
  // Checks are evaluated over the pages actually parsed, which can run a page or
  // two ahead of `pages_crawled` on a crawl that is still settling. That is not
  // a discovery about the site.
  assert.equal(K.issueCountFor('canonical', 122, 120), 0);
});

test('the SAME ten inversions are applied to the page-level booleans', () => {
  const [bad, good] = PAGE_ROWS.map(N.normalisePage);

  /**
   * `checks.canonical === true` means the page HAS one. A failure list built by
   * collecting the `true`s would report every correctly-configured page as
   * failing — the domain-level trap again, in a different data type, which is
   * why `isFailingCheck` is shared between the two readings.
   */
  assert.deepEqual(bad.failingChecks.sort(), [
    'canonical',
    'meta_charset_consistency',
    'no_description',
    'no_image_alt',
  ]);
  assert.equal(bad.failingCount, 4);

  // The healthy page passes every positive check and fails nothing.
  assert.deepEqual(good.failingChecks, []);
  assert.equal(good.failingCount, 0);
});

test('a counter nobody has classified is SHOWN as an unclassified notice, not dropped', () => {
  const issues = N.issuesFrom(SUMMARY, PAGES_CRAWLED);
  const unknown = issues.find((i) => i.key === 'something_they_added_in_2027');

  assert.ok(unknown, 'an unrecognised counter must still reach the screen');
  assert.equal(unknown.known, false);
  assert.equal(unknown.severity, 'notice');
  assert.equal(unknown.weight, 0);
  assert.equal(unknown.pages, 5);
  assert.equal(unknown.label, 'Something they added in 2027');

  // And every counter we DO know is flagged as known, so the screen can say
  // which findings nobody has looked at.
  assert.equal(issues.find((i) => i.key === 'canonical').known, true);
});

test('an aliased counter produces ONE row, not two', () => {
  // The summary carries `page_metrics.duplicate_title` AND
  // `page_metrics.checks.duplicate_title_tag`. They are one finding.
  const issues = N.issuesFrom(SUMMARY, PAGES_CRAWLED);
  assert.equal(issues.filter((i) => i.key === 'duplicate_title').length, 1);
  assert.equal(issues.filter((i) => i.key === 'duplicate_title_tag').length, 0);
  assert.equal(issues.find((i) => i.key === 'duplicate_title').pages, 12);
});

test('`links_internal` and `onpage_score` are not issue counts and never appear as findings', () => {
  const issues = N.issuesFrom(SUMMARY, PAGES_CRAWLED);
  for (const key of ['links_internal', 'links_external', 'onpage_score', 'checks']) {
    assert.equal(
      issues.some((i) => i.key === key),
      false,
      `${key} is on page_metrics and is not a problem`
    );
  }
  // Five thousand internal links would otherwise be the site's largest issue.
  assert.equal(K.TOP_LEVEL_COUNTERS.includes('links_internal'), false);
});

test('a null counter stays null and is not counted as a finding', () => {
  const issues = N.issuesFrom(SUMMARY, PAGES_CRAWLED);
  const spelling = issues.find((i) => i.key === 'has_misspelling');
  assert.ok(spelling);
  assert.equal(spelling.rawCount, null);
  assert.equal(spelling.pages, null);
  // "No misspellings were found" and "we did not look" are opposite facts.
  assert.equal(
    N.issueTotalsFrom(issues).notice.findings > 0,
    true,
    'other notices still count'
  );
});

// ---------------------------------------------------------------------------
// 2. Ordering, buckets and the score
// ---------------------------------------------------------------------------

test('issues are ordered by weight x share, so a notice never outranks a weighted issue', () => {
  const issues = N.issuesFrom(SUMMARY, PAGES_CRAWLED);

  const canonicalToBroken = issues.findIndex((i) => i.key === 'canonical_to_broken');
  const canonical = issues.findIndex((i) => i.key === 'canonical');

  // Eight canonicals pointing at broken pages (an error) above twenty-four pages
  // with no canonical at all (a notice) — which is what "sort by actual score
  // impact" means and is the opposite of sorting by affected pages.
  assert.ok(
    canonicalToBroken < canonical,
    'the weighted error must sort above the higher-count notice'
  );

  const impact = (key) => issues.find((i) => i.key === key).impact;
  // weight 9 x (8 / 120)
  assert.equal(impact('canonical_to_broken'), 0.6);
  // weight 8 x (64 / 120)
  assert.equal(impact('no_image_alt'), 4.267);
  // Notices carry no weight, so they carry no impact.
  assert.equal(impact('canonical'), 0);
});

test('the bucket totals separate FINDINGS from PAGES and exclude the mirrored counters', () => {
  const issues = N.issuesFrom(SUMMARY, PAGES_CRAWLED);
  const totals = N.issueTotalsFrom(issues);

  // `is_https` inverted is the same population as `is_http`, which carries the
  // weight — counted in both, the error bucket would double it.
  assert.equal(issues.find((i) => i.key === 'is_https').mirrors, 'is_http');
  assert.equal(issues.find((i) => i.key === 'has_meta_title').mirrors, 'no_title');

  // `no_title` (7) + high_loading_time (4) + canonical_to_broken (8)
  // + recursive_canonical (2) + links_relation_conflict (1) = 22
  assert.equal(totals.error.pages, 22);
  assert.equal(totals.error.findings, 5);

  assert.ok(totals.warning.pages > 0);
  assert.ok(totals.notice.pages > 0);
});

test('`onpage_score` is carried VERBATIM and is never recomputed from our weights', () => {
  const data = N.aggregateAudit({
    summaryRow: SUMMARY,
    pageRows: PAGE_ROWS,
    config: C.ONPAGE_CRAWL_CONFIG,
    domain: 'acme.com',
    collectedAt: NOW,
  });
  assert.equal(data.totals.onpageScore, 82.53);
});

test('the catalog sums to the published denominators, which is what makes the weights honest', () => {
  const sum = (severity) =>
    K.CHECKS.filter((c) => c.severity === severity).reduce((n, c) => n + c.weight, 0);
  const count = (severity) => K.CHECKS.filter((c) => c.severity === severity).length;

  // DataForSEO publish `Sc = 100 - SUM(En/78)x55 - SUM(Wn/123)x45`, twelve
  // weighted errors and twenty-two weighted warnings. Six individual weights are
  // theirs; the rest are ours and are used only for ORDERING. Pinning the sums
  // is what stops the ours drifting into a shape that no longer matches their
  // formula.
  assert.equal(sum('error'), K.ERROR_WEIGHT_TOTAL);
  assert.equal(sum('warning'), K.WARNING_WEIGHT_TOTAL);
  assert.equal(count('error'), 12);
  assert.equal(count('warning'), 22);
  assert.equal(sum('notice'), 0, 'notices do not move the score');

  // The six they publish, marked so a reader can tell ours from theirs.
  const verified = K.CHECKS.filter((c) => c.verified).map((c) => [c.key, c.weight]);
  assert.deepEqual(verified.sort(), [
    ['broken_resources', 10],
    ['canonical_to_broken', 9],
    ['duplicate_description', 9],
    ['duplicate_title', 10],
    ['high_loading_time', 10],
    ['is_http', 8],
    ['large_page_size', 10],
    ['no_image_alt', 8],
    ['no_title', 7],
    ['recursive_canonical', 9],
    ['redirect_loop', 10],
  ].sort());
});

// ---------------------------------------------------------------------------
// 3. Sample size — the second trap
// ---------------------------------------------------------------------------

test('the crawl configuration is stored WHOLE and hashed onto every reading', () => {
  const data = N.aggregateAudit({
    summaryRow: SUMMARY,
    pageRows: PAGE_ROWS,
    config: C.ONPAGE_CRAWL_CONFIG,
    domain: 'acme.com',
    collectedAt: NOW,
  });

  assert.equal(data.config.max_crawl_pages, C.ONPAGE_MAX_CRAWL_PAGES);
  assert.equal(data.configHash, N.configHashFor(C.ONPAGE_CRAWL_CONFIG));
  assert.equal(data.configHash.length, 16);
});

test('the hash ignores key order and changes with the crawl size', () => {
  const a = { max_crawl_pages: 1000, respect_sitemap: true, check_spell: true };
  const b = { check_spell: true, max_crawl_pages: 1000, respect_sitemap: true };
  assert.equal(N.configHashFor(a), N.configHashFor(b), 'key order is not a configuration');

  // THE ONE THAT MATTERS. `onpage_score` normalises by N/Ntotal, so a crawl of
  // 100 pages and a crawl of 1,000 produce different scores for the same site.
  assert.notEqual(
    N.configHashFor(a),
    N.configHashFor({ ...a, max_crawl_pages: 100 }),
    'the crawl size is part of what a score means'
  );
  // And so does any rendering flag, because they change what was measured.
  assert.notEqual(
    N.configHashFor(a),
    N.configHashFor({ ...a, enable_browser_rendering: true })
  );
});

test('a crawl that stopped early is stored as PARTIAL, so it can never become a baseline', async () => {
  const job = { items: [{ externalId: 'crawl-1', collected: false }], save: async () => {} };
  const stub = stubClient({
    summary: { ...SUMMARY, crawl_stop_reason: 'limit_exceeded' },
  });

  const originalClose = T.closeJob;
  T.closeJob = async () => job;
  try {
    const out = await collectCrawlJob({
      client: stub.client,
      job,
      kind: KIND,
      project: project(),
      now: NOW,
    });
    /**
     * `connectorDataController` only ever takes an `ok` reading as the previous
     * one, so `partial` is what keeps a truncated crawl out of every comparison
     * without a second mechanism to remember.
     */
    assert.equal(out.status, 'partial');
    assert.match(out.note, /stopped early \(limit_exceeded\)/);
    assert.equal(out.data.crawl.stopReason, 'limit_exceeded');
  } finally {
    T.closeJob = originalClose;
  }
});

// ---------------------------------------------------------------------------
// 4. Core Web Vitals — lab data, no INP, and a retired FID
// ---------------------------------------------------------------------------

test('the vitals are LAB data, carry no field data, and have no INP at all', () => {
  const pages = PAGE_ROWS.map(N.normalisePage);
  const vitals = N.coreWebVitals(pages, C.ONPAGE_CRAWL_CONFIG);

  assert.equal(vitals.source, 'lab');
  /**
   * There is no CrUX and no field data anywhere in this API — verified three
   * ways in the research note. Presented under "Core Web Vitals" without that
   * said out loud, these read as the numbers Google ranks on.
   */
  assert.equal(vitals.fieldDataAvailable, false);
  /** INP replaced FID as a Core Web Vital in March 2024 and is not in this API. */
  assert.equal(vitals.inpAvailable, false);
  assert.equal('inp' in vitals, false);
  /** DataForSEO still report FID. Carried, and flagged as the legacy metric. */
  assert.equal(vitals.fid.retired, true);
});

test('with browser rendering off every vital is NULL, not a perfect zero', () => {
  const pages = PAGE_ROWS.map(N.normalisePage);
  const vitals = N.coreWebVitals(pages, C.ONPAGE_CRAWL_CONFIG);

  assert.equal(vitals.browserRendering, false);
  /**
   * DataForSEO return 0 for LCP, FID and CLS without browser rendering. Rendered
   * as figures, "CLS 0.00" is a perfect score awarded for not looking — and CLS
   * is the one where zero is a legitimate value, so a reader cannot tell.
   */
  assert.equal(vitals.lcp.p75, null);
  assert.equal(vitals.cls.p75, null);
  assert.equal(vitals.fid.p75, null);
  assert.equal(vitals.lcp.measured, false);
  assert.equal(vitals.measuredPages, 0);
  assert.match(vitals.note, /Browser rendering was off/);
});

test('CLS is read from `meta` and LCP/FID from `page_timing` — their arrangement, not ours', () => {
  const page = N.normalisePage({
    meta: { cumulative_layout_shift: 0.24 },
    page_timing: { largest_contentful_paint: 3100, first_input_delay: 90 },
  });
  assert.equal(page.cumulativeLayoutShift, 0.24);
  assert.equal(page.largestContentfulPaint, 3100);
  assert.equal(page.firstInputDelay, 90);
});

test('when rendering IS on the vitals are the 75th percentile, not a mean', () => {
  // A hypothetical, because nothing this provider ships ever enables it — the
  // maths still has to be right the day somebody does.
  const rendered = { ...C.ONPAGE_CRAWL_CONFIG, [C.BROWSER_RENDERING_KEY]: true };
  const pages = [1000, 2000, 3000, 9000].map((lcp) => ({
    largestContentfulPaint: lcp,
    cumulativeLayoutShift: 0.1,
    firstInputDelay: 10,
  }));
  const vitals = N.coreWebVitals(pages, rendered);

  // A mean would be 3,750 and would hide the slow tail the threshold exists for.
  assert.equal(vitals.lcp.p75, 3000);
  assert.equal(vitals.lcp.measured, true);
  assert.equal(vitals.measuredPages, 4);
  assert.equal(vitals.note, '');
});

// ---------------------------------------------------------------------------
// 5. The 34x guard
// ---------------------------------------------------------------------------

test('`enable_browser_rendering` THROWS rather than being stripped, and names the multiplier', () => {
  assert.throws(
    () =>
      guardBrowserRendering({
        endpoint: C.ENDPOINT_ONPAGE_TASK_POST,
        payload: { target: 'acme.com', [C.BROWSER_RENDERING_KEY]: true },
      }),
    /34x the base crawl price/
  );

  // A stripped flag turns a deliberate change into a feature that mysteriously
  // does not work; the next person adds it again somewhere the strip misses.
  const payload = { target: 'acme.com', [C.BROWSER_RENDERING_KEY]: false };
  assert.deepEqual(guardBrowserRendering({ endpoint: 'x', payload }), payload);
});

test('nothing this provider builds carries the 34x flag, and the config says so out loud', () => {
  const payload = crawlPayloadFor({ domain: 'acme.com', tag: 't' });

  // Present and FALSE rather than absent: an absent key reads as "nobody thought
  // about it" and a false reads as "this was decided".
  assert.equal(payload[C.BROWSER_RENDERING_KEY], false);
  assert.equal(payload[C.ONPAGE_JAVASCRIPT_KEY], false);
  assert.equal(payload[C.ONPAGE_LOAD_RESOURCES_KEY], false);
  assert.equal(payload[C.ONPAGE_KEYWORD_DENSITY_KEY], false);

  // The two that are free and are ON.
  assert.equal(payload.respect_sitemap, true, 'the only way is_orphan_page means anything');
  assert.equal(payload.check_spell, true, 'without it has_misspelling is null, not zero');

  const plan = crawlPlan({ session, kind: KIND, project: project(), requestHash: 'h', attempt: 1 });
  for (const batch of plan.batches) {
    for (const task of batch.payload) {
      assert.notEqual(task[C.BROWSER_RENDERING_KEY], true);
    }
  }
});

// ---------------------------------------------------------------------------
// 6. The money
// ---------------------------------------------------------------------------

test('the crawl is reserved against the CEILING, because the refund only lands at settle', () => {
  const { estimateUsd, pageUsd, multiplier } = P.onpageEstimateFor({
    quota: null,
    endpoint: C.ENDPOINT_ONPAGE_TASK_POST,
    pages: C.ONPAGE_MAX_CRAWL_PAGES,
    config: C.ONPAGE_CRAWL_CONFIG,
  });

  assert.equal(pageUsd, C.ONPAGE_PAGE_USD);
  assert.equal(multiplier, 1);
  // 1,000 x $0.00015. A forty-page site is charged for forty and the difference
  // comes back through the envelope's own `cost` at settle.
  assert.equal(estimateUsd, 0.15);

  const plan = crawlPlan({ session, kind: KIND, project: project(), requestHash: 'h', attempt: 1 });
  assert.equal(plan.estimateUsd, 0.15);
});

test('the multipliers do not compound — browser rendering SUBSUMES the other two', () => {
  // 34 x 10 x 3 would be 1,020x, which over-reserves by a hundredfold and
  // therefore refuses collections the monthly cap actually allows.
  assert.equal(
    P.crawlMultiplier({
      [C.BROWSER_RENDERING_KEY]: true,
      [C.ONPAGE_JAVASCRIPT_KEY]: true,
      [C.ONPAGE_LOAD_RESOURCES_KEY]: true,
    }),
    34
  );
  assert.equal(P.crawlMultiplier({ [C.ONPAGE_LOAD_RESOURCES_KEY]: true }), 3);
  assert.equal(P.crawlMultiplier(C.ONPAGE_CRAWL_CONFIG), 1);

  // And the estimate follows a config change, so a cap holds on the first crawl
  // after somebody turns one on rather than after the invoice arrives.
  assert.equal(
    P.onpageEstimateFor({
      quota: null,
      endpoint: C.ENDPOINT_ONPAGE_TASK_POST,
      pages: 1000,
      config: { [C.BROWSER_RENDERING_KEY]: true },
    }).estimateUsd,
    5.1
  );
});

test('the crawl plan buys ONE call and no cross-tenant probe', () => {
  const plan = crawlPlan({ session, kind: KIND, project: project(), requestHash: 'h', attempt: 1 });
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].payload.length, 1);
  assert.equal(plan.batches[0].endpoint, C.ENDPOINT_ONPAGE_TASK_POST);
  // Phase 11 is about two tenants tracking the same KEYWORD. A crawl of
  // somebody's website is not a public fact that could ever be shared.
  assert.equal(plan.probe, null);
  assert.deepEqual(plan.units, ['acme.com']);
});

// ---------------------------------------------------------------------------
// 7. Shape: transport, family, variant scope, cadence
// ---------------------------------------------------------------------------

test('site_audit is a TASK kind in the onpage family, and the only one', () => {
  assert.equal(KIND.transport, 'task');
  assert.equal(KIND.family, 'onpage');
  assert.equal(KIND.postEndpoint, C.ENDPOINT_ONPAGE_TASK_POST);
  assert.equal(KIND.getEndpoint, C.ENDPOINT_ONPAGE_SUMMARY);

  /**
   * ONE kind, deliberately. Backlinks is four because on that API the CALLS are
   * the bill; here the CRAWL is the bill and every result endpoint is free, so a
   * second kind would buy a second crawl to draw a second panel.
   */
  assert.deepEqual(
    KINDS.filter((k) => k.family === 'onpage').map((k) => k.key),
    ['site_audit']
  );
});

test('a crawl is DOMAIN-scoped: four targets buy one crawl, not four', () => {
  const { variants } = variantsFor('site_audit', project());
  assert.equal(variants.length, 1);
  assert.equal(variants[0].key, VARIANT_KEY);

  // The crawl payload carries no locale and no browser preset, which is what
  // makes `domain` correct rather than convenient.
  const payload = crawlPayloadFor({ domain: 'acme.com', tag: 't' });
  for (const key of ['location_code', 'language_code', 'device', 'browser_preset']) {
    assert.equal(key in payload, false, `${key} must not be on a crawl payload`);
  }

  const descriptor = require('./index');
  assert.equal(descriptor.sameVariant('site_audit', VARIANT_KEY, '2840|en|desktop'), true);
});

test('the cadence is monthly and the rebuy floor sits under it', () => {
  assert.equal(KIND.intervalHours, 720);
  assert.equal(KIND.minRebuyHours, 600);
  assert.ok(KIND.minRebuyHours < KIND.intervalHours);

  // A reading three days old refuses a re-buy; one twenty-six days old allows it.
  assert.equal(
    T.rebuyGuard(KIND, { fetchedAt: new Date('2026-08-31T10:00:00Z') }, NOW).refuse,
    true
  );
  assert.equal(
    T.rebuyGuard(KIND, { fetchedAt: new Date('2026-08-06T10:00:00Z') }, NOW).refuse,
    false
  );
});

test('a crawl gets THREE TIMES the SERP expiry, because a crawl is not a query', () => {
  // Expiring at twelve hours abandons a crawl that is still running and buys a
  // second one — the double charge the expiry mechanism exists to bound,
  // arrived at through the safety valve.
  assert.equal(KIND.expiryHours, C.ONPAGE_EXPIRY_HOURS);
  assert.equal(C.ONPAGE_EXPIRY_HOURS, 36);
  assert.ok(C.ONPAGE_EXPIRY_HOURS > C.TASK_EXPIRY_HOURS);
});

test('the screen exists, draws this kind, and is not always-on', () => {
  const screen = SCREENS.find((s) => s.key === 'site_audit');
  assert.ok(screen);
  assert.deepEqual(screen.kinds, ['site_audit']);
  assert.equal(screen.alwaysOn, false);
  // Neither "live" nor "competitive index" — a crawl is neither.
  assert.doesNotMatch(screen.blurb, /\blive\b/i);
  assert.doesNotMatch(screen.blurb, /competitive index/i);
});

// ---------------------------------------------------------------------------
// 8. The pool, the allowlist and the dispatch
// ---------------------------------------------------------------------------

test('OnPage inherits the ONE shared pool and adds no limiter of its own', () => {
  /**
   * Labs, Backlinks and OnPage share DataForSEO's single ceiling of thirty. A
   * third limiter of twenty-five would be seventy-five in flight against it.
   */
  assert.ok(DB_BACKED_PREFIXES.includes('on_page/'));
  assert.equal(C.DB_BACKED_POOL_LIMIT, 25);
  assert.ok(C.DB_BACKED_POOL_LIMIT < C.DB_BACKED_SIMULTANEOUS_CEILING);

  const source = require('node:fs').readFileSync(`${__dirname}/onpage.js`, 'utf8');
  assert.equal(
    /new Semaphore|maxConcurrent|withSlot\(|createPool/.test(source),
    false,
    'onpage.js must not build a second pool'
  );
});

test('the collection pass may read a crawl and may NOT start one', async () => {
  // The free half.
  assert.equal(isFreeEndpoint(C.ENDPOINT_ONPAGE_SUMMARY), true);
  assert.equal(isFreeEndpoint(`${C.ENDPOINT_ONPAGE_SUMMARY}/crawl-1`), true);
  assert.equal(isFreeEndpoint(C.ENDPOINT_ONPAGE_PAGES), true);

  // The billable half. An ALLOWLIST is what makes this the default; a denylist
  // would have admitted it the day this phase landed.
  assert.equal(isFreeEndpoint(C.ENDPOINT_ONPAGE_TASK_POST), false);

  const wrapped = collectOnlyClient({ call: async () => ({}), send: async () => ({}) });
  await assert.rejects(
    () => wrapped.call(C.ENDPOINT_ONPAGE_TASK_POST, [{ target: 'acme.com' }]),
    /may not call on_page\/task_post/
  );
  // ...and the wrapper is still transparent to the free ones.
  await wrapped.call(`${C.ENDPOINT_ONPAGE_SUMMARY}/crawl-1`, null, { method: 'GET' });
});

test('the collector routes a crawl to the crawl reader and refuses to guess', () => {
  assert.notEqual(collectorFor('onpage'), collectorFor('serp'));
  /**
   * Handed to `collectJob`, a crawl would be polled on the SERP path and its
   * summary normalised as a SERP — producing an empty snapshot that then looks
   * current for a month. Nothing about that throws.
   */
  assert.equal(collectorFor('labs'), null);
  assert.equal(collectorFor('something_new'), null);
});

test('an unknown queued family THROWS rather than defaulting to the SERP builder', async () => {
  /**
   * A default here would send a crawl to the SERP builder, which chunks a
   * keyword list, posts it to `serp/.../task_post` and normalises the answer as
   * a SERP - spending money on the wrong endpoint and then writing an empty
   * snapshot. Phase 7 made the same argument for the live table and the
   * consequence is worse on this one, because this one can post.
   *
   * Asserted by temporarily giving the real kind a family nothing implements,
   * which is exactly the state a future kind added without a runner would be in.
   */
  const original = KIND.family;
  KIND.family = 'a_family_nobody_wrote';
  try {
    await assert.rejects(
      () =>
        fetchKind('site_audit', {
          session,
          // `runOnce` neutered: the reservation reconciler it drives is not what
          // this test is about and would sit on Mongoose's buffering timeout.
          client: { ...stubClient().client, runOnce: async () => null },
          project: project(),
          variant: { key: VARIANT_KEY, ...VARIANT },
          now: NOW,
        }),
      /No DataForSEO queued runner for the "a_family_nobody_wrote" family/
    );
  } finally {
    KIND.family = original;
  }
});

test('a crawl never reads the SERP announcement feed', async () => {
  /**
   * `tasks_ready` is `serp/google/organic/tasks_ready` and lists SERP task ids;
   * a crawl id will never appear in it. Reading it would spend a free call to
   * learn nothing and then hold the crawl behind `READY_GRACE_HOURS` before its
   * first poll.
   */
  resetPool();
  const store = stubStore();
  const stub = stubClient({ summary: IN_PROGRESS });
  const client = { ...stub.client, runOnce: async (_key, fn) => fn() };
  try {
    await fetchKind('site_audit', {
      session,
      client,
      project: project(),
      variant: { key: VARIANT_KEY, ...VARIANT },
      now: NOW,
    });
    assert.equal(
      stub.state.urls.some((u) => u.includes('tasks_ready')),
      false
    );
  } finally {
    store.restore();
  }
});

// ---------------------------------------------------------------------------
// 9. The lifecycle: buy once, poll for free
// ---------------------------------------------------------------------------

/**
 * A transport that answers the three OnPage endpoints and counts the posts.
 *
 * `posts` is the number that matters. It is the bill. Built through the REAL
 * `createDfsClient`, so every call travels the real status checking and the real
 * shared pool on its way out.
 */
function stubClient({ summary = SUMMARY, pages = PAGE_ROWS, failPages = false } = {}) {
  const state = { posts: 0, summaries: 0, pageReads: 0, urls: [] };

  const impl = async (url, init) => {
    state.urls.push(url);
    let body;

    if (url.includes('on_page/task_post')) {
      state.posts += 1;
      const sent = JSON.parse(init.body);
      body = {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.15,
        tasks_count: 1,
        tasks_error: 0,
        tasks: [
          {
            id: 'crawl-1',
            status_code: 20100,
            status_message: 'Task Created.',
            cost: 0.15,
            data: { tag: sent[0].tag, target: sent[0].target },
            result: null,
          },
        ],
      };
    } else if (url.includes('on_page/summary')) {
      state.summaries += 1;
      body = {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0,
        tasks_count: 1,
        tasks_error: 0,
        tasks: [
          { id: 'crawl-1', status_code: 20000, status_message: 'Ok.', cost: 0, result: [summary] },
        ],
      };
    } else if (url.includes('on_page/pages')) {
      state.pageReads += 1;
      if (failPages) throw new Error('pages read failed');
      body = {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0,
        tasks_count: 1,
        tasks_error: 0,
        tasks: [
          {
            id: 'crawl-1',
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0,
            result: [{ items: pages, items_count: pages.length }],
          },
        ],
      };
    } else {
      throw new Error(`unexpected URL ${url}`);
    }

    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  return { state, client: createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] }) };
}

/**
 * `DfsTask` and the budget, in memory — with THE PARTIAL UNIQUE INDEX enforced,
 * because it is the only real concurrency control in this design and a fake that
 * did not refuse the second insert would let every test pass while the real
 * thing double-charged.
 */
function stubStore() {
  const rows = [];
  let seq = 0;
  const same = (a, b) => String(a) === String(b);

  const originals = {
    create: DfsTask.create,
    findOne: DfsTask.findOne,
    find: DfsTask.find,
    updateOne: DfsTask.updateOne,
    scopesFor: Budget.scopesFor,
    reserveAll: B.reserveAll,
    settleAll: B.settleAll,
  };

  DfsTask.create = async (input) => {
    if (
      input.state === 'open' &&
      rows.some(
        (r) =>
          r.state === 'open' &&
          same(r.project, input.project) &&
          r.kind === input.kind &&
          r.variant === input.variant
      )
    ) {
      const err = new Error('E11000 duplicate key error collection: dfstasks');
      err.code = 11000;
      throw err;
    }
    const row = { _id: `dfs-${(seq += 1)}`, costUsd: 0, items: [], ...input };
    row.save = async () => row;
    rows.push(row);
    return row;
  };

  const thenable = (value) => {
    const self = {
      sort: () => self,
      select: () => self,
      limit: () => self,
      lean: () => Promise.resolve(value),
      then: (res, rej) => Promise.resolve(value).then(res, rej),
    };
    return self;
  };

  const matches = (row, filter) =>
    Object.entries(filter).every(([key, want]) => {
      const got = row[key];
      if (want && typeof want === 'object' && '$in' in want) {
        return want.$in.some((v) => same(v, got));
      }
      return same(want, got);
    });

  DfsTask.findOne = (filter) =>
    thenable([...rows].reverse().find((r) => matches(r, filter)) || null);
  DfsTask.find = (filter) => thenable(rows.filter((r) => matches(r, filter)));
  DfsTask.updateOne = async (filter, update) => {
    const row = rows.find((r) => matches(r, filter));
    if (!row) return { acknowledged: true, matchedCount: 0 };
    for (const [k, v] of Object.entries(update.$set || {})) row[k] = v;
    for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
    for (const [k, v] of Object.entries(update.$push || {})) {
      row[k] = [...(row[k] || []), ...(v.$each || [v])];
    }
    return { acknowledged: true, matchedCount: 1 };
  };

  const reserved = [];
  const settled = [];
  Budget.scopesFor = async () => [
    {
      organisation: 'org-1',
      provider: 'dataforseo',
      scope: 'org',
      scopeId: 'org-1',
      periodKey: '2026-09',
      capUsd: 5,
    },
  ];
  B.reserveAll = async ({ estimateUsd }) => {
    reserved.push(estimateUsd);
    return { ok: true };
  };
  B.settleAll = async ({ actualUsd }) => {
    settled.push(actualUsd);
    return { ok: true };
  };

  return {
    rows,
    reserved,
    settled,
    restore: () => {
      Object.assign(DfsTask, {
        create: originals.create,
        findOne: originals.findOne,
        find: originals.find,
        updateOne: originals.updateOne,
      });
      Budget.scopesFor = originals.scopesFor;
      B.reserveAll = originals.reserveAll;
      B.settleAll = originals.settleAll;
    },
  };
}

const run = (client, { now = NOW, force = false, proj = project() } = {}) =>
  runOnPageKind(KIND, {
    session,
    client,
    project: proj,
    variant: { key: VARIANT_KEY, ...VARIANT },
    now,
    force,
  });

test('the first tick orders ONE crawl; every later tick polls it for free', async () => {
  resetPool();
  const store = stubStore();
  const stub = stubClient({ summary: IN_PROGRESS });
  try {
    const first = await run(stub.client);
    assert.equal(first.status, 'pending');
    assert.equal(stub.state.posts, 1, 'the first tick orders exactly one crawl');
    assert.match(first.note, /crawl of up to 1000 pages was ordered/i);

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const again = await run(stub.client, { now: new Date(NOW.getTime() + (i + 1) * 3_600_000) });
      assert.equal(again.status, 'pending');
      assert.match(again.note, /still running/);
    }

    assert.equal(stub.state.posts, 1, 'five more hours of polling bought nothing');
    assert.equal(stub.state.summaries, 5);
    // `pages` is not read until the crawl is finished — read mid-crawl it would
    // be a snapshot of a partial site, scored as if it were the whole one.
    assert.equal(stub.state.pageReads, 0);
  } finally {
    store.restore();
  }
});

test('a finished crawl writes a reading dated from the crawl, not from when we asked', async () => {
  resetPool();
  const store = stubStore();
  const posting = stubClient({ summary: IN_PROGRESS });
  try {
    await run(posting.client);

    // Now it has finished. The SAME open row is polled.
    const done = stubClient();
    const out = await run(done.client, { now: new Date('2026-09-04T09:00:00Z') });

    assert.equal(done.state.posts, 0, 'collecting a finished crawl buys nothing');
    assert.equal(out.status, 'ok');
    assert.equal(out.data.totals.pagesCrawled, PAGES_CRAWLED);
    assert.equal(out.data.totals.onpageScore, 82.53);
    assert.equal(out.data.pages.length, 2);

    /**
     * `crawl_end`, not `now`. The reading is of the site AS IT WAS WHEN THE
     * CRAWL RAN, and on a crawl that took nine hours those are different days —
     * which is what `periodKey` is derived from.
     */
    assert.equal(out.collectedAt.toISOString(), '2026-09-03T04:41:12.000Z');

    const row = store.rows[0];
    assert.equal(row.state, 'done');
    assert.equal(row.periodKey, '2026-09-03');
  } finally {
    store.restore();
  }
});

test('the summary survives a failed page read, because the summary is the irreplaceable half', async () => {
  resetPool();
  const store = stubStore();
  const posting = stubClient({ summary: IN_PROGRESS });
  try {
    await run(posting.client);
    const done = stubClient({ failPages: true });
    const out = await run(done.client, { now: new Date('2026-09-04T09:00:00Z') });

    // The score, every counter and the whole issue list are on the summary. A
    // crawl already paid for must not be lost to a second free read failing.
    assert.equal(out.status, 'ok');
    assert.equal(out.data.totals.onpageScore, 82.53);
    assert.deepEqual(out.data.pages, []);
  } finally {
    store.restore();
  }
});

test('two processes racing one site order ONE crawl between them', async () => {
  resetPool();
  const store = stubStore();
  const stub = stubClient({ summary: IN_PROGRESS });
  try {
    const [a, b] = await Promise.all([run(stub.client), run(stub.client)]);
    assert.equal(stub.state.posts, 1, 'the partial unique index decided the winner');
    const notes = [a.note, b.note];
    assert.ok(notes.some((n) => /already queued/i.test(n)));
  } finally {
    store.restore();
  }
});

test('the rebuy floor and the budget stop both answer `pending`, never an account failure', async () => {
  resetPool();
  const store = stubStore();
  const stub = stubClient();
  try {
    // Collected two days ago against a 600-hour floor.
    const guarded = await runOnPageKind(KIND, {
      session,
      client: stub.client,
      project: project(),
      variant: { key: VARIANT_KEY, ...VARIANT },
      existing: { fetchedAt: new Date('2026-09-01T10:00:00Z') },
      now: NOW,
    });
    assert.equal(guarded.status, 'pending');
    assert.match(guarded.note, /available again in/);
    assert.equal(stub.state.posts, 0);

    // And the account-wide budget stop, which must not throw `quotaExhausted` —
    // that would break `syncAccount` out of the project loop and strand every
    // remaining site's FREE polls for crawls already paid for.
    const suppressed = {
      ...stub.client,
      postingSuppressed: () => true,
      postingSuppressedNote: () => 'Monthly budget reached.',
    };
    const stopped = await run(suppressed);
    assert.equal(stopped.status, 'pending');
    assert.equal(stopped.note, 'Monthly budget reached.');
    assert.equal(stub.state.posts, 0);
  } finally {
    store.restore();
  }
});

test('a site with no domain buys nothing and says why', async () => {
  const store = stubStore();
  const stub = stubClient();
  try {
    const out = await run(stub.client, { proj: project({ domain: '' }) });
    assert.equal(out.status, 'pending');
    assert.match(out.note, /no domain/);
    assert.equal(stub.state.posts, 0);
  } finally {
    store.restore();
  }
});

test('`pollCrawl` reports progress while the crawl runs and never invents a reading', async () => {
  resetPool();
  const stub = stubClient({ summary: IN_PROGRESS });
  const out = await pollCrawl({
    client: stub.client,
    job: { items: [{ externalId: 'crawl-1', collected: false }] },
    kind: KIND,
    now: NOW,
  });

  assert.equal(out.ready, false);
  assert.equal(out.failed, false);
  assert.match(out.note, /360 pages so far, 640 in the queue/);
  assert.equal(out.collectedAt, null);
});

test('a crawl payload asks for exactly the pinned configuration and nothing else', () => {
  const payload = crawlPayloadFor({ domain: 'acme.com', tag: 'abc.1.0' });
  assert.deepEqual(Object.keys(payload).sort(), [
    'calculate_keyword_density',
    'check_spell',
    'enable_browser_rendering',
    'enable_javascript',
    'load_resources',
    'max_crawl_pages',
    'respect_sitemap',
    'tag',
    'target',
  ]);
  assert.equal(payload.target, 'acme.com');
  assert.equal(payload.max_crawl_pages, C.ONPAGE_MAX_CRAWL_PAGES);
});

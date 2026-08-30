/**
 * The OnPage check catalog, and the one thing in this phase that ships nonsense
 * if it is read the obvious way.
 *
 * ---- THE POSITIVE CHECKS ----------------------------------------------------
 *
 * `page_metrics.checks` is an object of about sixty integer counters, and the
 * natural reading of every one of them is "how many pages have this problem".
 * That reading is WRONG for ten of them, and the ten are not marked in the
 * payload in any way.
 *
 *   canonical                              pages that HAVE a canonical
 *   is_https                               pages that ARE on https
 *   has_html_doctype                       pages that HAVE a doctype
 *   has_meta_title                         pages that HAVE a title tag
 *   meta_charset_consistency               pages whose charset AGREES
 *   seo_friendly_url                       pages whose URL IS friendly
 *   seo_friendly_url_characters_check      ... and its four sub-checks
 *   seo_friendly_url_dynamic_check
 *   seo_friendly_url_keywords_check
 *   seo_friendly_url_relative_length_check
 *
 * For these the issue count is `pagesCrawled - counter`, and getting it
 * backwards produces a number that is plausible, monotonic and invisible: a site
 * where every single page is on HTTPS reports `is_https: 120` out of 120 pages
 * and would be rendered as "120 pages with an HTTPS problem" — a perfect site
 * shown as the worst possible one, at the TOP of a list sorted by severity,
 * on a client report. Nothing in the payload contradicts it and no total fails
 * to add up.
 *
 * It is the same class of mistake as phase 7's dofollow subtraction, and it is
 * stopped the same way: the direction is DATA on the catalog entry below, the
 * arithmetic lives in exactly one function (`issueCountFor`), and the test that
 * covers it is built so the naive answer and the true answer are different
 * numbers on the same fixture.
 *
 * ---- The denominator can be missing, and then the answer is NULL ------------
 *
 * `pagesCrawled - counter` needs a denominator. A crawl that has not finished, a
 * `summary` read before any page was fetched, or a payload shape we misread all
 * produce a `pagesCrawled` of zero or undefined — and `0 - 96` is `-96`, which
 * would sort to the top of an ascending list and render as a negative issue
 * count. So an unusable denominator yields `null`, which the client renders as
 * an em dash, and never a number.
 *
 * ---- Weights: which of these are DataForSEO's and which are ours ------------
 *
 * DataForSEO publish the SCORING FORMULA and the two denominators —
 * `Sc = 100 - SUM(En/78)x55 - SUM(Wn/123)x45`, twelve weighted errors summing to
 * 78 and twenty-two weighted warnings summing to 123 — and they publish the
 * heaviest few of each - six errors and five warnings. Those ELEVEN weights were
 * verified from their documentation and are marked `verified: true` below.
 *
 * The rest are OURS. They are chosen to sum to the published denominators so the
 * ranking is internally consistent, and they are used for EXACTLY ONE thing:
 * ordering issues within a bucket by `weight x affectedPages / pagesCrawled`, so
 * that "eight broken canonicals" outranks "three hundred missing image titles".
 *
 * THEY ARE NEVER USED TO COMPUTE A SCORE. `onpage_score` is taken verbatim from
 * DataForSEO and never recomputed here — recomputing it from half-guessed
 * weights would produce a number that disagrees with their own dashboard and
 * looks authoritative. The screen labels the ordering as an ordering and the
 * score as theirs.
 *
 * ---- A counter we do not recognise is SHOWN, not dropped -------------------
 *
 * DataForSEO add checks. An unknown key becomes a notice with `known: false`, a
 * label humanised from the key, and no weight — so it appears on the screen as
 * an unclassified finding rather than disappearing. The residual risk is stated
 * rather than hidden: if a check they add later is a POSITIVE one, this file
 * will read it the naive way until somebody adds it below. `known: false` on
 * screen is the flag that says "nobody has looked at this one".
 */

/**
 * The ten counters that count SUCCESSES. Everything in this file turns on it.
 *
 * A `Set` rather than a flag on each row, deliberately: this is the list the
 * plan, the research note and the phase-7 handover all name, and a reader
 * checking that it is complete should be able to see all ten in one place rather
 * than grep for `positive: true` across sixty entries.
 */
const POSITIVE_CHECKS = new Set([
  'canonical',
  'is_https',
  'has_html_doctype',
  'has_meta_title',
  'meta_charset_consistency',
  'seo_friendly_url',
  'seo_friendly_url_characters_check',
  'seo_friendly_url_dynamic_check',
  'seo_friendly_url_keywords_check',
  'seo_friendly_url_relative_length_check',
]);

/**
 * Counters that live on `page_metrics` itself rather than inside `checks`.
 *
 * Picked by name rather than by "every number on the object", because
 * `page_metrics` also carries `onpage_score`, `links_internal` and
 * `links_external` — none of which are issue counts, and two of which would
 * otherwise be reported as tens of thousands of problems.
 */
const TOP_LEVEL_COUNTERS = [
  'broken_links',
  'broken_resources',
  'duplicate_title',
  'duplicate_description',
  'duplicate_content',
  'links_relation_conflict',
  'redirect_loop',
  'non_indexable',
];

/**
 * @typedef {Object} CheckSpec
 * @property {string} key
 * @property {'error'|'warning'|'notice'} severity
 * @property {number} weight   - ordering only. NEVER a score input.
 * @property {string} label
 * @property {boolean} [verified] - the weight is DataForSEO's published one
 * @property {string[]} [aliases] - other spellings of the same counter
 * @property {string} [mirrors]   - the counter that already carries these pages
 */

/** @type {CheckSpec[]} */
const CHECKS = [
  // ---- Errors. Twelve, summing to 78. --------------------------------------
  { key: 'high_loading_time', severity: 'error', weight: 10, verified: true, label: 'Slow to load' },
  { key: 'redirect_loop', severity: 'error', weight: 10, verified: true, label: 'Redirect loop' },
  {
    key: 'canonical_to_broken',
    severity: 'error',
    weight: 9,
    verified: true,
    label: 'Canonical points at a broken page',
  },
  {
    key: 'recursive_canonical',
    severity: 'error',
    weight: 9,
    verified: true,
    label: 'Recursive canonical',
  },
  {
    /**
     * The negative twin of `is_https`, and the reason `is_https` below carries
     * no weight of its own: the same pages would be counted twice in the error
     * bucket, once directly and once through the inversion.
     */
    key: 'is_http',
    severity: 'error',
    weight: 8,
    verified: true,
    label: 'Served over HTTP',
  },
  { key: 'no_title', severity: 'error', weight: 7, verified: true, label: 'No title tag' },
  { key: 'is_4xx_code', severity: 'error', weight: 6, label: 'Returns 4xx' },
  { key: 'is_5xx_code', severity: 'error', weight: 6, label: 'Returns 5xx' },
  { key: 'is_broken', severity: 'error', weight: 5, label: 'Broken page' },
  {
    key: 'canonical_to_redirect',
    severity: 'error',
    weight: 4,
    label: 'Canonical points at a redirect',
  },
  { key: 'no_content_encoding', severity: 'error', weight: 2, label: 'No content encoding' },
  {
    key: 'links_relation_conflict',
    severity: 'error',
    weight: 2,
    label: 'Conflicting link relations',
    aliases: ['is_link_relation_conflict'],
  },

  // ---- Warnings. Twenty-two, summing to 123. -------------------------------
  {
    key: 'duplicate_title',
    severity: 'warning',
    weight: 10,
    verified: true,
    label: 'Duplicate title',
    aliases: ['duplicate_title_tag'],
  },
  {
    key: 'broken_resources',
    severity: 'warning',
    weight: 10,
    verified: true,
    label: 'Broken resources',
  },
  {
    key: 'large_page_size',
    severity: 'warning',
    weight: 10,
    verified: true,
    label: 'Large page',
  },
  {
    key: 'duplicate_description',
    severity: 'warning',
    weight: 9,
    verified: true,
    label: 'Duplicate description',
  },
  { key: 'no_image_alt', severity: 'warning', weight: 8, verified: true, label: 'Images with no alt text' },
  { key: 'duplicate_content', severity: 'warning', weight: 9, label: 'Duplicate content' },
  { key: 'broken_links', severity: 'warning', weight: 8, label: 'Broken links' },
  { key: 'no_description', severity: 'warning', weight: 8, label: 'No meta description' },
  { key: 'no_h1_tag', severity: 'warning', weight: 7, label: 'No H1' },
  { key: 'low_content_rate', severity: 'warning', weight: 6, label: 'Very little text' },
  { key: 'title_too_long', severity: 'warning', weight: 5, label: 'Title too long' },
  { key: 'title_too_short', severity: 'warning', weight: 5, label: 'Title too short' },
  {
    key: 'has_links_to_redirects',
    severity: 'warning',
    weight: 4,
    label: 'Links to redirects',
  },
  {
    key: 'https_to_http_links',
    severity: 'warning',
    weight: 4,
    label: 'HTTPS page links to HTTP',
  },
  { key: 'no_favicon', severity: 'warning', weight: 3, label: 'No favicon' },
  { key: 'no_image_title', severity: 'warning', weight: 3, label: 'Images with no title' },
  { key: 'irrelevant_title', severity: 'warning', weight: 3, label: 'Title does not match the content' },
  {
    key: 'irrelevant_description',
    severity: 'warning',
    weight: 3,
    label: 'Description does not match the content',
  },
  {
    key: 'irrelevant_meta_keywords',
    severity: 'warning',
    weight: 2,
    label: 'Meta keywords do not match the content',
  },
  { key: 'deprecated_html_tags', severity: 'warning', weight: 2, label: 'Deprecated HTML tags' },
  { key: 'frame', severity: 'warning', weight: 2, label: 'Uses frames' },
  { key: 'flash', severity: 'warning', weight: 2, label: 'Uses Flash' },

  // ---- Notices. No weight; they do not move the score. ---------------------
  {
    /**
     * POSITIVE. Its inverted count is the same population as `is_http` above,
     * which carries the weight — so this one is a notice with none, and the two
     * are cross-checked against each other in the tests. Keeping both on screen
     * is deliberate: one answers "how many pages are insecure" and the other
     * "how many are secure", and a reader looking for the second should not have
     * to do the subtraction that this file exists to get right.
     */
    key: 'is_https',
    severity: 'notice',
    weight: 0,
    label: 'Not served over HTTPS',
    mirrors: 'is_http',
  },
  { key: 'canonical', severity: 'notice', weight: 0, label: 'No canonical tag' },
  { key: 'has_html_doctype', severity: 'notice', weight: 0, label: 'No doctype' },
  { key: 'has_meta_title', severity: 'notice', weight: 0, label: 'No meta title', mirrors: 'no_title' },
  {
    key: 'meta_charset_consistency',
    severity: 'notice',
    weight: 0,
    label: 'Charset declaration disagrees with the response',
  },
  { key: 'seo_friendly_url', severity: 'notice', weight: 0, label: 'URL is not SEO friendly' },
  {
    key: 'seo_friendly_url_characters_check',
    severity: 'notice',
    weight: 0,
    label: 'URL has unfriendly characters',
  },
  {
    key: 'seo_friendly_url_dynamic_check',
    severity: 'notice',
    weight: 0,
    label: 'URL is dynamic',
  },
  {
    key: 'seo_friendly_url_keywords_check',
    severity: 'notice',
    weight: 0,
    label: 'URL carries no keywords',
  },
  {
    key: 'seo_friendly_url_relative_length_check',
    severity: 'notice',
    weight: 0,
    label: 'URL path is very long',
  },
  { key: 'is_redirect', severity: 'notice', weight: 0, label: 'Redirects' },
  { key: 'is_www', severity: 'notice', weight: 0, label: 'On the www host' },
  { key: 'is_orphan_page', severity: 'notice', weight: 0, label: 'Orphan page (in the sitemap, linked from nowhere)' },
  { key: 'high_waiting_time', severity: 'notice', weight: 0, label: 'Slow first byte' },
  { key: 'small_page_size', severity: 'notice', weight: 0, label: 'Very small page' },
  { key: 'size_greater_than_3mb', severity: 'notice', weight: 0, label: 'Over 3 MB' },
  { key: 'duplicate_meta_tags', severity: 'notice', weight: 0, label: 'Duplicate meta tags' },
  { key: 'no_encoding_meta_tag', severity: 'notice', weight: 0, label: 'No encoding meta tag' },
  { key: 'has_meta_refresh_redirect', severity: 'notice', weight: 0, label: 'Meta refresh redirect' },
  { key: 'lorem_ipsum', severity: 'notice', weight: 0, label: 'Placeholder text' },
  { key: 'non_indexable', severity: 'notice', weight: 0, label: 'Not indexable' },
  {
    /**
     * NULL rather than zero unless `check_spell: true` was sent on the crawl —
     * which it is, and this comment is why. A counter that is null for a
     * configuration reason renders as "no misspellings found" if it is coerced,
     * so the normaliser keeps null as null everywhere and the screen shows an
     * em dash.
     */
    key: 'has_misspelling',
    severity: 'notice',
    weight: 0,
    label: 'Misspellings',
  },
];

const BY_KEY = new Map();
for (const spec of CHECKS) {
  BY_KEY.set(spec.key, spec);
  for (const alias of spec.aliases || []) BY_KEY.set(alias, spec);
}

/** The published denominators. Asserted against the catalog in the tests. */
const ERROR_WEIGHT_TOTAL = 78;
const WARNING_WEIGHT_TOTAL = 123;

/** `no_image_alt` -> "No image alt", for a counter nobody has classified yet. */
const humanise = (key) =>
  String(key || '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

/** @param {string} key @returns {CheckSpec|null} */
const getCheck = (key) => BY_KEY.get(key) || null;

/** @param {string} key @returns {boolean} */
const isPositiveCheck = (key) => POSITIVE_CHECKS.has(String(key));

/**
 * HOW MANY PAGES HAVE THIS PROBLEM — the whole of the trap, in one function.
 *
 * There is deliberately no second place in this codebase where a counter is
 * turned into an issue count. Two implementations of this is how one panel and
 * one export disagree about whether a site has 24 canonical problems or 96, and
 * both look right.
 *
 * @param {string} key
 * @param {number|null} count - the raw counter DataForSEO returned
 * @param {number|null} pagesCrawled - the denominator, and it may be missing
 * @returns {number|null} pages affected, or null when it cannot be known
 */
const issueCountFor = (key, count, pagesCrawled) => {
  if (typeof count !== 'number' || !Number.isFinite(count)) return null;

  if (!isPositiveCheck(key)) return Math.max(0, Math.round(count));

  /**
   * A POSITIVE counter with no denominator is not zero and it is not the count
   * either — it is unknown. `0 - 96` would render as -96 and sort to the top of
   * an ascending list; `96` would render a perfect site as the worst one.
   */
  if (typeof pagesCrawled !== 'number' || !Number.isFinite(pagesCrawled) || pagesCrawled <= 0) {
    return null;
  }

  /**
   * Clamped at zero rather than allowed negative. DataForSEO count pages in
   * `crawl_status.pages_crawled` and evaluate checks over the pages they
   * actually parsed, so a counter can legitimately exceed the denominator by a
   * page or two on a crawl that was still finishing. A small negative is that,
   * not a discovery.
   */
  return Math.max(0, Math.round(pagesCrawled) - Math.round(count));
};

/**
 * Everything the summary counted, in one flat map.
 *
 * `checks` wins over the top-level counters on a name collision, because it is
 * the object DataForSEO document as the check set and the top-level fields are
 * conveniences that duplicate some of it.
 *
 * @param {Object|null} pageMetrics - `summary.page_metrics`
 * @returns {Object<string, number>}
 */
const countersFrom = (pageMetrics) => {
  const out = {};
  const metrics = pageMetrics && typeof pageMetrics === 'object' ? pageMetrics : {};

  for (const key of TOP_LEVEL_COUNTERS) {
    const value = metrics[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }

  const checks = metrics.checks && typeof metrics.checks === 'object' ? metrics.checks : {};
  for (const [key, value] of Object.entries(checks)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (value === null) out[key] = null;
  }

  return out;
};

/**
 * Is this page-level boolean a FAILURE?
 *
 * The page rows carry the same check names as booleans, and the same ten are
 * inverted there too: `checks.canonical === true` means the page HAS one, which
 * is good. Sharing `isPositiveCheck` between the two readings is the point —
 * a page-level list of failures built from its own hardcoded set would be a
 * second copy of the trap, drifting from the first.
 *
 * @param {string} key
 * @param {boolean|null} value
 * @returns {boolean}
 */
const isFailingCheck = (key, value) => {
  if (typeof value !== 'boolean') return false;
  return isPositiveCheck(key) ? value === false : value === true;
};

module.exports = {
  CHECKS,
  POSITIVE_CHECKS,
  TOP_LEVEL_COUNTERS,
  ERROR_WEIGHT_TOTAL,
  WARNING_WEIGHT_TOTAL,
  getCheck,
  isPositiveCheck,
  issueCountFor,
  countersFrom,
  isFailingCheck,
  humanise,
};

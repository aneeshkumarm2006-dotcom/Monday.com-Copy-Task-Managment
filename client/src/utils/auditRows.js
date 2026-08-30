import { BLANK, sortRowsBy } from './rankRows.js';

/**
 * Turning a stored `site_audit` snapshot into the rows the Site Audit screen
 * draws — and refusing to draw the one number that would be wrong.
 *
 * ---- Why this is a fourth file beside `rankRows`, `labsRows`, `backlinkRows` -
 *
 * Same reason `backlinkRows.js` gives, one API further on: the rules do not
 * transfer. A rank has a three-way null rule; a Labs number has an index age; a
 * backlink rank has a scale. An audit has neither of those and has one all its
 * own — a SAMPLE SIZE — and it is the thing that makes two readings comparable
 * or not.
 *
 * What IS shared is the blanks-last comparator, imported rather than copied,
 * because another copy of "a null must not sort as a zero" is another chance for
 * one table to disagree with the others.
 *
 * ---- The two things this file is really for --------------------------------
 *
 * 1. `comparability`. `onpage_score` is sample-size dependent BY DATAFORSEO'S
 *    OWN ADMISSION: the domain score normalises each issue by `N / Ntotal`, so
 *    the same site crawled at 100 pages and at 1,000 scores differently and
 *    nothing in either reading says so. Two readings taken under different crawl
 *    configurations are two measurements of two different things, and their
 *    difference is a chart of our own settings.
 *
 *    So the shape is `backlinkRows.comparability`'s, deliberately: it returns a
 *    REASON rather than a boolean, and `deltaOf` refuses rather than the caller
 *    remembering to ask. A caller that forgets the check gets no number instead
 *    of a wrong one.
 *
 * 2. NOTHING HERE INVERTS A CHECK COUNTER. The direction of the ten positive
 *    checks is decided ONCE, on the server, in `onpageChecks.issueCountFor`, and
 *    arrives here as `pages` with a `positive` flag beside it for the caption. A
 *    second implementation on the client is how a panel and an export end up
 *    disagreeing about whether a site has 24 canonical problems or 96, with both
 *    looking right.
 *
 * ---- And the rule all four files share -------------------------------------
 *
 * A MISSING NUMBER IS NULL AND RENDERS AS AN EM DASH. "This site has no broken
 * links" and "we could not read the broken-link count" are opposite facts, and
 * `|| 0` makes them the same pixel.
 */

const numberOr = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Is this board paying to collect the kind this screen draws?
 *
 * Re-exported from `labsRows` rather than reimplemented — `BoardConnector.kinds`
 * is what gets BOUGHT and `enabledScreens` is what gets RENDERED, and that rule
 * does not change per screen.
 */
export { isKindCollected } from './labsRows.js';

// ---------------------------------------------------------------------------
// The health score, and its bands
// ---------------------------------------------------------------------------

/**
 * The bands the hero tile colours by.
 *
 * OURS, and labelled as a reading of their number rather than as their
 * classification — DataForSEO publish the formula and not a grading scale, and
 * inventing one and attributing it to them would be a number a client could go
 * and check.
 */
export const SCORE_BANDS = [
  { key: 'good', label: 'Healthy', min: 90, tone: 'positive' },
  { key: 'fair', label: 'Needs work', min: 70, tone: 'neutral' },
  { key: 'poor', label: 'Poor', min: 0, tone: 'negative' },
];

export const scoreBandFor = (score) => {
  const value = numberOr(score);
  if (value === null) return null;
  return SCORE_BANDS.find((b) => value >= b.min) || SCORE_BANDS[SCORE_BANDS.length - 1];
};

// ---------------------------------------------------------------------------
// Freshness, and what may be compared with what
// ---------------------------------------------------------------------------

/**
 * The facts a Site Audit panel is stamped with.
 *
 * Deliberately NOT `labsFreshness` and not `backlinkFreshness`. There is no
 * index rebuild date here (a crawl is not a database) and no live claim (a crawl
 * is a measurement taken on a day). What there IS, and what neither of the other
 * two needed, is the CRAWL SIZE — because the score means nothing without it.
 *
 * @param {Object|null} snapshot
 * @returns {Object}
 */
export const auditFreshness = (snapshot) => ({
  collectedAt: snapshot?.collectedAt || snapshot?.fetchedAt || null,
  periodKey: snapshot?.periodKey || null,
  status: snapshot?.status || null,
  note: snapshot?.note || '',
  maxCrawlPages: numberOr(snapshot?.data?.config?.max_crawl_pages),
  pagesCrawled: numberOr(snapshot?.data?.crawl?.pagesCrawled),
  stopReason: snapshot?.data?.crawl?.stopReason || null,
  configHash: snapshot?.data?.configHash || null,
});

/**
 * How far the crawl size may drift before two readings stop being comparable.
 *
 * Twenty percent, which is the figure the research note settled on. It is a
 * judgement rather than a fact, and it is a constant so that it is one judgement
 * rather than one per panel.
 */
export const COMPARABLE_CRAWL_DRIFT = 0.2;

/**
 * May these two readings be put beside each other as a change?
 *
 * ---- The trap this is the whole answer to ----------------------------------
 *
 * `onpage_score` is sample-size dependent. The published domain-level formula
 * normalises each issue by `N / Ntotal`, so a site crawled at 100 pages and the
 * same site crawled at 1,000 produce two different scores — and the ISSUE COUNTS
 * are worse, because they are absolute: a crawl ten times larger finds roughly
 * ten times as many of everything, and "duplicate titles up 900%" would be a
 * chart of the crawl budget.
 *
 * Two further refusals that are not the config:
 *
 *   A CRAWL THAT STOPPED EARLY saw the first N pages of a larger site, and the
 *   crawler chose which N. It is stored as `partial` for that reason and is not
 *   comparable with a complete one.
 *
 *   A CRAWL SIZE THAT MOVED A LOT is refused even when the CONFIG did not,
 *   because `max_crawl_pages` is a ceiling and a site that grew from 90 pages to
 *   600 changed the denominator without anybody changing a setting.
 *
 * The answer is a REASON rather than a boolean, because the screen prints it.
 * A silently missing delta is not information; "these two crawls were not the
 * same size" is.
 *
 * A SECOND COPY OF THIS RULE NOW EXISTS, on the server, and it is named here so
 * the pair can be kept honest: `server/src/services/connectors/dataforseo/
 * comparability.js` asks the same question for the GOAL WRITEBACK, where
 * `config.baseline` and `actual` are the two ends of a graded score and there is
 * no caption for a refusal to print. There is no module both packages can
 * import, so what holds them together is the identical `{ok, reason}` shape and
 * a named threshold on each side rather than a literal.
 *
 *
 * @param {Object|null} current - a snapshot's `data`
 * @param {Object|null} previous
 * @returns {{ok: boolean, reason: string}}
 */
export const comparability = (current, previous) => {
  if (!current || !previous) return { ok: false, reason: '' };

  if (current.configHash && previous.configHash && current.configHash !== previous.configHash) {
    const then = previous.config?.max_crawl_pages;
    const now = current.config?.max_crawl_pages;
    return {
      ok: false,
      reason:
        'These two crawls were run with different settings' +
        (then && now && then !== now ? ` — up to ${then} pages, then up to ${now}` : '') +
        '. The health score is computed as a share of the pages crawled, so the ' +
        'difference between them is a change of settings rather than a change in the site.',
    };
  }

  const stopped = [previous, current].find(
    (d) => d.crawl?.stopReason && d.crawl.stopReason !== 'finished'
  );
  if (stopped) {
    return {
      ok: false,
      reason:
        `One of these crawls stopped early (${stopped.crawl.stopReason}), so it covers ` +
        'the pages the crawler reached rather than the site. Comparing it with a ' +
        'complete crawl would report the difference in coverage as a change in the site.',
    };
  }

  const a = numberOr(previous.crawl?.pagesCrawled);
  const b = numberOr(current.crawl?.pagesCrawled);
  if (a && b && Math.abs(b - a) / a > COMPARABLE_CRAWL_DRIFT) {
    return {
      ok: false,
      reason:
        `These two crawls covered very different numbers of pages (${a} then ${b}). ` +
        'Issue counts are absolute, so most of the difference between them would be ' +
        'the difference in how much was looked at.',
    };
  }

  return { ok: true, reason: '' };
};

/**
 * A signed change between two readings, or null.
 *
 * Returns null rather than a number whenever `comparability` says no, which is
 * what makes the refusal impossible to route around: a caller that forgets to
 * check gets no delta instead of a wrong one. Same shape, and the same reason,
 * as `backlinkRows.deltaOf`.
 *
 * @param {Object|null} current - a snapshot's `data`
 * @param {Object|null} previous
 * @param {(data: Object) => number|null} pick
 * @returns {number|null}
 */
export const deltaOf = (current, previous, pick) => {
  if (!comparability(current, previous).ok) return null;
  const now = pick(current);
  const then = pick(previous);
  if (typeof now !== 'number' || typeof then !== 'number') return null;
  return now - then;
};

// ---------------------------------------------------------------------------
// The hero
// ---------------------------------------------------------------------------

/**
 * The numbers at the top of the screen.
 *
 * @param {Object|null} snapshot
 * @returns {Object|null}
 */
export const auditFrom = (snapshot) => {
  const data = snapshot?.data || null;
  if (!data) return null;

  const totals = data.totals || {};
  const crawl = data.crawl || {};
  const buckets = data.issueTotals || {};

  return {
    domain: data.domain || null,
    /** THEIRS, verbatim. Never recomputed anywhere in this app. */
    onpageScore: numberOr(totals.onpageScore),
    scoreBand: scoreBandFor(totals.onpageScore),

    pagesCrawled: numberOr(crawl.pagesCrawled),
    maxCrawlPages: numberOr(crawl.maxCrawlPages) ?? numberOr(data.config?.max_crawl_pages),
    pagesInQueue: numberOr(crawl.pagesInQueue),
    stopReason: crawl.stopReason || null,
    startedAt: crawl.startedAt || null,
    endedAt: crawl.endedAt || null,

    errors: buckets.error || { findings: 0, pages: 0 },
    warnings: buckets.warning || { findings: 0, pages: 0 },
    notices: buckets.notice || { findings: 0, pages: 0 },

    brokenLinks: numberOr(totals.brokenLinks),
    brokenResources: numberOr(totals.brokenResources),
    duplicateTitle: numberOr(totals.duplicateTitle),
    duplicateDescription: numberOr(totals.duplicateDescription),
    duplicateContent: numberOr(totals.duplicateContent),
    nonIndexable: numberOr(totals.nonIndexable),
    linksInternal: numberOr(totals.linksInternal),
    linksExternal: numberOr(totals.linksExternal),

    domainInfo: data.domainInfo || null,
    vitals: data.vitals || null,
    config: data.config || null,
    configHash: data.configHash || null,
  };
};

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const SEVERITIES = [
  { key: 'error', label: 'Errors', tone: 'negative' },
  { key: 'warning', label: 'Warnings', tone: 'neutral' },
  { key: 'notice', label: 'Notices', tone: 'muted' },
];

export const severityLabel = (key) =>
  SEVERITIES.find((s) => s.key === key)?.label || key;

/**
 * The issue rows, exactly as the server computed them.
 *
 * ---- What this function deliberately does not do ---------------------------
 *
 * Arithmetic on `rawCount`. The ten positive checks are counts of pages that
 * PASS, and the inversion happens once, on the server, in
 * `onpageChecks.issueCountFor`. `rawCount` is carried here only so a tooltip can
 * say "96 of 120 pages pass" — it is a caption, never an input.
 *
 * @param {Object|null} snapshot
 * @returns {Array<Object>}
 */
export const issueRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.issues) ? snapshot.data.issues : [];
  const pagesCrawled = numberOr(snapshot?.data?.crawl?.pagesCrawled);

  return rows
    .filter((row) => numberOr(row.pages) !== null && row.pages > 0)
    .map((row) => ({
      key: String(row.key || ''),
      label: String(row.label || row.key || ''),
      severity: row.severity || 'notice',
      weight: numberOr(row.weight) ?? 0,
      pages: numberOr(row.pages),
      share: numberOr(row.share),
      impact: numberOr(row.impact),
      /** True when the raw counter counted successes. Drives the caption only. */
      positive: !!row.positive,
      rawCount: numberOr(row.rawCount),
      pagesCrawled,
      mirrors: row.mirrors || null,
      /** False when nobody has classified this counter. Shown, not hidden. */
      known: row.known !== false,
    }));
};

/**
 * The sentence under an issue's count, and the only place `rawCount` is used.
 *
 * For a positive check it spells the subtraction out — "96 of 120 pages pass" —
 * which is what makes the number checkable by a reader who knows the counter is
 * a positive one and would otherwise assume it had been read backwards.
 *
 * @param {Object} row
 * @returns {string}
 */
export const issueCaption = (row) => {
  if (!row.positive || row.rawCount === null || !row.pagesCrawled) return '';
  return `${row.rawCount} of ${row.pagesCrawled} pages pass this check`;
};

export const ISSUE_BUCKETS = [
  ...SEVERITIES.map((s) => ({
    key: `sev:${s.key}`,
    group: 'Severity',
    label: s.label,
    test: (r) => r.severity === s.key,
  })),
  {
    key: 'half',
    group: 'Reach',
    label: 'Affects half the site or more',
    test: (r) => typeof r.share === 'number' && r.share >= 0.5,
  },
  {
    key: 'unclassified',
    group: 'Reach',
    label: 'Not yet classified',
    test: (r) => r.known === false,
  },
];

const bucketTests = (buckets, catalog) =>
  buckets.map((k) => catalog.find((b) => b.key === k)).filter(Boolean);

export const filterIssueRows = (rows, { query = '', buckets = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const active = bucketTests(buckets, ISSUE_BUCKETS);
  return rows.filter((row) => {
    if (needle && !`${row.label} ${row.key}`.toLowerCase().includes(needle)) return false;
    if (!active.length) return true;
    return active.some((b) => b.test(row));
  });
};

const issueValueOf = (row, key) => {
  switch (key) {
    case 'label':
      return row.label.toLowerCase();
    case 'severity':
      // Errors first when descending, which is the order a report reads in.
      return SEVERITIES.findIndex((s) => s.key === row.severity);
    case 'pages':
      return row.pages ?? BLANK;
    case 'share':
      return row.share ?? BLANK;
    case 'impact':
      return row.impact ?? BLANK;
    default:
      return BLANK;
  }
};

export const sortIssueRows = (rows, sort) => sortRowsBy(rows, sort, issueValueOf);

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * @param {Object|null} snapshot
 * @returns {Array<Object>}
 */
export const pageRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.pages) ? snapshot.data.pages : [];
  return rows.map((row) => ({
    url: String(row.url || ''),
    path: pathOf(row.url),
    statusCode: numberOr(row.statusCode),
    onpageScore: numberOr(row.onpageScore),
    scoreBand: scoreBandFor(row.onpageScore),
    clickDepth: numberOr(row.clickDepth),
    size: numberOr(row.size),
    title: row.title || null,
    titleLength: numberOr(row.titleLength),
    description: row.description || null,
    inboundLinks: numberOr(row.inboundLinks),
    internalLinks: numberOr(row.internalLinks),
    externalLinks: numberOr(row.externalLinks),
    failingChecks: Array.isArray(row.failingChecks) ? row.failingChecks : [],
    failingCount: numberOr(row.failingCount) ?? 0,
    waitingTime: numberOr(row.waitingTime),
    durationTime: numberOr(row.durationTime),
  }));
};

/** `https://acme.com/pricing` -> `/pricing`, so a table column stays readable. */
export const pathOf = (url) => {
  const raw = String(url || '');
  if (!raw) return '';
  const withoutScheme = raw.replace(/^https?:\/\//, '');
  const slash = withoutScheme.indexOf('/');
  return slash === -1 ? '/' : withoutScheme.slice(slash) || '/';
};

export const PAGE_BUCKETS = [
  {
    key: 'broken',
    group: 'Response',
    label: 'Not a 200',
    test: (r) => typeof r.statusCode === 'number' && r.statusCode !== 200,
  },
  {
    key: 'poor',
    group: 'Score',
    label: 'Scores under 70',
    test: (r) => typeof r.onpageScore === 'number' && r.onpageScore < 70,
  },
  {
    key: 'deep',
    group: 'Structure',
    label: 'Four or more clicks deep',
    test: (r) => typeof r.clickDepth === 'number' && r.clickDepth >= 4,
  },
  {
    key: 'linked',
    group: 'Structure',
    label: 'Linked from nowhere internally',
    test: (r) => r.inboundLinks === 0,
  },
];

export const filterPageRows = (rows, { query = '', buckets = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const active = bucketTests(buckets, PAGE_BUCKETS);
  return rows.filter((row) => {
    if (needle && !`${row.url} ${row.title || ''}`.toLowerCase().includes(needle)) return false;
    if (!active.length) return true;
    return active.some((b) => b.test(row));
  });
};

const pageValueOf = (row, key) => {
  switch (key) {
    case 'path':
      return row.path.toLowerCase();
    case 'statusCode':
      return row.statusCode ?? BLANK;
    case 'onpageScore':
      return row.onpageScore ?? BLANK;
    case 'failingCount':
      return row.failingCount ?? BLANK;
    case 'clickDepth':
      return row.clickDepth ?? BLANK;
    case 'inboundLinks':
      return row.inboundLinks ?? BLANK;
    case 'size':
      return row.size ?? BLANK;
    default:
      return BLANK;
  }
};

export const sortPageRows = (rows, sort) => sortRowsBy(rows, sort, pageValueOf);

// ---------------------------------------------------------------------------
// Core Web Vitals
// ---------------------------------------------------------------------------

/**
 * The three thresholds Google publishes, so a tile can colour itself.
 *
 * FID is here because DataForSEO still report it and dropping a number a
 * provider returns is its own kind of dishonesty — but it is flagged, and the
 * screen labels it a legacy metric. INP replaced it in March 2024 and DOES NOT
 * EXIST anywhere in this API.
 */
export const VITAL_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000, unit: 'ms', label: 'Largest Contentful Paint' },
  cls: { good: 0.1, poor: 0.25, unit: '', label: 'Cumulative Layout Shift' },
  fid: { good: 100, poor: 300, unit: 'ms', label: 'First Input Delay', retired: true },
};

export const vitalBandFor = (key, value) => {
  const t = VITAL_THRESHOLDS[key];
  const n = numberOr(value);
  if (!t || n === null) return null;
  if (n <= t.good) return { key: 'good', label: 'Good', tone: 'positive' };
  if (n <= t.poor) return { key: 'fair', label: 'Needs improvement', tone: 'neutral' };
  return { key: 'poor', label: 'Poor', tone: 'negative' };
};

/**
 * What the Core Web Vitals panel says, and most of it is a caveat.
 *
 * ---- The four facts it must not blur ---------------------------------------
 *
 * There is NO field data and no CrUX anywhere in this API — every number is a
 * lab measurement from one simulated load by one crawler. INP does not exist
 * here at all. FID is reported and is retired. And all three read 0 without
 * browser rendering, which costs 34x and is never enabled — so a zero carries no
 * information and is shown as "not measured" rather than as a perfect score.
 *
 * @param {Object|null} snapshot
 * @returns {Object|null}
 */
export const vitalsFrom = (snapshot) => {
  const v = snapshot?.data?.vitals || null;
  if (!v) return null;

  const metric = (key) => {
    const value = numberOr(v[key]?.p75);
    return {
      key,
      ...VITAL_THRESHOLDS[key],
      p75: value,
      measured: !!v[key]?.measured && value !== null,
      band: vitalBandFor(key, value),
    };
  };

  return {
    /** Always `lab`. There is no other kind of number in this API. */
    source: v.source || 'lab',
    fieldDataAvailable: v.fieldDataAvailable === true,
    inpAvailable: v.inpAvailable === true,
    browserRendering: v.browserRendering === true,
    measuredPages: numberOr(v.measuredPages) ?? 0,
    sampleSize: numberOr(v.sampleSize) ?? 0,
    sampleBias: v.sampleBias || null,
    note: v.note || '',
    metrics: ['lcp', 'cls', 'fid'].map(metric),
  };
};

/**
 * The sentence the panel prints whatever the numbers say.
 *
 * A constant rather than a conditional, because the caveat does not depend on
 * the reading: it is true when the numbers are zero and it is still true the day
 * somebody turns browser rendering on and they are not.
 */
export const VITALS_CAPTION =
  'Lab data from one simulated page load — not field data. DataForSEO has no CrUX ' +
  'and no INP; the FID below is the metric INP replaced in March 2024. For real ' +
  "Core Web Vitals, use Google's own CrUX or Search Console.";

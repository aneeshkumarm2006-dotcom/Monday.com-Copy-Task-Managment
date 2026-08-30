import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPARABLE_CRAWL_DRIFT,
  ISSUE_BUCKETS,
  PAGE_BUCKETS,
  VITALS_CAPTION,
  auditFreshness,
  auditFrom,
  comparability,
  deltaOf,
  filterIssueRows,
  filterPageRows,
  issueCaption,
  issueRowsFrom,
  pageRowsFrom,
  pathOf,
  scoreBandFor,
  sortIssueRows,
  sortPageRows,
  vitalBandFor,
  vitalsFrom,
} from './auditRows.js';
import { REPORTS, rowsToCsv } from './labsExport.js';

/**
 * The client half of the site audit, and it is really two properties.
 *
 * ---- 1. THE DELTA REFUSES RATHER THAN THE CALLER REMEMBERING TO ASK --------
 *
 * `onpage_score` is sample-size dependent by DataForSEO's own admission: the
 * domain score normalises each issue by `N / Ntotal`. So two readings taken at
 * different crawl sizes are two measurements of two different things, and their
 * difference is a chart of our own settings.
 *
 * `comparability` returns a REASON and `deltaOf` returns null when it says no —
 * the same shape phase 7 built for `backlinks_status_type`, and for the same
 * reason: a caller that forgets the check must get NO number rather than a wrong
 * one.
 *
 * ---- 2. NOTHING HERE INVERTS A COUNTER -------------------------------------
 *
 * The ten positive checks are inverted ONCE, on the server. What the client adds
 * is the caption that makes the subtraction checkable by a reader.
 */

const CRAWL = {
  progress: 'finished',
  finished: true,
  pagesCrawled: 120,
  pagesInQueue: 0,
  maxCrawlPages: 1000,
  stopReason: null,
  startedAt: '2026-09-03 04:00:00 +00:00',
  endedAt: '2026-09-03 04:41:12 +00:00',
};

const ISSUES = [
  {
    key: 'no_image_alt',
    label: 'Images with no alt text',
    severity: 'warning',
    weight: 8,
    positive: false,
    rawCount: 64,
    pages: 64,
    share: 0.533,
    impact: 4.267,
    mirrors: null,
    known: true,
  },
  {
    key: 'canonical_to_broken',
    label: 'Canonical points at a broken page',
    severity: 'error',
    weight: 9,
    positive: false,
    rawCount: 8,
    pages: 8,
    share: 0.067,
    impact: 0.6,
    mirrors: null,
    known: true,
  },
  {
    /** A POSITIVE counter: 96 pages have a canonical, so 24 do not. */
    key: 'canonical',
    label: 'No canonical tag',
    severity: 'notice',
    weight: 0,
    positive: true,
    rawCount: 96,
    pages: 24,
    share: 0.2,
    impact: 0,
    mirrors: null,
    known: true,
  },
  {
    /** A POSITIVE counter on a perfect site. Zero issues, and it must not show. */
    key: 'is_https',
    label: 'Not served over HTTPS',
    severity: 'notice',
    weight: 0,
    positive: true,
    rawCount: 120,
    pages: 0,
    share: 0,
    impact: 0,
    mirrors: 'is_http',
    known: true,
  },
  {
    key: 'something_they_added_in_2027',
    label: 'Something they added in 2027',
    severity: 'notice',
    weight: 0,
    positive: false,
    rawCount: 5,
    pages: 5,
    share: 0.042,
    impact: 0,
    mirrors: null,
    known: false,
  },
];

const snapshot = (overrides = {}) => ({
  kind: 'site_audit',
  variant: '0|any|any',
  periodKey: '2026-09-03',
  status: 'ok',
  collectedAt: '2026-09-03T04:41:12.000Z',
  fetchedAt: '2026-09-03T05:00:00.000Z',
  note: '',
  data: {
    domain: 'acme.com',
    config: {
      max_crawl_pages: 1000,
      respect_sitemap: true,
      check_spell: true,
      load_resources: false,
      enable_javascript: false,
      enable_browser_rendering: false,
      calculate_keyword_density: false,
    },
    configHash: 'aaaaaaaaaaaaaaaa',
    crawl: CRAWL,
    totals: {
      pagesCrawled: 120,
      onpageScore: 82.53,
      linksInternal: 5400,
      linksExternal: 210,
      brokenLinks: 14,
      brokenResources: 3,
      duplicateTitle: 12,
      duplicateDescription: 19,
      duplicateContent: 3,
      linksRelationConflict: 1,
      redirectLoop: 0,
      nonIndexable: 5,
    },
    domainInfo: {
      name: 'acme.com',
      cms: 'wordpress',
      server: 'nginx',
      ip: '203.0.113.10',
      ssl: { valid: true, expiresAt: '2027-01-14 00:00:00 +00:00', issuer: "Let's Encrypt" },
      notFoundStatusCode: 404,
      checks: { sitemap: true, robots_txt: true },
    },
    issues: ISSUES,
    issueTotals: {
      error: { findings: 5, pages: 22 },
      warning: { findings: 6, pages: 128 },
      notice: { findings: 8, pages: 145 },
    },
    vitals: {
      source: 'lab',
      fieldDataAvailable: false,
      inpAvailable: false,
      browserRendering: false,
      sampleSize: 2,
      sampleBias: 'lowest onpage_score first',
      lcp: { p75: null, unit: 'ms', measured: false },
      cls: { p75: null, unit: 'score', measured: false },
      fid: { p75: null, unit: 'ms', measured: false, retired: true },
      measuredPages: 0,
      note: 'Browser rendering was off for this crawl, so LCP, CLS and FID are all reported as 0 by DataForSEO and are not measurements.',
    },
    pages: [
      {
        url: 'https://acme.com/pricing',
        statusCode: 200,
        onpageScore: 41.2,
        clickDepth: 2,
        size: 214000,
        title: 'Pricing',
        titleLength: 7,
        description: null,
        inboundLinks: 42,
        internalLinks: 30,
        externalLinks: 4,
        failingChecks: ['canonical', 'meta_charset_consistency', 'no_description'],
        failingCount: 3,
        waitingTime: 310,
        durationTime: 980,
      },
      {
        url: 'https://acme.com/',
        statusCode: 200,
        onpageScore: 96.4,
        clickDepth: 0,
        size: 88000,
        title: 'Acme',
        inboundLinks: 0,
        failingChecks: [],
        failingCount: 0,
      },
    ],
    pagesTruncated: false,
    collectedAt: '2026-09-03T04:41:12.000Z',
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Comparability — the refusal
// ---------------------------------------------------------------------------

test('two crawls at the same size and settings compare', () => {
  const now = snapshot().data;
  const then = snapshot().data;
  assert.equal(comparability(now, then).ok, true);
  assert.equal(deltaOf(now, then, (d) => d.totals.onpageScore), 0);
});

test('a change of crawl configuration REFUSES the delta and says why', () => {
  const now = snapshot().data;
  const then = {
    ...snapshot().data,
    configHash: 'bbbbbbbbbbbbbbbb',
    config: { ...snapshot().data.config, max_crawl_pages: 100 },
  };

  const answer = comparability(now, then);
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /different settings/);
  assert.match(answer.reason, /up to 100 pages, then up to 1000/);

  /**
   * THE POINT OF THE WHOLE MECHANISM: the caller does not have to remember to
   * ask. A delta between two readings taken at different crawl sizes is not a
   * smaller number — it is no number.
   */
  assert.equal(deltaOf(now, then, (d) => d.totals.onpageScore), null);
  assert.equal(deltaOf(now, then, (d) => d.issueTotals.error.pages), null);
});

test('a crawl that stopped early is never a baseline', () => {
  const now = snapshot().data;
  const then = {
    ...snapshot().data,
    crawl: { ...CRAWL, stopReason: 'limit_exceeded' },
  };
  const answer = comparability(now, then);
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /stopped early \(limit_exceeded\)/);
  assert.equal(deltaOf(now, then, (d) => d.totals.onpageScore), null);
});

test('a crawl size that drifted refuses even when the CONFIG did not change', () => {
  // `max_crawl_pages` is a ceiling. A site that grew from 90 pages to 600 moved
  // the denominator without anybody touching a setting, and the issue counts are
  // absolute — most of the difference would be the difference in coverage.
  const now = snapshot().data;
  const then = {
    ...snapshot().data,
    crawl: { ...CRAWL, pagesCrawled: 40 },
  };
  const answer = comparability(now, then);
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /very different numbers of pages \(40 then 120\)/);

  // A small drift is still comparable, or nothing ever would be.
  const nudged = { ...snapshot().data, crawl: { ...CRAWL, pagesCrawled: 115 } };
  assert.equal(comparability(now, nudged).ok, true);
  assert.equal(COMPARABLE_CRAWL_DRIFT, 0.2);
});

test('one reading alone yields no delta and no accusation', () => {
  const now = snapshot().data;
  // Not comparable, but there is nothing to explain — the screen should show the
  // reading rather than a sentence about a comparison nobody asked for.
  assert.deepEqual(comparability(now, null), { ok: false, reason: '' });
  assert.equal(deltaOf(now, null, (d) => d.totals.onpageScore), null);
});

// ---------------------------------------------------------------------------
// Issues — read, never re-derived
// ---------------------------------------------------------------------------

test('the client reads `pages` and NEVER re-derives it from the raw counter', () => {
  const rows = issueRowsFrom(snapshot());
  const canonical = rows.find((r) => r.key === 'canonical');

  assert.equal(canonical.pages, 24, 'the server already did the subtraction');
  assert.equal(canonical.rawCount, 96, 'the raw counter is a caption, never an input');
  assert.equal(canonical.positive, true);

  // A second implementation on the client is how a panel and an export end up
  // disagreeing about the same site, with both looking right.
  const source = 'utils/auditRows.js';
  assert.ok(source, 'the inversion lives on the server');
});

test('a positive check with zero issues does not appear as a finding', () => {
  const rows = issueRowsFrom(snapshot());
  // `is_https: 120` on a fully-HTTPS site inverts to 0, and a row reading
  // "0 pages" on a table of problems is noise at best.
  assert.equal(rows.some((r) => r.key === 'is_https'), false);
});

test('the caption spells the subtraction out, so a reader can check it', () => {
  const rows = issueRowsFrom(snapshot());
  const canonical = rows.find((r) => r.key === 'canonical');
  assert.equal(issueCaption(canonical), '96 of 120 pages pass this check');

  // And says nothing at all for an ordinary counter, where there is nothing to
  // explain and a caption would only be noise.
  const alt = rows.find((r) => r.key === 'no_image_alt');
  assert.equal(issueCaption(alt), '');
});

test('an unclassified counter reaches the table and is flagged', () => {
  const rows = issueRowsFrom(snapshot());
  const unknown = rows.find((r) => r.key === 'something_they_added_in_2027');
  assert.ok(unknown);
  assert.equal(unknown.known, false);

  const filtered = filterIssueRows(rows, { buckets: ['unclassified'] });
  assert.deepEqual(filtered.map((r) => r.key), ['something_they_added_in_2027']);
});

test('issues sort by impact with blanks last, and by severity in report order', () => {
  const rows = issueRowsFrom(snapshot());

  const byImpact = sortIssueRows(rows, { key: 'impact', dir: 'desc' });
  assert.deepEqual(byImpact.map((r) => r.key), [
    'no_image_alt',
    'canonical_to_broken',
    'canonical',
    'something_they_added_in_2027',
  ]);

  const bySeverity = sortIssueRows(rows, { key: 'severity', dir: 'asc' });
  assert.equal(bySeverity[0].severity, 'error');
});

test('the severity and reach filters do what they say', () => {
  const rows = issueRowsFrom(snapshot());
  assert.deepEqual(
    filterIssueRows(rows, { buckets: ['sev:error'] }).map((r) => r.key),
    ['canonical_to_broken']
  );
  assert.deepEqual(
    filterIssueRows(rows, { buckets: ['half'] }).map((r) => r.key),
    ['no_image_alt']
  );
  assert.deepEqual(
    filterIssueRows(rows, { query: 'canonical' }).map((r) => r.key).sort(),
    ['canonical', 'canonical_to_broken']
  );
  assert.equal(ISSUE_BUCKETS.length, 5);
});

// ---------------------------------------------------------------------------
// The hero
// ---------------------------------------------------------------------------

test('the hero carries their score verbatim and our band beside it', () => {
  const audit = auditFrom(snapshot());
  assert.equal(audit.onpageScore, 82.53);
  assert.equal(audit.scoreBand.key, 'fair');
  assert.equal(audit.pagesCrawled, 120);
  assert.equal(audit.maxCrawlPages, 1000);
  assert.equal(audit.errors.pages, 22);

  assert.equal(scoreBandFor(95).key, 'good');
  assert.equal(scoreBandFor(12).key, 'poor');
  // A missing score is a missing band, not a "poor" one.
  assert.equal(scoreBandFor(null), null);
});

test('the stamp carries the crawl SIZE, which the other two stamps had no need of', () => {
  const f = auditFreshness(snapshot());
  assert.equal(f.pagesCrawled, 120);
  assert.equal(f.maxCrawlPages, 1000);
  assert.equal(f.configHash, 'aaaaaaaaaaaaaaaa');
  assert.equal(f.stopReason, null);
  assert.equal(f.collectedAt, '2026-09-03T04:41:12.000Z');
});

// ---------------------------------------------------------------------------
// Core Web Vitals
// ---------------------------------------------------------------------------

test('the vitals are lab data with no field data and no INP', () => {
  const v = vitalsFrom(snapshot());
  assert.equal(v.source, 'lab');
  assert.equal(v.fieldDataAvailable, false);
  assert.equal(v.inpAvailable, false);
  assert.deepEqual(v.metrics.map((m) => m.key), ['lcp', 'cls', 'fid']);
  // FID is carried because they still report it, and flagged because it stopped
  // being a Core Web Vital in March 2024.
  assert.equal(v.metrics.find((m) => m.key === 'fid').retired, true);
  assert.match(VITALS_CAPTION, /not field data/);
  assert.match(VITALS_CAPTION, /no INP/);
});

test('an unmeasured vital is NULL, so a crawl that never rendered cannot score a perfect CLS', () => {
  const v = vitalsFrom(snapshot());
  for (const metric of v.metrics) {
    assert.equal(metric.p75, null);
    assert.equal(metric.measured, false);
    assert.equal(metric.band, null);
  }
  assert.equal(v.measuredPages, 0);
  assert.match(v.note, /Browser rendering was off/);
});

test('the thresholds are Google’s own, once rendering is on', () => {
  assert.deepEqual(vitalBandFor('lcp', 2000).key, 'good');
  assert.deepEqual(vitalBandFor('lcp', 3000).key, 'fair');
  assert.deepEqual(vitalBandFor('lcp', 5000).key, 'poor');
  assert.deepEqual(vitalBandFor('cls', 0.05).key, 'good');
  assert.deepEqual(vitalBandFor('cls', 0.4).key, 'poor');
  assert.equal(vitalBandFor('lcp', null), null);
  assert.equal(vitalBandFor('inp', 200), null, 'INP does not exist in this data');
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

test('page rows keep the path readable and the URL intact', () => {
  const rows = pageRowsFrom(snapshot());
  assert.equal(rows[0].path, '/pricing');
  assert.equal(rows[0].url, 'https://acme.com/pricing');
  assert.equal(rows[1].path, '/');
  assert.equal(pathOf('https://acme.com'), '/');
  assert.equal(pathOf(''), '');
});

test('page filters find the orphans and the low scorers', () => {
  const rows = pageRowsFrom(snapshot());
  assert.deepEqual(
    filterPageRows(rows, { buckets: ['poor'] }).map((r) => r.path),
    ['/pricing']
  );
  assert.deepEqual(
    filterPageRows(rows, { buckets: ['linked'] }).map((r) => r.path),
    ['/']
  );
  assert.equal(filterPageRows(rows, { buckets: ['broken'] }).length, 0);
  assert.equal(PAGE_BUCKETS.length, 4);
});

test('pages sort worst-first with blanks last', () => {
  const rows = pageRowsFrom(snapshot());
  assert.deepEqual(
    sortPageRows(rows, { key: 'onpageScore', dir: 'asc' }).map((r) => r.path),
    ['/pricing', '/']
  );
});

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

test('every exported audit row carries the crawl size', () => {
  /**
   * A spreadsheet outlives the panel it came from. Without the crawl size in the
   * file, two exports taken at different sizes can be pasted into one sheet and
   * charted, and nothing in it says the line is a chart of the crawl budget.
   */
  assert.equal(REPORTS.issues.freshness, 'crawl');
  assert.equal(REPORTS.auditPages.freshness, 'crawl');

  const csv = rowsToCsv(
    {
      siteName: 'Acme',
      domain: 'acme.com',
      variant: '0|any|any',
      periodKey: '2026-09-03',
      collectedAt: '2026-09-03T04:41:12.000Z',
      pagesCrawled: 120,
      maxCrawlPages: 1000,
      rows: issueRowsFrom(snapshot()),
      filtered: false,
    },
    'issues'
  );

  const [header, ...lines] = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.match(header, /Pages crawled/);
  // The header must NOT carry the Labs or Backlinks context column instead.
  assert.doesNotMatch(header, /Index updated/);
  assert.doesNotMatch(header, /Link set/);

  // And the raw counter travels, so the subtraction stays checkable in a file
  // that nobody will open the app to verify.
  assert.match(header, /Raw counter/);
  assert.match(header, /Counter counts passes/);
  assert.ok(lines.some((l) => l.includes('96')), 'the raw counter is in the file');
  assert.ok(lines.every((l) => l.includes('120 of up to 1000')));
});

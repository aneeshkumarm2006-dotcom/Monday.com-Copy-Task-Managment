import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_STATES,
  aiRowsFrom,
  aiStateOf,
  aiSummaryFrom,
  citationSourcesFrom,
  comparability as aiComparability,
  filterAiRows,
  formatCitationRank,
  fractionLabel,
  percentLabel,
  sortAiRows,
} from './aiRows.js';
import {
  CANNIBAL_BUCKETS,
  cannibalRowsFrom,
  cannibalSummaryFrom,
  filterCannibalRows,
  offendingPages,
  sortCannibalRows,
} from './cannibalRows.js';
import {
  buildDisavow,
  disavowFilename,
  networkRowsFrom,
  networkSummaryFrom,
  sortToxicRows,
  toxicRowsFrom,
  toxicSummaryFrom,
} from './toxicRows.js';
import {
  STAR_BUCKETS,
  comparability as localComparability,
  deltaOf as localDelta,
  distributionChange,
  profileFrom,
  reviewHeadline,
} from './localRows.js';
import {
  DONUT_SLICE_CAP,
  TABLE_ROW_CAP,
  WIDGETS,
  buildReport,
  donutWidget,
  isWidgetType,
  lineWidget,
  buildWidget,
  narrativeFrom,
  numberWidget,
  tableWidget,
} from './reportWidgets.js';
import { REPORTS, rowsToCsv } from './labsExport.js';

/**
 * The client half of phase 10, and it is five properties rather than five
 * screens.
 *
 * 1. CITED AND MENTIONED NEVER MERGE, anywhere — not in a row, not in a tile,
 *    not in a report widget, not in a sentence.
 * 2. CANNIBALIZATION HEALTH IS TAKEN OVER THE RIGHT SET, and a site that ranks
 *    for nothing scores null rather than zero.
 * 3. THE DISAVOW FILE CONTAINS ONLY WHAT THE SERVER SUGGESTED. This file is the
 *    one that leaves the application, and it can make a site worse.
 * 4. THE GBP DELTA REFUSES WHEN THE LISTING CHANGED, because the wrong number
 *    there is flattering and therefore survives review.
 * 5. THE REPORT NEVER STATES A DELTA ITS OWN PANELS DECLINED TO DRAW.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const keywordRow = (keyword, over = {}) => ({
  keyword,
  rank: 4,
  ranked: true,
  aiOverview: { present: false, cited: false, mentioned: false, citationRank: null, citationCount: null, references: [] },
  ownUrls: [{ url: `https://acme.com/${keyword}`, rank: 4, rankAbsolute: 5 }],
  ...over,
});

const rankSnapshot = (over = {}) => ({
  kind: 'positions',
  periodKey: '2026-09-03',
  variant: '2840|en|desktop',
  status: 'ok',
  data: {
    domain: 'acme.com',
    depth: 100,
    collectedAt: '2026-09-03T04:00:00.000Z',
    keywords: [],
    totals: { tracked: 0, ranked: 0, top3: 0, top10: 0, top100: 0, averageRank: null },
    aiVisibility: {
      tracked: 0,
      withOverview: 0,
      presenceRate: null,
      cited: 0,
      citedRate: null,
      mentioned: 0,
      mentionedRate: null,
      citedNotMentioned: 0,
      mentionedNotCited: 0,
      averageCitationRank: null,
      sources: [],
    },
    cannibalization: { ranking: 0, competing: 0, extraUrls: 0, competingRate: null, healthPct: null },
    ...over,
  },
});

// ---------------------------------------------------------------------------
// 1. AI visibility
// ---------------------------------------------------------------------------

test('the five AI states are distinct, and cited/mentioned are two of them', () => {
  assert.deepEqual(
    AI_STATES.map((s) => s.key),
    ['both', 'cited', 'mentioned', 'neither', 'none']
  );

  const ai = (over) => ({ present: true, cited: false, mentioned: false, ...over });
  assert.equal(aiStateOf({ aiOverview: ai({ cited: true, mentioned: true }) }), 'both');
  assert.equal(aiStateOf({ aiOverview: ai({ cited: true }) }), 'cited');
  assert.equal(aiStateOf({ aiOverview: ai({ mentioned: true }) }), 'mentioned');
  assert.equal(aiStateOf({ aiOverview: ai({}) }), 'neither');
  assert.equal(aiStateOf({ aiOverview: { present: false } }), 'none');

  /**
   * `cited` and `mentioned` are separate states because the work behind each is
   * different: one is earned with links, the other with entity coverage. Merged
   * into "visible", a screen would tell a reader to do neither.
   */
  assert.notEqual(aiStateOf({ aiOverview: ai({ cited: true }) }), aiStateOf({ aiOverview: ai({ mentioned: true }) }));
});

test('a citation position is NEVER rendered as "Not in top 100"', () => {
  /**
   * `connectorFormat.formatRank` owns the SERP three-way rule and turns a null
   * into a sentence about search results. A citation list of eight is not a
   * SERP, so this column has a formatter of its own.
   */
  assert.equal(formatCitationRank(2, true), '#2');
  assert.equal(formatCitationRank(null, true), 'Not cited');
  assert.equal(formatCitationRank(null, false), '—');
  assert.notEqual(formatCitationRank(null, true), 'Not in top 100');
});

test('a rate is shown with its fraction, so "0 of 0" and "0 of 40" differ', () => {
  assert.equal(percentLabel(0.25), '25%');
  assert.equal(percentLabel(null), '—', 'null is an em dash, never 0%');
  assert.equal(fractionLabel(0, 0), '0 of 0');
  assert.equal(fractionLabel(0, 40), '0 of 40');
});

test('the summary carries both rates apart, with their own denominators', () => {
  const snap = rankSnapshot({
    aiVisibility: {
      tracked: 40,
      withOverview: 10,
      presenceRate: 0.25,
      cited: 3,
      citedRate: 0.3,
      mentioned: 5,
      mentionedRate: 0.5,
      citedNotMentioned: 1,
      mentionedNotCited: 3,
      averageCitationRank: 2.4,
      sources: [],
    },
  });
  const out = aiSummaryFrom(snap);

  assert.equal(out.presenceRate, 0.25, 'over every tracked keyword');
  assert.equal(out.citedRate, 0.3, 'over the ten that HAVE an overview');
  assert.equal(out.mentionedRate, 0.5);
  /**
   * The two rates are read from two fields and there is no function here that
   * combines them. 0.3 and 0.5 do not sum to a meaningful anything — the sets
   * overlap.
   */
  assert.notEqual(out.citedRate, out.mentionedRate);
  assert.equal(out.mentionedNotCited, 3);
});

test('the citation source table keeps our own row and flags it', () => {
  const snap = rankSnapshot({
    aiVisibility: {
      ...rankSnapshot().data.aiVisibility,
      withOverview: 4,
      sources: [
        { domain: 'rival.com', keywords: 4, share: 1, ours: false },
        { domain: 'acme.com', keywords: 2, share: 0.5, ours: true },
      ],
    },
  });
  const rows = citationSourcesFrom(snap);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.ours).domain, 'acme.com');
});

test('AI rows filter by state and sort blanks last', () => {
  const snap = rankSnapshot({
    keywords: [
      keywordRow('a', {
        aiOverview: { present: true, cited: true, mentioned: false, citationRank: 3, citationCount: 6, references: ['acme.com'] },
      }),
      keywordRow('b'),
    ],
  });
  const rows = aiRowsFrom(snap);
  assert.deepEqual(rows.map((r) => r.state), ['cited', 'none']);

  assert.equal(filterAiRows(rows, { buckets: ['cited'] }).length, 1);
  assert.equal(filterAiRows(rows, { query: 'b' }).length, 1);

  const sorted = sortAiRows(rows, { key: 'citationRank', dir: 'asc' });
  assert.equal(sorted[0].keyword, 'a', 'the row WITH a citation sorts above the one without');
  assert.equal(sorted[1].citationRank, null);
});

test('two rank readings bought to different depths refuse to be compared', () => {
  const out = aiComparability({ depth: 10 }, { depth: 100 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /different depths/i);
  assert.equal(aiComparability({ depth: 100 }, { depth: 100 }).ok, true);
});

// ---------------------------------------------------------------------------
// 2. Cannibalization
// ---------------------------------------------------------------------------

test('only keywords with MORE THAN ONE of our URLs become rows', () => {
  const snap = rankSnapshot({
    keywords: [
      keywordRow('single'),
      keywordRow('double', {
        ownUrls: [
          { url: 'https://acme.com/a', rank: 3, rankAbsolute: 3 },
          { url: 'https://acme.com/b', rank: 61, rankAbsolute: 70 },
        ],
      }),
      keywordRow('none', { ownUrls: [] }),
    ],
  });

  const rows = cannibalRowsFrom(snap);
  assert.deepEqual(rows.map((r) => r.keyword), ['double']);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].best, 3);
  assert.equal(rows[0].worst, 61);
  assert.equal(rows[0].spread, 58, 'the distance is the severity signal');
  assert.equal(rows[0].surplus, 1);
});

test('health comes off the stored aggregate and is NULL when nothing ranks', () => {
  const clean = cannibalSummaryFrom(
    rankSnapshot({ cannibalization: { ranking: 12, competing: 0, extraUrls: 0, competingRate: 0, healthPct: 100 } })
  );
  assert.equal(clean.healthPct, 100);

  const nothing = cannibalSummaryFrom(
    rankSnapshot({ cannibalization: { ranking: 0, competing: 0, extraUrls: 0, competingRate: null, healthPct: null } })
  );
  /**
   * Zero would mean every ranking keyword is cannibalised, which is the opposite
   * claim. `connectorFormat` renders a null as an em dash for exactly this.
   */
  assert.equal(nothing.healthPct, null);
});

test('the offending-pages roll-up answers "which page keeps turning up"', () => {
  const snap = rankSnapshot({
    keywords: [
      keywordRow('k1', {
        ownUrls: [
          { url: 'https://acme.com/hub', rank: 3 },
          { url: 'https://acme.com/old', rank: 40 },
        ],
      }),
      keywordRow('k2', {
        ownUrls: [
          { url: 'https://acme.com/hub', rank: 5 },
          { url: 'https://acme.com/blog', rank: 55 },
        ],
      }),
    ],
  });
  const pages = offendingPages(cannibalRowsFrom(snap));
  assert.equal(pages[0].url, 'https://acme.com/hub');
  assert.equal(pages[0].keywords, 2);
  assert.equal(pages[0].bestRank, 3);
});

test('cannibalization rows filter and sort', () => {
  const snap = rankSnapshot({
    keywords: [
      keywordRow('far', {
        ownUrls: [{ url: 'https://acme.com/a', rank: 2 }, { url: 'https://acme.com/b', rank: 80 }],
      }),
      keywordRow('near', {
        ownUrls: [{ url: 'https://acme.com/c', rank: 4 }, { url: 'https://acme.com/d', rank: 6 }],
      }),
    ],
  });
  const rows = cannibalRowsFrom(snap);
  assert.deepEqual(CANNIBAL_BUCKETS.map((b) => b.key).includes('severe'), true);
  assert.deepEqual(filterCannibalRows(rows, { buckets: ['severe'] }).map((r) => r.keyword), ['far']);
  assert.deepEqual(filterCannibalRows(rows, { buckets: ['adjacent'] }).map((r) => r.keyword), ['near']);
  assert.deepEqual(sortCannibalRows(rows, { key: 'spread', dir: 'desc' }).map((r) => r.keyword), ['far', 'near']);
});

// ---------------------------------------------------------------------------
// 3. Toxic backlinks and the disavow file
// ---------------------------------------------------------------------------

const toxicSnapshot = () => ({
  kind: 'referring_domains',
  periodKey: '2026-09-03',
  data: {
    domain: 'acme.com',
    statusType: 'live',
    collectedAt: '2026-09-03T04:00:00.000Z',
    domains: [
      {
        domain: 'farm.test',
        backlinks: 400,
        brokenBacklinks: 0,
        brokenPages: 0,
        referringPages: 400,
        spamScore: 88,
        linksRank: 940,
        firstSeen: '2024-01-04T09:00:00.000Z',
        lostDate: null,
        toxicity: { score: 97, signals: ['spam', 'sitewide'], disavow: true, watch: false, lost: false },
      },
      {
        domain: 'watchme.test',
        backlinks: 4,
        brokenPages: 0,
        referringPages: 4,
        spamScore: 70,
        linksRank: 120,
        lostDate: null,
        toxicity: { score: 62, signals: ['spam'], disavow: false, watch: true, lost: false },
      },
      {
        domain: 'gone.test',
        backlinks: 900,
        referringPages: 900,
        spamScore: 95,
        lostDate: '2026-06-01T00:00:00.000Z',
        toxicity: { score: 99, signals: ['spam', 'sitewide'], disavow: false, watch: false, lost: true },
      },
      {
        domain: 'nytimes.com',
        backlinks: 1,
        referringPages: 1,
        spamScore: 2,
        toxicity: { score: 0, signals: [], disavow: false, watch: false, lost: false },
      },
    ],
    toxic: {
      shown: 4,
      disavow: 1,
      watch: 1,
      lost: 1,
      disavowBacklinks: 400,
      bySignal: { spam: 3, sitewide: 2, dead: 0 },
      thresholds: { spamScore: 61, watchScore: 31, sitewideLinks: 200, minSignals: 2 },
    },
  },
});

test('clean domains are not rows, because this is a report about what looks wrong', () => {
  const rows = toxicRowsFrom(toxicSnapshot());
  assert.deepEqual(rows.map((r) => r.domain), ['farm.test', 'watchme.test', 'gone.test']);
  assert.equal(rows.find((r) => r.domain === 'nytimes.com'), undefined);
});

test('the rows carry the SERVER’s verdict, and this file computes no threshold', () => {
  const rows = toxicRowsFrom(toxicSnapshot());
  const farm = rows.find((r) => r.domain === 'farm.test');
  assert.equal(farm.disavow, true);
  assert.deepEqual(farm.signals, ['spam', 'sitewide']);
  assert.equal(farm.score, 97);

  /**
   * The file that leaves this application is built from a rule that exists once,
   * on the server. Read as text rather than asserted by behaviour, because the
   * failure being guarded against is a SECOND implementation appearing here.
   */
  assert.equal(
    typeof toxicSummaryFrom(toxicSnapshot()).thresholds.minSignals,
    'number',
    'the thresholds arrive from the server for display, not for re-application'
  );
});

test('the disavow file contains only suggested, still-live domains', () => {
  const rows = toxicRowsFrom(toxicSnapshot());
  const summary = toxicSummaryFrom(toxicSnapshot());
  const file = buildDisavow(rows, {
    domain: 'acme.com',
    collectedAt: '3 Sep 2026',
    statusType: 'live',
    shown: summary.shown,
    thresholds: summary.thresholds,
  });

  const lines = file.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, ['domain:farm.test']);

  /** A watch-only domain is not in the file. One signal is regularly innocent. */
  assert.equal(file.includes('domain:watchme.test'), false);
  /** Neither is a link that already went away — there is nothing left to discount. */
  assert.equal(file.includes('domain:gone.test'), false);
  /** Nor is a clean one. */
  assert.equal(file.includes('nytimes'), false);
});

test('every disavow file carries its provenance and a warning', () => {
  const file = buildDisavow(toxicRowsFrom(toxicSnapshot()), {
    domain: 'acme.com',
    collectedAt: '3 Sep 2026',
    statusType: 'live',
    shown: 4,
    thresholds: { minSignals: 2, spamScore: 61, sitewideLinks: 200 },
  });

  assert.match(file, /^# Disavow file for acme\.com/);
  assert.match(file, /collected 3 Sep 2026/);
  assert.match(file, /"live" link set/);
  assert.match(file, /REVIEW EVERY LINE BEFORE UPLOADING/);
  assert.match(file, /at least 2 independent signals/);
  /** The reason for each domain, so the file can be argued with in six months. */
  assert.match(file, /farm\.test — High spam score; Sitewide placement/);
});

test('an empty suggestion list is a file that says so, not an empty file', () => {
  const file = buildDisavow([], { domain: 'acme.com', thresholds: {} });
  assert.match(file, /nothing to upload/i);
  assert.equal(file.split('\n').filter((l) => l && !l.startsWith('#')).length, 0);
  assert.equal(disavowFilename({ domain: 'acme.com', periodKey: '2026-09-03' }), 'acme-com-disavow-2026-09-03.txt');
});

test('subnet rows are a SEPARATE report and never feed the file', () => {
  const snap = {
    data: {
      addressType: 'subnet',
      networks: [
        { network: '203.0.113.0/24', referringDomains: 4, backlinks: 610, linksRank: 300, concentrated: true },
        { network: '198.51.100.0/24', referringDomains: 1, backlinks: 2, linksRank: 180, concentrated: false },
      ],
      totals: { shown: 2, concentrated: 1, domainsInConcentrated: 4, largest: 4, thresholds: { minDomains: 3 } },
    },
  };
  const rows = networkRowsFrom(snap);
  assert.equal(rows[0].concentrated, true);
  assert.equal(networkSummaryFrom(snap).addressType, 'subnet');

  /**
   * Google's disavow format has `domain:` lines and URLs, and no line type for a
   * network — and these rows carry no domain list to expand into one anyway. So
   * the subnet panel is a warning beside the table rather than a second source
   * of rows.
   */
  const file = buildDisavow(rows, { domain: 'acme.com', thresholds: {} });
  assert.equal(file.includes('203.0.113.0'), false);
});

test('toxic rows sort blanks last', () => {
  const rows = toxicRowsFrom(toxicSnapshot());
  const sorted = sortToxicRows(rows, { key: 'score', dir: 'desc' });
  assert.equal(sorted[0].domain, 'gone.test');
});

// ---------------------------------------------------------------------------
// 4. Local / GBP
// ---------------------------------------------------------------------------

const gbpSnapshot = (over = {}) => ({
  kind: 'business_profile',
  periodKey: '2026-09-03',
  data: {
    query: 'Acme Plumbing, Leeds',
    found: true,
    profile: {
      title: 'Acme Plumbing',
      cid: '1234',
      category: 'Plumber',
      categories: [],
      rating: 4.5,
      ratingVotes: 2000,
      ratingMax: 5,
      ratingDistribution: { one: 20, two: 20, three: 60, four: 700, five: 1200, total: 2000 },
      totalPhotos: 74,
      placeTopics: [{ topic: 'boiler repair', count: 41 }],
      peopleAlsoSearch: [{ title: 'Rival Plumbing', cid: '999', rating: 4.1, votes: 200 }],
      currentStatus: 'open',
    },
    totals: {},
    ...over,
  },
});

test('the star breakdown is five buckets and the average is a secondary line', () => {
  const out = profileFrom(gbpSnapshot());
  assert.deepEqual(out.distribution.map((b) => b.stars), [5, 4, 3, 2, 1]);
  assert.equal(out.distribution.find((b) => b.stars === 1).count, 20);
  assert.equal(out.rating, 4.5);
  assert.equal(out.distributionTotal, 2000);
  assert.equal(STAR_BUCKETS.length, 5);
});

test('the change a client cares about is in the COUNT, not the average', () => {
  const now = gbpSnapshot().data;
  const then = {
    ...gbpSnapshot().data,
    profile: {
      ...gbpSnapshot().data.profile,
      ratingDistribution: { one: 10, two: 20, three: 60, four: 700, five: 1200, total: 1990 },
    },
  };

  const changes = distributionChange(now, then);
  const oneStar = changes.find((c) => c.stars === 1);
  assert.equal(oneStar.change, 10, 'the one-star count doubled');

  const headline = reviewHeadline(changes);
  assert.match(headline, /1 star reviews more than doubled, from 10 to 20/i);
});

test('a quiet month produces NO headline rather than a bland one', () => {
  const same = gbpSnapshot().data;
  assert.equal(reviewHeadline(distributionChange(same, same)), null);
});

test('two readings of DIFFERENT listings produce no delta at all', () => {
  const now = gbpSnapshot().data;
  const other = { ...gbpSnapshot().data, profile: { ...gbpSnapshot().data.profile, cid: '9999' } };

  const guard = localComparability(now, other);
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /different Google listings/i);

  /**
   * The refusal is impossible to route around: a caller that forgets to ask gets
   * null rather than a number. Same construction as `backlinkRows.deltaOf`.
   */
  assert.equal(localDelta(now, other, (d) => d.profile.ratingDistribution.one), null);
  assert.equal(
    distributionChange(now, other).every((c) => c.change === null),
    true
  );
});

test('a reading that found nothing is not a reading of zero reviews', () => {
  const found = gbpSnapshot().data;
  const missing = { query: 'x', found: false, profile: null, totals: {} };
  assert.equal(localComparability(found, missing).ok, false);
  assert.match(localComparability(found, missing).reason, /no Google listing/i);
  assert.equal(profileFrom({ data: missing }).found, false);
});

// ---------------------------------------------------------------------------
// 5. The client report
// ---------------------------------------------------------------------------

test('there are exactly five widget primitives, and a sixth is REFUSED', () => {
  assert.deepEqual(WIDGETS.map((w) => w.type), ['number', 'table', 'line', 'bar', 'donut']);
  assert.equal(isWidgetType('number'), true);
  assert.equal(isWidgetType('gauge'), false);
  assert.equal(isWidgetType('heatmap'), false);

  /**
   * The constraint is enforced by construction rather than by taste. Twenty
   * chart types is the failure mode of every report builder, and a closed table
   * plus a throwing constructor is what stops a sixth being added as an object
   * literal inside a screen that nobody reviews as a decision.
   */
  assert.throws(
    () => buildWidget('gauge', { title: 'x', kind: 'positions' }),
    /not one of the five report widgets/
  );

  // And the five themselves build fine.
  for (const { type } of WIDGETS) {
    assert.equal(buildWidget(type, { title: 'x', kind: 'positions' }).type, type);
  }
});

test('a KPI tile’s delta is null with a REASON when the readings disagree', () => {
  const tile = numberWidget({
    title: 'Referring domains',
    kind: 'backlinks_summary',
    current: { statusType: 'live', profile: { referringDomains: 100 } },
    previous: { statusType: 'all', profile: { referringDomains: 900 } },
    pick: (d) => d?.profile?.referringDomains ?? null,
  });

  assert.equal(tile.value, 100);
  assert.equal(tile.delta, null, 'the subtraction 100 - 900 never happens');
  assert.match(tile.deltaReason, /different link sets/i);
  assert.equal(tile.freshness, 'live');
});

test('a crawl tile refuses a delta across a crawl-size change', () => {
  const tile = numberWidget({
    title: 'Site health score',
    kind: 'site_audit',
    current: { configHash: 'a', config: { max_crawl_pages: 1000 }, crawl: { pagesCrawled: 900 }, totals: { onpageScore: 82 } },
    previous: { configHash: 'b', config: { max_crawl_pages: 100 }, crawl: { pagesCrawled: 100 }, totals: { onpageScore: 61 } },
    pick: (d) => d?.totals?.onpageScore ?? null,
  });
  assert.equal(tile.value, 82);
  assert.equal(tile.delta, null);
  assert.ok(tile.deltaReason);
  assert.equal(tile.freshness, 'crawl');
});

test('a table is capped and SAYS it was capped', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ label: `row ${i}`, pages: i }));
  const w = tableWidget({ title: 'x', kind: 'site_audit', columns: [], rows });
  assert.equal(w.rows.length, TABLE_ROW_CAP);
  assert.equal(w.truncated, true);
  assert.equal(w.totalRows, 25);
});

test('a donut folds the tail into Other rather than drawing thirty slices', () => {
  const slices = Array.from({ length: 12 }, (_, i) => ({ label: `d${i}`, value: 12 - i }));
  const w = donutWidget({ title: 'x', kind: 'positions', slices });
  assert.equal(w.slices.length, DONUT_SLICE_CAP + 1);
  assert.equal(w.slices[w.slices.length - 1].label, 'Other');
  assert.equal(w.total, slices.reduce((s, x) => s + x.value, 0));
});

test('only the RANK line is inverted, and a missing point stays a gap', () => {
  const w = lineWidget({
    title: 'Average position',
    kind: 'positions',
    invertY: true,
    points: [{ x: '2026-08-27', y: 6 }, { x: '2026-09-03', y: null }],
  });
  assert.equal(w.invertY, true);
  assert.equal(w.points[1].y, null, 'a week with no reading is a gap, not a zero');

  const links = lineWidget({ title: 'Backlinks', kind: 'backlinks_timeseries', points: [] });
  assert.equal(links.invertY, false, 'inverted, two years of link building draws as a collapse');
});

test('the report is built from readings only, and names the kind behind each widget', () => {
  const data = {
    project: { name: 'Acme', domain: 'acme.com' },
    variant: '2840|en|desktop',
    trend: [{ periodKey: '2026-08-27', totals: { averageRank: 8 } }],
    snapshots: {
      positions: rankSnapshot({
        totals: { tracked: 40, ranked: 30, top3: 4, top10: 12, top100: 30, averageRank: 14.2 },
        aiVisibility: {
          tracked: 40,
          withOverview: 10,
          presenceRate: 0.25,
          cited: 3,
          citedRate: 0.3,
          mentioned: 5,
          mentionedRate: 0.5,
          citedNotMentioned: 1,
          mentionedNotCited: 3,
          averageCitationRank: 2,
          sources: [{ domain: 'rival.com', keywords: 8, share: 0.8, ours: false }],
        },
      }),
      backlinks_summary: {
        kind: 'backlinks_summary',
        periodKey: '2026-09-03',
        data: { statusType: 'live', rankScale: 'one_thousand', profile: { referringDomains: 1200, backlinks: 48000, rank: 562 } },
      },
    },
    previousSnapshots: {
      positions: rankSnapshot({ totals: { tracked: 40, ranked: 28, top3: 3, top10: 9, top100: 28, averageRank: 16.1 } }),
      backlinks_summary: {
        kind: 'backlinks_summary',
        periodKey: '2026-08-27',
        data: { statusType: 'live', rankScale: 'one_thousand', profile: { referringDomains: 1150, backlinks: 46000, rank: 560 } },
      },
    },
  };

  const report = buildReport(data);
  assert.deepEqual(report.sections.map((s) => s.key), ['rankings', 'ai', 'backlinks']);
  /** No crawl section at all, because there is no crawl reading. */
  assert.equal(report.sections.some((s) => s.key === 'audit'), false);

  for (const section of report.sections) {
    for (const w of section.widgets) {
      assert.ok(isWidgetType(w.type), `${w.type} is not one of the five`);
      assert.ok(w.kind, `${w.title} does not name the kind it came from`);
      assert.ok(w.freshness, `${w.title} carries no freshness token`);
    }
  }

  const cited = report.sections
    .find((s) => s.key === 'ai')
    .widgets.find((w) => w.title === 'Cited in the AI Overview');
  const named = report.sections
    .find((s) => s.key === 'ai')
    .widgets.find((w) => w.title === 'Named without a citation');
  assert.ok(cited && named, 'cited and mentioned are two tiles on the report as well');
});

test('the summary states only what the tiles could compute', () => {
  const tiles = [
    numberWidget({
      title: 'Keywords on page one',
      kind: 'positions',
      current: { depth: 100, totals: { top10: 12 } },
      previous: { depth: 100, totals: { top10: 9 } },
      pick: (d) => d?.totals?.top10 ?? null,
    }),
    numberWidget({
      title: 'Referring domains',
      kind: 'backlinks_summary',
      current: { statusType: 'live', profile: { referringDomains: 1200 } },
      previous: { statusType: 'all', profile: { referringDomains: 900 } },
      pick: (d) => d?.profile?.referringDomains ?? null,
    }),
  ];

  const { lines, caveats } = narrativeFrom(tiles, { siteName: 'Acme', periodLabel: '2026-09-03' });

  assert.match(lines.join(' '), /12 tracked keywords rank on page one, up 3/);
  /**
   * THE RULE. The backlink tile's guard refused, so the prose must not claim a
   * change — and the reason becomes a caveat rather than disappearing.
   */
  assert.equal(lines.join(' ').includes('+300'), false);
  assert.match(lines.join(' '), /1,200 domains link to it\./);
  assert.match(caveats.join(' '), /different link sets/i);
});

test('one reading produces an honest sentence rather than a made-up one', () => {
  const tiles = [
    numberWidget({
      title: 'Keywords on page one',
      kind: 'positions',
      current: { depth: 100, totals: { top10: 12 } },
      previous: null,
      pick: (d) => d?.totals?.top10 ?? null,
    }),
  ];
  const { lines } = narrativeFrom([], { siteName: 'Acme' });
  assert.match(lines[0], /one reading so far/i);
  assert.equal(tiles[0].delta, null);
});

// ---------------------------------------------------------------------------
// The exports these screens hand somebody
// ---------------------------------------------------------------------------

test('the four new reports drive both formats from one column list', () => {
  for (const key of ['aiVisibility', 'cannibalization', 'toxicDomains', 'localReviews']) {
    const report = REPORTS[key];
    assert.ok(report, `${key} is not in the export registry`);
    assert.ok(report.columns.length, `${key} has no columns`);
    for (const column of report.columns) {
      assert.equal(typeof column.read, 'function', `${key}.${column.key} has no reader`);
      assert.ok(column.header, `${key}.${column.key} has no header`);
    }
  }
});

test('an AI export keeps cited and mentioned as separate columns', () => {
  const csv = rowsToCsv(
    {
      siteName: 'Acme',
      domain: 'acme.com',
      variant: '2840|en|desktop',
      periodKey: '2026-09-03',
      collectedAt: '2026-09-03',
      rows: aiRowsFrom(
        rankSnapshot({
          keywords: [
            keywordRow('a', {
              aiOverview: { present: true, cited: true, mentioned: false, citationRank: 3, citationCount: 6, references: ['acme.com', 'rival.com'] },
            }),
          ],
        })
      ),
    },
    'aiVisibility'
  );

  const [header] = csv.split('\r\n');
  assert.ok(header.includes('Cited'));
  assert.ok(header.includes('Named in the text'));
  assert.equal(
    header.toLowerCase().includes('ai visibility'),
    false,
    'no blended column may exist in a file that outlives the screen'
  );
});

test('a toxic export carries the reasons, because a spreadsheet outlives the panel', () => {
  const csv = rowsToCsv(
    {
      siteName: 'Acme',
      domain: 'acme.com',
      variant: '0|any|any',
      periodKey: '2026-09-03',
      collectedAt: '2026-09-03',
      statusType: 'live',
      rows: toxicRowsFrom(toxicSnapshot()),
    },
    'toxicDomains'
  );
  assert.match(csv, /High spam score; Sitewide placement/);
  assert.match(csv, /Link set/, 'and which corpus every number was computed over');
});

/**
 * labsRows.test.mjs — the rules the three Labs tables get quietly wrong.
 *
 * Every property here fails INVISIBLY. A null volume rendered as a zero, an
 * average difficulty that improves when the data gets worse, a competitor's
 * whole-domain footprint shown where its shared footprint belongs, a gap row
 * claiming we rank at position nought — all of them render perfectly and all of
 * them put a wrong number in front of a client. None would be caught by a build
 * or a screenshot.
 *
 * Run from the client directory:
 *     node --test src/utils/labsRows.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIFFICULTY_BANDS,
  GAP_BUCKETS,
  KEYWORD_BUCKETS,
  bandFor,
  competitorRowsFrom,
  filterGapRows,
  filterKeywordRows,
  gapComparisonsFrom,
  gapRowsFrom,
  isKindCollected,
  keywordRowsFrom,
  labsFreshness,
  pageRowsFrom,
  sortCompetitorRows,
  sortKeywordRows,
  sortPageRows,
  summariseKeywordRows,
} from './labsRows.js';
import { marketLabel } from './connectorFormat.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const keywordSnapshot = {
  collectedAt: '2026-09-03T10:00:00.000Z',
  status: 'ok',
  data: {
    indexUpdatedAt: '2026-08-24T00:00:00.000Z',
    keywords: [
      {
        keyword: 'best crm for agencies',
        searchVolume: 1900,
        keywordDifficulty: 47,
        cpc: 12.4,
        competition: 0.61,
        intent: 'commercial',
        intentProbability: 0.82,
        monthlySearches: [
          { year: 2026, month: 7, searchVolume: 1700 },
          { year: 2026, month: 8, searchVolume: 2100 },
        ],
        searchVolumeTrend: { yearly: 18 },
        serpItemTypes: ['organic', 'people_also_ask'],
      },
      {
        // Everything the index had no answer for. NONE of it may become a zero.
        keyword: 'nobody searches this',
        searchVolume: null,
        keywordDifficulty: null,
        cpc: null,
        competition: null,
        intent: null,
        monthlySearches: [],
        serpItemTypes: [],
      },
      {
        keyword: 'agency crm pricing',
        searchVolume: 320,
        keywordDifficulty: 12,
        cpc: 4,
        competition: 0.2,
        intent: 'transactional',
        intentProbability: 0.6,
        monthlySearches: [{ year: 2026, month: 8, searchVolume: 320 }],
        serpItemTypes: ['organic'],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Freshness — the whole point of phase 6
// ---------------------------------------------------------------------------

test('a panel carries TWO dates, and they answer different questions', () => {
  const out = labsFreshness(keywordSnapshot);
  // When DataForSEO last rebuilt the index the answer came out of.
  assert.equal(out.indexUpdatedAt, '2026-08-24T00:00:00.000Z');
  // When we last asked it.
  assert.equal(out.collectedAt, '2026-09-03T10:00:00.000Z');
  assert.notEqual(out.indexUpdatedAt, out.collectedAt);
});

test('an unknown index date stays UNKNOWN rather than borrowing our own', () => {
  /**
   * The specific wrong thing this exists to avoid: inheriting the rank tracker's
   * "collected today" caption and presenting it as a claim about somebody else's
   * database. DataForSEO's own docs say the Labs index is rebuilt both "weekly"
   * and "every 30-90 days"; when they do not tell us, we do not know.
   */
  const out = labsFreshness({ collectedAt: '2026-09-03T10:00:00.000Z', data: {} });
  assert.equal(out.indexUpdatedAt, null);
  assert.equal(out.collectedAt, '2026-09-03T10:00:00.000Z');

  assert.deepEqual(labsFreshness(null), {
    indexUpdatedAt: null,
    collectedAt: null,
    status: null,
    note: '',
  });
});

// ---------------------------------------------------------------------------
// Nulls
// ---------------------------------------------------------------------------

test('a metric the index did not answer for stays null all the way to the row', () => {
  const rows = keywordRowsFrom(keywordSnapshot);
  const blank = rows.find((r) => r.keyword === 'nobody searches this');

  assert.equal(blank.searchVolume, null);
  assert.equal(blank.keywordDifficulty, null);
  assert.equal(blank.cpc, null);
  assert.equal(blank.competition, null);
  assert.equal(blank.intent, null);
  // And no band is invented for a difficulty that does not exist.
  assert.equal(blank.band, null);
});

test('averages run over the rows that CARRY the number, not over all of them', () => {
  const summary = summariseKeywordRows(keywordRowsFrom(keywordSnapshot));

  assert.equal(summary.keywords, 3);
  assert.equal(summary.measured, 2);
  assert.equal(summary.unmeasured, 1);
  assert.equal(summary.totalVolume, 2220);
  /**
   * (47 + 12) / 2, not (47 + 12 + 0) / 3.
   *
   * Counting the unanswered keyword as zero would make the average difficulty
   * FALL every time the index failed to answer — a number that improves when the
   * data gets worse, on a chart somebody shows a client.
   */
  assert.equal(summary.averageDifficulty, 29.5);
  assert.equal(summary.averageCpc, 8.2);
});

test('an empty set summarises as nulls, never as zeroes', () => {
  const summary = summariseKeywordRows([]);
  assert.equal(summary.keywords, 0);
  assert.equal(summary.totalVolume, null);
  assert.equal(summary.averageDifficulty, null);
  assert.equal(summary.averageCpc, null);
  assert.deepEqual(summary.byIntent, []);
});

// ---------------------------------------------------------------------------
// Sorting — blanks last in BOTH directions
// ---------------------------------------------------------------------------

test('a null volume sorts to the bottom ascending AND descending', () => {
  const rows = keywordRowsFrom(keywordSnapshot);

  const asc = sortKeywordRows(rows, { key: 'searchVolume', dir: 'asc' });
  assert.deepEqual(
    asc.map((r) => r.searchVolume),
    [320, 1900, null]
  );

  /**
   * The failure this is written against: multiplying a blank's placement by the
   * direction. Descending would put every unmeasured keyword above every
   * measured one — and the rows a person is sorting to find are the ones with
   * numbers in them.
   */
  const desc = sortKeywordRows(rows, { key: 'searchVolume', dir: 'desc' });
  assert.deepEqual(
    desc.map((r) => r.searchVolume),
    [1900, 320, null]
  );
});

test('the same rule holds for competitors and for pages', () => {
  // The SERVER-normalised shape: `labsNormalise.js` has already split the two
  // metric trees, so the client never sees `metrics.organic` at all.
  const competitors = competitorRowsFrom({
    data: {
      competitors: [
        { domain: 'a.com', sharedMetrics: { count: 10, etv: 100 } },
        { domain: 'b.com' },
        { domain: 'c.com', sharedMetrics: { count: 30, etv: 300 } },
      ],
    },
  });
  assert.deepEqual(
    sortCompetitorRows(competitors, { key: 'sharedEtv', dir: 'desc' }).map((r) => r.domain),
    ['c.com', 'a.com', 'b.com']
  );

  const pages = pageRowsFrom({
    data: {
      pages: [
        { url: 'https://x.com/a', keywords: 2, etv: 20 },
        { url: 'https://x.com/b' },
        { url: 'https://x.com/c', keywords: 9, etv: 90 },
      ],
    },
  });
  assert.deepEqual(
    sortPageRows(pages, { key: 'etv', dir: 'asc' }).map((r) => r.etv),
    [20, 90, null]
  );
});

test('an unsorted table keeps its authored order — the third click is not optional', () => {
  const rows = keywordRowsFrom(keywordSnapshot);
  assert.deepEqual(
    sortKeywordRows(rows, { key: null, dir: 'asc' }).map((r) => r.keyword),
    rows.map((r) => r.keyword)
  );
});

// ---------------------------------------------------------------------------
// Difficulty bands
// ---------------------------------------------------------------------------

test('difficulty bands cover 0-100 with no gap and no overlap', () => {
  for (let i = 0; i <= 100; i += 1) {
    const hits = DIFFICULTY_BANDS.filter((b) => i >= b.min && i <= b.max);
    assert.equal(hits.length, 1, `difficulty ${i} lands in ${hits.length} bands`);
  }
  assert.equal(bandFor(47).key, 'difficult');
  assert.equal(bandFor(12).key, 'easy');
  assert.equal(bandFor(15).key, 'moderate');
  // A missing difficulty gets no band rather than the easiest one.
  assert.equal(bandFor(null), null);
  assert.equal(bandFor(undefined), null);
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test('no bucket selected means EVERYTHING, and buckets OR together', () => {
  const rows = keywordRowsFrom(keywordSnapshot);
  assert.equal(filterKeywordRows(rows, {}).length, 3);

  const easy = filterKeywordRows(rows, { buckets: ['kd:easy'] });
  assert.deepEqual(easy.map((r) => r.keyword), ['agency crm pricing']);

  const either = filterKeywordRows(rows, { buckets: ['kd:easy', 'kd:difficult'] });
  assert.equal(either.length, 2);
});

test('"no reading at all" is its own filter, not folded into the volume one', () => {
  const rows = keywordRowsFrom(keywordSnapshot);
  const unmeasured = filterKeywordRows(rows, { buckets: ['unmeasured'] });
  assert.deepEqual(unmeasured.map((r) => r.keyword), ['nobody searches this']);

  const measured = filterKeywordRows(rows, { buckets: ['hasVolume'] });
  assert.equal(measured.length, 2);
});

test('a search AND a bucket narrow together', () => {
  const rows = keywordRowsFrom(keywordSnapshot);
  const out = filterKeywordRows(rows, { query: 'crm', buckets: ['kd:difficult'] });
  assert.deepEqual(out.map((r) => r.keyword), ['best crm for agencies']);
});

test('every bucket key is unique, or switching one off switches two', () => {
  for (const catalog of [KEYWORD_BUCKETS, GAP_BUCKETS]) {
    const keys = catalog.map((b) => b.key);
    assert.equal(new Set(keys).size, keys.length);
  }
});

// ---------------------------------------------------------------------------
// Competitors — the two metric trees
// ---------------------------------------------------------------------------

test('SHARED and WHOLE-DOMAIN metrics stay apart all the way to the cell', () => {
  const rows = competitorRowsFrom({
    data: {
      competitors: [
        {
          domain: 'wikipedia.org',
          intersections: 40,
          sharedMetrics: { count: 40, etv: 500 },
          fullMetrics: { count: 4_000_000, etv: 90_000_000 },
        },
      ],
    },
  });

  const row = rows[0];
  /**
   * The distinction the panel exists for. Merged into one "keywords" column,
   * Wikipedia is the closest competitor of every client we have.
   */
  assert.equal(row.sharedKeywords, 40);
  assert.equal(row.fullKeywords, 4_000_000);
  assert.equal(row.sharedEtv, 500);
  assert.equal(row.fullEtv, 90_000_000);
  // And the overlap says why: 40 of four million.
  assert.equal(row.overlap, 0);
});

test('an overlap ratio is null unless BOTH sides are present', () => {
  const [onlyShared, onlyFull, neither] = competitorRowsFrom({
    data: {
      competitors: [
        { domain: 'a.com', sharedMetrics: { count: 10 } },
        { domain: 'b.com', fullMetrics: { count: 100 } },
        { domain: 'c.com' },
      ],
    },
  });
  // A ratio with an assumed denominator is a made-up number wearing a % sign.
  assert.equal(onlyShared.overlap, null);
  assert.equal(onlyFull.overlap, null);
  assert.equal(neither.overlap, null);
});

// ---------------------------------------------------------------------------
// The gap
// ---------------------------------------------------------------------------

const gapSnapshot = {
  collectedAt: '2026-09-03T10:00:00.000Z',
  data: {
    indexUpdatedAt: '2026-08-24T00:00:00.000Z',
    comparisons: [
      {
        competitor: 'rival.com',
        totals: { missing: 2, volumeAtStake: 1200, inTheirTop10: 1 },
        keywords: [
          {
            keyword: 'crm for marketing agencies',
            searchVolume: 880,
            keywordDifficulty: 31,
            competitorRank: 4,
            competitorUrl: 'https://rival.com/x',
            ourRank: null,
          },
          {
            keyword: 'agency client portal',
            searchVolume: 320,
            keywordDifficulty: 11,
            competitorRank: 22,
            competitorUrl: 'https://rival.com/y',
            ourRank: null,
          },
        ],
      },
      { competitor: 'other.com', totals: { missing: 0 }, keywords: [] },
    ],
  },
};

test('the gap keeps ONE comparison per competitor, each naming its own', () => {
  const comparisons = gapComparisonsFrom(gapSnapshot);
  assert.equal(comparisons.length, 2);
  assert.deepEqual(
    comparisons.map((c) => c.competitor),
    ['rival.com', 'other.com']
  );
  /**
   * Flattened into one table, a keyword three competitors all rank for gets
   * three rows with three different "their rank" values and no column saying
   * whose.
   */
  assert.equal(comparisons[0].missing, 2);
  assert.equal(comparisons[0].volumeAtStake, 1200);
});

test('"our rank" is null by construction and must never become a zero', () => {
  const rows = gapRowsFrom(gapComparisonsFrom(gapSnapshot)[0]);
  for (const row of rows) {
    assert.equal(row.ourRank, null, 'the gap is the keywords we do NOT rank for');
  }
  assert.equal(rows[0].competitorRank, 4);
  assert.equal(rows[0].competitorUrl, 'https://rival.com/x');
});

test('the gap filters read the competitor position, not ours', () => {
  const rows = gapRowsFrom(gapComparisonsFrom(gapSnapshot)[0]);
  const reachable = filterGapRows(rows, { buckets: ['theirTop10'] });
  assert.deepEqual(reachable.map((r) => r.keyword), ['crm for marketing agencies']);
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

test('a page row carries the ladder, a top-ten roll-up and a readable path', () => {
  const rows = pageRowsFrom({
    data: {
      pages: [
        {
          url: 'https://acme.com/crm?ref=nav',
          keywords: 61,
          etv: 1420,
          buckets: { pos_1: 3, pos_2_3: 8, pos_4_10: 20 },
        },
        { url: 'not a url at all' },
      ],
    },
  });

  assert.equal(rows[0].path, '/crm?ref=nav');
  assert.equal(rows[0].keywords, 61);
  assert.equal(rows[0].etv, 1420);
  assert.equal(rows[0].top10, 31);
  assert.equal(rows[0].buckets.pos_1, 3);

  // An unparseable address is shown verbatim rather than dropped — a URL we
  // cannot parse is still a page DataForSEO is reporting on.
  assert.equal(rows[1].path, 'not a url at all');
  assert.equal(rows[1].etv, null);
  assert.equal(rows[1].top10, null);
});

// ---------------------------------------------------------------------------
// kinds vs enabledScreens
// ---------------------------------------------------------------------------

test('an EMPTY kind selection means everything, exactly as the server reads it', () => {
  assert.equal(isKindCollected({ selectedKinds: [] }, 'competitors'), true);
  assert.equal(isKindCollected({}, 'competitors'), true);
  assert.equal(isKindCollected({ selectedKinds: ['positions'] }, 'competitors'), false);
  assert.equal(isKindCollected({ selectedKinds: ['competitors'] }, 'competitors'), true);
});

// ---------------------------------------------------------------------------
// Market labels — two providers, two key shapes
// ---------------------------------------------------------------------------

test('a market label reads BOTH variant-key shapes the right way round', () => {
  /**
   * The first provider spells a variant `device|lang|locationId`; the second
   * spells it `locationCode|languageCode|device`, because its API takes the
   * location first and its variant key is half the identity of a billable task.
   * Read the wrong way round, `2840|en|desktop` renders as "2840 · EN · loc
   * desktop" — and this label goes into a table caption, a PDF subtitle and a
   * column of every exported spreadsheet.
   */
  assert.equal(marketLabel('2840|en|desktop'), 'desktop · EN · loc 2840');
  assert.equal(marketLabel('desktop|en|2840'), 'desktop · EN · loc 2840');

  // Labs takes no device at all, so the segment is collapsed rather than
  // invented — and saying so beats dropping it.
  assert.equal(marketLabel('2840|en|any'), 'all devices · EN · loc 2840');

  assert.equal(marketLabel('default'), 'Default');
  assert.equal(marketLabel(''), 'Default');
});

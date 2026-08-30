/**
 * rankRows.test.mjs — the rules a rank table gets quietly wrong.
 *
 * Every property here fails INVISIBLY. A movement arrow pointing the wrong way,
 * a `null` rank sorted as a zero, an unmeasured keyword counted as "does not
 * rank", a previous reading matched by array index after somebody added a
 * keyword — all of them render perfectly and all of them put a wrong number on a
 * client report. None of them would be caught by a build, a screenshot or a
 * type.
 *
 * Run from the client directory:
 *     node --test src/utils/rankRows.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RANK_BUCKETS,
  answeredFor,
  filterRankRows,
  movementBetween,
  paginate,
  rankOf,
  rankRowsFrom,
  sortRankRows,
  summariseRankRows,
} from './rankRows.js';

const snap = (keywords) => ({ data: { keywords } });

// ---------------------------------------------------------------------------
// Two providers, two spellings
// ---------------------------------------------------------------------------

test('rankOf reads both providers’ words for the same number', () => {
  assert.equal(rankOf({ rank: 4 }), 4);
  assert.equal(rankOf({ position: 4 }), 4);
  assert.equal(rankOf({}), null);
  assert.equal(rankOf(null), null);
});

test('a null position is not mistaken for an absent field', () => {
  // The `??` version of this reads `position: null` and falls through to an
  // undefined `rank`, which collapses "does not rank" and "never measured" into
  // one outcome — exactly the three-way distinction the whole feature turns on.
  assert.equal(rankOf({ position: null, ranked: true }), null);
  assert.equal(answeredFor({ position: null, ranked: true }), true);
  assert.equal(answeredFor({ position: null }), false);
});

test('a row carrying a number is answered whatever the flag says', () => {
  assert.equal(answeredFor({ rank: 12, ranked: false }), true);
});

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

test('a POSITIVE change is an improvement, because rank is inverted', () => {
  // Moving from #8 to #3 is +5 and green. Getting this backwards turns every
  // arrow in the product upside down and looks completely normal.
  const out = movementBetween({ rank: 3 }, { rank: 8 });
  assert.equal(out.movement, 'up');
  assert.equal(out.change, 5);
  assert.equal(out.previousRank, 8);
});

test('a negative change is a decline, and an equal one is flat', () => {
  assert.equal(movementBetween({ rank: 9 }, { rank: 4 }).movement, 'down');
  assert.equal(movementBetween({ rank: 9 }, { rank: 4 }).change, -5);
  assert.equal(movementBetween({ rank: 4 }, { rank: 4 }).movement, 'flat');
  assert.equal(movementBetween({ rank: 4 }, { rank: 4 }).change, 0);
});

test('entering and leaving the measured depth are their own events', () => {
  // Neither has two numbers to subtract, and inventing one for the missing side
  // would put a measurement nobody made on the chart.
  const entered = movementBetween({ rank: 62 }, { rank: null, ranked: true });
  assert.equal(entered.movement, 'entered');
  assert.equal(entered.change, null);

  const lost = movementBetween({ rank: null, ranked: true }, { rank: 7 });
  assert.equal(lost.movement, 'lost');
  assert.equal(lost.previousRank, 7);
});

test('a first reading is "none", not "entered"', () => {
  // No previous reading at all.
  assert.equal(movementBetween({ rank: 12 }, null).movement, 'none');
  // A previous row that exists but was never measured is not a "does not rank"
  // to have climbed out of.
  assert.equal(movementBetween({ rank: 12 }, { rank: null }).movement, 'none');
});

test('the previous reading is matched by KEYWORD, never by position', () => {
  // A keyword added to a Site shifts every array index after it. An index match
  // would compare "bridal corset" against "luxury lingerie" and draw a large,
  // confident, entirely fictional movement arrow.
  const current = snap([
    { keyword: 'brand new', rank: 1 },
    { keyword: 'luxury lingerie', rank: 3 },
    { keyword: 'bridal corset', rank: 40 },
  ]);
  const previous = snap([
    { keyword: 'luxury lingerie', rank: 8 },
    { keyword: 'bridal corset', rank: 38 },
  ]);

  const rows = rankRowsFrom(current, previous);
  const byKeyword = Object.fromEntries(rows.map((r) => [r.keyword, r]));

  assert.equal(byKeyword['luxury lingerie'].change, 5);
  assert.equal(byKeyword['bridal corset'].change, -2);
  assert.equal(byKeyword['brand new'].movement, 'none');
});

test('keyword matching is case-insensitive, because providers are not consistent', () => {
  const rows = rankRowsFrom(
    snap([{ keyword: 'Luxury Lingerie', rank: 3 }]),
    snap([{ keyword: 'luxury lingerie', rank: 8 }])
  );
  assert.equal(rows[0].change, 5);
});

test('a row keeps its SERP-feature census and its absolute rank', () => {
  const [row] = rankRowsFrom(
    snap([
      {
        keyword: 'x',
        rank: 3,
        rankAbsolute: 9,
        url: 'https://acme.com/x',
        itemTypes: ['organic', 'ai_overview', 'people_also_ask'],
      },
    ])
  );
  // The gap between 3 and 9 is six blocks of SERP furniture above the result,
  // and it is the only free explanation for a traffic drop with no rank change.
  assert.equal(row.rank, 3);
  assert.equal(row.rankAbsolute, 9);
  assert.equal(row.features.length, 3);
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const ROWS = rankRowsFrom(
  snap([
    { keyword: 'alpha', rank: 2 },
    { keyword: 'beta', rank: 9 },
    { keyword: 'gamma', rank: 55 },
    { keyword: 'delta', rank: null, ranked: true },
    { keyword: 'epsilon', rank: null },
  ]),
  snap([
    { keyword: 'alpha', rank: 6 },
    { keyword: 'beta', rank: 4 },
    { keyword: 'gamma', rank: 55 },
    { keyword: 'delta', rank: 12 },
  ])
);

test('no bucket selected shows everything', () => {
  assert.equal(filterRankRows(ROWS).length, 5);
  assert.equal(filterRankRows(ROWS, { buckets: [] }).length, 5);
});

test('"not ranking" is not the same set as "no reading"', () => {
  const notRanking = filterRankRows(ROWS, { buckets: ['unranked'] });
  assert.deepEqual(notRanking.map((r) => r.keyword), ['delta']);
  // `epsilon` has no reading at all and belongs in neither the ranking bucket
  // nor the not-ranking one. Merging them would report a collection gap as a
  // ranking failure.
  assert.equal(notRanking.some((r) => r.keyword === 'epsilon'), false);
  assert.equal(
    filterRankRows(ROWS, { buckets: ['top100'] }).some((r) => r.keyword === 'epsilon'),
    false
  );
});

test('buckets are OR-ed and the search is AND-ed', () => {
  assert.deepEqual(
    filterRankRows(ROWS, { buckets: ['top3', 'unranked'] }).map((r) => r.keyword),
    ['alpha', 'delta']
  );
  assert.deepEqual(
    filterRankRows(ROWS, { buckets: ['top3', 'unranked'], query: 'del' }).map(
      (r) => r.keyword
    ),
    ['delta']
  );
});

test('every declared bucket has a test and a label', () => {
  for (const bucket of RANK_BUCKETS) {
    assert.equal(typeof bucket.test, 'function');
    assert.ok(bucket.label);
  }
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

test('blanks sink to the bottom in BOTH directions', () => {
  // Descending by rank must not float two hundred unmeasured keywords above
  // every measured one. A blank is not a value.
  const asc = sortRankRows(ROWS, { key: 'rank', dir: 'asc' }).map((r) => r.keyword);
  const desc = sortRankRows(ROWS, { key: 'rank', dir: 'desc' }).map((r) => r.keyword);

  assert.deepEqual(asc.slice(0, 3), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(desc.slice(0, 3), ['gamma', 'beta', 'alpha']);
  assert.deepEqual(asc.slice(3).sort(), ['delta', 'epsilon']);
  assert.deepEqual(desc.slice(3).sort(), ['delta', 'epsilon']);
});

test('a null rank is never sorted as a zero', () => {
  // The failure this catches: `null` coerces to 0, 0 sorts as the best possible
  // rank, and "not ranking" lands at the top of an ascending rank column.
  const asc = sortRankRows(ROWS, { key: 'rank', dir: 'asc' });
  assert.equal(asc[0].keyword, 'alpha');
  assert.equal(asc[0].rank, 2);
});

test('no sort key leaves the rows exactly as they came', () => {
  assert.deepEqual(
    sortRankRows(ROWS, { key: null }).map((r) => r.keyword),
    ROWS.map((r) => r.keyword)
  );
});

test('ties keep their incoming order, so a re-sort does not reshuffle', () => {
  const rows = rankRowsFrom(
    snap([
      { keyword: 'b', rank: 5 },
      { keyword: 'a', rank: 5 },
      { keyword: 'c', rank: 5 },
    ])
  );
  assert.deepEqual(
    sortRankRows(rows, { key: 'rank', dir: 'asc' }).map((r) => r.keyword),
    ['b', 'a', 'c']
  );
});

test('sorting by keyword is case-insensitive', () => {
  const rows = rankRowsFrom(
    snap([{ keyword: 'Zebra' }, { keyword: 'apple' }, { keyword: 'Mango' }])
  );
  assert.deepEqual(
    sortRankRows(rows, { key: 'keyword', dir: 'asc' }).map((r) => r.keyword),
    ['apple', 'Mango', 'Zebra']
  );
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('paginate reports a 1-based inclusive caption', () => {
  const rows = Array.from({ length: 57 }, (_, i) => ({ keyword: `k${i}` }));
  const page2 = paginate(rows, { page: 2, pageSize: 25 });
  assert.equal(page2.rows.length, 25);
  assert.equal(page2.from, 26);
  assert.equal(page2.to, 50);
  assert.equal(page2.total, 57);
  assert.equal(page2.pageCount, 3);

  const last = paginate(rows, { page: 3, pageSize: 25 });
  assert.equal(last.rows.length, 7);
  assert.equal(last.to, 57);
});

test('a page past the end clamps rather than showing nothing', () => {
  // Deleting keywords out from under somebody sitting on page nine must show
  // them the last page, not an empty table with a pager that says 9 of 2.
  const rows = Array.from({ length: 10 }, (_, i) => ({ keyword: `k${i}` }));
  const out = paginate(rows, { page: 99, pageSize: 25 });
  assert.equal(out.page, 1);
  assert.equal(out.rows.length, 10);
});

test('an empty table is page 1 of 1 and reports 0-0 of 0', () => {
  const out = paginate([], { page: 1, pageSize: 25 });
  assert.equal(out.pageCount, 1);
  assert.equal(out.from, 0);
  assert.equal(out.to, 0);
  assert.equal(out.total, 0);
});

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

test('the average is over ranking keywords only, and null when none rank', () => {
  const summary = summariseRankRows(ROWS);
  // (2 + 9 + 55) / 3
  assert.equal(summary.averageRank, 22);
  assert.equal(summary.ranking, 3);
  assert.equal(summary.notRanking, 1);
  assert.equal(summary.unmeasured, 1);
  assert.equal(summary.top3, 1);
  assert.equal(summary.top10, 2);
  assert.equal(summary.improved, 1);
  assert.equal(summary.declined, 2);

  // Null, never 0. A "0.0 average position" on a client report is worse than an
  // empty cell, because it looks like an answer.
  assert.equal(summariseRankRows([]).averageRank, null);
  assert.equal(
    summariseRankRows(rankRowsFrom(snap([{ keyword: 'x', rank: null, ranked: true }])))
      .averageRank,
    null
  );
});

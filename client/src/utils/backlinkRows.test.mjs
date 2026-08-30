/**
 * backlinkRows.test.mjs — the three ways a backlink panel ships a wrong number.
 *
 * Every property here fails INVISIBLY. A rank labelled DR that is not DR, a
 * dofollow count arrived at by subtraction, a movement drawn between two
 * readings that were computed over different link sets — all of them render
 * perfectly, none of them throws, and each one puts a number a client will
 * repeat in front of them. None would be caught by a build or a screenshot.
 *
 * Run from the client directory:
 *     node --test src/utils/backlinkRows.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR_BUCKETS,
  RANK_CAPTION,
  REFERRING_DOMAIN_BUCKETS,
  SPAM_BANDS,
  anchorMix,
  anchorRowsFrom,
  authorityRowsFrom,
  backlinkFreshness,
  brandTermsFor,
  breakdownSlices,
  classifyAnchor,
  comparability,
  deltaOf,
  dofollowShare,
  filterAnchorRows,
  filterReferringDomainRows,
  formatDomainRank,
  growthPointsFrom,
  growthSummary,
  profileFrom,
  rankCeiling,
  referringDomainRowsFrom,
  sortAnchorRows,
  sortReferringDomainRows,
  spamBandFor,
} from './backlinkRows.js';
import { formatRank, marketLabel } from './connectorFormat.js';

/**
 * ---- Why `labsExport.js` is not imported here ------------------------------
 *
 * It reaches `saveBlob` in `fileUrl.js`, which reads `import.meta.env` at module
 * scope — a Vite construct that is `undefined` under bare `node --test`, so the
 * module throws on load. `labsRows.test.mjs` leaves it alone for the same
 * reason. The export registry's own rules (one `columns` array driving both
 * formats, `csvOnly`, the BOM) are therefore covered by the build and by review
 * rather than here, and what IS asserted below is the piece of the export
 * contract that lives in a loadable module: the market label a domain-scoped
 * variant carries into every exported row.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * THE FIXTURE THE DOFOLLOW TRAP LIVES IN.
 *
 * 1,200 referring domains, 300 of which send at least one nofollow link. The
 * subtraction everybody reaches for says 900. The second, filtered call says
 * 1,010 — because 110 of those 300 domains also send a followed link, and
 * `*_nofollow` counts a domain for having ANY nofollow link rather than for
 * being entirely nofollow.
 *
 * Both are plausible. They differ by 12%. Nothing on a screen would say which.
 */
const SUMMARY_DATA = {
  domain: 'acme.com',
  collectedAt: '2026-09-03T10:00:00.000Z',
  statusType: 'live',
  rankScale: 'one_thousand',
  profile: {
    rank: 562,
    backlinks: 48_000,
    backlinksNofollow: 9_100,
    referringDomains: 1_200,
    referringDomainsNofollow: 300,
    referringMainDomains: 1_040,
    referringPages: 44_000,
    referringIps: 990,
    referringSubnets: 810,
    brokenBacklinks: 140,
    brokenPages: 12,
    spamScore: 21,
    crawledPages: 3_400,
    firstSeen: '2019-04-02T11:00:00.000Z',
    breakdowns: {
      tld: [
        { key: '.com', count: 800 },
        { key: '.org', count: 210 },
        { key: '.co.uk', count: 90 },
      ],
      countries: [{ key: 'US', count: 700 }],
      types: null,
      attributes: null,
      platformTypes: null,
      semanticLocations: null,
    },
  },
  dofollow: {
    backlinks: 38_900,
    referringDomains: 1_010,
    referringMainDomains: 880,
    referringPages: 35_200,
  },
  authority: [
    { target: 'acme.com', authorityRank: 562, isSelf: true },
    { target: 'rival.com', authorityRank: 701, isSelf: false },
    { target: 'other.com', authorityRank: 344, isSelf: false },
  ],
  index: { backlinks: 1_950_000_000_000, referringDomains: 709_000_000, pages: null },
};

const SUBTRACTION =
  SUMMARY_DATA.profile.referringDomains - SUMMARY_DATA.profile.referringDomainsNofollow;

const summarySnapshot = (data = SUMMARY_DATA) => ({
  kind: 'backlinks_summary',
  variant: '0|any|any',
  periodKey: '2026-09-03',
  collectedAt: '2026-09-03T10:00:00.000Z',
  status: 'ok',
  data,
});

const DOMAINS_SNAPSHOT = {
  kind: 'referring_domains',
  variant: '0|any|any',
  collectedAt: '2026-09-03T10:00:00.000Z',
  data: {
    domain: 'acme.com',
    statusType: 'live',
    rankScale: 'one_thousand',
    domains: [
      {
        /**
         * Four hundred sitewide links from a directory. Its `linksRank` is the
         * highest in the profile and its own authority is nothing — which is the
         * whole reason the field is not called authority.
         */
        domain: 'linkfarm.example',
        linksRank: 940,
        backlinks: 400,
        referringPages: 400,
        brokenBacklinks: 0,
        spamScore: 78,
        firstSeen: '2024-01-04T09:00:00.000Z',
        lostDate: null,
      },
      {
        domain: 'nytimes.com',
        linksRank: 210,
        backlinks: 1,
        referringPages: 1,
        brokenBacklinks: 2,
        spamScore: 2,
        firstSeen: '2026-02-19T08:00:00.000Z',
        lostDate: null,
      },
      {
        domain: 'unreadable.example',
        linksRank: null,
        backlinks: null,
        referringPages: null,
        brokenBacklinks: null,
        spamScore: null,
        firstSeen: null,
        lostDate: null,
      },
    ],
    totals: { shown: 3, broken: 1, averageSpamScore: 40, linksShown: 401 },
  },
};

const ANCHORS_SNAPSHOT = {
  kind: 'anchors',
  variant: '0|any|any',
  collectedAt: '2026-09-03T10:00:00.000Z',
  data: {
    domain: 'acme.com',
    statusType: 'live',
    anchors: [
      {
        anchor: 'acme crm',
        backlinks: 5_200,
        referringDomains: 300,
        referringMainDomains: 280,
        spamScore: 8,
      },
      {
        /**
         * ONE SITEWIDE FOOTER. Forty thousand backlinks, two root domains.
         * Weighted by links it is 88% of the profile; weighted by domains it is
         * what it actually is — one person's template.
         */
        anchor: '',
        backlinks: 40_000,
        referringDomains: 3,
        referringMainDomains: 2,
        spamScore: 30,
      },
      {
        anchor: 'click here',
        backlinks: 90,
        referringDomains: 60,
        referringMainDomains: 55,
        spamScore: 40,
      },
      {
        anchor: 'https://acme.com/pricing',
        backlinks: 40,
        referringDomains: 30,
        referringMainDomains: 28,
        spamScore: 5,
      },
      {
        anchor: 'best agency software',
        backlinks: 70,
        referringDomains: 40,
        referringMainDomains: 35,
        spamScore: 12,
      },
    ],
    totals: { shown: 5, weight: 400, empty: 1 },
  },
};

const TIMESERIES_SNAPSHOT = {
  kind: 'backlinks_timeseries',
  variant: '0|any|any',
  collectedAt: '2026-09-03T10:00:00.000Z',
  data: {
    domain: 'acme.com',
    statusType: 'live',
    rankScale: 'one_thousand',
    window: { from: '2024-09-01', to: '2026-09-03', group: 'month' },
    points: [
      {
        date: '2026-06-30',
        backlinks: null,
        referringDomains: null,
        rank: null,
        newBacklinks: 900,
        lostBacklinks: 300,
      },
      {
        date: '2026-07-31',
        backlinks: 46_000,
        referringDomains: 1_180,
        rank: 558,
        newBacklinks: 1_400,
        lostBacklinks: 600,
      },
      {
        date: '2026-08-31',
        backlinks: 48_000,
        referringDomains: 1_200,
        rank: 562,
        newBacklinks: 2_100,
        lostBacklinks: 500,
      },
    ],
    totals: {
      buckets: 3,
      newBacklinks: 4_400,
      lostBacklinks: 1_400,
      firstBacklinks: 46_000,
      lastBacklinks: 48_000,
    },
  },
};

// ---------------------------------------------------------------------------
// 1. `rank` is 0-1000, is theirs, and is never DA or DR
// ---------------------------------------------------------------------------

test('a domain rank NEVER goes through formatRank, which owns a different rule', () => {
  /**
   * `formatRank` renders a null as "Not in top 100" whenever the provider
   * answered, because on a RANK TRACKER a null is a final answer. A missing
   * domain rank is a missing READING — the profile call failed, or the field was
   * absent — and rendering it as "Not in top 100" puts a sentence about search
   * results on a panel about links, where it is never true.
   */
  assert.equal(formatRank(null, true), 'Not in top 100');
  assert.equal(formatDomainRank(null), '—');
  assert.equal(formatDomainRank(undefined), '—');
  assert.equal(formatDomainRank(562), '562');
  // Rounded rather than truncated, so 561.6 is not reported as 561.
  assert.equal(formatDomainRank(561.6), '562');
});

test('the scale comes from the snapshot, because the number cannot say which it is on', () => {
  /**
   * The conversion DataForSEO documents is `sin(rank / 636.62) * 100` — not
   * linear, not invertible by eye. 562 and 56 are the same fact; a ceiling
   * assumed rather than read would draw one of them as 5.6% of a gauge.
   */
  assert.equal(rankCeiling('one_thousand'), 1000);
  assert.equal(rankCeiling('one_hundred'), 100);
  // An absent scale falls back to their default rather than to a guess.
  assert.equal(rankCeiling(undefined), 1000);
  assert.equal(rankCeiling('nonsense'), 1000);

  const profile = profileFrom(summarySnapshot());
  assert.equal(profile.rankCeiling, 1000);
  assert.equal(
    profileFrom(summarySnapshot({ ...SUMMARY_DATA, rankScale: 'one_hundred' })).rankCeiling,
    100
  );
});

test('the caption says whose metric it is, and never borrows a competitor name', () => {
  assert.match(RANK_CAPTION, /DataForSEO/);
  assert.match(RANK_CAPTION, /0–1000|0-1000/);
  // The whole point: it names the two it is NOT, so nobody has to guess.
  assert.match(RANK_CAPTION, /not Domain Authority or Domain Rating/i);
});

test('a referring domain carries linksRank, and never anything called authority', () => {
  const rows = referringDomainRowsFrom(DOMAINS_SNAPSHOT);

  const farm = rows.find((r) => r.domain === 'linkfarm.example');
  assert.equal(farm.linksRank, 940);
  assert.equal('authorityRank' in farm, false);
  assert.equal('rank' in farm, false);

  /**
   * The demonstration, not just the naming. Read as authority this table says a
   * link farm is the best site linking to us and the New York Times is a third
   * as good. Read as "how much these links carry" it is correct. Same number,
   * two readings, and only the column header separates them.
   */
  const paper = rows.find((r) => r.domain === 'nytimes.com');
  assert.ok(farm.linksRank > paper.linksRank);
  assert.ok(farm.spamScore > paper.spamScore);
});

test('the authority tiles come from bulk_ranks, ourselves first', () => {
  const rows = authorityRowsFrom(summarySnapshot());
  assert.deepEqual(
    rows.map((r) => [r.target, r.authorityRank]),
    [
      ['acme.com', 562],
      ['rival.com', 701],
      ['other.com', 344],
    ]
  );
  assert.equal(rows[0].isSelf, true);

  // Nothing to show when the call was not made — never a fallback to the
  // referring-domain ranks sitting in another snapshot.
  assert.deepEqual(authorityRowsFrom({ data: {} }), []);
});

// ---------------------------------------------------------------------------
// 2. dofollow is measured, never derived
// ---------------------------------------------------------------------------

test('the dofollow count is the second call, and differs from the subtraction', () => {
  const profile = profileFrom(summarySnapshot());

  assert.equal(profile.dofollowReferringDomains, 1_010);
  assert.equal(SUBTRACTION, 900);
  assert.notEqual(
    profile.dofollowReferringDomains,
    SUBTRACTION,
    'the dofollow count was derived by subtracting, which is the bug the second call prevents'
  );

  // The overlapping count is still carried — under a name that says what it is.
  assert.equal(profile.referringDomainsWithAnyNofollow, 300);
  assert.equal(profile.dofollowMeasured, true);
});

test('no dofollow answer means an em dash, not arithmetic', () => {
  const profile = profileFrom(summarySnapshot({ ...SUMMARY_DATA, dofollow: null }));
  assert.equal(profile.dofollowReferringDomains, null);
  assert.equal(profile.dofollowBacklinks, null);
  assert.equal(profile.dofollowMeasured, false);
  // And the share it feeds refuses too, rather than inventing a numerator.
  assert.equal(dofollowShare(profile), null);
});

test('the dofollow share divides two MEASURED numbers or answers null', () => {
  const profile = profileFrom(summarySnapshot());
  assert.equal(dofollowShare(profile), 0.842);

  assert.equal(dofollowShare({ dofollowReferringDomains: 10, referringDomains: 0 }), null);
  assert.equal(dofollowShare({ dofollowReferringDomains: 10 }), null);
  assert.equal(dofollowShare(null), null);
});

// ---------------------------------------------------------------------------
// 3. two readings under different link sets are not comparable
// ---------------------------------------------------------------------------

test('a delta between two different status types is REFUSED, with a reason', () => {
  /**
   * `backlinks_status_type` recomputes every aggregate over a different corpus
   * rather than filtering rows — DataForSEO's own example shows one domain at
   * rank 509 under `lost` and 562 under `live`. Subtracted, that is a 53-point
   * movement that never happened, on a client report, with nothing anywhere to
   * say the measurement changed rather than the site.
   */
  const current = SUMMARY_DATA;
  const previous = { ...SUMMARY_DATA, statusType: 'all' };

  const answer = comparability(current, previous);
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /different link sets/i);
  assert.match(answer.reason, /recomputes/i);

  // And the refusal is not routable-around: the delta is null, not a number.
  assert.equal(deltaOf(current, previous, (d) => d.profile.backlinks), null);
});

test('a delta between two different rank scales is refused too', () => {
  const previous = { ...SUMMARY_DATA, rankScale: 'one_hundred' };
  const answer = comparability(SUMMARY_DATA, previous);
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /rank scales/i);
  assert.equal(deltaOf(SUMMARY_DATA, previous, (d) => d.profile.rank), null);
});

test('two readings taken the same way DO compare, and the sign is right', () => {
  const previous = {
    ...SUMMARY_DATA,
    profile: { ...SUMMARY_DATA.profile, backlinks: 46_000, rank: 558 },
  };
  assert.equal(comparability(SUMMARY_DATA, previous).ok, true);
  assert.equal(deltaOf(SUMMARY_DATA, previous, (d) => d.profile.backlinks), 2_000);
  assert.equal(deltaOf(SUMMARY_DATA, previous, (d) => d.profile.rank), 4);
});

test('one reading is not a comparison, and says nothing rather than zero', () => {
  assert.deepEqual(comparability(SUMMARY_DATA, null), { ok: false, reason: '' });
  assert.equal(deltaOf(SUMMARY_DATA, null, (d) => d.profile.backlinks), null);
  // A missing field on one side is not a change of zero either.
  const previous = { ...SUMMARY_DATA, profile: { ...SUMMARY_DATA.profile, backlinks: null } };
  assert.equal(deltaOf(SUMMARY_DATA, previous, (d) => d.profile.backlinks), null);
});

test('the freshness stamp carries the link set, not a rebuild date', () => {
  /**
   * The Labs stamp carries `indexUpdatedAt`, which is the day their database was
   * last rebuilt and the whole reason those panels say "competitive index". The
   * backlink index is rebuilt continuously, so there is no rebuild date — the
   * honest facts are the link set every number was computed over and how big the
   * index is.
   */
  const stamp = backlinkFreshness(summarySnapshot());
  assert.equal(stamp.statusType, 'live');
  assert.equal(stamp.rankScale, 'one_thousand');
  assert.equal(stamp.index.backlinks, 1_950_000_000_000);
  assert.equal('indexUpdatedAt' in stamp, false);
});

// ---------------------------------------------------------------------------
// 4. Anchors — weighted by domains, never by link count
// ---------------------------------------------------------------------------

test('the anchor mix is weighted by ROOT DOMAINS, so one footer cannot own it', () => {
  const rows = anchorRowsFrom(ANCHORS_SNAPSHOT, 'acme.com');
  const mix = anchorMix(rows);

  const empty = mix.find((k) => k.key === 'empty');
  const branded = mix.find((k) => k.key === 'branded');

  /**
   * The sitewide footer is 40,000 of the 45,400 backlinks in this profile — 88%
   * — and 2 of the 400 root domains, which is 0.5%. Weighted by links, "image
   * link with no alt text" is the site's anchor profile. Weighted by domains it
   * is what it is: one website's template.
   */
  assert.equal(empty.domains, 2);
  assert.equal(empty.share, 0.005);
  assert.equal(branded.domains, 280);
  assert.equal(branded.share, 0.7);
  assert.ok(branded.share > empty.share * 100);
});

test('an anchor is classified into the five kinds, and empty is one of them', () => {
  const terms = brandTermsFor('acme.com');
  assert.deepEqual(terms, ['acme']);

  assert.equal(classifyAnchor('', terms), 'empty');
  assert.equal(classifyAnchor('   ', terms), 'empty');
  assert.equal(classifyAnchor('Acme CRM', terms), 'branded');
  assert.equal(classifyAnchor('https://acme.com/pricing', terms), 'url');
  assert.equal(classifyAnchor('www.acme.com', terms), 'url');
  assert.equal(classifyAnchor('click here', terms), 'generic');
  assert.equal(classifyAnchor('best agency software', terms), 'other');

  // A hyphenated brand yields the whole name and its useful parts, because a
  // branded anchor misfiled as "other" inflates the number somebody acts on.
  assert.deepEqual(brandTermsFor('acme-crm.co.uk'), ['acme-crm', 'acme', 'crm']);
  assert.equal(classifyAnchor('the acme-crm blog', brandTermsFor('acme-crm.co.uk')), 'branded');
  assert.deepEqual(brandTermsFor(''), []);
});

test('an anchor row carries its share of the DOMAIN weight, from the stored total', () => {
  const rows = anchorRowsFrom(ANCHORS_SNAPSHOT, 'acme.com');
  const branded = rows.find((r) => r.anchor === 'acme crm');
  assert.equal(branded.referringMainDomains, 280);
  assert.equal(branded.share, 0.7);

  // No stored weight means no share — never a denominator invented from the
  // rows on screen, which would move every time somebody filtered the table.
  const noWeight = anchorRowsFrom(
    { data: { ...ANCHORS_SNAPSHOT.data, totals: {} } },
    'acme.com'
  );
  assert.equal(noWeight[0].share, null);
});

test('the anchor filters and sort keep blanks last in both directions', () => {
  const rows = anchorRowsFrom(ANCHORS_SNAPSHOT, 'acme.com');

  const generic = filterAnchorRows(rows, { buckets: ['class:generic'] });
  assert.deepEqual(generic.map((r) => r.anchor), ['click here']);

  const searched = filterAnchorRows(rows, { query: 'acme' });
  assert.deepEqual(searched.map((r) => r.anchor), ['acme crm', 'https://acme.com/pricing']);

  // The empty anchor sorts LAST by name in both directions rather than first in
  // one of them, which is the blanks-last rule `sortRowsBy` owns.
  const asc = sortAnchorRows(rows, { key: 'anchor', dir: 'asc' });
  const desc = sortAnchorRows(rows, { key: 'anchor', dir: 'desc' });
  assert.equal(asc[asc.length - 1].anchor, '');
  assert.equal(desc[desc.length - 1].anchor, '');

  assert.equal(ANCHOR_BUCKETS.length, 5);
});

// ---------------------------------------------------------------------------
// 5. Referring domains
// ---------------------------------------------------------------------------

test('a referring-domain row keeps its nulls, and they sort last', () => {
  const rows = referringDomainRowsFrom(DOMAINS_SNAPSHOT);
  const unreadable = rows.find((r) => r.domain === 'unreadable.example');
  assert.equal(unreadable.linksRank, null);
  assert.equal(unreadable.backlinks, null);
  assert.equal(unreadable.spamBand, null);

  for (const dir of ['asc', 'desc']) {
    const sorted = sortReferringDomainRows(rows, { key: 'linksRank', dir });
    assert.equal(
      sorted[sorted.length - 1].domain,
      'unreadable.example',
      `a blank must not sort as a zero going ${dir}`
    );
  }
});

test('the sitewide filter is what stops a footer being read as four hundred votes', () => {
  const rows = referringDomainRowsFrom(DOMAINS_SNAPSHOT);
  const sitewide = filterReferringDomainRows(rows, { buckets: ['sitewide'] });
  assert.deepEqual(sitewide.map((r) => r.domain), ['linkfarm.example']);

  const single = filterReferringDomainRows(rows, { buckets: ['single'] });
  assert.deepEqual(single.map((r) => r.domain), ['nytimes.com']);

  const broken = filterReferringDomainRows(rows, { buckets: ['broken'] });
  assert.deepEqual(broken.map((r) => r.domain), ['nytimes.com']);

  const high = filterReferringDomainRows(rows, { buckets: ['spam:high'] });
  assert.deepEqual(high.map((r) => r.domain), ['linkfarm.example']);

  assert.equal(REFERRING_DOMAIN_BUCKETS.length, 6);
});

test('spam bands are the DOMAIN-level ones, and a missing score has no band', () => {
  /**
   * There is a second, different set of bands at LINK level (0-44 / 45-59 /
   * 60-100). Using one for the other misreports by a whole band, which is why
   * only the set this file draws is carried here.
   */
  assert.deepEqual(SPAM_BANDS.map((b) => [b.min, b.max]), [
    [0, 30],
    [31, 60],
    [61, 100],
  ]);
  assert.equal(spamBandFor(0).key, 'low');
  assert.equal(spamBandFor(30).key, 'low');
  assert.equal(spamBandFor(31).key, 'medium');
  assert.equal(spamBandFor(61).key, 'high');
  assert.equal(spamBandFor(null), null);
  assert.equal(spamBandFor(undefined), null);
});

test('a breakdown becomes shares that sum to the whole, or nothing at all', () => {
  const slices = breakdownSlices(SUMMARY_DATA.profile.breakdowns.tld);
  assert.deepEqual(
    slices.map((s) => [s.key, s.share]),
    [
      ['.com', 0.727],
      ['.org', 0.191],
      ['.co.uk', 0.082],
    ]
  );
  assert.deepEqual(breakdownSlices(null), []);
  assert.deepEqual(breakdownSlices([]), []);
  // All-zero counts would divide by zero rather than draw an empty ring.
  assert.deepEqual(breakdownSlices([{ key: 'x', count: 0 }]), []);
});

// ---------------------------------------------------------------------------
// 6. The growth series
// ---------------------------------------------------------------------------

test('a month with flows and no levels stays a GAP, never a zero', () => {
  const points = growthPointsFrom(TIMESERIES_SNAPSHOT);
  assert.equal(points.length, 3);

  const june = points[0];
  /**
   * June has new/lost counts and no level reading. Drawn as 0 the chart would
   * show every link disappearing and coming back; carried forward it would draw
   * a flat line, which is a claim that nothing changed. Null breaks the line,
   * which is the only honest option and the same rule the rank chart follows.
   */
  assert.equal(june.backlinks, null);
  assert.equal(june.newBacklinks, 900);
  assert.equal(points[2].backlinks, 48_000);
});

test('lost links stay POSITIVE in the data, so an export can be summed', () => {
  const points = growthPointsFrom(TIMESERIES_SNAPSHOT);
  assert.equal(points[2].lostBacklinks, 500);
  assert.ok(points.every((p) => p.lostBacklinks === null || p.lostBacklinks >= 0));
});

test('the growth summary quotes the window its new/lost counts are relative to', () => {
  const summary = growthSummary(TIMESERIES_SNAPSHOT);
  /**
   * DataForSEO computes new and lost RELATIVE TO `date_from`, so the same
   * month's numbers are different under a different start date and there is
   * nothing in the series to say which was used. Carried forward so a caption
   * can name it.
   */
  assert.deepEqual(summary.window, { from: '2024-09-01', to: '2026-09-03', group: 'month' });
  assert.equal(summary.newBacklinks, 4_400);
  assert.equal(summary.lostBacklinks, 1_400);
  assert.equal(summary.change, 2_000);
  assert.equal(summary.statusType, 'live');

  // A change needs two ends. One reading is not a trend.
  const single = growthSummary({
    data: { totals: { buckets: 1, firstBacklinks: 46_000, lastBacklinks: null } },
  });
  assert.equal(single.change, null);
  assert.equal(growthSummary(null), null);
});

// ---------------------------------------------------------------------------
// 7. The variant with no market in it
// ---------------------------------------------------------------------------

test('a domain-scoped variant is NAMED rather than rendered as location nought', () => {
  /**
   * Backlinks takes no location, no language and no device, so its variant key
   * collapses to `0|any|any`. Read through `marketLabel`'s ordinary rules that
   * comes out as "all devices · loc 0" — a location code of nought, printed in
   * the caption of every panel, in a PDF subtitle and in a column of every
   * exported spreadsheet.
   *
   * Named instead, because "there is no market dimension" is a fact about the
   * data rather than a missing field.
   */
  assert.equal(marketLabel('0|any|any'), 'Whole domain');

  // And the two shapes that already existed are untouched.
  assert.equal(marketLabel('2840|en|desktop'), 'desktop · EN · loc 2840');
  assert.equal(marketLabel('2840|en|any'), 'all devices · EN · loc 2840');
  assert.equal(marketLabel('default'), 'Default');
});

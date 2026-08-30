const test = require('node:test');
const assert = require('node:assert/strict');

const { FIELDS, FIELD_KEYS, getField, isField, readField, widestGap } = require('./fields');
const { KIND_KEYS } = require('./kinds');
const K = require('./onpageChecks');
const C = require('./constants');
const { aggregateAudit } = require('./onpageNormalise');
const { aggregatePositions } = require('./normalise');
const { aggregateSummary } = require('./backlinksNormalise');
const { SOURCE_TYPES } = require('../fieldMapping');

/**
 * The mappable field catalog — a hundred and ten entries against the first
 * provider's twenty-six, and every one of them a place a wrong number can reach
 * a client report through a goal cell that has no caption on it.
 *
 * Four properties are worth more than the rest, and each has its own section:
 *
 *   THE DECLARATIONS. A field naming a kind this provider does not collect, or
 *   a type `fieldMapping` cannot accept, is savable and then permanently
 *   unfillable — indistinguishable from "the sync has not run yet", which is
 *   why nobody reports it. And a key is a URL PATH SEGMENT here, which the
 *   first provider's catalog never had to care about.
 *
 *   THE ISSUE LIST IS GENERATED, not typed. That is the whole of the
 *   keyed-versus-flattened decision: the catalog is a function of
 *   `onpageChecks.CHECKS`, so classifying a check DataForSEO added is the only
 *   act needed to make it goal-mappable. The test asserts the FUNCTION rather
 *   than the resulting list, because a list would have to be re-typed every time
 *   and would then be a second declaration of the same thing.
 *
 *   NOTHING HERE INVERTS A COUNTER. Ten of DataForSEO's counters count pages
 *   that PASS, and `issueCountFor` is the only place in the codebase that turns
 *   one into an issue count. Every generated reader takes `pages` and not
 *   `rawCount`, and the fixture below is built so those two are different
 *   numbers for every row.
 *
 *   NOTHING HERE SUBTRACTS A DOFOLLOW COUNT. `*_nofollow` means "at least one
 *   nofollow link", so the sets overlap; the fixture is built so the subtraction
 *   (900) and the truth (null, because the filtered call did not answer) cannot
 *   be confused.
 */

// ---------------------------------------------------------------------------
// Fixtures — built through the REAL normalisers wherever the shape is subtle
// ---------------------------------------------------------------------------

const PAGES_CRAWLED = 120;

/**
 * A crawl summary, run through `aggregateAudit` rather than hand-written.
 *
 * That is deliberate and it is what makes the inversion assertions mean
 * anything: `issues[]` here is produced by `issuesFrom` -> `issueCountFor`, so
 * the numbers a field reads are the numbers the product stores. A hand-written
 * `issues[]` would let a reader that inverted a second time pass.
 */
const auditData = aggregateAudit({
  summaryRow: {
    crawl_progress: 'finished',
    crawl_status: { max_crawl_pages: 1000, pages_in_queue: 0, pages_crawled: PAGES_CRAWLED },
    crawl_stop_reason: null,
    domain_info: {
      name: 'acme.com',
      total_pages: PAGES_CRAWLED,
      crawl_start: '2026-09-03 04:00:00 +00:00',
      crawl_end: '2026-09-03 04:41:12 +00:00',
      ssl_info: {
        valid_certificate: true,
        certificate_expiration_date: '2027-01-14 00:00:00 +00:00',
      },
      checks: { sitemap: true, robots_txt: true },
    },
    page_metrics: {
      onpage_score: 82.53,
      links_internal: 5400,
      links_external: 210,
      broken_links: 14,
      duplicate_title: 12,
      checks: {
        // Positive counters: pages that PASS. `canonical` is weight 0 and is
        // therefore not mappable, but it still has to survive the read.
        canonical: 96,
        is_https: PAGES_CRAWLED,
        has_meta_title: 113,
        // Ordinary issue counters.
        no_title: 7,
        no_description: 31,
        no_image_alt: 64,
        no_h1_tag: 9,
        high_loading_time: 4,
        broken_links: 14,
        low_content_rate: 5,
      },
    },
  },
  pageRows: [],
  config: C.ONPAGE_CRAWL_CONFIG,
  domain: 'acme.com',
  collectedAt: '2026-09-03T04:41:12.000Z',
});

const positionsData = aggregatePositions(
  [
    {
      keyword: 'seo agency london',
      rank: 4,
      rankAbsolute: 9,
      url: 'https://acme.com/seo',
      ranked: true,
      itemTypes: ['organic', 'people_also_ask', 'local_pack'],
      resultsCount: 4_120_000,
      organicCount: 100,
    },
    {
      // Outside the hundred we bought. A FINAL answer, not a missing reading.
      keyword: 'cheap seo',
      rank: null,
      rankAbsolute: null,
      url: null,
      ranked: false,
      itemTypes: [],
      resultsCount: null,
      organicCount: 100,
    },
  ],
  { domain: 'acme.com', depth: 100, collectedAt: new Date('2026-09-01T06:12:00.000Z') }
);

/**
 * A link profile whose filtered second call NEVER RAN.
 *
 * The numbers are chosen so the tempting subtraction and the truth are visibly
 * different: `1010 - 110` is 900, and the honest answer is null.
 */
const backlinksData = aggregateSummary({
  profile: {
    target: 'acme.com',
    rank: 412,
    backlinks: 48_200,
    backlinksNofollow: 9_100,
    referringDomains: 1010,
    referringDomainsNofollow: 110,
    referringMainDomains: 870,
    brokenBacklinks: 41,
    brokenPages: 12,
    referringIps: 640,
    referringSubnets: 410,
    spamScore: 18,
    firstSeen: '2019-04-02T00:00:00.000Z',
  },
  dofollow: null,
  authority: [
    { target: 'acme.com', authorityRank: 412 },
    { target: 'competitor.com', authorityRank: 688 },
  ],
  domain: 'acme.com',
  collectedAt: '2026-09-01T00:00:00.000Z',
});

const gapData = {
  domain: 'acme.com',
  comparisons: [
    { competitor: 'small.com', totals: { missing: 12, volumeAtStake: 900 } },
    { competitor: 'giant.com', totals: { missing: 480, volumeAtStake: 141_000 } },
    { competitor: 'mid.com', totals: { missing: 310, volumeAtStake: 90_000 } },
  ],
  totals: { competitors: 3, missing: 802 },
};

// ---------------------------------------------------------------------------
// The declarations
// ---------------------------------------------------------------------------

test('every field declares a type a goal target can accept', () => {
  for (const field of FIELDS) {
    assert.ok(
      SOURCE_TYPES.includes(field.type),
      `${field.key} declares "${field.type}", which no goal target accepts`
    );
  }
});

test('every field names a kind this provider actually collects', () => {
  for (const field of FIELDS) {
    assert.ok(KIND_KEYS.includes(field.kind), `${field.key} names kind "${field.kind}"`);
  }
});

test('every kind is reachable from a goal', () => {
  // A collected kind with no mappable field is a purchase whose result can never
  // reach a goal — money spent on a screen and nothing else.
  const covered = new Set(FIELDS.map((f) => f.kind));
  for (const key of KIND_KEYS) {
    assert.ok(covered.has(key), `nothing on ${key} can be bound to a goal`);
  }
});

test('a field key is safe to put in a URL path, because it is put in one', () => {
  // `PUT /boards/:id/connectors/:provider/fields/:field` takes the key
  // unencoded. This is why the audit issues are `issue_broken_links` rather
  // than `issue:broken_links`.
  for (const key of FIELD_KEYS) {
    assert.match(key, /^[a-z0-9_]+$/, `${key} is not a safe path segment`);
  }
});

test('no field key is declared twice', () => {
  const seen = new Set();
  for (const key of FIELD_KEYS) {
    assert.equal(seen.has(key), false, `${key} is declared twice`);
    seen.add(key);
  }
});

test('the 0-1000 rank is never labelled DA or DR', () => {
  // DataForSEO say in as many words that it should not be expected to match
  // Ahrefs' Domain Rating. A label is what ends up on a client report.
  for (const field of FIELDS) {
    assert.doesNotMatch(
      field.label,
      /domain authority|domain rating|\bDA\b|\bDR\b/i,
      `${field.key} is labelled "${field.label}"`
    );
  }
  assert.match(getField('domain_rank').label, /0-1000/);
});

test('a referring domain’s own rank is not offered under any name', () => {
  // On a referring-domain row `rank` is the rank of the links THAT DOMAIN SENDS
  // US, not its standing — a link farm sending four hundred sitewide links
  // scores 940 and a newspaper sending one editorial link scores 210.
  const onReferringDomains = FIELDS.filter((f) => f.kind === 'referring_domains');
  for (const field of onReferringDomains) {
    assert.doesNotMatch(field.key, /rank/, `${field.key} reads like an authority number`);
  }
});

// ---------------------------------------------------------------------------
// The generated audit issue list
// ---------------------------------------------------------------------------

const issueFields = () => FIELDS.filter((f) => f.key.startsWith('issue_'));

test('the issue catalog is a FUNCTION of the check catalog, not a typed list', () => {
  // The line is DataForSEO's own: `weight > 0` is exactly the twelve errors
  // summing to 78 and the twenty-two warnings summing to 123 that their
  // published formula is computed over. Classifying a check they add later is
  // the only act needed to make it goal-mappable.
  const expected = K.CHECKS.filter((c) => c.weight > 0).map((c) => `issue_${c.key}`);
  assert.deepEqual(issueFields().map((f) => f.key), expected);
  assert.equal(expected.length, 34);
});

test('a weightless notice is not mappable, and neither is a mirror', () => {
  // A weight-0 notice does not move `onpage_score`. And `has_meta_title` mirrors
  // `no_title` — the same population under two names — so offering both would
  // let one month's promise be bound twice.
  const keys = new Set(issueFields().map((f) => f.key));
  assert.equal(keys.has('issue_is_redirect'), false);
  assert.equal(keys.has('issue_has_meta_title'), false);
  assert.equal(keys.has('issue_canonical'), false);
  for (const spec of K.CHECKS.filter((c) => c.mirrors)) {
    assert.equal(keys.has(`issue_${spec.key}`), false, `${spec.key} mirrors ${spec.mirrors}`);
  }
});

test('every issue reader takes `pages`, never `rawCount`', () => {
  /**
   * THE INVERSION IS NOT REIMPLEMENTED HERE, and this is the test that says so.
   *
   * The fixture gives every issue row a `rawCount` that differs from its
   * `pages`, so a reader reaching for the raw counter — which is what a second
   * implementation of the direction would do — returns the wrong number for all
   * thirty-four rather than passing by luck on the ones where they agree.
   */
  const data = {
    issues: issueFields().map((field, i) => ({
      key: field.key.slice('issue_'.length),
      rawCount: 900 + i,
      pages: 10 + i,
      positive: true,
    })),
  };
  issueFields().forEach((field, i) => {
    assert.equal(readField(field.key, data), 10 + i, field.key);
  });
});

test('an issue field reads the row the real normaliser wrote', () => {
  // Straight through the crawl fixture, so the number a goal would receive is
  // the number the product stores.
  assert.equal(readField('issue_no_title', auditData), 7);
  assert.equal(readField('issue_no_image_alt', auditData), 64);
  assert.equal(readField('issue_broken_links', auditData), 14);
  // A check the crawl did not report at all is null, never 0 — "no pages have
  // this problem" and "we did not look" are opposite facts.
  assert.equal(readField('issue_flash', auditData), null);
});

// ---------------------------------------------------------------------------
// The headline audit readers
// ---------------------------------------------------------------------------

test('the audit headline numbers come off the stored body verbatim', () => {
  assert.equal(readField('onpage_score', auditData), 82.53);
  assert.equal(readField('pages_crawled', auditData), PAGES_CRAWLED);
  assert.equal(readField('internal_links', auditData), 5400);
  assert.equal(readField('external_links', auditData), 210);
  assert.equal(readField('crawl_ended_on', auditData), '2026-09-03');
  assert.equal(readField('ssl_expires_on', auditData), '2027-01-14');
  assert.equal(
    readField('audit_error_pages', auditData),
    auditData.issueTotals.error.pages
  );
  assert.equal(
    readField('audit_error_findings', auditData),
    auditData.issueTotals.error.findings
  );
});

test('nothing in the catalog carries a site-wide boolean', () => {
  /**
   * `domain_info.ssl.valid` and the eleven site-wide `domain_info.checks` are
   * the only values DataForSEO return that this catalog cannot hold, because
   * `SOURCE_TYPES` has no boolean and widening it is a change to the generic
   * engine on behalf of one provider. Asserted rather than left as a comment, so
   * that adding one is a deliberate act with a failing test in front of it.
   */
  assert.equal(SOURCE_TYPES.includes('boolean'), false);
  for (const field of FIELDS) {
    const value = field.read(auditData, { keyword: 'seo agency london' });
    assert.notEqual(typeof value, 'boolean', `${field.key} returned a boolean`);
  }
});

// ---------------------------------------------------------------------------
// Rank
// ---------------------------------------------------------------------------

test('rank reads the keyword’s own row, and a null outside the depth is an ANSWER', () => {
  assert.equal(readField('rank', positionsData, { keyword: 'seo agency london' }), 4);
  assert.equal(readField('rank_absolute', positionsData, { keyword: 'seo agency london' }), 9);
  assert.equal(
    readField('ranking_url', positionsData, { keyword: 'seo agency london' }),
    'https://acme.com/seo'
  );
  assert.equal(readField('rank', positionsData, { keyword: 'cheap seo' }), null);
  assert.ok(getField('rank').nullMeans, 'the null outside the depth needs a sentence');
  // A keyword the last collection did not carry is a gap and carries no
  // sentence of its own — the writeback treats both as "do not write".
  assert.equal(readField('rank', positionsData, { keyword: 'not tracked' }), null);
});

test('the keyword is matched case-insensitively, because two people typed it', () => {
  assert.equal(readField('rank', positionsData, { keyword: 'SEO Agency London' }), 4);
});

test('SERP features arrive as a readable line rather than an array', () => {
  assert.equal(
    readField('serp_features', positionsData, { keyword: 'seo agency london' }),
    'organic, people_also_ask, local_pack'
  );
  // An empty list is an absence, not an empty cell somebody cleared.
  assert.equal(readField('serp_features', positionsData, { keyword: 'cheap seo' }), null);
});

test('the daily kind has its own fields, because it is a different measurement', () => {
  // `movement` is bought to depth 10 and `positions` to depth 100, so a keyword
  // at 40 reads 40 in one and null in the other. One field serving both would
  // make a goal unable to say which it meant.
  const daily = FIELDS.filter((f) => f.kind === 'movement');
  assert.ok(daily.length >= 5);
  assert.equal(readField('daily_rank', positionsData, { keyword: 'seo agency london' }), 4);
  assert.equal(getField('daily_rank').kind, 'movement');
  assert.equal(getField('rank').kind, 'positions');
});

test('the project totals never average an unranked keyword in as zero', () => {
  assert.equal(readField('keywords_tracked', positionsData), 2);
  assert.equal(readField('keywords_ranked', positionsData), 1);
  assert.equal(readField('average_rank', positionsData), 4);
  assert.equal(readField('collected_on', positionsData), '2026-09-01');
});

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

test('a dofollow count is never derived by subtraction', () => {
  /**
   * `referringDomains - referringDomainsNofollow` is 900 on this fixture and it
   * is wrong: a domain linking twice, once followed and once not, is in both
   * terms. The honest answer when the filtered call did not run is null.
   */
  assert.equal(readField('referring_domains_total', backlinksData), 1010);
  assert.equal(readField('dofollow_referring_domains', backlinksData), null);
  assert.notEqual(readField('dofollow_referring_domains', backlinksData), 900);
  assert.equal(readField('dofollow_backlinks', backlinksData), null);
  assert.ok(getField('dofollow_backlinks').nullMeans, 'the null needs a sentence');
});

test('authority comes from bulk_ranks and picks OUR row out of it', () => {
  // The competitor in the same list is at 688. Reading the first row, or the
  // highest, would report somebody else's standing as ours.
  assert.equal(readField('authority_rank', backlinksData), 412);
  assert.equal(readField('domain_rank', backlinksData), 412);
});

test('the profile numbers are read off `profile`, not off the top level', () => {
  assert.equal(readField('backlinks_total', backlinksData), 48_200);
  assert.equal(readField('referring_root_domains', backlinksData), 870);
  assert.equal(readField('broken_backlinks', backlinksData), 41);
  assert.equal(readField('referring_subnets', backlinksData), 410);
  assert.equal(readField('backlink_spam_score', backlinksData), 18);
  assert.equal(readField('first_backlink_seen_on', backlinksData), '2019-04-02');
});

test('net new backlinks refuses to answer with half the pair', () => {
  const both = { totals: { newBacklinks: 300, lostBacklinks: 120 } };
  assert.equal(readField('net_new_backlinks', both), 180);
  assert.equal(readField('net_new_backlinks', { totals: { newBacklinks: 300 } }), null);
  assert.equal(readField('net_new_backlinks', { totals: {} }), null);
});

// ---------------------------------------------------------------------------
// The gap report — three fields that have to describe ONE comparison
// ---------------------------------------------------------------------------

test('the three gap fields all describe the same competitor', () => {
  // "Widest gap is against small.com" beside a count taken from giant.com is
  // worse than no answer at all, so all three read one resolved comparison.
  assert.equal(widestGap(gapData).competitor, 'giant.com');
  assert.equal(readField('gap_widest_competitor', gapData), 'giant.com');
  assert.equal(readField('gap_widest_missing', gapData), 480);
  assert.equal(readField('gap_widest_volume', gapData), 141_000);
  // The report's OWN total sums the comparisons, so it is offered as what it is
  // and never as the widest one.
  assert.equal(readField('gap_competitors', gapData), 3);
});

test('a gap report with no comparisons answers null rather than throwing', () => {
  assert.equal(readField('gap_widest_competitor', { comparisons: [] }), null);
  assert.equal(readField('gap_widest_missing', {}), null);
});

// ---------------------------------------------------------------------------
// Every reader, against payloads it was not written for
// ---------------------------------------------------------------------------

const GARBAGE = [
  null,
  undefined,
  {},
  { keywords: null, totals: null, issues: 'nope', profile: 3 },
  { keywords: [{ keyword: 'k', rank: 'four' }], totals: { ranked: '2' } },
  { issues: [{ key: 'no_title', pages: 'seven' }] },
  { profile: { rank: NaN }, authority: 'not a list' },
  { comparisons: [{ totals: null }] },
  [],
];

test('a number field returns a finite number or null, never NaN or a string', () => {
  for (const data of GARBAGE) {
    for (const field of FIELDS.filter((f) => f.type === 'number')) {
      const value = readField(field.key, data, { keyword: 'k' });
      assert.ok(
        value === null || (typeof value === 'number' && Number.isFinite(value)),
        `${field.key} returned ${JSON.stringify(value)}`
      );
    }
  }
});

test('a text or link field never returns an empty string', () => {
  // An empty string in a cell is indistinguishable from a value somebody typed
  // and then cleared, which is the distinction the ownership rule turns on.
  const blank = {
    keywords: [{ keyword: 'k', url: '   ', intent: '', itemTypes: ['', '  '] }],
    totals: { topDomain: '  ', topPage: '' },
    comparisons: [{ competitor: '   ', totals: { missing: 4 } }],
  };
  for (const data of [...GARBAGE, blank]) {
    for (const field of FIELDS.filter((f) => f.type === 'text' || f.type === 'link')) {
      const value = readField(field.key, data, { keyword: 'k' });
      assert.ok(value === null || value.trim() !== '', `${field.key} returned ${JSON.stringify(value)}`);
    }
  }
});

test('a date field returns a day key or null, never an Invalid Date', () => {
  const nonsense = {
    collectedAt: 'the third of never',
    crawl: { endedAt: '' },
    domainInfo: { ssl: { expiresAt: null } },
    profile: { firstSeen: 'yesterday' },
    indexUpdatedAt: 0,
  };
  for (const data of [...GARBAGE, nonsense]) {
    for (const field of FIELDS.filter((f) => f.type === 'date')) {
      const value = readField(field.key, data, { keyword: 'k' });
      assert.ok(
        value === null || /^\d{4}-\d{2}-\d{2}$/.test(value),
        `${field.key} returned ${JSON.stringify(value)}`
      );
    }
  }
});

test('a keyword-scoped field reads null when nobody said which keyword', () => {
  // The writeback skips these before it gets here, but a reader that guessed
  // the first row would produce an entirely plausible number in the wrong goal.
  for (const field of FIELDS.filter((f) => f.scope === 'keyword')) {
    assert.equal(readField(field.key, positionsData, {}), null, field.key);
  }
});

// ---------------------------------------------------------------------------
// The lookup surface
// ---------------------------------------------------------------------------

test('an unknown field key reads null rather than throwing', () => {
  // A mapping row can outlive the field it names. A weekly run that crashed
  // there would take every other field on the board down with it.
  assert.equal(getField('no_such_field'), null);
  assert.equal(isField('no_such_field'), false);
  assert.equal(readField('no_such_field', positionsData, { keyword: 'k' }), null);
  assert.equal(readField('issue_a_check_nobody_classified', auditData), null);
});

test('getField and isField agree with the catalog', () => {
  for (const key of FIELD_KEYS) {
    assert.equal(isField(key), true);
    assert.equal(getField(key).key, key);
  }
});

test('every entry carries the copy the mapping panel renders', () => {
  for (const field of FIELDS) {
    assert.ok(field.label, `${field.key} needs a label`);
    assert.ok(field.blurb, `${field.key} needs a blurb`);
    assert.ok(['keyword', 'project'].includes(field.scope), `${field.key} scope`);
    assert.equal(typeof field.read, 'function');
  }
});

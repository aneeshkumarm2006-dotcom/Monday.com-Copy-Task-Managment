const test = require('node:test');
const assert = require('node:assert/strict');

const N = require('./normalise');

/**
 * The normalisers, exercised against the shapes `llms.md` documents and the
 * shapes it does not.
 *
 * ---- What these tests are actually protecting ------------------------------
 *
 * ONE SEMANTIC ABOVE ALL: a rank of `null` on a keyword whose `status` is `ok`
 * means "this domain does not rank in the top 100". The documentation is
 * explicit that it is a final answer and "NOT a 'still loading' state". If a
 * normaliser ever smooths that into the same output as a missing field, a failed
 * sync and an honest "not ranking" become indistinguishable — and the tab would
 * render both as an empty cell, which is the single most misleading thing this
 * feature could do to an SEO team.
 *
 * The rest is tolerance. Every response table these tools have is reproduced
 * below, but four of the five kinds are documented only as "the raw Ubersuggest
 * API payload (fields defined by the backend)" — so the tests assert that an
 * unexpected shape DEGRADES rather than throws, and that a renamed field costs a
 * null rather than a run.
 */

// ---------------------------------------------------------------------------
// positions
// ---------------------------------------------------------------------------

/** The documented shape, verbatim from the response table. */
const positionsPayload = {
  done: true,
  updated_at: '2026-08-24T06:12:00.000Z',
  keywords: [
    {
      keyword: 'luxury lingerie',
      status: 'ok',
      old_position: { position: 8 },
      new_position: { position: 3 },
    },
    {
      keyword: 'silk robes',
      status: 'ok',
      old_position: { position: 4 },
      new_position: { position: 11 },
    },
    {
      // The case that must never look like a failure.
      keyword: 'bridal corset',
      status: 'ok',
      old_position: { position: null },
      new_position: { position: null },
    },
    {
      keyword: 'satin slip',
      status: 'ok',
      old_position: { position: null },
      new_position: { position: 42 },
    },
    {
      keyword: 'lace bodysuit',
      status: 'ok',
      old_position: { position: 19 },
      new_position: { position: null },
    },
  ],
  binned: { not_ranking: 1 },
  average_positions: {
    positions: [
      { date: '2026-08-17', position: 24.5 },
      { date: '2026-08-10', position: 27.1 },
    ],
  },
};

test('positions: a null rank with status ok is "not in top 100", not a gap', () => {
  const out = N.normalisePositions(positionsPayload);
  const row = out.keywords.find((k) => k.keyword === 'bridal corset');

  assert.equal(row.position, null);
  // `ranked` is what separates "the provider said null" from "the provider did
  // not send the field". Both are `position: null`; only one is an answer.
  assert.equal(row.ranked, true);
  assert.equal(row.status, 'ok');
  assert.equal(row.movement, 'none');
});

test('positions: a field the provider omitted is NOT reported as not-ranking', () => {
  const out = N.normalisePositions({
    keywords: [{ keyword: 'orphan', status: 'ok' }],
  });
  assert.equal(out.keywords[0].position, null);
  assert.equal(out.keywords[0].ranked, false);
});

test('positions: movement is previous minus current, so positive means better', () => {
  const out = N.normalisePositions(positionsPayload);
  const up = out.keywords.find((k) => k.keyword === 'luxury lingerie');
  const down = out.keywords.find((k) => k.keyword === 'silk robes');

  // 8 → 3 is an improvement of five places.
  assert.equal(up.change, 5);
  assert.equal(up.movement, 'up');
  // 4 → 11 is a fall of seven.
  assert.equal(down.change, -7);
  assert.equal(down.movement, 'down');
});

test('positions: entering and leaving the top 100 are movement, not nulls', () => {
  const out = N.normalisePositions(positionsPayload);
  assert.equal(out.keywords.find((k) => k.keyword === 'satin slip').movement, 'entered');
  assert.equal(out.keywords.find((k) => k.keyword === 'lace bodysuit').movement, 'lost');
});

test('positions: the provider’s own not_ranking bucket wins over our count', () => {
  // Ours would say 1 too here, but the point is that `binned` is authoritative:
  // it counts rows we may have failed to name, and disagreeing with the number
  // the provider's own UI shows is worse than being slightly redundant.
  const out = N.normalisePositions(positionsPayload);
  assert.equal(out.totals.notRanking, 1);
  assert.equal(out.totals.tracked, 5);
  assert.equal(out.totals.ranking, 3);
});

test('positions: `done` is read strictly — an unfinished report is not final', () => {
  assert.equal(N.normalisePositions({ done: true }).done, true);
  assert.equal(N.normalisePositions({ done: false }).done, false);
  // Absent means not final. Assuming otherwise would stop us ever coming back.
  assert.equal(N.normalisePositions({}).done, false);
});

test('positions: a pending keyword is counted apart from a non-ranking one', () => {
  // `pending` only appears on a brand-new project whose first SERP collection
  // has not run. It is the ONE case where a null rank really does mean "not
  // yet", and folding it into notRanking would tell a new client they rank for
  // nothing.
  const out = N.normalisePositions({
    keywords: [{ keyword: 'new thing', status: 'pending' }],
  });
  assert.equal(out.totals.pending, 1);
  assert.equal(out.totals.notRanking, 0);
});

test('positions: the average series is sorted oldest-first and survives bare numbers', () => {
  const out = N.normalisePositions(positionsPayload);
  assert.deepEqual(out.averagePositions.map((p) => p.date), ['2026-08-10', '2026-08-17']);

  const bare = N.normaliseAverageSeries([12, 14, 9]);
  assert.deepEqual(bare.map((p) => p.value), [12, 14, 9]);
});

test('positions: an unrecognised envelope degrades to empty rather than throwing', () => {
  for (const payload of [null, undefined, 'nope', 42, [], { keywords: 'no' }]) {
    const out = N.normalisePositions(payload);
    assert.deepEqual(out.keywords, []);
    assert.equal(out.done, false);
  }
});

test('positions: a `result`-wrapped payload is unwrapped', () => {
  const out = N.normalisePositions({ result: positionsPayload });
  assert.equal(out.keywords.length, 5);
});

// ---------------------------------------------------------------------------
// keyword_metrics
// ---------------------------------------------------------------------------

test('keyword_metrics: sd is SEO difficulty and pd is PAID difficulty', () => {
  // The two are trivially confusable and swapping them would put a paid number
  // in a column labelled KD — precisely the class of silent error the whole
  // connector exists to remove from these boards.
  const [row] = N.normaliseKeywordMetrics({
    searched_keywords: [
      {
        keyword: 'best crm',
        volume: 1400,
        cpc: 12.5,
        sd: 61,
        pd: 88,
        competition: 0.9,
        search_intent: 'Commercial',
      },
    ],
  });
  assert.equal(row.difficulty, 61);
  assert.equal(row.paidDifficulty, 88);
  assert.equal(row.volume, 1400);
  assert.equal(row.intent, 'Commercial');
});

test('keyword_metrics: `suggestions` is ignored entirely', () => {
  // It is the expansion half of the tool, routinely an order of magnitude
  // larger than the seeds, and nothing renders it. Storing it would bloat a
  // collection whose whole purpose is to be kept forever.
  const rows = N.normaliseKeywordMetrics({
    searched_keywords: [{ keyword: 'a', volume: 10 }],
    suggestions: [{ keyword: 'b', volume: 20 }],
  });
  assert.deepEqual(rows.map((r) => r.keyword), ['a']);
});

test('keyword_metrics: quoted and comma-formatted numbers are parsed', () => {
  const [row] = N.normaliseKeywordMetrics({
    searched_keywords: [{ keyword: 'x', volume: '1,400', cpc: '$12.50' }],
  });
  assert.equal(row.volume, 1400);
  assert.equal(row.cpc, 12.5);
});

test('keyword_metrics: a row with no keyword is dropped, not kept as null', () => {
  const rows = N.normaliseKeywordMetrics({
    searched_keywords: [{ volume: 10 }, { keyword: 'ok', volume: 20 }],
  });
  assert.equal(rows.length, 1);
});

// ---------------------------------------------------------------------------
// site_audit
// ---------------------------------------------------------------------------

const auditPayload = {
  result: {
    done: true,
    crawl_count: 150,
    crawl_max_pages: 150,
    extended_status: 'no_errors',
    report: {
      overview: { health_score: 74 },
      issues_per_category: {
        errors: [
          { id: 'broken_links', name: 'Broken links', count: 12 },
          { id: 'missing_title', name: 'Missing title', count: 30 },
        ],
        warnings: [{ id: 'long_title', name: 'Title too long', count: 4 }],
        recommendations: [],
      },
    },
  },
};

test('site_audit: the report unwraps from `result` and carries its health score', () => {
  const out = N.normaliseSiteAudit(auditPayload);
  assert.equal(out.done, true);
  assert.equal(out.healthScore, 74);
  assert.equal(out.crawled, 150);
  assert.equal(out.extendedStatus, 'no_errors');
});

test('site_audit: issues are ordered by count, because that is the work queue', () => {
  const out = N.normaliseSiteAudit(auditPayload);
  assert.deepEqual(out.categories.errors.map((i) => i.id), ['missing_title', 'broken_links']);
  assert.equal(out.totals.errors, 42);
  assert.equal(out.totals.recommendations, 0);
});

test('site_audit: an issue with no id is kept but marked unaddressable', () => {
  // Issue ids are not enumerated anywhere and are also the argument
  // `site_audit_results` takes to list affected URLs — an issue without one
  // still counts toward the total but cannot be drilled into.
  const out = N.normaliseSiteAudit({
    report: { issues_per_category: { errors: [{ name: 'Mystery', count: 3 }] } },
  });
  assert.equal(out.categories.errors[0].id, null);
  assert.equal(out.totals.errors, 3);
});

test('site_audit: an in-progress crawl still yields the counts it has', () => {
  const out = N.normaliseSiteAudit({
    result: { done: false, crawl_count: 47, crawl_max_pages: 150, report: {} },
  });
  assert.equal(out.done, false);
  assert.equal(out.crawled, 47);
  assert.deepEqual(out.categories.errors, []);
});

test('site_audit: every category exists even when the payload omits it', () => {
  // The tab renders three headings unconditionally; a missing key must be an
  // empty list rather than `undefined.length`.
  const out = N.normaliseSiteAudit({});
  for (const name of N.AUDIT_CATEGORIES) {
    assert.deepEqual(out.categories[name], []);
    assert.equal(out.totals[name], 0);
  }
});

/**
 * The shape the provider ACTUALLY sends, captured live on 2026-08-28 from
 * `site_audit_status` for a real crawled domain.
 *
 * Three things differ from the hypothetical fixture above, and all three used to
 * be read as nothing: the health score is `overall_score` and not `health_score`,
 * the page count lives on `report.overview.crawled` and not on the result root,
 * and a category is `{ count, issues: [...] }` rather than a bare array. The card
 * rendered a crawl of 1,137 pages scoring 70 with 1,334 findings as an em dash
 * and three zeros.
 */
const liveAuditPayload = {
  result: {
    done: true,
    report: {
      overview: {
        crawled: 1137,
        overall_score: 70,
        total_issues_count: 1334,
        previous_overall_score: 70,
        health_check: { broken: 41, redirected: 4, successful: 1091, blocked: 1 },
      },
      extended_status: 'no_errors',
      issues_per_category: {
        errors: {
          count: 740,
          issues: [
            { id: 'content_count_words', count: 170, seo_impact: 'high' },
            { id: 'duplicate_meta_descriptions', count: 294, seo_impact: 'high' },
            { id: 'have_title_duplicates', count: 275, seo_impact: 'high' },
            { id: 'page_allowed', count: 1, seo_impact: 'high' },
            { id: 'absent_h1_tag', count: 0, seo_impact: 'high' },
          ],
        },
        warnings: { count: 594, issues: [{ id: 'low_word_count', count: 594 }] },
        recommendations: {
          count: 0,
          issues: [{ id: 'ssl_certificate_expiration', count: 0 }],
        },
      },
    },
  },
};

test('site_audit: the LIVE payload yields a health score, a page count and real totals', () => {
  const out = N.normaliseSiteAudit(liveAuditPayload);
  assert.equal(out.healthScore, 70, 'overall_score is the health score');
  assert.equal(out.previousHealthScore, 70);
  assert.equal(out.crawled, 1137, 'the page count is on report.overview.crawled');
  assert.equal(out.extendedStatus, 'no_errors', 'extended_status sits on report');
  assert.equal(out.totals.errors, 740);
  assert.equal(out.totals.warnings, 594);
  assert.equal(out.totals.recommendations, 0);
});

test('site_audit: a category is an envelope, not an array, and its issues unwrap', () => {
  const out = N.normaliseSiteAudit(liveAuditPayload);
  assert.deepEqual(
    out.categories.errors.map((i) => i.id),
    ['duplicate_meta_descriptions', 'have_title_duplicates', 'content_count_words', 'page_allowed']
  );
});

test('site_audit: checks that PASSED are not listed as findings', () => {
  // The provider returns every check it ran, including the ones with a count of
  // zero, so a client can render a full checklist. This section lists work to
  // do; `absent_h1_tag: 0` is not work to do, and burying four real findings
  // under a list of clean checks is worse than not showing them.
  const out = N.normaliseSiteAudit(liveAuditPayload);
  assert.ok(!out.categories.errors.some((i) => i.count === 0));
  assert.deepEqual(out.categories.recommendations, []);
});

test('site_audit: the category count wins over the sum, and the two agree anyway', () => {
  // 170 + 294 + 275 + 1 = 740, which is what the provider says. Reading its own
  // number keeps the headline right if it ever sends a truncated issue list.
  const out = N.normaliseSiteAudit(liveAuditPayload);
  const summed = out.categories.errors.reduce((s, i) => s + i.count, 0);
  assert.equal(summed, 740);
  assert.equal(out.totals.errors, 740);
});

// ---------------------------------------------------------------------------
// domain_overview + backlinks — wholly undocumented payloads
// ---------------------------------------------------------------------------

test('domain_overview: reads the documented headline fields', () => {
  const out = N.normaliseDomainOverview(
    {
      organic_traffic: 18400,
      organic_keywords: 2210,
      domain_authority: 41,
      backlinks: 90210,
    },
    { traffic_value: 12750 }
  );
  assert.equal(out.organicTraffic, 18400);
  assert.equal(out.organicKeywords, 2210);
  assert.equal(out.domainAuthority, 41);
  assert.equal(out.trafficValue, 12750);
});

test('domain_overview: a field we cannot locate is null, never zero', () => {
  // A zero traffic estimate and a field we failed to find look identical on a
  // number line and mean opposite things. The tab renders null as an em dash.
  const out = N.normaliseDomainOverview({ something_else: 5 });
  assert.equal(out.organicTraffic, null);
  assert.equal(out.domainAuthority, null);
  // And the payload is kept, so the missing field is a change to this file.
  assert.deepEqual(out.overview, { something_else: 5 });
});

test('domain_overview: camelCase is accepted behind snake_case', () => {
  const out = N.normaliseDomainOverview({ organicTraffic: 12, domainAuthority: 30 });
  assert.equal(out.organicTraffic, 12);
  assert.equal(out.domainAuthority, 30);
});

test('domain_overview: a failed traffic_value leaves the rest intact', () => {
  const out = N.normaliseDomainOverview({ organic_traffic: 100 }, null);
  assert.equal(out.organicTraffic, 100);
  assert.equal(out.trafficValue, null);
});

test('backlinks: totals and anchors, anchors ordered by link count', () => {
  const out = N.normaliseBacklinks(
    { backlinks: 90210, referring_domains: 812, domain_authority: 41 },
    { anchors: [
      { anchor: 'click here', backlinks: 12 },
      { anchor: 'acme', backlinks: 300 },
    ] }
  );
  assert.equal(out.backlinks, 90210);
  assert.equal(out.referringDomains, 812);
  assert.deepEqual(out.anchors.map((a) => a.anchor), ['acme', 'click here']);
});

test('backlinks: a missing anchor list is an empty array, not undefined', () => {
  const out = N.normaliseBacklinks({ backlinks: 1 }, null);
  assert.deepEqual(out.anchors, []);
});

/**
 * The two undocumented payloads as they actually arrive, captured live
 * 2026-08-28. Both mix camelCase with the snake_case the docs imply, inside a
 * single response — which is why `pick` compares on a canonical spelling now
 * rather than on an enumerated list of casings.
 */
test('backlinks: the LIVE payload fills referring domains and the follow split', () => {
  const out = N.normaliseBacklinks(
    {
      domainAuthority: 44,
      backlinks: 43230,
      refDomains: 950,
      refDomainsGovEdu: 0,
      follow: 42138,
      noFollow: 1092,
    },
    null
  );
  assert.equal(out.backlinks, 43230);
  assert.equal(out.domainAuthority, 44);
  // `refDomains` — one capital letter away from the `refdomains` the candidate
  // list already had, and it read as null on every backlink snapshot until the
  // comparison stopped being case-sensitive.
  assert.equal(out.referringDomains, 950);
  // `follow` is not a casing of `dofollow`; it had to be named.
  assert.equal(out.dofollow, 42138);
  assert.equal(out.nofollow, 1092);
});

test('domain_overview: the LIVE payload counts organic keywords, not the sample array', () => {
  // `organicKeywords` is a fifty-row sample; `organic` is the count. A `pick`
  // that stopped at the first PRESENT key stopped at the array, `num` turned it
  // into null, and the count sitting in the same object was never read.
  const out = N.normaliseDomainOverview(
    {
      domain: 'dopethc.com',
      organic: 1275,
      traffic: 901,
      domainAuthority: 44,
      backlinks: 43230,
      refDomains: 950,
      organicKeywords: [{ keyword: 'thca shake qp' }, { keyword: 'blackout strain' }],
    },
    null
  );
  assert.equal(out.organicKeywords, 1275);
  assert.equal(out.organicTraffic, 901);
  assert.equal(out.domainAuthority, 44);
  assert.equal(out.referringDomains, 950);
});

test('domain_overview: traffic_value is unavailable on this plan and that is survivable', () => {
  // `traffic_value` answers HTTP 403 on every call for a tier3 account. The
  // number is null; nothing else about the card is.
  const out = N.normaliseDomainOverview({ organic: 1275, traffic: 901 }, null);
  assert.equal(out.trafficValue, null);
  assert.equal(out.organicTraffic, 901);
});

test('pickNum steps over a candidate that is not a number', () => {
  // The property that makes a candidate list a list of ALTERNATIVES rather than
  // a list where one bad entry shadows every later one.
  assert.equal(N.pickNum({ a: [1, 2], b: 7 }, ['a', 'b']), 7);
  assert.equal(N.pickNum({ a: 'not a number', b: 7 }, ['a', 'b']), 7);
  assert.equal(N.pickNum({ a: 3, b: 7 }, ['a', 'b']), 3);
  assert.equal(N.pickNum({}, ['a']), null);
});

test('pick falls back to a canonical spelling but never reorders a literal hit', () => {
  assert.equal(N.pick({ refDomains: 950 }, ['ref_domains']), 950);
  assert.equal(N.pick({ noFollow: 5 }, ['nofollow']), 5);
  // An exact match still wins in the order the caller gave, even when a
  // canonical match for an earlier key also exists.
  assert.equal(N.pick({ ref_domains: 1, refDomains: 2 }, ['refDomains']), 2);
});

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

test('positionOf distinguishes an explicit null from an absent field', () => {
  assert.deepEqual(N.positionOf({ position: null }), { value: null, present: true });
  assert.deepEqual(N.positionOf({}), { value: null, present: false });
  assert.deepEqual(N.positionOf(undefined), { value: null, present: false });
  assert.deepEqual(N.positionOf(null), { value: null, present: true });
  // A bare number in the slot is the obvious future simplification.
  assert.deepEqual(N.positionOf(7), { value: 7, present: true });
});

test('movementOf holds the sign convention the whole tab depends on', () => {
  assert.equal(N.movementOf(3, 8).change, 5);
  assert.equal(N.movementOf(3, 8).movement, 'up');
  assert.equal(N.movementOf(8, 3).movement, 'down');
  assert.equal(N.movementOf(5, 5).movement, 'flat');
  assert.equal(N.movementOf(5, null).movement, 'entered');
  assert.equal(N.movementOf(null, 5).movement, 'lost');
  assert.equal(N.movementOf(null, null).movement, 'none');
});

test('num refuses a non-number rather than producing NaN', () => {
  assert.equal(N.num('abc'), null);
  assert.equal(N.num(''), null);
  assert.equal(N.num(null), null);
  assert.equal(N.num(Infinity), null);
  assert.equal(N.num(0), 0);
});

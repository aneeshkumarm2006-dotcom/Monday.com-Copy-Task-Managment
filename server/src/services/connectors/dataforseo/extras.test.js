const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./constants');
const T = require('./tasks');
const B = require('../budget');
const Budget = require('./budget');
const DfsTask = require('../../../models/DfsTask');

const { KINDS, getKind, isTaskKind } = require('./kinds');
const { SCREENS, resolveScreens } = require('./screens');
const { variantsFor, variantKeyFor, readSiteForm } = require('./sites');
const { isFreeEndpoint, collectOnlyClient } = require('./collect');
const { createDfsClient } = require('./client');
const { resetPool, DB_BACKED_PREFIXES } = require('./pool');
const { comparability } = require('./comparability');
const { FIELDS, readField } = require('./fields');

const N = require('./normalise');
const toxicity = require('./toxicity');
const BN = require('./backlinksNormalise');
const BusN = require('./businessNormalise');
const { planBacklinksRequests } = require('./backlinks');
const { planBusinessRequests, businessQueryFor, runBusinessKind } = require('./business');
const A = require('./alerts');

const Notification = require('../../../models/Notification');
const NotificationPreference = require('../../../models/NotificationPreference');
const notificationService = require('../../notificationService');

/**
 * Phase 10 — Extras, and the six features are six different kinds of trap.
 *
 * 1. AI VISIBILITY. CITED and MENTIONED are different metrics with different
 *    fixes, and the tempting simplification is one "AI visibility" percentage.
 *    It also has three denominators, and mixing them makes our visibility
 *    collapse on a week Google simply showed fewer overviews.
 *
 * 2. ALERTS. A `Notification.type` with no `TYPE_CATEGORY` row IS ALWAYS
 *    DELIVERED. For a rank tracker — a machine whose whole job is noticing
 *    movement — that is the loudest possible thing in the bell with no off
 *    switch. Three registrations or none.
 *
 * 3. CANNIBALIZATION. Free from the deep census, meaningless at depth 10, and
 *    the health percentage has a denominator that turns a ranking problem into a
 *    duplication problem if it is taken over the wrong set.
 *
 * 4. TOXIC LINKS. The output is a file somebody uploads to Google Search
 *    Console, and a disavow can make a site worse. One signal is regularly
 *    innocent; the rule is a score with named reasons and a two-signal floor.
 *
 * 5. CLIENT REPORTS. Zero API cost — asserted, because a report screen that
 *    quietly fetched would buy SERPs on a page load.
 *
 * 6. LOCAL / GBP. `rating_distribution` rather than the average, because the
 *    average cannot see twenty new one-star reviews. And the fuzzy Maps query is
 *    an IDENTITY trap: a card for the wrong business subtracts beautifully.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-03T10:00:00Z');

const MARKET_VARIANT = {
  key: variantKeyFor({ locationCode: 2840, languageCode: 'en', device: 'any' }),
  locationCode: 2840,
  languageCode: 'en',
  device: 'any',
};

const project = (overrides = {}) => ({
  _id: 'proj-1',
  organisation: 'org-1',
  account: 'acct-1',
  provider: 'dataforseo',
  domain: 'acme.com',
  businessName: 'Acme Plumbing, Leeds',
  trackedKeywords: ['best crm for agencies'],
  competitors: ['rival.com'],
  targets: [{ locationCode: 2840, languageCode: 'en', device: 'desktop' }],
  ...overrides,
});

const session = {
  accountId: 'acct-1',
  organisation: 'org-1',
  getCredentials: () => ({ login: 'l', password: 'p' }),
  getQuota: () => null,
};

const envelope = ({ cost = 0, result = null }) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [
    { id: 'bd-1', status_code: 20000, status_message: 'Ok.', cost, data: {}, result },
  ],
});

const listEnvelope = ({ cost = 0, items = [] }) => envelope({ cost, result: [{ items }] });

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

const stubWorld = () => {
  const originals = {
    create: DfsTask.create,
    updateOne: DfsTask.updateOne,
    find: DfsTask.find,
    findOpenJob: T.findOpenJob,
    expireJob: T.expireJob,
    settleJobBudget: T.settleJobBudget,
    scopesFor: Budget.scopesFor,
    reserveAll: B.reserveAll,
    settleAll: B.settleAll,
  };
  const seen = { created: [], reserved: [], settled: [] };

  DfsTask.create = async (doc) => {
    seen.created.push(doc);
    const row = { ...doc, _id: 'job-1' };
    row.save = async () => row;
    return row;
  };
  DfsTask.updateOne = async () => ({ acknowledged: true });
  DfsTask.find = () => thenable([]);
  T.findOpenJob = async () => null;
  T.expireJob = async (job) => ({ attempt: job.attempt || 1, dead: false });
  T.settleJobBudget = async (job, { actualUsd }) => {
    seen.settled.push({ estimateUsd: job.estimateUsd, actualUsd });
  };
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
    seen.reserved.push(estimateUsd);
    return { ok: true };
  };
  B.settleAll = async () => ({ ok: true });

  return {
    seen,
    restore: () => {
      Object.assign(DfsTask, {
        create: originals.create,
        updateOne: originals.updateOne,
        find: originals.find,
      });
      Object.assign(T, {
        findOpenJob: originals.findOpenJob,
        expireJob: originals.expireJob,
        settleJobBudget: originals.settleJobBudget,
      });
      Budget.scopesFor = originals.scopesFor;
      B.reserveAll = originals.reserveAll;
      B.settleAll = originals.settleAll;
    },
  };
};

// ---------------------------------------------------------------------------
// 1. AI Visibility — cited and mentioned are two metrics
// ---------------------------------------------------------------------------

/**
 * The SERP the whole AI section is argued over.
 *
 * `acme.com` is CITED (it is in the per-paragraph reference list) and NOT
 * MENTIONED (the prose never says "Acme"). `rival.com` is the other way round.
 * A single blended metric would score them identically, and the two of them need
 * opposite work: one needs the brand in the answer, the other needs the link.
 */
const aiSerp = ({ cited = true, mentioned = false, topLevelRefs = true } = {}) => ({
  keyword: 'best crm',
  item_types: ['organic', 'ai_overview'],
  items: [
    {
      type: 'ai_overview',
      title: 'Choosing a CRM',
      items: [
        {
          type: 'ai_overview_element',
          text: mentioned
            ? 'Acme is widely used by agencies for pipeline tracking.'
            : 'Several tools cover pipeline tracking for agencies.',
          /** Per-paragraph references — the shape a top-level-only reader misses. */
          references: cited
            ? [{ url: 'https://acme.com/crm#:~:text=pipeline', domain: 'acme.com', rank_group: 2 }]
            : [],
        },
      ],
      references: topLevelRefs
        ? [{ url: 'https://rival.com/guide', domain: 'rival.com', rank_group: 1 }]
        : [],
    },
    { type: 'organic', rank_group: 4, rank_absolute: 6, domain: 'acme.com', url: 'https://acme.com/a' },
  ],
});

const plainSerp = (keyword) => ({
  keyword,
  item_types: ['organic'],
  items: [
    { type: 'organic', rank_group: 3, rank_absolute: 3, domain: 'acme.com', url: 'https://acme.com/x' },
  ],
});

test('CITED and MENTIONED are read apart, and neither implies the other', () => {
  const citedOnly = N.readAiOverview(aiSerp({ cited: true, mentioned: false }).items, 'acme.com');
  assert.equal(citedOnly.present, true);
  assert.equal(citedOnly.cited, true);
  assert.equal(
    citedOnly.mentioned,
    false,
    'a link in the reference list is not the brand being named in the answer'
  );

  const mentionedOnly = N.readAiOverview(
    aiSerp({ cited: false, mentioned: true }).items,
    'acme.com'
  );
  assert.equal(mentionedOnly.cited, false);
  assert.equal(
    mentionedOnly.mentioned,
    true,
    'being named in the prose with no citation is a real and DIFFERENT outcome'
  );
});

test('references are collected from the block AND from its paragraphs', () => {
  /**
   * Google increasingly attaches citations per paragraph rather than in one list
   * at the top. A reader that only took `ai_overview.references` would parse an
   * overview built that way as "cited nobody" — cleanly, with no error.
   */
  const both = N.aiReferencesIn(aiSerp().items[0]);
  assert.deepEqual(both.map((r) => r.domain), ['rival.com', 'acme.com']);

  const perParagraphOnly = N.aiReferencesIn(aiSerp({ topLevelRefs: false }).items[0]);
  assert.deepEqual(perParagraphOnly.map((r) => r.domain), ['acme.com']);
});

test('a citation URL with a scroll-to-text fragment still resolves to a host', () => {
  const refs = N.aiReferencesIn({
    references: [{ url: 'https://blog.acme.com/post#:~:text=something%20here' }],
  });
  assert.deepEqual(refs.map((r) => r.domain), ['blog.acme.com']);
});

test('no AI Overview at all is `present: false`, not "the overview ignored us"', () => {
  const none = N.readAiOverview(plainSerp('x').items, 'acme.com');
  assert.deepEqual(none, {
    present: false,
    cited: false,
    mentioned: false,
    citationRank: null,
    citationCount: null,
    references: [],
  });
});

test('the brand token is guessed from the domain, and a short one is refused', () => {
  assert.equal(N.brandTokenFor('www.acme.com'), 'acme');
  assert.equal(N.brandTokenFor('acme.co.uk'), 'acme');
  assert.equal(N.brandTokenFor('shop.acme.com.au'), 'acme');
  /**
   * A two-letter brand matches inside a hundred ordinary words, and a false
   * `mentioned` on a client report is worse than an honest gap. Refused rather
   * than searched for.
   */
  assert.equal(N.brandTokenFor('bp.com'), null);
});

test('presence is over EVERY keyword; cited and mentioned are over the ones WITH an overview', () => {
  const rows = [
    N.normaliseSerpResult(aiSerp({ cited: true, mentioned: false }), { domain: 'acme.com' }),
    N.normaliseSerpResult(plainSerp('a'), { domain: 'acme.com' }),
    N.normaliseSerpResult(plainSerp('b'), { domain: 'acme.com' }),
    N.normaliseSerpResult(plainSerp('c'), { domain: 'acme.com' }),
  ];
  const ai = N.aggregateAiVisibility(rows, 'acme.com');

  assert.equal(ai.tracked, 4);
  assert.equal(ai.withOverview, 1);
  assert.equal(ai.presenceRate, 0.25, 'presence is a fact about the MARKET, over all keywords');
  /**
   * THE DENOMINATOR TRAP. Divided by all four keywords this would be 0.25, and
   * it would fall every time Google showed fewer overviews — which draws as our
   * AI visibility collapsing on a week we did nothing.
   */
  assert.equal(ai.citedRate, 1, 'we were cited in the one overview that existed');
  assert.equal(ai.cited, 1);
  assert.equal(ai.mentioned, 0);
  assert.equal(ai.citedNotMentioned, 1);
  assert.equal(ai.mentionedNotCited, 0);
});

test('the citation-source table counts every domain Google cited, ours included', () => {
  const rows = [N.normaliseSerpResult(aiSerp(), { domain: 'acme.com' })];
  const ai = N.aggregateAiVisibility(rows, 'acme.com');

  const ours = ai.sources.find((s) => s.domain === 'acme.com');
  const theirs = ai.sources.find((s) => s.domain === 'rival.com');
  assert.equal(ours.ours, true, 'our own row is kept — it is the one a reader looks for');
  assert.equal(theirs.ours, false);
  assert.equal(ours.keywords, 1);
});

test('the catalog offers cited and mentioned separately and never as one number', () => {
  const aiFields = FIELDS.filter((f) => f.key.includes('ai_'));
  const keys = aiFields.map((f) => f.key);

  assert.ok(keys.includes('ai_cited'));
  assert.ok(keys.includes('ai_mentioned'));
  assert.ok(keys.includes('daily_ai_cited'), 'the daily kind carries its own, like every other');

  /**
   * The rule stated as a test: nothing in the catalog may be a single blended
   * "AI visibility" figure. Cited is fixed by earning links and mentioned by
   * covering the entity, and one number that moves for either tells a reader to
   * do neither.
   */
  for (const field of aiFields) {
    assert.doesNotMatch(
      field.label,
      /^AI visibility$/i,
      `${field.key} is a blended AI visibility number`
    );
  }
});

test('an AI citation position is null when uncited, and never says "not in top 100"', () => {
  const rows = [N.normaliseSerpResult(aiSerp({ cited: false }), { domain: 'acme.com' })];
  const data = N.aggregatePositions(rows, { domain: 'acme.com', depth: 100 });

  assert.equal(readField('ai_citation_position', data, { keyword: 'best crm' }), null);

  const field = FIELDS.find((f) => f.key === 'ai_citation_position');
  /**
   * `connectorFormat.formatRank` renders a null as "Not in top 100", which is a
   * sentence about search results. A citation list of eight is not a SERP, so
   * this field carries its own `nullMeans` and the screen must not route it
   * through that formatter.
   */
  assert.match(field.nullMeans, /does not cite/i);
  assert.doesNotMatch(field.nullMeans, /top 100/i);
});

test('AI visibility buys nothing: no kind, no endpoint, and the async flag stays off', () => {
  const screen = SCREENS.find((s) => s.key === 'ai_visibility');
  assert.deepEqual(screen.kinds, ['positions'], 'it draws the rank census and nothing else');

  /**
   * `load_async_ai_overview` costs +1 base price, refunded only when no overview
   * comes back. Sending it would make "the marginal API cost is ~zero" false
   * with nothing on the screen saying so, so it is a recorded decision rather
   * than an absent flag.
   */
  assert.equal(C.AI_OVERVIEW_ASYNC_LOAD, false);
  const built = T.buildRequest({
    kind: getKind('positions'),
    variant: { locationCode: 2840, languageCode: 'en', device: 'desktop' },
    domain: 'acme.com',
    keywords: ['best crm'],
  });
  assert.equal(
    JSON.stringify(built).includes('load_async_ai_overview'),
    false,
    'no SERP request carries the surcharge flag'
  );
});

// ---------------------------------------------------------------------------
// 2. Cannibalization — free from the census, and the denominator is the rule
// ---------------------------------------------------------------------------

const cannibalSerp = (keyword, ownRanks) => ({
  keyword,
  item_types: ['organic'],
  items: [
    { type: 'organic', rank_group: 1, rank_absolute: 1, domain: 'rival.com', url: 'https://rival.com/' },
    ...ownRanks.map((rank, i) => ({
      type: 'organic',
      rank_group: rank,
      rank_absolute: rank,
      domain: i % 2 === 0 ? 'acme.com' : 'blog.acme.com',
      url: `https://acme.com/page-${rank}`,
    })),
  ],
});

test('every one of our own URLs is kept, subdomains included, best first', () => {
  const row = N.normaliseSerpResult(cannibalSerp('best crm', [4, 9, 47]), { domain: 'acme.com' });

  assert.equal(row.rank, 4, 'the headline rank is still the FIRST of ours');
  assert.deepEqual(row.ownUrls.map((u) => u.rank), [4, 9, 47]);
  assert.equal(row.ownUrls.length, 3, 'blog.acme.com is ours; notacme.com would not be');
});

test('one page listed twice is one page, not a site cannibalising itself', () => {
  const row = N.normaliseSerpResult(
    {
      keyword: 'k',
      items: [
        { type: 'organic', rank_group: 3, domain: 'acme.com', url: 'https://acme.com/a' },
        { type: 'organic', rank_group: 4, domain: 'acme.com', url: 'https://acme.com/a' },
      ],
    },
    { domain: 'acme.com' }
  );
  assert.equal(row.ownUrls.length, 1);
});

test('the own-URL list is capped, which is what keeps the snapshot bounded', () => {
  const row = N.normaliseSerpResult(cannibalSerp('k', [1, 2, 3, 4, 5, 6, 7, 8]), {
    domain: 'acme.com',
  });
  assert.equal(row.ownUrls.length, C.CANNIBAL_URLS_PER_KEYWORD);
});

test('health is taken over the keywords we RANK for, not over every tracked keyword', () => {
  const rows = [
    N.normaliseSerpResult(cannibalSerp('a', [4, 9]), { domain: 'acme.com' }),
    N.normaliseSerpResult(cannibalSerp('b', [7]), { domain: 'acme.com' }),
    // Ninety-eight keywords we do not rank for at all.
    ...Array.from({ length: 98 }, (_, i) =>
      N.normaliseSerpResult(cannibalSerp(`miss-${i}`, []), { domain: 'acme.com' })
    ),
  ];
  const out = N.aggregateCannibalization(rows);

  assert.equal(out.ranking, 2);
  assert.equal(out.competing, 1);
  assert.equal(out.extraUrls, 1);
  /**
   * THE DENOMINATOR. Taken over all one hundred keywords this reads 99% healthy,
   * which is a site with a ranking problem being congratulated. Taken over the
   * two we appear for it reads 50%, which is the truth about the pages.
   */
  assert.equal(out.healthPct, 50);
});

test('a site that ranks for nothing has NULL health, never zero', () => {
  const rows = [N.normaliseSerpResult(cannibalSerp('a', []), { domain: 'acme.com' })];
  const out = N.aggregateCannibalization(rows);
  assert.equal(out.ranking, 0);
  assert.equal(
    out.healthPct,
    null,
    'zero would mean every ranking keyword is cannibalised, which is the opposite claim'
  );
});

test('the cannibalization fields exist on the CENSUS only, unlike the AI ones', () => {
  const cannibal = FIELDS.filter((f) => f.key.startsWith('cannibaliz'));
  assert.ok(cannibal.length >= 3);
  for (const field of cannibal) {
    assert.equal(
      field.kind,
      'positions',
      'a second URL at position 47 is invisible to a ten-deep daily check'
    );
  }
  // And the AI ones deliberately DO exist on both, because the overview block
  // sits above the results and arrives at either depth.
  assert.ok(FIELDS.some((f) => f.key === 'daily_ai_cited'));

  const screen = SCREENS.find((s) => s.key === 'cannibalization');
  assert.deepEqual(screen.kinds, ['positions']);
});

// ---------------------------------------------------------------------------
// 3. Toxic backlinks — a score with named reasons, never a filter
// ---------------------------------------------------------------------------

const referringDomain = (over = {}) =>
  BN.normaliseReferringDomain({
    domain: 'example.test',
    rank: 100,
    backlinks: 3,
    broken_backlinks: 0,
    broken_pages: 0,
    referring_pages: 3,
    referring_pages_nofollow: 0,
    backlinks_spam_score: 5,
    ...over,
  });

test('one signal is a WATCH and two are a suggestion — a disavow can make a site worse', () => {
  const spammyOnly = toxicity.scoreDomain(referringDomain({ backlinks_spam_score: 88 }));
  assert.deepEqual(spammyOnly.signals, ['spam']);
  assert.equal(
    spammyOnly.disavow,
    false,
    'a high spam score alone is regularly a real site on bad neighbours’ infrastructure'
  );
  assert.equal(spammyOnly.watch, true);

  const both = toxicity.scoreDomain(
    referringDomain({ backlinks_spam_score: 88, backlinks: 400, referring_pages: 400 })
  );
  assert.deepEqual(both.signals, ['spam', 'sitewide']);
  assert.equal(both.disavow, true);
  assert.equal(both.watch, false, 'a suggestion is not also a watch');
  assert.equal(C.TOXIC_DISAVOW_MIN_SIGNALS, 2);
});

test('a link that is already gone is scored, shown, and NEVER suggested', () => {
  const gone = toxicity.scoreDomain(
    referringDomain({
      backlinks_spam_score: 95,
      backlinks: 900,
      referring_pages: 900,
      lost_date: '2026-06-01 00:00:00 +00:00',
    })
  );
  assert.equal(gone.signals.length, 2);
  assert.equal(gone.lost, true);
  /**
   * Disavowing a link that no longer exists achieves nothing and pads the file
   * with rows nobody can verify. It is still shown, because "the worst thing
   * pointing at you already left" is worth knowing.
   */
  assert.equal(gone.disavow, false);
  assert.equal(gone.watch, false);
});

test('a dead referrer needs MOST of its linking pages broken, not one', () => {
  const rot = toxicity.scoreDomain(referringDomain({ referring_pages: 40, broken_pages: 1 }));
  assert.equal(rot.signals.includes('dead'), false, 'one broken page is ordinary rot');

  const abandoned = toxicity.scoreDomain(
    referringDomain({ referring_pages: 40, broken_pages: 30 })
  );
  assert.equal(abandoned.signals.includes('dead'), true);
});

test('every stored referring domain carries its score, so the two tables agree', () => {
  const agg = BN.aggregateReferringDomains(
    [
      referringDomain({ domain: 'farm.test', backlinks_spam_score: 88, backlinks: 400, referring_pages: 400 }),
      referringDomain({ domain: 'nytimes.com', backlinks_spam_score: 2, backlinks: 1, referring_pages: 1 }),
    ],
    { domain: 'acme.com' }
  );

  assert.equal(agg.domains.length, 2);
  for (const row of agg.domains) assert.ok(row.toxicity, 'scored at normalisation, not on a screen');

  assert.equal(agg.toxic.disavow, 1);
  assert.equal(agg.toxic.disavowBacklinks, 400, 'the LINK count, beside the domain count');
  assert.equal(agg.toxic.bySignal.spam, 1);
  assert.equal(agg.toxic.thresholds.minSignals, C.TOXIC_DISAVOW_MIN_SIGNALS);
});

test('the network request asks for SUBNETS, ordered by how crowded they are', () => {
  const { requests } = planBacklinksRequests({
    kind: getKind('referring_networks'),
    project: project(),
    now: NOW,
  });
  assert.equal(requests.length, 1);
  const payload = requests[0].payload;

  /**
   * At `ip` this endpoint groups by a single address, which is a shared host and
   * is mostly noise. `subnet` is the grouping a private blog network shows up in.
   */
  assert.equal(payload.network_address_type, 'subnet');
  assert.equal(C.BACKLINKS_NETWORK_ADDRESS_TYPE, 'subnet');
  /**
   * Ordered by `referring_domains` and not by `rank` — the copy-paste from the
   * referring-domains request would make the first page the STRONGEST links
   * rather than the most concentrated ones, answering a question nobody asked.
   */
  assert.deepEqual(payload.order_by, ['referring_domains,desc']);
  assert.equal(payload.backlinks_status_type, C.BACKLINKS_STATUS_TYPE);
});

test('a subnet is CONCENTRATED at three referrers, and the count is shown not judged', () => {
  const agg = BN.aggregateReferringNetworks(
    [
      BN.normaliseReferringNetwork({
        network_address: '203.0.113.0/24',
        referring_domains: 4,
        backlinks: 610,
        rank: 300,
      }),
      BN.normaliseReferringNetwork({
        network_address: '198.51.100.0/24',
        referring_domains: 1,
        backlinks: 2,
        rank: 180,
      }),
    ],
    { domain: 'acme.com' }
  );

  assert.equal(C.TOXIC_NETWORK_MIN_DOMAINS, 3);
  assert.equal(agg.networks[0].concentrated, true);
  assert.equal(agg.networks[1].concentrated, false);
  assert.equal(agg.totals.concentrated, 1);
  assert.equal(agg.totals.domainsInConcentrated, 4);
  assert.equal(agg.totals.largest, 4);
  assert.equal(agg.addressType, 'subnet', 'which grouping was bought is a fact about the REQUEST');
  // The corpus guard rides along, because a status type change recomputes these
  // counts exactly as it recomputes a domain's.
  assert.equal(agg.statusType, C.BACKLINKS_STATUS_TYPE);
});

test('a network row’s rank is link strength, not the authority of a /24', () => {
  const row = BN.normaliseReferringNetwork({ network_address: '203.0.113.0/24', rank: 940 });
  assert.equal(row.linksRank, 940);
  assert.equal('rank' in row, false, 'there is no such thing as the authority of a subnet');
  assert.equal('authorityRank' in row, false);
});

test('two network readings under different link sets refuse to be compared', () => {
  const a = { statusType: 'live', rankScale: 'one_thousand' };
  const b = { statusType: 'lost', rankScale: 'one_thousand' };
  const out = comparability('referring_networks', a, b);
  assert.equal(out.ok, false);
  assert.match(out.reason, /different link sets/i);
});

test('the new billable Backlinks endpoint is NOT on the free allowlist', () => {
  assert.equal(isFreeEndpoint(C.ENDPOINT_BACKLINKS_REFERRING_NETWORKS), false);
  assert.equal(isFreeEndpoint(C.ENDPOINT_BUSINESS_MY_BUSINESS_INFO), false);
  // The one free footnote in the family still is, which is what an allowlist is for.
  assert.equal(isFreeEndpoint(C.ENDPOINT_BACKLINKS_INDEX), true);
});

// ---------------------------------------------------------------------------
// 4. Local / GBP — the distribution, and the identity trap
// ---------------------------------------------------------------------------

const GBP = {
  title: 'Acme Plumbing',
  cid: '1234567890',
  place_id: 'ChIJxyz',
  category: 'Plumber',
  additional_categories: ['Heating contractor'],
  address: '1 High Street, Leeds',
  phone: '+441130000000',
  url: 'https://acme.com',
  domain: 'acme.com',
  is_claimed: true,
  rating: { value: 4.5, votes_count: 2000, rating_max: 5 },
  rating_distribution: { 1: 20, 2: 20, 3: 60, 4: 700, 5: 1200 },
  total_photos: 74,
  place_topics: { 'boiler repair': 41, 'emergency callout': 18, price: 9 },
  people_also_search: [
    { title: 'Rival Plumbing', cid: '999', rating: { value: 4.1, votes_count: 200 } },
  ],
  work_time: { current_status: 'open' },
  first_seen: '2021-05-04 09:00:00 +00:00',
};

test('the star breakdown is five counts, and the average is not what a change is read from', () => {
  const card = BusN.normaliseBusinessInfo(GBP);
  assert.deepEqual(card.ratingDistribution, {
    one: 20,
    two: 20,
    three: 60,
    four: 700,
    five: 1200,
    total: 2000,
  });

  /**
   * THE ARITHMETIC THIS PANEL EXISTS FOR, run on the fixture rather than
   * asserted in a comment.
   *
   * Twenty new one-star reviews on top of these two thousand — the one-star
   * count DOUBLING — move the average from 4.520 to 4.485. Both display as 4.5,
   * and the month-over-month delta is 0.035, which is inside the noise of any
   * normal review flow. So the single event a local business most needs to be
   * told about is invisible in the headline it would most likely be reported
   * through, and visible in the count.
   */
  const avg = (d, total) =>
    (1 * d.one + 2 * d.two + 3 * d.three + 4 * d.four + 5 * d.five) / total;
  const before = avg({ one: 20, two: 20, three: 60, four: 700, five: 1200 }, 2000);
  const after = avg({ one: 40, two: 20, three: 60, four: 700, five: 1200 }, 2020);

  assert.equal(before.toFixed(1), after.toFixed(1), 'the displayed average does not move');
  assert.ok(Math.abs(after - before) < 0.05, 'and neither does it move by a displayable step');
  assert.equal(40 / 20, 2, 'while the number a person acts on has doubled');
});

test('a missing star bucket is null, never a defaulted zero', () => {
  const partial = BusN.normaliseRatingDistribution({ 1: 4, 5: 20 });
  assert.equal(partial.one, 4);
  assert.equal(partial.two, null, '"Google did not tell us" is not "nobody left a two-star"');
  assert.equal(partial.total, 24);
  assert.deepEqual(BusN.normaliseRatingDistribution(null), {
    one: null, two: null, three: null, four: null, five: null, total: null,
  });
});

test('Google names the themes and the competitive set, and both are kept', () => {
  const card = BusN.normaliseBusinessInfo(GBP);
  assert.deepEqual(card.placeTopics[0], { topic: 'boiler repair', count: 41 });
  assert.equal(card.placeTopics.length, 3, 'sorted by count, capped by BUSINESS_LIST_LIMIT');
  assert.equal(card.peopleAlsoSearch[0].title, 'Rival Plumbing');
  assert.equal(card.peopleAlsoSearch[0].cid, '999', 'the CID, because a title can be renamed');
});

test('the GBP query is the business name and is NEVER defaulted to the domain', () => {
  const named = businessQueryFor(project());
  assert.equal(named.query, 'Acme Plumbing, Leeds');

  const unnamed = businessQueryFor(project({ businessName: '' }));
  assert.equal(unnamed.query, '');
  assert.notEqual(unnamed.query, 'acme.com');
  assert.match(unnamed.note, /business name/i);

  const { requests, note } = planBusinessRequests({
    kind: getKind('business_profile'),
    project: project({ businessName: '' }),
    variant: MARKET_VARIANT,
  });
  assert.equal(requests.length, 0, 'no name means no billable Maps lookup at all');
  assert.ok(note);
});

test('the Local kind is GATED on a string, which is the one requires that works', () => {
  const kind = getKind('business_profile');
  assert.equal(kind.requires, 'businessName');
  assert.equal(kind.family, 'business');
  assert.equal(isTaskKind(kind), false);
  assert.equal(kind.variantScope, 'market');
  assert.ok(kind.minRebuyHours < kind.intervalHours);

  /**
   * `planProjectWork` gates on truthiness. An empty ARRAY is truthy, which is
   * why `requires: 'trackedKeywords'` never protected anything and is recorded
   * twice in `kinds.js`. An empty STRING is falsy.
   */
  assert.equal(Boolean([]), true);
  assert.equal(Boolean(''), false);
  assert.equal(readSiteForm({
    domain: 'acme.com',
    trackedKeywords: ['a'],
    targets: [{ locationCode: 2840, languageCode: 'en', device: 'desktop' }],
  }).values.businessName, '');
});

test('a GBP kind takes a market, so a chain does not store one city over another', () => {
  const twoCities = project({
    targets: [
      { locationCode: 2840, languageCode: 'en', device: 'desktop' },
      { locationCode: 2826, languageCode: 'en', device: 'desktop' },
    ],
  });
  const out = variantsFor('business_profile', twoCities);
  assert.equal(out.variants.length, 2, 'two markets are two listings, not one');
  // And the device is collapsed, because there is no desktop version of a shop.
  for (const v of out.variants) assert.equal(v.device, 'any');
});

test('two readings of DIFFERENT listings refuse to be subtracted', () => {
  const now = { found: true, profile: { cid: 'B' }, totals: { oneStar: 12 } };
  const then = { found: true, profile: { cid: 'A' }, totals: { oneStar: 40 } };

  const out = comparability('business_profile', now, then);
  /**
   * THE MOST FLATTERING WRONG NUMBER THIS PROVIDER COULD PRODUCE. Subtracted,
   * the new listing's 12 one-stars minus the old listing's 40 reads as "your
   * one-stars fell by 28" — for a business that merely rebranded.
   */
  assert.equal(out.ok, false);
  assert.match(out.reason, /different Google listings/i);

  assert.equal(comparability('business_profile', now, { ...then, profile: { cid: 'B' } }).ok, true);
});

test('a reading that found nothing is not a reading of zero reviews', () => {
  const missing = { found: false, profile: null, totals: {} };
  const found = { found: true, profile: { cid: 'B' }, totals: { oneStar: 3 } };
  assert.equal(comparability('business_profile', found, missing).ok, false);
  assert.match(comparability('business_profile', found, missing).reason, /no Google listing/i);
});

test('an empty Maps answer is STORED as a reading, so it does not re-buy forever', async () => {
  resetPool();
  const world = stubWorld();
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, payload: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(listEnvelope({ cost: 0.0054, items: [] })),
    };
  };

  try {
    const out = await runBusinessKind(getKind('business_profile'), {
      session,
      client: createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] }),
      project: project(),
      variant: MARKET_VARIANT,
      now: NOW,
    });

    /**
     * `pending` here would write NO snapshot, which means no `existing` reading
     * for `rebuyGuard` to refuse against — so the next hourly tick would buy the
     * same empty answer again, forever. A stored miss costs one snapshot and
     * stops the loop.
     */
    assert.equal(out.status, 'ok');
    assert.equal(out.data.found, false);
    assert.equal(out.data.query, 'Acme Plumbing, Leeds');
    assert.match(out.note, /no business profile/i);
    assert.equal(calls.length, 1, 'one call, one card — there is no second half here');
    assert.equal(calls[0].payload[0].keyword, 'Acme Plumbing, Leeds');
    assert.equal(calls[0].payload[0].location_code, 2840);
  } finally {
    world.restore();
  }
});

test('a Business Data call reserves the published price and settles on the envelope', async () => {
  resetPool();
  const world = stubWorld();
  const impl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(listEnvelope({ cost: 0.0061, items: [GBP] })),
  });

  try {
    const out = await runBusinessKind(getKind('business_profile'), {
      session,
      client: createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] }),
      project: project(),
      variant: MARKET_VARIANT,
      now: NOW,
    });

    assert.equal(out.status, 'ok');
    assert.equal(out.data.profile.title, 'Acme Plumbing');
    assert.deepEqual(world.seen.reserved, [C.BUSINESS_TASK_USD]);
    /** The ledger records what DataForSEO said it charged, never the estimate. */
    assert.deepEqual(world.seen.settled, [{ estimateUsd: C.BUSINESS_TASK_USD, actualUsd: 0.0061 }]);
    // And the row's units are the card, not a keyword list.
    assert.deepEqual(world.seen.created[0].keywords, ['Acme Plumbing, Leeds']);
  } finally {
    world.restore();
  }
});

test('Business Data does NOT join the database-backed pool, and adds no limiter', () => {
  /**
   * The 30-simultaneous ceiling is shared by Labs, Backlinks, OnPage, Content
   * Analysis and Domain Analytics. Business Data live is not one of them — it is
   * a real-time fetch, like SERP live — so putting it in the pool would take
   * slots away from the families that genuinely share the ceiling.
   *
   * And no second limiter is added anywhere, which is the rule phases 6-8 all
   * inherited: one ceiling, one pool.
   */
  assert.equal(
    DB_BACKED_PREFIXES.some((p) => 'business_data/'.startsWith(p)),
    false
  );
  assert.deepEqual(DB_BACKED_PREFIXES, [
    'dataforseo_labs/',
    'backlinks/',
    'on_page/',
    'content_analysis/',
    'domain_analytics/',
  ]);
});

test('the collect-only transport refuses a Maps lookup even if code asked for one', async () => {
  const wrapped = collectOnlyClient(
    createDfsClient(session, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) })
  );
  await assert.rejects(
    wrapped.call(C.ENDPOINT_BUSINESS_MY_BUSINESS_INFO, [{ keyword: 'x' }]),
    /may not call/
  );
  await assert.rejects(
    wrapped.send(C.ENDPOINT_BACKLINKS_REFERRING_NETWORKS, {}),
    /may not call/
  );
});

// ---------------------------------------------------------------------------
// 5. Alerts — three registrations, or the bell becomes noise
// ---------------------------------------------------------------------------

test('every alert type is in the ENUM and in a preference category', () => {
  const enumValues = Notification.schema.path('type').enumValues;
  const prefPaths = Object.keys(NotificationPreference.schema.paths);

  for (const rule of A.RULES) {
    assert.ok(enumValues.includes(rule.type), `${rule.type} is not a Notification type`);
  }
  assert.ok(
    prefPaths.includes('categories.seo'),
    'the category the two types map to must exist'
  );
  const channels = NotificationPreference.schema.path('categories.seo').schema.paths;
  assert.ok(channels.inApp && channels.email, 'and it must carry both channels');
});

test('MUTING the seo category actually suppresses delivery — the mapping, end to end', async () => {
  /**
   * THE REGISTRATION THAT IS SILENT WHEN IT IS MISSING.
   *
   * `categoryForType` returns null for an unmapped type and `isChannelEnabled`
   * then returns TRUE — so a type present in the enum and absent from
   * `TYPE_CATEGORY` is delivered to everybody regardless of preference. For a
   * rank tracker, whose entire job is noticing that something moved, that is the
   * loudest thing in the bell with no off switch: exactly the failure the
   * `goals` category's own comment warns about.
   *
   * Asserted through `createNotification` rather than by reading the table, so
   * the test fails if the mapping is removed OR if the gate stops consulting it.
   * A muted category returns null before any database call, which is why this
   * runs without a connection.
   */
  const pref = new NotificationPreference({ user: '000000000000000000000001' });
  pref.categories.seo.inApp = false;

  for (const rule of A.RULES) {
    // eslint-disable-next-line no-await-in-loop
    const made = await notificationService.createNotification({
      userId: '000000000000000000000001',
      type: rule.type,
      message: 'x',
      pref,
    });
    assert.equal(made, null, `${rule.type} is not gated by the seo category`);
  }

  /**
   * THE NEGATIVE CONTROL, and it is what makes the test above mean anything.
   *
   * `ownershipTransferred` is deliberately absent from `TYPE_CATEGORY` — who
   * owns your workspace is not a subscription — so it sails straight past the
   * SAME muted document. Without this, a `createNotification` that returned null
   * for every input would pass the loop above.
   *
   * `Notification.create` is stubbed because this suite runs with no database.
   * The gate under test returns null BEFORE that call, which is exactly why the
   * two paths are distinguishable here.
   */
  const realCreate = Notification.create;
  Notification.create = async (doc) => ({ ...doc, _id: 'stub' });
  try {
    const unmapped = await notificationService.createNotification({
      userId: '000000000000000000000001',
      type: 'ownershipTransferred',
      message: 'x',
      pref,
    });
    assert.notEqual(
      unmapped,
      null,
      'an unmapped type is always delivered — which is why these two are mapped'
    );

    /** And a mapped-but-muted one still creates nothing, with the stub in place. */
    const muted = await notificationService.createNotification({
      userId: '000000000000000000000001',
      type: 'seoRankDrop',
      message: 'x',
      pref,
    });
    assert.equal(muted, null);
  } finally {
    Notification.create = realCreate;
  }
});

test('the preference WRITE allowlist names the seo category', () => {
  /**
   * A third place, and it is silent in the other direction: a category on the
   * model and missing from `PREFERENCE_CATEGORIES` renders a switch the settings
   * page can toggle and the server discards on save. `goals` was in exactly that
   * state before this phase, which is how the failure mode is known to be real
   * rather than theoretical.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'controllers', 'notificationController.js'),
    'utf8'
  );
  const block = source.slice(
    source.indexOf('const PREFERENCE_CATEGORIES'),
    source.indexOf('const clampMinute')
  );
  assert.match(block, /'seo'/);
  assert.match(block, /'goals'/);
});

test('a rank drop needs BOTH a starting position and a distance', () => {
  const current = { keywords: [{ keyword: 'a', rank: 12 }, { keyword: 'b', rank: 91 }], depth: 100 };
  const previous = { keywords: [{ keyword: 'a', rank: 3 }, { keyword: 'b', rank: 74 }], depth: 100 };

  const drops = A.rankDrops(current, previous, 100);
  /**
   * `b` fell seventeen places, which is further than `a` fell — and it is not
   * news. The long tail is where movement is largest and matters least.
   */
  assert.deepEqual(drops.map((d) => d.keyword), ['a']);
  assert.equal(drops[0].from, 3);
  assert.equal(drops[0].to, 12);
  assert.equal(C.ALERT_RANK_DROP_FROM_MAX, 20);
  assert.equal(C.ALERT_RANK_DROP_MIN, 5);
});

test('a small wobble at the top is not a drop', () => {
  const drops = A.rankDrops(
    { keywords: [{ keyword: 'a', rank: 6 }] },
    { keywords: [{ keyword: 'a', rank: 3 }] },
    100
  );
  assert.deepEqual(drops, []);
});

test('leaving the bought depth is a drop, and its size is a LOWER BOUND', () => {
  const drops = A.rankDrops(
    { keywords: [{ keyword: 'a', rank: null, ranked: false }] },
    { keywords: [{ keyword: 'a', rank: 6 }] },
    10
  );
  assert.equal(drops.length, 1);
  assert.equal(drops[0].to, null, 'it did not go to 11 — it went somewhere past ten');
  assert.equal(drops[0].leftDepth, true);
  assert.equal(drops[0].drop, 5, 'at depth 10 the bound is 11 - 6, floored at the minimum');
});

test('a keyword that vanished from the list is not a ranking loss', () => {
  /**
   * Absent from the newer reading means it was untracked, or the collection was
   * short. Reporting either as a drop is how an alert teaches people to distrust
   * it.
   */
  const drops = A.rankDrops(
    { keywords: [] },
    { keywords: [{ keyword: 'a', rank: 3 }] },
    100
  );
  assert.deepEqual(drops, []);
});

test('the message names three keywords and then counts, because a bell line is one line', () => {
  const drops = Array.from({ length: 9 }, (_, i) => ({
    keyword: `kw-${i}`,
    from: 3,
    to: 20,
    drop: 17,
    leftDepth: false,
  }));
  const message = A.rankDropMessage(drops, 100, 'Board · acme.com');
  assert.match(message, /9 keywords dropped/);
  assert.match(message, /and 6 more/);
  assert.equal((message.match(/kw-/g) || []).length, C.ALERT_RANK_DROP_NAMED);
});

test('an alert asks COMPARABILITY before it subtracts anything', () => {
  /**
   * The line phase 9 asked for by name: "an alert that fires because a crawl got
   * bigger is worse than no alert, because somebody acts on it." Here the two
   * readings were bought to different depths, so every keyword between 10 and
   * 100 would read as having fallen off the internet.
   */
  const out = A.evaluateRule(A.RULE_BY_KEY.get('rank_drop'), {
    kind: 'positions',
    current: { periodKey: '2026-09-03', data: { depth: 10, keywords: [{ keyword: 'a', rank: null }] } },
    previous: { periodKey: '2026-08-27', data: { depth: 100, keywords: [{ keyword: 'a', rank: 40 }] } },
  });
  assert.equal(out.fired, false);
  assert.match(out.reason, /different depths/i);
  assert.equal(out.message, '');
});

test('one reading is not a comparison, and it says so rather than firing', () => {
  const out = A.evaluateRule(A.RULE_BY_KEY.get('rank_drop'), {
    kind: 'positions',
    current: { periodKey: '2026-09-03', data: { depth: 100, keywords: [] } },
    previous: null,
  });
  assert.equal(out.fired, false);
  assert.match(out.reason, /nothing to compare/i);
});

test('lost backlinks needs BOTH a share and an absolute floor', () => {
  const run = (from, to) =>
    A.evaluateRule(A.RULE_BY_KEY.get('lost_backlinks'), {
      kind: 'backlinks_summary',
      current: { periodKey: '2026-09-03', data: { statusType: 'live', profile: { referringDomains: to } } },
      previous: { periodKey: '2026-08-27', data: { statusType: 'live', profile: { referringDomains: from } } },
    });

  /** 8% but only one domain — noise on a tiny profile. */
  assert.equal(run(12, 11).fired, false);
  /** 600 domains but 1.5% — a large profile's ordinary churn. */
  assert.equal(run(40_000, 39_400).fired, false);
  /** Both crossed. */
  const real = run(200, 150);
  assert.equal(real.fired, true);
  assert.match(real.message, /50 referring domains lost/);
  assert.match(real.message, /25%/);
});

test('lost backlinks refuses two readings taken over different link sets', () => {
  const out = A.evaluateRule(A.RULE_BY_KEY.get('lost_backlinks'), {
    kind: 'backlinks_summary',
    current: { periodKey: '2026-09-03', data: { statusType: 'live', profile: { referringDomains: 100 } } },
    previous: { periodKey: '2026-08-27', data: { statusType: 'all', profile: { referringDomains: 900 } } },
  });
  assert.equal(out.fired, false);
  assert.match(out.reason, /different link sets/i);
});

test('one rule reads the CENSUS when both rank kinds are collected', () => {
  const keywords = [{ keyword: 'a', rank: 30 }];
  const out = A.evaluateAll({
    snapshots: {
      positions: { periodKey: '2026-09-03', data: { depth: 100, keywords } },
      movement: { periodKey: '2026-09-03', data: { depth: 10, keywords: [{ keyword: 'a', rank: null }] } },
      backlinks_summary: { periodKey: '2026-09-03', data: { statusType: 'live', profile: { referringDomains: 100 } } },
    },
    previousSnapshots: {
      positions: { periodKey: '2026-08-27', data: { depth: 100, keywords: [{ keyword: 'a', rank: 4 }] } },
      movement: { periodKey: '2026-09-02', data: { depth: 10, keywords: [{ keyword: 'a', rank: 4 }] } },
      backlinks_summary: { periodKey: '2026-08-27', data: { statusType: 'live', profile: { referringDomains: 200 } } },
    },
    label: 'Board · acme.com',
  });

  const rank = out.find((r) => r.rule === 'rank_drop');
  /**
   * ONE alert about one event. Both kinds saw the same drop, and telling it
   * twice with different numbers — "fell to 30" and "left the top ten" — is the
   * same event reported as two.
   */
  assert.equal(out.filter((r) => r.rule === 'rank_drop').length, 1);
  assert.equal(rank.kind, 'positions', 'the census is the better measurement');
  assert.equal(rank.fired, true);
  assert.match(rank.message, /4 → 30/);

  const links = out.find((r) => r.rule === 'lost_backlinks');
  assert.equal(links.fired, true);
});

test('a rule whose kind is not collected says so rather than staying silent', () => {
  const out = A.evaluateAll({ snapshots: {}, previousSnapshots: {} });
  assert.equal(out.length, A.RULES.length);
  for (const row of out) {
    assert.equal(row.fired, false);
    assert.match(row.reason, /is being collected/i);
  }
});

test('the thresholds ride on the result, so a screen prints them rather than restating them', () => {
  for (const rule of A.RULES) {
    assert.ok(rule.thresholds && Object.keys(rule.thresholds).length);
  }
  const out = A.evaluateAll({ snapshots: {}, previousSnapshots: {} });
  assert.deepEqual(out[0].thresholds, A.RULES[0].thresholds);
});

// ---------------------------------------------------------------------------
// 6. Client Reports, and the screen catalog as a whole
// ---------------------------------------------------------------------------

test('the six Extras screens are declared and every kind they draw is collected', () => {
  const collected = new Set(KINDS.map((k) => k.key));
  const extras = ['ai_visibility', 'cannibalization', 'toxic_backlinks', 'alerts', 'client_report', 'local'];

  for (const key of extras) {
    const screen = SCREENS.find((s) => s.key === key);
    assert.ok(screen, `${key} is not declared`);
    assert.equal(screen.alwaysOn, false, 'an extra is opt-in per board');
    for (const kind of screen.kinds) {
      assert.ok(collected.has(kind), `${key} draws "${kind}", which this provider does not collect`);
    }
  }
});

test('the client report buys nothing — every kind it draws is somebody else’s purchase', () => {
  const report = SCREENS.find((s) => s.key === 'client_report');
  const drawnElsewhere = new Set(
    SCREENS.filter((s) => s.key !== 'client_report').flatMap((s) => s.kinds)
  );
  for (const kind of report.kinds) {
    assert.ok(
      drawnElsewhere.has(kind),
      `${kind} exists only for the report, which would make the report a purchase`
    );
  }
});

test('narrowing enabledScreens is LOCAL: it changes rendering and never a kind', () => {
  /**
   * The distinction the whole phase is gated on. A board that keeps only the
   * client report still has every kind in the catalog available to collect —
   * `resolveScreens` answers a rendering question and touches nothing that is
   * bought. Narrowing `kinds` instead would reach across to a co-tenant board,
   * because the runner unions kinds and collects a project once.
   */
  const narrowed = resolveScreens(['client_report']);
  assert.deepEqual(
    narrowed.map((s) => s.key).sort(),
    ['client_report', 'usage'],
    'and the money screen comes back regardless, because it is alwaysOn'
  );
  assert.equal(KINDS.length, 13, 'the kind catalog is untouched by a screen selection');

  // An empty selection means EVERYTHING, not nothing.
  assert.equal(resolveScreens([]).length, SCREENS.length);
});

test('both new kinds carry a rebuy floor below their cadence', () => {
  for (const key of ['referring_networks', 'business_profile']) {
    const kind = getKind(key);
    assert.ok(Number.isFinite(kind.minRebuyHours) && kind.minRebuyHours > 0, key);
    assert.ok(kind.minRebuyHours < kind.intervalHours, `${key} floor is not below its cadence`);
  }
});

test('the new fields read the bodies the real normalisers wrote', () => {
  const networks = BN.aggregateReferringNetworks(
    [BN.normaliseReferringNetwork({ network_address: '203.0.113.0/24', referring_domains: 4 })],
    { domain: 'acme.com' }
  );
  assert.equal(readField('concentrated_networks', networks), 1);
  assert.equal(readField('domains_in_concentrated_networks', networks), 4);

  const gbp = BusN.aggregateBusinessProfile(BusN.normaliseBusinessInfo(GBP), { query: 'Acme' });
  assert.equal(readField('gbp_one_star_reviews', gbp), 20);
  assert.equal(readField('gbp_rating', gbp), 4.5);
  assert.equal(readField('gbp_listing_name', gbp), 'Acme Plumbing');

  const rows = [N.normaliseSerpResult(aiSerp(), { domain: 'acme.com' })];
  const ranks = N.aggregatePositions(rows, { domain: 'acme.com', depth: 100 });
  assert.equal(readField('ai_cited', ranks), 1);
  assert.equal(readField('ai_cited_rate', ranks), 100, 'a rate reaches a goal column as a percentage');

  const domains = BN.aggregateReferringDomains(
    [referringDomain({ backlinks_spam_score: 88, backlinks: 400, referring_pages: 400 })],
    { domain: 'acme.com' }
  );
  assert.equal(readField('toxic_domains_suggested', domains), 1);
});

// ---------------------------------------------------------------------------
// 7. The delivery pass
// ---------------------------------------------------------------------------

const alertRunner = require('../../seoAlertRunner');
const ConnectorSnapshot = require('../../../models/ConnectorSnapshot');
const BoardConnector = require('../../../models/BoardConnector');

test('the claim key names the rule, the site and the market, and carries no dot', () => {
  const key = alertRunner.claimKey('rank_drop', 'abc123', '2840|en|desktop');
  assert.equal(key, 'rank_drop|abc123|2840|en|desktop');
  /**
   * A dot in a Mongo update path is a nested field, so a key containing one
   * would write `alertState.rank_drop.abc123` — a different document shape that
   * the `$ne` filter would never match, which turns the claim into a no-op and
   * the alert into an hourly repeat.
   */
  assert.equal(key.includes('.'), false);
});

test('readings are paired PER VARIANT, so two markets are never subtracted', async () => {
  const real = ConnectorSnapshot.find;
  ConnectorSnapshot.find = () => ({
    select: () => ({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            { kind: 'positions', variant: 'us', periodKey: '2026-09-03', status: 'ok', data: { depth: 100, k: 'us-now' } },
            { kind: 'positions', variant: 'uk', periodKey: '2026-09-03', status: 'ok', data: { depth: 100, k: 'uk-now' } },
            { kind: 'positions', variant: 'us', periodKey: '2026-08-27', status: 'ok', data: { depth: 100, k: 'us-then' } },
            { kind: 'positions', variant: 'uk', periodKey: '2026-08-27', status: 'ok', data: { depth: 100, k: 'uk-then' } },
          ],
        }),
      }),
    }),
  });

  try {
    const pairs = await alertRunner.pairsFor({ _id: 'p1' });
    const buckets = alertRunner.byVariant(pairs);

    assert.equal(buckets.size, 2, 'a US rank and a UK rank are two facts');
    assert.equal(buckets.get('us').snapshots.positions.data.k, 'us-now');
    /**
     * THE PAIRING TRAP. Taking the newest two rows of a two-market site gives
     * one reading from each country, and subtracting them reports the
     * DIFFERENCE BETWEEN COUNTRIES as movement.
     */
    assert.equal(buckets.get('us').previousSnapshots.positions.data.k, 'us-then');
    assert.equal(buckets.get('uk').previousSnapshots.positions.data.k, 'uk-then');
  } finally {
    ConnectorSnapshot.find = real;
  }
});

test('the pass reads only FINISHED readings', async () => {
  /**
   * A `partial` reading is a short collection, and half a keyword list compared
   * with a whole one reports every missing keyword as having fallen out of the
   * rankings — the single most alarming false alarm this feature could produce.
   * Enforced in the QUERY rather than by filtering afterwards, so it is asserted
   * on the filter.
   */
  const real = ConnectorSnapshot.find;
  let seen = null;
  ConnectorSnapshot.find = (filter) => {
    seen = filter;
    return {
      select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    };
  };
  try {
    await alertRunner.pairsFor({ _id: 'p1' });
    assert.equal(seen.status, 'ok');
  } finally {
    ConnectorSnapshot.find = real;
  }
});

test('a board that switched the ALERTS screen off is never notified', async () => {
  /**
   * The screen gate, resolved through the descriptor rather than by reading the
   * array — an empty selection means EVERYTHING and an always-on screen comes
   * back regardless, and re-deriving either rule here is how a board that has
   * expressed no opinion silently stops getting alerts.
   */
  const realFind = BoardConnector.findOneAndUpdate;
  let claimed = false;
  BoardConnector.findOneAndUpdate = () => {
    claimed = true;
    return { lean: async () => null };
  };

  const connector = require('./index');
  try {
    await alertRunner.alertOne(
      { _id: 'bc1', board: 'b1', provider: 'dataforseo', enabledScreens: ['usage'] },
      connector
    );
    assert.equal(claimed, false, 'it did not even reach a board lookup');
  } finally {
    BoardConnector.findOneAndUpdate = realFind;
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./constants');
const P = require('./pricing');
const T = require('./tasks');
const B = require('../budget');
const Budget = require('./budget');
const DfsTask = require('../../../models/DfsTask');

const { KINDS, getKind, isTaskKind } = require('./kinds');
const { SCREENS } = require('./screens');
const { variantsFor, variantKeyFor } = require('./sites');
const { isFreeEndpoint, collectOnlyClient } = require('./collect');
const { createDfsClient } = require('./client');
const { resetPool, poolStats, DB_BACKED_PREFIXES } = require('./pool');
const {
  baseFor,
  timeseriesWindow,
  rankTargets,
  planBacklinksRequests,
  runBacklinksKind,
} = require('./backlinks');
const {
  normaliseSummary,
  normaliseReferringDomain,
  normaliseBulkRank,
  normaliseAnchor,
  aggregateSummary,
  aggregateTimeseries,
} = require('./backlinksNormalise');
const { fetchKind } = require('./fetchers');

/**
 * Phase 7 — Backlinks, and the three metric traps that are the whole phase.
 *
 * Every one of them produces a number that looks right on a client report. None
 * of them throws, logs, or leaves anything in the payload to check against. So
 * each one gets a test that would fail if somebody later "simplified" it, and
 * the test says which simplification it is guarding against.
 *
 * 1. `rank` IS 0-1000 AND IS DATAFORSEO'S OWN METRIC. It is original PageRank
 *    with damping 0.5, they say in as many words that it should not be expected
 *    to match Ahrefs DR, and `rank_scale: 'one_hundred'` returns the same fact
 *    on a different scale through a NON-LINEAR conversion. And
 *    `referring_domains.rank` is not domain authority at all — it is the rank of
 *    the links that domain sends US. The authority number comes from
 *    `bulk_ranks` or from nowhere.
 *
 * 2. `*_nofollow` MEANS "AT LEAST ONE NOFOLLOW LINK". It overlaps the referring
 *    set rather than partitioning it, so `referring_domains -
 *    referring_domains_nofollow` is not the dofollow count. Getting the real one
 *    costs a SECOND filtered `summary` call, and the fixture below is built so
 *    that the subtraction and the truth are different numbers.
 *
 * 3. `backlinks_status_type` RECOMPUTES THE AGGREGATES rather than filtering
 *    rows — DataForSEO's own example shows one domain at rank 509 under `lost`
 *    and 562 under `live`. Two readings taken under different status types are
 *    not comparable, so every request carries the same one and every snapshot
 *    stores it.
 *
 * Plus the things phase 6 established that phase 7 must not undo: ONE shared
 * pool for the 30-simultaneous ceiling, the collector that cannot spend, and the
 * live-transport claim-reserve-call-settle-close.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-03T10:00:00Z');

const BACKLINKS_KINDS = KINDS.filter((k) => k.family === 'backlinks');

/** The single domain-scoped variant every Backlinks kind collapses to. */
const VARIANT = {
  key: variantKeyFor({ locationCode: 0, languageCode: 'any', device: 'any' }),
  locationCode: 0,
  languageCode: 'any',
  device: 'any',
};

const project = (overrides = {}) => ({
  _id: 'proj-1',
  organisation: 'org-1',
  account: 'acct-1',
  provider: 'dataforseo',
  domain: 'acme.com',
  trackedKeywords: ['best crm for agencies'],
  competitors: ['rival.com', 'other.com'],
  targets: [
    { locationCode: 2840, languageCode: 'en', device: 'desktop' },
    { locationCode: 2840, languageCode: 'en', device: 'mobile' },
  ],
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
    {
      id: 'bl-1',
      status_code: 20000,
      status_message: 'Ok.',
      cost,
      data: {},
      result,
    },
  ],
});

/** A list endpoint: `result[0].items`. */
const listEnvelope = ({ cost = 0, items = [] }) =>
  envelope({ cost, result: [{ items }] });

/** `summary` answers with ONE OBJECT and no `items` at all. */
const objectEnvelope = ({ cost = 0, row = {} }) => envelope({ cost, result: [row] });

/**
 * THE FIXTURE THE DOFOLLOW TRAP LIVES IN.
 *
 * The unfiltered profile says 1,200 referring domains of which 300 send at least
 * one nofollow link. The subtraction everybody reaches for therefore says 900.
 *
 * The truth, from the filtered call, is 1,010 — because 110 of those 300 domains
 * ALSO send a followed link, and `referring_domains_nofollow` counts a domain
 * once for having any nofollow link at all rather than for being entirely
 * nofollow. 900 and 1,010 are both plausible, differ by 12%, and nothing on a
 * screen would say which one it was looking at.
 */
const PROFILE = {
  target: 'acme.com',
  first_seen: '2019-04-02 11:00:00 +00:00',
  rank: 562,
  backlinks: 48_000,
  backlinks_nofollow: 9_100,
  broken_backlinks: 140,
  broken_pages: 12,
  referring_domains: 1_200,
  referring_domains_nofollow: 300,
  referring_main_domains: 1_040,
  referring_main_domains_nofollow: 260,
  referring_pages: 44_000,
  referring_pages_nofollow: 8_800,
  referring_ips: 990,
  referring_subnets: 810,
  backlinks_spam_score: 21,
  crawled_pages: 3_400,
  internal_links_count: 91_000,
  external_links_count: 2_100,
  info: { target_spam_score: 4 },
  referring_links_tld: { '.com': 800, '.org': 210, '.co.uk': 90 },
  referring_links_types: { anchor: 41_000, image: 6_800 },
  referring_links_attributes: { nofollow: 9_100, noopener: 400 },
  referring_links_platform_types: { blogs: 610, cms: 400 },
  referring_links_semantic_locations: { article: 900, sidebar: 120 },
  referring_links_countries: { US: 700, GB: 190 },
};

const DOFOLLOW_PROFILE = {
  ...PROFILE,
  backlinks: 38_900,
  backlinks_nofollow: 0,
  /** NOT 1200 - 300. See the block above. */
  referring_domains: 1_010,
  referring_domains_nofollow: 0,
  referring_main_domains: 880,
  referring_pages: 35_200,
};

/** The naive answer this whole arrangement exists to avoid shipping. */
const SUBTRACTION = PROFILE.referring_domains - PROFILE.referring_domains_nofollow;

const BULK_RANKS = [
  { target: 'acme.com', rank: 562 },
  { target: 'rival.com', rank: 701 },
  { target: 'other.com', rank: 344 },
];

/**
 * A referring domain whose `rank` is HIGHER than any real authority it has.
 *
 * `linkfarm.example` sends us four hundred sitewide links, so the rank of the
 * links it sends is high; the domain itself is worth nothing. Read as authority
 * it is the best link in the profile. That reading is what `linksRank` exists to
 * make impossible to type by accident.
 */
const REFERRING_DOMAINS = [
  {
    domain: 'linkfarm.example',
    rank: 940,
    backlinks: 400,
    broken_backlinks: 0,
    referring_pages: 400,
    referring_pages_nofollow: 0,
    backlinks_spam_score: 78,
    first_seen: '2024-01-04 09:00:00 +00:00',
    referring_links_tld: { '.example': 400 },
  },
  {
    domain: 'nytimes.com',
    rank: 210,
    backlinks: 1,
    broken_backlinks: 0,
    referring_pages: 1,
    referring_pages_nofollow: 0,
    backlinks_spam_score: 2,
    first_seen: '2026-02-19 08:00:00 +00:00',
  },
];

/**
 * Phase 10's subnet rows.
 *
 * Built so the two halves of the finding are DIFFERENT NUMBERS: the first block
 * carries four referring domains on one /24 and is what a private blog network
 * looks like from outside; the second carries one and is what an ordinary host
 * looks like. A fixture where every block were concentrated would pass against a
 * `summariseNetworks` that returned `rows.length`.
 */
const REFERRING_NETWORKS = [
  {
    network_address: '203.0.113.0/24',
    referring_domains: 4,
    referring_main_domains: 4,
    backlinks: 610,
    broken_backlinks: 0,
    rank: 300,
    first_seen: '2024-01-04 09:00:00 +00:00',
  },
  {
    network_address: '198.51.100.0/24',
    referring_domains: 1,
    referring_main_domains: 1,
    backlinks: 2,
    broken_backlinks: 0,
    rank: 180,
    first_seen: '2026-02-19 08:00:00 +00:00',
  },
];

const ANCHORS = [
  {
    anchor: 'acme crm',
    backlinks: 5_200,
    referring_domains: 300,
    referring_main_domains: 280,
    referring_pages: 5_100,
    backlinks_spam_score: 8,
  },
  {
    /** An empty anchor is a REAL anchor — an image link with no alt text. */
    anchor: '',
    backlinks: 40_000,
    referring_domains: 3,
    referring_main_domains: 2,
    referring_pages: 40_000,
    backlinks_spam_score: 30,
  },
];

const TIMESERIES_LEVELS = [
  {
    date: '2026-07-31 00:00:00 +00:00',
    rank: 558,
    backlinks: 46_000,
    referring_domains: 1_180,
    referring_main_domains: 1_020,
    backlinks_spam_score: 22,
  },
  {
    date: '2026-08-31 00:00:00 +00:00',
    rank: 562,
    backlinks: 48_000,
    referring_domains: 1_200,
    referring_main_domains: 1_040,
    backlinks_spam_score: 21,
  },
];

/**
 * The flows, and DELIBERATELY NOT THE SAME LENGTH as the levels.
 *
 * `timeseries_new_lost_summary` answers a June bucket that the levels call did
 * not, which is exactly the shape that breaks a client zipping two arrays by
 * index: every level would shift by one month and the chart would be wrong by a
 * whole bucket with nothing to notice it by.
 */
const TIMESERIES_FLOWS = [
  {
    date: '2026-06-30 00:00:00 +00:00',
    new_backlinks: 900,
    lost_backlinks: 300,
    new_referring_domains: 40,
    lost_referring_domains: 12,
  },
  {
    date: '2026-07-31 00:00:00 +00:00',
    new_backlinks: 1_400,
    lost_backlinks: 600,
    new_referring_domains: 55,
    lost_referring_domains: 20,
  },
  {
    date: '2026-08-31 00:00:00 +00:00',
    new_backlinks: 2_100,
    lost_backlinks: 500,
    new_referring_domains: 61,
    lost_referring_domains: 18,
  },
];

/**
 * The whole world `runBacklinksKind` writes to, replaced.
 *
 * The same harness `labs.test.js` uses and for the same reason: everything below
 * the fetcher — the claim row, the budget ledger and the documents it answers to
 * — is stubbed at the MODULE OBJECT, because these tests are about what the
 * fetcher decides and a `mongodb-memory-server` would answer a slower version of
 * the same questions.
 */
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

const stubWorld = ({ openJob = null, reserve = { ok: true } } = {}) => {
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

  const seen = { created: [], updates: [], reserved: [], settled: [] };

  DfsTask.create = async (doc) => {
    seen.created.push(doc);
    const row = { ...doc, _id: 'job-1' };
    row.save = async () => row;
    return row;
  };
  DfsTask.updateOne = async (filter, update) => {
    seen.updates.push({ filter, update });
    return { acknowledged: true };
  };
  DfsTask.find = () => thenable([]);

  T.findOpenJob = async () => openJob;
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
    return reserve;
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

/**
 * A transport that answers the Backlinks endpoints and refuses anything else.
 *
 * Built through the REAL `createDfsClient`, so every call travels the real three
 * layers of status checking and the real SHARED pool on its way out.
 */
const stubClient = ({ cost = 0.024036, failDofollow = false, onCall = null } = {}) => {
  const calls = [];

  const impl = async (url, init) => {
    const payload = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, payload });
    if (onCall) onCall({ url, payload });

    let body;
    if (url.includes('backlinks/index')) {
      body = envelope({
        cost: 0,
        result: [
          {
            live_backlinks: 1_950_000_000_000,
            live_referring_domains: 709_000_000,
            live_pages: 196_000_000_000,
            date: '2026-09-03 06:00:00 +00:00',
          },
        ],
      });
    } else if (url.includes('backlinks/summary')) {
      const dofollow = Array.isArray(payload?.[0]?.backlinks_filters);
      if (dofollow && failDofollow) {
        body = {
          status_code: 20000,
          status_message: 'Ok.',
          cost,
          tasks_count: 1,
          tasks_error: 1,
          tasks: [
            {
              id: 'bl-x',
              status_code: 40501,
              status_message: 'Invalid Field: backlinks_filters.',
              cost,
              result: null,
            },
          ],
        };
      } else {
        body = objectEnvelope({ cost, row: dofollow ? DOFOLLOW_PROFILE : PROFILE });
      }
    } else if (url.includes('bulk_ranks')) {
      body = listEnvelope({ cost, items: BULK_RANKS });
    } else if (url.includes('timeseries_new_lost_summary')) {
      body = listEnvelope({ cost, items: TIMESERIES_FLOWS });
    } else if (url.includes('timeseries_summary')) {
      body = listEnvelope({ cost, items: TIMESERIES_LEVELS });
    } else if (url.includes('referring_networks')) {
      body = listEnvelope({ cost, items: REFERRING_NETWORKS });
    } else if (url.includes('referring_domains')) {
      body = listEnvelope({ cost, items: REFERRING_DOMAINS });
    } else if (url.includes('anchors')) {
      body = listEnvelope({ cost, items: ANCHORS });
    } else if (url.includes('tasks_ready')) {
      body = listEnvelope({ cost: 0, items: [] });
    } else {
      throw new Error(`unexpected URL ${url}`);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  return {
    calls,
    client: createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] }),
  };
};

const collect = async (kindKey, opts = {}) => {
  resetPool();
  const world = stubWorld(opts.world);
  const stub = stubClient(opts.client);
  try {
    const out = await runBacklinksKind(getKind(kindKey), {
      session,
      client: stub.client,
      project: opts.project || project(),
      variant: VARIANT,
      now: NOW,
    });
    return { out, calls: stub.calls, seen: world.seen };
  } finally {
    world.restore();
  }
};

// ---------------------------------------------------------------------------
// 1. `rank` is 0-1000, is theirs, and is NEVER labelled DA or DR
// ---------------------------------------------------------------------------

test('the rank scale is SENT explicitly and STORED, because the number cannot say which it is on', async () => {
  const { out, calls } = await collect('backlinks_summary');
  assert.equal(out.status, 'ok', out.note);

  /**
   * The conversion between the two scales is `sin(rank / 636.62) * 100` — not
   * linear, and not recoverable from the number. A stored series whose scale
   * changed under it would draw a collapse from 562 to 56 with nothing anywhere
   * saying the measurement had changed rather than the site.
   */
  assert.equal(out.data.rankScale, C.BACKLINKS_RANK_SCALE);
  assert.equal(C.BACKLINKS_RANK_SCALE, 'one_thousand');
  assert.equal(out.data.profile.rank, 562);
  assert.ok(out.data.profile.rank <= C.BACKLINKS_RANK_MAX.one_thousand);

  for (const call of calls.filter((c) => !c.url.includes('backlinks/index'))) {
    const payload = call.payload?.[0] || {};
    if ('rank_scale' in payload) {
      assert.equal(
        payload.rank_scale,
        C.BACKLINKS_RANK_SCALE,
        `${call.url} asked for a different scale from the one the snapshot records`
      );
    }
  }
});

test('referring_domains.rank is NOT domain authority, and the names make that untypeable', () => {
  const row = normaliseReferringDomain(REFERRING_DOMAINS[0]);

  /**
   * `linkfarm.example` sends four hundred sitewide links, so the rank of the
   * links it sends is 940 — higher than the New York Times' single editorial
   * link at 210. As "authority" that is nonsense. As "how much rank these links
   * carry to us" it is exactly right, which is why the field is kept and
   * renamed rather than dropped.
   */
  assert.equal(row.linksRank, 940);
  assert.equal('rank' in row, false, 'the ambiguous name must not survive');
  assert.equal(
    'authorityRank' in row,
    false,
    'a referring-domain row must never carry the name the authority number uses'
  );

  // And the authority number, from the only endpoint that answers it.
  assert.deepEqual(normaliseBulkRank({ target: 'rival.com', rank: 701 }), {
    target: 'rival.com',
    authorityRank: 701,
  });
});

test('authority comes from bulk_ranks or from nowhere — never from a referring-domain row', async () => {
  const { out } = await collect('backlinks_summary');

  assert.deepEqual(
    out.data.authority.map((a) => [a.target, a.authorityRank, a.isSelf]),
    [
      ['acme.com', 562, true],
      ['rival.com', 701, false],
      ['other.com', 344, false],
    ]
  );

  /**
   * The negative control: with no `bulk_ranks` answer there is NO authority
   * list, even though a hundred referring-domain rows are sitting there each
   * carrying a field called `rank`. A fallback to those would be the trap
   * arriving through the back door.
   */
  const withoutRanks = aggregateSummary({
    domain: 'acme.com',
    profile: normaliseSummary(PROFILE),
    dofollow: normaliseSummary(DOFOLLOW_PROFILE),
    authority: [],
    collectedAt: NOW,
  });
  assert.deepEqual(withoutRanks.authority, []);
});

test('nothing this provider renders calls it DA, DR, domain authority or domain rating', () => {
  /**
   * DataForSEO positions `rank` as an alternative to Ahrefs' Domain Rating and
   * says in as many words that the values should not be expected to match.
   * Borrowing either competitor's name for it hands a client a number they can
   * look up elsewhere and find to be wrong — and the client is right.
   */
  const forbidden = /\bDA\b|\bDR\b|domain authority|domain rating|moz/i;

  for (const kind of BACKLINKS_KINDS) {
    assert.doesNotMatch(`${kind.label} ${kind.blurb}`, forbidden, kind.key);
  }
  const screen = SCREENS.find((s) => s.key === 'backlinks');
  assert.ok(screen, 'phase 7 declares a Backlinks screen');
  assert.doesNotMatch(`${screen.label} ${screen.blurb}`, forbidden);
});

// ---------------------------------------------------------------------------
// 2. `*_nofollow` is not the complement of dofollow
// ---------------------------------------------------------------------------

test('dofollow is a SECOND filtered summary call, not a subtraction', async () => {
  const { out, calls } = await collect('backlinks_summary');

  const summaries = calls.filter((c) => c.url.includes('backlinks/summary'));
  assert.equal(summaries.length, 2, 'the dofollow answer needs its own call');

  const [plain, filtered] = summaries;
  assert.equal(plain.payload[0].target, 'acme.com');
  assert.equal('backlinks_filters' in plain.payload[0], false);
  assert.deepEqual(filtered.payload[0].backlinks_filters, [...C.BACKLINKS_DOFOLLOW_FILTER]);
  assert.equal(filtered.payload[0].target, 'acme.com', 'both halves must be the same target');

  /**
   * THE ASSERTION THE WHOLE SECOND CALL EXISTS FOR.
   *
   * `referring_domains_nofollow` counts domains sending AT LEAST ONE nofollow
   * link, so it overlaps `referring_domains` rather than partitioning it. The
   * subtraction says 900. The filtered call says 1,010. Both are plausible, they
   * differ by 12%, and nothing on a screen would say which one it was showing.
   */
  assert.equal(out.data.dofollow.referringDomains, DOFOLLOW_PROFILE.referring_domains);
  assert.notEqual(
    out.data.dofollow.referringDomains,
    SUBTRACTION,
    'the dofollow count was derived by subtracting, which is the bug this call prevents'
  );
  assert.equal(SUBTRACTION, 900);

  // The unfiltered numbers are still carried, under names that say what they are.
  assert.equal(out.data.profile.referringDomains, 1_200);
  assert.equal(out.data.profile.referringDomainsNofollow, 300);
});

test('a failed dofollow call leaves NULL, and there is no arithmetic fallback', async () => {
  const { out } = await collect('backlinks_summary', { client: { failDofollow: true } });

  /**
   * An em dash is an honest "we did not get it". A subtraction would be a number
   * wrong by an unknowable amount that looks exactly like a right one — and it
   * would be wrong forever, because the stored row keeps no trace of how it was
   * derived.
   */
  assert.equal(out.data.dofollow, null);
  assert.equal(out.status, 'partial', 'a half-collected profile is not a clean one');
  assert.equal(out.data.profile.referringDomains, 1_200, 'the half that worked is kept');
});

test('aggregateSummary cannot synthesise a dofollow block it was not handed', () => {
  const built = aggregateSummary({
    domain: 'acme.com',
    profile: normaliseSummary(PROFILE),
    dofollow: null,
    collectedAt: NOW,
  });
  assert.equal(built.dofollow, null);
  assert.equal(built.profile.referringDomains, 1_200);
});

// ---------------------------------------------------------------------------
// 3. `backlinks_status_type` recomputes, so it must be uniform and recorded
// ---------------------------------------------------------------------------

test('every Backlinks request that takes a status type sends the SAME one', () => {
  /**
   * `all | live | lost` changes the corpus every number is computed over,
   * INCLUDING `rank` — DataForSEO's own example shows one domain at 509 under
   * `lost` and 562 under `live`. A collection whose summary was taken under one
   * and whose timeseries was taken under another would put two measurements of
   * two different graphs on one screen.
   *
   * Asserted across every kind at once rather than per request, because the bug
   * is a MIXTURE: any single request built without the field still answers
   * perfectly well under the default.
   */
  assert.ok(C.BACKLINKS_STATUS_TYPES.includes(C.BACKLINKS_STATUS_TYPE));

  const seen = new Set();
  for (const kind of BACKLINKS_KINDS) {
    const { requests } = planBacklinksRequests({ kind, project: project(), now: NOW });
    assert.ok(requests.length, `${kind.key} planned no request at all`);
    for (const request of requests) {
      if ('backlinks_status_type' in request.payload) {
        seen.add(request.payload.backlinks_status_type);
      }
    }
  }

  assert.deepEqual([...seen], [C.BACKLINKS_STATUS_TYPE]);
  assert.ok(seen.size === 1, 'two status types in one product is two incomparable graphs');
});

test('every Backlinks snapshot records the status type it was computed under', async () => {
  for (const kind of BACKLINKS_KINDS) {
    // eslint-disable-next-line no-await-in-loop
    const { out } = await collect(kind.key);
    assert.equal(out.status === 'ok' || out.status === 'partial', true, out.note);
    assert.equal(
      out.data.statusType,
      C.BACKLINKS_STATUS_TYPE,
      `${kind.key} stored no status type, so nothing downstream can refuse to compare it`
    );
  }
});

test('the stored status type is OURS, not whatever an answer happened to echo', () => {
  /**
   * Read off the response it would be a mirror of a value we sent, which is
   * circular — and it would silently follow a payload that echoed something
   * else. Taken from the constant it is a statement about the request WE made,
   * which is the fact a later comparison needs.
   */
  const built = aggregateSummary({
    domain: 'acme.com',
    profile: normaliseSummary({ ...PROFILE, backlinks_status_type: 'lost' }),
    dofollow: normaliseSummary(DOFOLLOW_PROFILE),
    collectedAt: NOW,
  });
  assert.equal(built.statusType, C.BACKLINKS_STATUS_TYPE);
  assert.notEqual(built.statusType, 'lost');
});

// ---------------------------------------------------------------------------
// 4. The request shapes
// ---------------------------------------------------------------------------

test('the timeseries window is clamped to the index epoch and travels with the series', async () => {
  const window = timeseriesWindow(NOW);
  assert.equal(window.from, '2024-09-01');

  // Twenty-four months back from 2020 would predate everything the endpoint has.
  const early = timeseriesWindow(new Date('2020-03-01T00:00:00Z'));
  assert.equal(early.from, C.BACKLINKS_INDEX_EPOCH);

  const { out } = await collect('backlinks_timeseries');
  /**
   * "New" and "lost" are computed RELATIVE TO `date_from`, so the same month's
   * new-backlink count is a different number under a different start date and
   * there is nothing in the series to say which. Stored because it cannot be
   * recovered.
   */
  assert.equal(out.data.window.from, '2024-09-01');
  assert.equal(out.data.window.group, C.BACKLINKS_TIMESERIES_GROUP);
});

test('levels and flows are merged on the DAY KEY, never zipped by index', async () => {
  const { out } = await collect('backlinks_timeseries');

  // Three buckets: the flows carry a June the levels do not.
  assert.deepEqual(
    out.data.points.map((p) => p.date),
    ['2026-06-30', '2026-07-31', '2026-08-31']
  );

  const june = out.data.points[0];
  const august = out.data.points[2];

  /**
   * Zipped by index, June's flows would have landed on July's levels and every
   * reading would be one month out — a whole series shifted, with nothing on the
   * chart to notice it by.
   */
  assert.equal(june.newBacklinks, 900);
  // NULL rather than a borrowed level: June has flows and no levels, and a
  // chart drawing it must draw a gap rather than July's link count.
  assert.equal(june.backlinks, null, 'June has flows and no levels, and stays that way');
  assert.equal(august.backlinks, 48_000);
  assert.equal(august.newBacklinks, 2_100);
  assert.equal(august.rank, 562);
});

test('the merge lets a level survive a flow row carrying nulls in its place', () => {
  const merged = aggregateTimeseries({
    domain: 'acme.com',
    levels: [{ date: '2026-08-31', backlinks: 48_000, newBacklinks: null }],
    flows: [{ date: '2026-08-31', backlinks: null, newBacklinks: 2_100 }],
  });
  assert.equal(merged.points.length, 1);
  assert.equal(merged.points[0].backlinks, 48_000);
  assert.equal(merged.points[0].newBacklinks, 2_100);
});

test('the anchor cloud is weighted by ROOT DOMAINS, not by how many links repeat', async () => {
  const { calls, out } = await collect('anchors');

  const anchors = calls.find((c) => c.url.includes('anchors'));
  /**
   * Ordered by `backlinks`, one sitewide footer repeated across forty thousand
   * pages is the entire anchor profile — forty thousand links carrying one
   * phrase that exactly one person chose. `referring_main_domains` counts how
   * many DIFFERENT root domains chose it, which is what an anchor profile is
   * about.
   */
  assert.deepEqual(anchors.payload[0].order_by, ['referring_main_domains,desc']);

  const empty = out.data.anchors.find((a) => a.anchor === '');
  assert.ok(empty, 'an empty anchor is an image link with no alt text, and is a finding');
  assert.equal(empty.backlinks, 40_000);
  assert.equal(empty.referringMainDomains, 2);
  // The denominator every share is taken against, in the units the cloud uses.
  assert.equal(out.data.totals.weight, 282);
});

test('the free breakdown maps ride in on a call already being made', async () => {
  const { calls, out } = await collect('backlinks_summary');
  const summary = calls.find((c) => c.url.includes('backlinks/summary'));
  assert.equal(summary.payload[0].internal_list_limit, C.BACKLINKS_INTERNAL_LIST_LIMIT);

  // Sorted, so a donut has an order; a list, so a TLD cannot be a Mongo key.
  assert.deepEqual(out.data.profile.breakdowns.tld, [
    { key: '.com', count: 800 },
    { key: '.org', count: 210 },
    { key: '.co.uk', count: 90 },
  ]);
  assert.equal(out.data.profile.breakdowns.countries[0].key, 'US');
});

test('bulk_ranks takes the whole competitor list, because rows are not the bill here', () => {
  const targets = rankTargets(project({ competitors: ['rival.com', 'RIVAL.com', 'other.com'] }));
  assert.deepEqual(targets, ['acme.com', 'rival.com', 'other.com']);

  /**
   * $0.024 a request and $0.000036 a row: eleven targets and one target cost the
   * same to within a thousandth of a cent. Labs is the opposite shape, which is
   * why its gap report caps competitors at three and this does not.
   */
  const one = P.backlinksEstimateFor({ endpoint: C.ENDPOINT_BACKLINKS_BULK_RANKS, rows: 1 });
  const eleven = P.backlinksEstimateFor({
    endpoint: C.ENDPOINT_BACKLINKS_BULK_RANKS,
    rows: 11,
  });
  assert.ok(eleven.estimateUsd - one.estimateUsd < 0.001);
});

test('a site with no domain is `pending`, not an empty billable call', async () => {
  const { out, calls, seen } = await collect('backlinks_summary', {
    project: project({ domain: '' }),
  });
  assert.equal(out.status, 'pending');
  assert.match(out.note, /no domain/i);
  assert.equal(seen.created.length, 0, 'nothing may be claimed for nothing');
  assert.equal(calls.length, 0);
});

test('the base every request shares is where the status type is decided', () => {
  assert.deepEqual(baseFor('acme.com'), {
    target: 'acme.com',
    backlinks_status_type: C.BACKLINKS_STATUS_TYPE,
  });
});

// ---------------------------------------------------------------------------
// 5. Variants — ONE profile per site, whatever its markets say
// ---------------------------------------------------------------------------

test('a backlink profile is bought ONCE per site, however many markets it tracks', () => {
  const site = project();
  assert.equal(variantsFor('positions', site).variants.length, 2, 'SERP still fans out');

  for (const kind of BACKLINKS_KINDS) {
    const out = variantsFor(kind.key, site);
    assert.equal(
      out.variants.length,
      1,
      `${kind.key} would buy the same profile once per target, forever`
    );
    assert.equal(out.variants[0].key, VARIANT.key);
  }

  // Four targets, still one profile. This is the whole point of the third scope.
  const wide = project({
    targets: [
      { locationCode: 2840, languageCode: 'en', device: 'desktop' },
      { locationCode: 2840, languageCode: 'en', device: 'mobile' },
      { locationCode: 2826, languageCode: 'en', device: 'desktop' },
      { locationCode: 2250, languageCode: 'fr', device: 'mobile' },
    ],
  });
  assert.equal(variantsFor('backlinks_summary', wide).variants.length, 1);
  // A market-scoped Labs kind would have made that FOUR into TWO and still
  // doubled the bill. It is the near miss, so it is asserted beside it.
  assert.equal(variantsFor('competitors', wide).variants.length, 3);
});

test('a domain-scoped snapshot answers for whatever market the tab is showing', () => {
  const descriptor = require('./index');
  const rank = variantKeyFor({ locationCode: 2840, languageCode: 'en', device: 'desktop' });
  const uk = variantKeyFor({ locationCode: 2826, languageCode: 'en', device: 'desktop' });

  /**
   * Not a loosening. `variantsFor` guarantees there is exactly ONE stored
   * variant for these kinds, so there is nothing else the comparison could be
   * choosing between — while a market comparison would never match
   * (`0|any|any` against `2840|en|…`) and would blank the screen permanently.
   */
  assert.equal(descriptor.sameVariant('backlinks_summary', VARIANT.key, rank), true);
  assert.equal(descriptor.sameVariant('anchors', VARIANT.key, uk), true);
  assert.equal(descriptor.sameVariant('referring_domains', VARIANT.key, 'default'), true);

  // The other two scopes are untouched.
  assert.equal(descriptor.sameVariant('positions', uk, rank), false);
  assert.equal(
    descriptor.sameVariant(
      'competitors',
      variantKeyFor({ locationCode: 2840, languageCode: 'en', device: 'any' }),
      rank
    ),
    true
  );
});

// ---------------------------------------------------------------------------
// 6. Money — estimated from a book, RECORDED from the response
// ---------------------------------------------------------------------------

test('the ledger records the ENVELOPE cost, not the estimate', async () => {
  const cost = 0.019_87;
  const { seen } = await collect('referring_domains', { client: { cost } });

  assert.equal(seen.settled.length, 1);
  assert.equal(seen.settled[0].actualUsd, cost);
  assert.notEqual(
    seen.settled[0].actualUsd,
    seen.settled[0].estimateUsd,
    'a settle that matched the estimate would not prove the envelope was read'
  );
});

test("the account's own Backlinks price wins over the published one", () => {
  const quota = {
    price: {
      backlinks: { summary: { live: { task: 0.02, item: 0.00002 } } },
    },
  };
  const mine = P.backlinksEstimateFor({
    quota,
    endpoint: C.ENDPOINT_BACKLINKS_SUMMARY,
    rows: 100,
  });
  assert.equal(mine.source, 'account');
  assert.equal(mine.taskUsd, 0.02);

  const published = P.backlinksEstimateFor({
    endpoint: C.ENDPOINT_BACKLINKS_SUMMARY,
    rows: 100,
  });
  assert.equal(published.source, 'published');
  assert.equal(published.taskUsd, C.BACKLINKS_TASK_USD);
  assert.equal(published.itemUsd, C.BACKLINKS_ITEM_USD);
});

test('OUR OWN cap answers `pending` and suppresses posting — it never throws', async () => {
  resetPool();
  const world = stubWorld({ reserve: { ok: false, blocked: { scope: 'org', capUsd: 5 } } });
  const { client, calls } = stubClient();

  try {
    const out = await runBacklinksKind(getKind('anchors'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
    assert.equal(out.status, 'pending');
    assert.match(out.note, /Monthly budget reached/);
    assert.equal(client.postingSuppressed(), true);
  } finally {
    world.restore();
  }

  // The free footnote is allowed to have run. NOTHING BILLABLE may have.
  assert.equal(
    calls.filter((c) => !c.url.includes('backlinks/index')).length,
    0,
    'a refused reservation must not reach a billable endpoint'
  );
});

test('a concurrent claim loses on the index and spends nothing', async () => {
  resetPool();
  const world = stubWorld();
  const { client, calls } = stubClient();
  const create = DfsTask.create;
  DfsTask.create = async () => {
    const err = new Error('E11000 duplicate key');
    err.code = 11000;
    throw err;
  };

  try {
    const out = await runBacklinksKind(getKind('backlinks_summary'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
    assert.equal(out.status, 'pending');
    assert.match(out.note, /already running/i);
  } finally {
    DfsTask.create = create;
    world.restore();
  }

  assert.equal(calls.filter((c) => c.url.includes('backlinks/summary')).length, 0);
});

// ---------------------------------------------------------------------------
// 7. The shared ceiling, and the collector that cannot spend
// ---------------------------------------------------------------------------

test('phase 7 adds NO limiter of its own — it joins the one shared pool', async () => {
  /**
   * DataForSEO's 30-simultaneous ceiling is ONE ceiling for Labs, Backlinks and
   * OnPage. A Backlinks limiter of twenty-five beside phase 6's twenty-five is
   * fifty in flight against thirty, and the symptom is not a crash — it is a
   * storm of `40209`s spread across a shared credential, each retried, each
   * retry taking a slot somebody else was waiting for.
   *
   * The prefix has been in the list since phase 6, before this family existed.
   * The whole of phase 7's compliance is making a call at all.
   */
  assert.ok(DB_BACKED_PREFIXES.includes('backlinks/'));

  resetPool();
  const world = stubWorld();
  const { client } = stubClient();
  const before = poolStats().admitted;
  try {
    await runBacklinksKind(getKind('backlinks_summary'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
  } finally {
    world.restore();
  }

  // The free index footnote plus the three billable calls, all pooled.
  assert.equal(poolStats().admitted - before, 4);
  assert.ok(poolStats().peakInFlight <= C.DB_BACKED_POOL_LIMIT);
  assert.equal(poolStats().inFlight, 0);
});

test('the collection pass refuses every billable Backlinks endpoint by default', () => {
  // The one free one, admitted deliberately.
  assert.equal(isFreeEndpoint(C.ENDPOINT_BACKLINKS_INDEX), true);

  for (const kind of BACKLINKS_KINDS) {
    assert.equal(
      isFreeEndpoint(kind.endpoint),
      false,
      `${kind.endpoint} was admitted to the free allowlist`
    );
  }

  // Including the ones no kind is FILED under but every collection calls.
  for (const endpoint of [
    C.ENDPOINT_BACKLINKS_SUMMARY,
    C.ENDPOINT_BACKLINKS_TIMESERIES,
    C.ENDPOINT_BACKLINKS_TIMESERIES_NEW_LOST,
    C.ENDPOINT_BACKLINKS_REFERRING_DOMAINS,
    C.ENDPOINT_BACKLINKS_ANCHORS,
    C.ENDPOINT_BACKLINKS_BULK_RANKS,
    C.ENDPOINT_BACKLINKS_REFERRING_NETWORKS,
  ]) {
    assert.equal(isFreeEndpoint(endpoint), false, endpoint);
  }
});

test('the collect-only transport rejects a Backlinks purchase even if code asked for one', async () => {
  const wrapped = collectOnlyClient(stubClient().client);
  await assert.rejects(
    wrapped.call(C.ENDPOINT_BACKLINKS_SUMMARY, [{ target: 'acme.com' }]),
    /may not call/
  );
  await assert.rejects(wrapped.send(C.ENDPOINT_BACKLINKS_BULK_RANKS, {}), /may not call/);
  // And the free footnote still passes, which is what an allowlist is for.
  assert.equal(isFreeEndpoint(C.ENDPOINT_BACKLINKS_INDEX), true);
});

// ---------------------------------------------------------------------------
// 8. The dispatch
// ---------------------------------------------------------------------------

test('every Backlinks kind is live, in the backlinks family, and floored', () => {
  /**
   * FIVE since phase 10. `referring_networks` joined the family rather than
   * becoming a second call on `referring_domains`, because on this API the
   * CALLS are the bill and a kind is what a board can switch off.
   */
  assert.equal(BACKLINKS_KINDS.length, 5);
  for (const kind of BACKLINKS_KINDS) {
    assert.equal(isTaskKind(kind), false, `${kind.key} is not a queued kind`);
    assert.equal(kind.transport, 'live');
    assert.equal(kind.family, 'backlinks');
    assert.equal(kind.variantScope, 'domain');
    assert.ok(
      Number.isFinite(kind.minRebuyHours) && kind.minRebuyHours > 0,
      `${kind.key} has no rebuy floor`
    );
    assert.ok(kind.minRebuyHours < kind.intervalHours, `${kind.key} floor is not below cadence`);
  }
});

test('fetchKind routes on FAMILY, and the Backlinks floor refuses an early re-buy', async () => {
  resetPool();
  const world = stubWorld();
  const { client, calls } = stubClient();

  try {
    // Two hours old against a 144-hour floor.
    const refused = await fetchKind('backlinks_summary', {
      session,
      client,
      project: project(),
      variant: VARIANT,
      existing: { fetchedAt: new Date('2026-09-03T08:00:00Z') },
      now: NOW,
    });
    assert.equal(refused.status, 'pending');
    assert.match(refused.note, /available again in/);
    assert.equal(calls.length, 0, 'the floor must be checked before anything is spent');

    // A person who read the note and asked anyway gets through — to the
    // BACKLINKS builder, not to the Labs one, which would have planned nothing
    // and answered "No Labs request is defined for backlinks_summary".
    const forced = await fetchKind('backlinks_summary', {
      session,
      client,
      project: project(),
      variant: VARIANT,
      existing: { fetchedAt: new Date('2026-09-03T08:00:00Z') },
      force: true,
      now: NOW,
    });
    assert.equal(forced.status, 'ok', forced.note);
    assert.equal(forced.data.profile.rank, 562);
  } finally {
    world.restore();
  }
});

test('a Backlinks kind never asks tasks_ready what has finished', async () => {
  resetPool();
  const world = stubWorld();
  const { client, calls } = stubClient();

  try {
    await fetchKind('anchors', {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
  } finally {
    world.restore();
  }

  assert.equal(
    calls.filter((c) => c.url.includes('tasks_ready')).length,
    0,
    'a free call whose answer nothing consults is still a call'
  );
});

// ---------------------------------------------------------------------------
// 9. What the screen is handed
// ---------------------------------------------------------------------------

test('a referring-domain row keeps its nulls and its spam score', async () => {
  const { out } = await collect('referring_domains');
  assert.equal(out.data.domains.length, 2);

  const paper = out.data.domains.find((d) => d.domain === 'nytimes.com');
  assert.equal(paper.linksRank, 210);
  assert.equal(paper.backlinks, 1);
  assert.equal(paper.spamScore, 2);
  // Absent on the fixture. Null, never 0 — "no broken links" and "we could not
  // read the field" are opposite facts.
  assert.equal(paper.lostDate, null);
  assert.equal(paper.breakdowns.tld, null);

  /**
   * Named `shown` rather than `referringDomains`, because it is the top hundred
   * we asked for and the hero tile above says 1,200. Two numbers called the same
   * thing on one screen is how a footer contradicts a headline.
   */
  assert.equal(out.data.totals.shown, 2);
  assert.equal(out.data.totals.averageSpamScore, 40);
});

test('a missing number stays null all the way to the snapshot', () => {
  const bare = normaliseSummary({ target: 'acme.com' });
  assert.equal(bare.rank, null);
  assert.equal(bare.backlinks, null);
  assert.equal(bare.referringDomains, null);
  assert.equal(bare.spamScore, null);
  assert.equal(bare.breakdowns.tld, null);

  const anchor = normaliseAnchor({ anchor: 'x' });
  assert.equal(anchor.referringMainDomains, null);
  assert.equal(anchor.backlinks, null);

  assert.deepEqual(normaliseBulkRank(null), { target: null, authorityRank: null });
});

test('the free index footnote is a caption, and an unreadable one costs only the caption', async () => {
  const { out } = await collect('backlinks_summary');
  assert.equal(out.data.index.referringDomains, 709_000_000);

  resetPool();
  const world = stubWorld();
  const broken = createDfsClient(session, {
    fetchImpl: async (url) => {
      if (url.includes('backlinks/index')) throw new Error('network');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.includes('backlinks/summary')
              ? objectEnvelope({ row: PROFILE })
              : listEnvelope({ items: BULK_RANKS })
          ),
      };
    },
    retryDelaysMs: [],
  });

  try {
    const out2 = await runBacklinksKind(getKind('backlinks_summary'), {
      session,
      client: broken,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
    assert.equal(out2.status, 'ok', out2.note);
    assert.equal(out2.data.index, null);
    assert.equal(out2.data.profile.rank, 562);
  } finally {
    world.restore();
  }
});

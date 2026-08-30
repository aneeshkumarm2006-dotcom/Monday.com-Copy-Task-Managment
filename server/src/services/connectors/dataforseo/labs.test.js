const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./constants');
const P = require('./pricing');
const T = require('./tasks');
const B = require('../budget');
const Budget = require('./budget');
const DfsTask = require('../../../models/DfsTask');
const ConnectorProject = require('../../../models/ConnectorProject');
const snapshotService = require('../snapshotService');

const { KINDS, getKind, isTaskKind } = require('./kinds');

/**
 * The Labs kinds, by FAMILY rather than by transport.
 *
 * "Not a task kind" meant "a Labs kind" for exactly as long as Labs was the only
 * live family, and phase 7 made Backlinks live too. Every assertion in this file
 * that used the transport meant the family — a Labs payload, a Labs screen, a
 * Labs price — so the predicate moved and the tests did not.
 *
 * `isTaskKind` stays imported because one assertion here is genuinely about the
 * transport: the ten-minute collector skips a live row whichever family it
 * belongs to.
 */
const LABS_KINDS = KINDS.filter((k) => k.family === 'labs');
const { SCREENS } = require('./screens');
const { variantsFor, variantKeyFor } = require('./sites');
const { isFreeEndpoint, collectOnlyClient, collectAllReady } = require('./collect');
const { createDfsClient } = require('./client');
const { resetPool, poolStats } = require('./pool');
const { findSearchOperators } = require('./operators');
const {
  guardClickstream,
  labsKeywords,
  gapCompetitors,
  planLabsRequests,
  runLabsKind,
} = require('./labs');
const { normaliseLabsStatus, normaliseGapRow } = require('./labsNormalise');
const { fetchKind } = require('./fetchers');

/**
 * Phase 6 — the Labs pack, and the four things it can get expensively wrong.
 *
 * 1. `include_clickstream_data: true` SILENTLY DOUBLES the request cost on ~15
 *    Labs endpoints, defaults false, and changes nothing visible in the
 *    response. There is no symptom short of the invoice, so the guard is
 *    asserted at the seam every Labs payload passes through.
 *
 * 2. LABS IS A DATABASE, NOT A CRAWL, and DataForSEO's own docs say both
 *    "weekly" and "30-90 days" about how stale it is. Both cannot be true, so
 *    every panel carries `indexUpdatedAt` from the free `/status` and the word
 *    "live" is reserved for SERP and Backlinks. A snapshot without that stamp is
 *    a claim we have no basis for.
 *
 * 3. THE PRICE OF A LABS CALL IS SETTLED FROM THE RESPONSE, never from a
 *    constant. That is what makes Labs Bing — whose price DataForSEO has never
 *    published — correct in our ledger on its first call, and it is the plan's
 *    outstanding item #4 answered structurally rather than by a number somebody
 *    has to maintain.
 *
 * 4. `domain_intersection` IS DIRECTIONAL. Swap `target1` and `target2` and the
 *    same call cheerfully returns the opposite report, with nothing in the
 *    payload to say so, under a heading that says "keyword gap".
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-03T10:00:00Z');
const INDEX_DATE = '2026-08-24 00:00:00 +00:00';

const VARIANT = {
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
  trackedKeywords: ['best crm for agencies', 'agency crm pricing'],
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

const envelope = ({ cost = 0, items = [], result = null }) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [
    {
      id: 'labs-1',
      status_code: 20000,
      status_message: 'Ok.',
      cost,
      data: {},
      result: result || [{ items }],
    },
  ],
});

const statusEnvelope = (dateUpdate = INDEX_DATE) =>
  envelope({
    cost: 0,
    result: [
      {
        google: { date_update: dateUpdate },
        bing: { date_update: dateUpdate },
        amazon: { date_update: dateUpdate },
      },
    ],
  });

const keywordItem = (keyword, overrides = {}) => ({
  keyword,
  keyword_info: {
    search_volume: 1900,
    cpc: 12.4,
    competition: 0.61,
    competition_level: 'HIGH',
    monthly_searches: [{ year: 2026, month: 8, search_volume: 2100 }],
    search_volume_trend: { monthly: 4, quarterly: -2, yearly: 18 },
  },
  keyword_properties: { keyword_difficulty: 47 },
  search_intent_info: { main_intent: 'commercial', probability: 0.82 },
  serp_info: { serp_item_types: ['organic', 'people_also_ask'], se_results_count: 4_100_000 },
  ...overrides,
});

const competitorItem = (domain) => ({
  domain,
  intersections: 42,
  avg_position: 14.2,
  median_position: 11,
  rating: 0.71,
  metrics: { organic: { count: 42, etv: 900, pos_1: 1, pos_2_3: 4, pos_4_10: 12 } },
  full_domain_metrics: {
    organic: { count: 21000, etv: 480000, pos_1: 900, pos_2_3: 2100, pos_4_10: 6000 },
  },
});

const gapItem = (keyword) => ({
  keyword_data: {
    keyword,
    keyword_info: { search_volume: 880, cpc: 6.2 },
    keyword_properties: { keyword_difficulty: 31 },
  },
  first_domain_serp_element: { rank_group: 4, url: 'https://rival.com/x', etv: 120 },
  second_domain_serp_element: null,
});

const pageItem = (url) => ({
  page_address: url,
  metrics: { organic: { count: 61, etv: 1420, pos_1: 3, pos_2_3: 8, pos_4_10: 20 } },
});

/**
 * The whole world `runLabsKind` writes to, replaced.
 *
 * Everything below the fetcher — the claim row, the budget ledger and the
 * documents it answers to — is stubbed at the MODULE OBJECT rather than at the
 * database, because these tests are about what the fetcher decides, and a
 * `mongodb-memory-server` would answer a slower version of the same questions.
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

  const seen = {
    created: [],
    updates: [],
    reserved: [],
    settled: [],
  };

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
  /**
   * The reservation reconciler runs once per pass off the client's `runOnce`,
   * for BOTH transports — a Labs call holds a reservation the same way a SERP
   * post does. Answered with nothing to sweep, rather than left to buffer
   * against a database no test connects to.
   */
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
 * A transport that answers the Labs endpoints and refuses anything else.
 *
 * Built through the REAL `createDfsClient`, so the calls travel the real three
 * layers of status checking and the real shared pool on their way out.
 */
const stubClient = ({ cost = 0.0264, statusBody = null, onCall = null } = {}) => {
  const calls = [];

  const impl = async (url, init) => {
    const payload = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, payload });
    if (onCall) onCall({ url, payload });

    let body;
    if (url.includes('tasks_ready')) {
      body = envelope({ cost: 0, result: [] });
    } else if (url.includes('serp/errors')) {
      body = { status_code: 20000, cost: 0, tasks_count: 1, tasks_error: 0, tasks: [] };
    } else if (url.includes('dataforseo_labs/status')) {
      body = statusBody === null ? statusEnvelope() : statusBody;
    } else if (url.includes('keyword_overview')) {
      const asked = payload?.[0]?.keywords || [];
      body = envelope({ cost, items: asked.map((k) => keywordItem(k)) });
    } else if (url.includes('competitors_domain')) {
      body = envelope({ cost, items: [competitorItem('rival.com'), competitorItem('other.com')] });
    } else if (url.includes('domain_intersection')) {
      body = envelope({ cost, items: [gapItem('crm for marketing agencies')] });
    } else if (url.includes('relevant_pages')) {
      body = envelope({ cost, items: [pageItem('https://acme.com/crm')] });
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

// ---------------------------------------------------------------------------
// 1. The clickstream guard
// ---------------------------------------------------------------------------

test('a payload carrying include_clickstream_data is REFUSED, not quietly stripped', () => {
  assert.throws(
    () =>
      guardClickstream({
        endpoint: C.ENDPOINT_LABS_KEYWORD_OVERVIEW,
        payload: { keywords: ['x'], [C.CLICKSTREAM_KEY]: true },
        allowed: false,
      }),
    /DOUBLES/
  );

  // Absent and explicitly false are both "no", and both cost nothing extra.
  assert.equal(
    guardClickstream({ endpoint: 'x', payload: { keywords: ['x'] }, allowed: false }),
    1
  );
  assert.equal(
    guardClickstream({ endpoint: 'x', payload: { [C.CLICKSTREAM_KEY]: false }, allowed: false }),
    1
  );
});

test('a kind that OPTS IN gets the multiplier, so the estimate doubles with the price', () => {
  const multiplier = guardClickstream({
    endpoint: C.ENDPOINT_LABS_KEYWORD_OVERVIEW,
    payload: { [C.CLICKSTREAM_KEY]: true },
    allowed: true,
  });
  assert.equal(multiplier, C.CLICKSTREAM_MULTIPLIER);

  const plain = P.labsEstimateFor({
    endpoint: C.ENDPOINT_LABS_KEYWORD_OVERVIEW,
    rows: 200,
    multiplier: 1,
  });
  const doubled = P.labsEstimateFor({
    endpoint: C.ENDPOINT_LABS_KEYWORD_OVERVIEW,
    rows: 200,
    multiplier,
  });
  assert.equal(doubled.estimateUsd, P.round6(plain.estimateUsd * 2));
});

test('NOTHING shipped asks for clickstream data, and nothing shipped builds it in', () => {
  for (const kind of KINDS) {
    assert.notEqual(
      kind.clickstream,
      true,
      `${kind.key} opts into a x2 nobody signed off on`
    );
  }

  // And the payload builder does not smuggle it in either. This is the check
  // that survives somebody copying a request example out of the docs.
  for (const kind of LABS_KINDS) {
    const { requests } = planLabsRequests({
      kind,
      project: project(),
      variant: VARIANT,
    });
    assert.ok(requests.length, `${kind.key} planned no request at all`);
    for (const request of requests) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(request.payload, C.CLICKSTREAM_KEY),
        false,
        `${kind.key} built ${C.CLICKSTREAM_KEY} into its payload`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Freshness — the stamp, and the sentence it makes honest
// ---------------------------------------------------------------------------

test('every Labs snapshot carries the index date from the free /status', async () => {
  resetPool();
  const world = stubWorld();
  const { client, calls } = stubClient();

  try {
    for (const kind of LABS_KINDS) {
      // eslint-disable-next-line no-await-in-loop
      const out = await runLabsKind(kind, {
        session,
        client,
        project: project(),
        variant: VARIANT,
        now: NOW,
      });
      assert.equal(out.status, 'ok', `${kind.key}: ${out.note}`);
      assert.equal(
        out.data.indexUpdatedAt,
        '2026-08-24T00:00:00.000Z',
        `${kind.key} did not stamp the index date`
      );
      /**
       * TWO DIFFERENT FACTS, and the screens show both. `collectedAt` is when WE
       * asked; `indexUpdatedAt` is when THEY last rebuilt the database the answer
       * came out of. Collapsing them would let a Labs panel inherit the rank
       * tracker's "collected 2 hours ago" caption and make a freshness claim
       * about somebody else's index that we have no basis for.
       */
      assert.equal(out.data.collectedAt, NOW);
      assert.notEqual(out.data.collectedAt, out.data.indexUpdatedAt);
    }
  } finally {
    world.restore();
  }

  // ONE `/status` call for four kinds — memoised on the client through
  // `runOnce`, the same seam `tasks_ready` uses.
  const statusCalls = calls.filter((c) => c.url.includes('dataforseo_labs/status'));
  assert.equal(statusCalls.length, 1);
});

test('an unreadable /status costs the caption and never the collection', async () => {
  resetPool();
  const world = stubWorld();
  const { client } = stubClient({
    statusBody: envelope({ cost: 0, result: [{ google: { date_update: 'not a date' } }] }),
  });

  try {
    const out = await runLabsKind(getKind('competitors'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
    assert.equal(out.status, 'ok');
    assert.equal(out.data.indexUpdatedAt, null);
  } finally {
    world.restore();
  }
});

test('normaliseLabsStatus reads the three databases and refuses to guess', () => {
  const good = normaliseLabsStatus({
    google: { date_update: '2026-08-24 00:00:00 +00:00' },
    bing: { date_update: '2026-08-20 00:00:00 +00:00' },
    amazon: {},
  });
  assert.equal(good.google, '2026-08-24T00:00:00.000Z');
  assert.equal(good.bing, '2026-08-20T00:00:00.000Z');
  assert.equal(good.amazon, null);
  assert.deepEqual(normaliseLabsStatus(null), {
    google: null,
    bing: null,
    amazon: null,
  });
});

test('every Labs screen says "competitive index" rather than "live"', () => {
  const labsKinds = new Set(LABS_KINDS.map((k) => k.key));
  const touchesLabs = SCREENS.filter((s) => s.kinds.some((k) => labsKinds.has(k)));

  /**
   * THE RULE THAT HAS NO EXCEPTION: nothing drawing Labs data may call it live.
   * DataForSEO's own documentation puts that database at both "weekly" and
   * "30-90 days", and the word is reserved for SERP and Backlinks.
   */
  for (const screen of touchesLabs) {
    assert.doesNotMatch(
      screen.blurb,
      /\blive\b/i,
      `${screen.key} describes a database as a live reading`
    );
  }

  /**
   * AND THE CAPTION RULE, which applies to a screen whose numbers ALL come out
   * of that database.
   *
   * Phase 10 split these two apart, and the reason is `client_report`: it draws
   * Labs, SERP, Backlinks and a crawl on one page, and a single blurb cannot
   * honestly caption four freshness stories at once. Its widgets carry a
   * per-source stamp instead — see `reportWidgets.js`, where every widget names
   * the kind it came from — which is the same information one level down.
   *
   * Written as "every kind on this screen is a Labs kind" rather than as a
   * hardcoded count, so a fourth single-family Labs screen would be held to the
   * rule automatically.
   */
  const labsOnly = touchesLabs.filter((s) => s.kinds.every((k) => labsKinds.has(k)));
  assert.equal(labsOnly.length, 3, 'phase 6 ships three Labs-only screens');
  for (const screen of labsOnly) {
    assert.match(
      screen.blurb,
      /competitive index/i,
      `${screen.key} must say which database it is reading`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Money — estimated from a book, RECORDED from the response
// ---------------------------------------------------------------------------

test('the ledger records the ENVELOPE cost, not the estimate — the Bing answer', async () => {
  resetPool();
  const world = stubWorld();
  /**
   * A cost deliberately unlike anything this code could have computed. The
   * published Google tier would put a 2-keyword `keyword_overview` at
   * $0.012 + 2 x $0.00012 = $0.01224; DataForSEO says $0.00777.
   *
   * That gap IS the test. Labs Bing has no published price at all — their
   * pricing page renders as a nav shell — so any design that recorded an
   * estimate would be permanently and invisibly wrong for eleven endpoints. This
   * one is right on the first call whatever the number turns out to be.
   */
  const { client } = stubClient({ cost: 0.00777 });

  try {
    const out = await runLabsKind(getKind('keyword_metrics'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
    assert.equal(out.status, 'ok');
  } finally {
    world.restore();
  }

  const inc = world.seen.updates.find((u) => u.update.$inc);
  assert.equal(inc.update.$inc.costUsd, 0.00777, 'the row must record what was charged');

  const settled = world.seen.settled.at(-1);
  assert.equal(settled.actualUsd, 0.00777);
  assert.notEqual(
    settled.actualUsd,
    settled.estimateUsd,
    'a test where the estimate happens to equal the cost proves nothing'
  );
});

test('the ledger records what was BOUGHT, not how many HTTP calls it took', async () => {
  resetPool();
  const world = stubWorld();
  const { client } = stubClient();

  try {
    await runLabsKind(getKind('keyword_metrics'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
    await runLabsKind(getKind('keyword_gap'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
  } finally {
    world.restore();
  }

  /**
   * `keyword_overview` sends two hundred keywords in ONE request. Recording one
   * ledger entry per request would report that purchase as "1 keyword bought"
   * on the Usage screen while DataForSEO charged for two hundred rows — a ledger
   * understating the exact thing it exists to account for.
   */
  assert.deepEqual(world.seen.created[0].keywords, [
    'best crm for agencies',
    'agency crm pricing',
  ]);

  // A gap job's units really ARE its calls — one per competitor — so those
  // travel through unchanged.
  assert.deepEqual(world.seen.created[1].keywords, ['rival.com', 'other.com']);
});

test('an unpriced endpoint OVER-reserves rather than under — the safe direction', () => {
  /**
   * No account price book at all, which is the state a Bing endpoint is in:
   * unpublished, unlisted, unknown. The estimate falls back to the published
   * GOOGLE figures, which the only Bing figure anybody has ever quoted
   * ($0.01/task + $0.0001/item) sits BELOW. So an unknown price can hold too
   * much of the cap and never too little, and the settle corrects it seconds
   * later from the response.
   */
  const unknown = P.labsEstimateFor({
    quota: null,
    endpoint: C.ENDPOINT_LABS_BING_BULK_KEYWORD_DIFFICULTY,
    rows: 10,
  });
  assert.equal(unknown.source, 'published');
  assert.equal(unknown.taskUsd, C.LABS_TASK_USD);
  assert.equal(unknown.itemUsd, C.LABS_ITEM_USD);
  assert.equal(unknown.estimateUsd, P.round6(0.012 + 10 * 0.00012));

  const rumouredBingPrice = 0.01 + 10 * 0.0001;
  assert.ok(
    unknown.estimateUsd > rumouredBingPrice,
    'the fallback must not sit under the cheapest plausible real price'
  );
});

test("the account's OWN Labs price wins, and the per-item price is not mistaken for it", () => {
  const quota = {
    price: {
      dataforseo_labs: {
        google: { keyword_overview: { live: { task: 0.009, item: 0.00009 } } },
      },
    },
  };
  const out = P.labsEstimateFor({
    quota,
    endpoint: C.ENDPOINT_LABS_KEYWORD_OVERVIEW,
    rows: 100,
  });
  assert.equal(out.source, 'account');
  assert.equal(out.taskUsd, 0.009);
  assert.equal(out.itemUsd, 0.00009);
  assert.equal(out.estimateUsd, P.round6(0.009 + 100 * 0.00009));

  /**
   * The bug this shape exists to avoid: `readLeaf` takes the MINIMUM in a
   * subtree, which is correct for SERP (every unmodelled dimension multiplies
   * upward) and a hundred-fold under-estimate on a Labs leaf holding two prices.
   */
  assert.equal(P.unitPriceFor(quota.price, C.ENDPOINT_LABS_KEYWORD_OVERVIEW), 0.00009);
  assert.notEqual(out.taskUsd, 0.00009);
});

test('OUR OWN cap answers `pending` and suppresses posting — it never throws', async () => {
  resetPool();
  const world = stubWorld({ reserve: { ok: false, blocked: { scope: 'org', capUsd: 5 } } });
  const { client, calls } = stubClient();

  try {
    const out = await runLabsKind(getKind('top_pages'), {
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

  /**
   * The `/status` read happens before the purchase and is free, so it is allowed
   * to have run. NOTHING BILLABLE may have.
   */
  assert.equal(
    calls.filter((c) => !c.url.includes('dataforseo_labs/status')).length,
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
    const out = await runLabsKind(getKind('competitors'), {
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

  assert.equal(calls.filter((c) => c.url.includes('competitors_domain')).length, 0);
});

// ---------------------------------------------------------------------------
// 4. The request shapes
// ---------------------------------------------------------------------------

test('the gap report is DIRECTIONAL: the competitor is target1 and we are target2', () => {
  const { requests } = planLabsRequests({
    kind: getKind('keyword_gap'),
    project: project(),
    variant: VARIANT,
  });

  // One call per competitor, capped.
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.payload.target2, 'acme.com', 'we must be the second target');
    assert.notEqual(request.payload.target1, 'acme.com');
    /**
     * `false` IS the gap report — keywords `target1` ranks for and `target2`
     * does not. `true` would be the overlap, which is a different screen.
     */
    assert.equal(request.payload.intersections, false);
    assert.equal(request.payload.limit, C.LABS_GAP_LIMIT);
  }

  // And the normaliser reads the sides the same way round the builder wrote them.
  const row = normaliseGapRow(gapItem('crm for marketing agencies'));
  assert.equal(row.competitorRank, 4);
  assert.equal(row.competitorUrl, 'https://rival.com/x');
  // NULL is the point of this report, and must never become a rank of zero.
  assert.equal(row.ourRank, null);
});

test('a gap with nobody to compare against is `pending`, not an empty purchase', async () => {
  const { competitors, note } = gapCompetitors(project({ competitors: [] }));
  assert.deepEqual(competitors, []);
  assert.match(note, /needs somebody to compare against/i);

  resetPool();
  const world = stubWorld();
  const { client, calls } = stubClient();
  try {
    const out = await runLabsKind(getKind('keyword_gap'), {
      session,
      client,
      project: project({ competitors: [] }),
      variant: VARIANT,
      now: NOW,
    });
    assert.equal(out.status, 'pending');
    assert.equal(world.seen.created.length, 0, 'nothing may be claimed for nothing');
  } finally {
    world.restore();
  }
  assert.equal(calls.length, 0);
});

test('the competitor pull strips the domains that compete with everybody', () => {
  const { requests } = planLabsRequests({
    kind: getKind('competitors'),
    project: project(),
    variant: VARIANT,
  });
  assert.equal(requests[0].payload.exclude_top_domains, true);
  assert.equal(requests[0].payload.limit, C.LABS_COMPETITOR_LIMIT);
  assert.equal(requests[0].payload.target, 'acme.com');
});

test('every Labs request carries an explicit limit — the only cost control there is', () => {
  for (const kind of LABS_KINDS) {
    const { requests } = planLabsRequests({ kind, project: project(), variant: VARIANT });
    for (const request of requests) {
      const bounded =
        typeof request.payload.limit === 'number' ||
        Array.isArray(request.payload.keywords);
      assert.ok(bounded, `${kind.key} would let DataForSEO decide how many rows to bill for`);
      assert.ok(request.rows > 0, `${kind.key} estimates against zero rows`);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Search operators — the existing validator, reused
// ---------------------------------------------------------------------------

test('an operator keyword is dropped from a Labs batch, and the note names it', () => {
  const rows = project({
    trackedKeywords: ['best crm for agencies', 'site:acme.com', 'agency crm pricing'],
  });
  const out = labsKeywords(rows);

  assert.deepEqual(out.keywords, ['best crm for agencies', 'agency crm pricing']);
  assert.equal(out.dropped.length, 1);
  assert.match(out.dropped[0], /site:/);
  assert.match(out.note, /search operator/i);

  // The same rule `sites.readKeywords` enforces at save time — one detector, so
  // a keyword refused by the form cannot be silently bought by the fetcher.
  assert.equal(findSearchOperators('site:acme.com').length, 1);
});

test('a keyword list that is ALL operators is `pending`, not an empty billable call', () => {
  const out = labsKeywords(project({ trackedKeywords: ['site:acme.com', 'inurl:blog'] }));
  assert.deepEqual(out.keywords, []);
  assert.match(out.note, /search operator/i);

  const { requests, note } = planLabsRequests({
    kind: getKind('keyword_metrics'),
    project: project({ trackedKeywords: ['site:acme.com'] }),
    variant: VARIANT,
  });
  assert.deepEqual(requests, []);
  assert.ok(note);
});

// ---------------------------------------------------------------------------
// 6. Variants — a device distinction Labs does not make
// ---------------------------------------------------------------------------

test('desktop and mobile collapse to ONE Labs variant, and stay TWO for SERP', () => {
  const site = project();

  const serp = variantsFor('positions', site);
  assert.equal(serp.variants.length, 2, 'a desktop rank and a mobile rank are two facts');

  for (const kind of LABS_KINDS) {
    const labs = variantsFor(kind.key, site);
    assert.equal(
      labs.variants.length,
      1,
      `${kind.key} would buy the same rows twice for a device parameter Labs does not take`
    );
    // Minted by the ONE function that mints variant keys, with the device
    // collapsed rather than the format changed.
    assert.equal(
      labs.variants[0].key,
      variantKeyFor({ locationCode: 2840, languageCode: 'en', device: 'any' })
    );
  }
});

test('a Labs snapshot is matched to the picked market, not to the picked device', () => {
  const descriptor = require('./index');
  const rank = variantKeyFor({ locationCode: 2840, languageCode: 'en', device: 'desktop' });
  const labsUs = variantKeyFor({ locationCode: 2840, languageCode: 'en', device: 'any' });
  const labsUk = variantKeyFor({ locationCode: 2826, languageCode: 'en', device: 'any' });

  /**
   * Compared literally these keys can NEVER be equal, so a literal filter blanks
   * three screens permanently. Compared on the market they share, the US Labs
   * reading answers for the US rank selection and the UK one does not.
   */
  assert.equal(descriptor.sameVariant('competitors', labsUs, rank), true);
  assert.equal(descriptor.sameVariant('competitors', labsUk, rank), false);

  // The device-scoped kind keeps the exact comparison it has always had.
  assert.equal(descriptor.sameVariant('positions', rank, rank), true);
  assert.equal(
    descriptor.sameVariant(
      'positions',
      variantKeyFor({ locationCode: 2840, languageCode: 'en', device: 'mobile' }),
      rank
    ),
    false
  );

  // A board collecting only Labs has no market picker to compare against, and
  // refusing everything would blank the tab this hook exists to fill.
  assert.equal(descriptor.sameVariant('top_pages', labsUk, 'default'), true);
  assert.equal(descriptor.sameVariant('top_pages', labsUk, ''), true);
});

test('two real markets stay two Labs variants', () => {
  const site = project({
    targets: [
      { locationCode: 2840, languageCode: 'en', device: 'desktop' },
      { locationCode: 2826, languageCode: 'en', device: 'desktop' },
    ],
  });
  assert.equal(variantsFor('competitors', site).variants.length, 2);
});

// ---------------------------------------------------------------------------
// 7. The collector still cannot spend, and must not touch a live row
// ---------------------------------------------------------------------------

test('the collection pass refuses every billable Labs endpoint by default', () => {
  // The one free one, admitted deliberately.
  assert.equal(isFreeEndpoint(C.ENDPOINT_LABS_STATUS), true);

  for (const kind of LABS_KINDS) {
    assert.equal(
      isFreeEndpoint(kind.endpoint),
      false,
      `${kind.endpoint} was admitted to the free allowlist`
    );
  }
  assert.equal(isFreeEndpoint(C.ENDPOINT_LABS_BING_BULK_KEYWORD_DIFFICULTY), false);
});

test('the collect-only transport rejects a Labs purchase even if code asked for one', async () => {
  const wrapped = collectOnlyClient(stubClient().client);
  await assert.rejects(
    wrapped.call(C.ENDPOINT_LABS_KEYWORD_OVERVIEW, [{ keywords: ['x'] }]),
    /may not call/
  );
  await assert.rejects(
    wrapped.send(C.ENDPOINT_LABS_COMPETITORS_DOMAIN, {}),
    /may not call/
  );
});

test('the ten-minute collector leaves a LIVE row alone rather than failing it', async () => {
  /**
   * A live row is a LOCK held for the seconds one HTTP call takes, not a job to
   * collect. `pollJob` would find no item carrying a task id, conclude the batch
   * finished with nothing, and mark FAILED a row that is at this moment mid-call
   * in another process — burning an attempt and writing a note about a failure
   * that did not happen.
   */
  const row = {
    _id: 'live-1',
    organisation: 'org-1',
    account: 'acct-1',
    project: 'proj-1',
    provider: 'dataforseo',
    kind: 'competitors',
    variant: VARIANT.key,
    state: 'open',
    attempt: 1,
    items: [],
    save: async () => row,
  };

  const originals = {
    distinct: DfsTask.distinct,
    find: DfsTask.find,
    projectFind: ConnectorProject.find,
    write: snapshotService.writeSnapshot,
  };

  DfsTask.distinct = async () => ['acct-1'];
  DfsTask.find = () => thenable([row]);
  ConnectorProject.find = () => thenable([{ _id: 'proj-1', domain: 'acme.com' }]);
  snapshotService.writeSnapshot = async () => {
    throw new Error('the collector must not write a snapshot for a live kind');
  };

  let report;
  try {
    report = await collectAllReady({
      now: NOW,
      sessionFactory: async () => session,
      clientFactory: () => stubClient().client,
    });
  } finally {
    Object.assign(DfsTask, { distinct: originals.distinct, find: originals.find });
    ConnectorProject.find = originals.projectFind;
    snapshotService.writeSnapshot = originals.write;
  }

  assert.equal(report.jobs, 0, 'a live row must not be counted as collectable work');
  assert.equal(report.failed, 0);
  assert.equal(row.state, 'open', 'the collector must not close a lock it does not own');
});

// ---------------------------------------------------------------------------
// 8. The dispatch, and the floor under a board's cadence
// ---------------------------------------------------------------------------

test('fetchKind routes on transport, and the Labs floor refuses an early re-buy', async () => {
  resetPool();
  const world = stubWorld();
  const { client, calls } = stubClient();

  try {
    // Two hours old against a 144-hour floor.
    const refused = await fetchKind('competitors', {
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

    // And a person who read the note and asked anyway gets through.
    const forced = await fetchKind('competitors', {
      session,
      client,
      project: project(),
      variant: VARIANT,
      existing: { fetchedAt: new Date('2026-09-03T08:00:00Z') },
      force: true,
      now: NOW,
    });
    assert.equal(forced.status, 'ok');
  } finally {
    world.restore();
  }
});

test('a live kind never asks tasks_ready what has finished', async () => {
  resetPool();
  const world = stubWorld();
  const { client, calls } = stubClient();

  try {
    await fetchKind('top_pages', {
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

test('the Labs calls travel through the SHARED pool, not around it', async () => {
  resetPool();
  const world = stubWorld();
  const { client } = stubClient();
  const before = poolStats().admitted;

  try {
    await runLabsKind(getKind('keyword_gap'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
  } finally {
    world.restore();
  }

  // `/status` plus one call per competitor.
  assert.equal(poolStats().admitted - before, 3);
  assert.ok(poolStats().peakInFlight <= C.DB_BACKED_POOL_LIMIT);
  assert.equal(poolStats().inFlight, 0);
});

// ---------------------------------------------------------------------------
// 9. What the screens are handed
// ---------------------------------------------------------------------------

test('a keyword row keeps its nulls, its intent probability and its seasonality', async () => {
  resetPool();
  const world = stubWorld();
  const { client } = stubClient();

  let out;
  try {
    out = await runLabsKind(getKind('keyword_metrics'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
  } finally {
    world.restore();
  }

  const row = out.data.keywords[0];
  assert.equal(row.searchVolume, 1900);
  assert.equal(row.keywordDifficulty, 47);
  assert.equal(row.intent, 'commercial');
  assert.equal(row.intentProbability, 0.82);
  assert.equal(row.monthlySearches.length, 1);
  assert.equal(out.data.totals.tracked, 2);
  assert.equal(out.data.totals.averageDifficulty, 47);
});

test('a missing metric is null and never a zero, at every level', () => {
  const { aggregateKeywordMetrics, normaliseKeywordOverview } = require('./labsNormalise');
  const bare = normaliseKeywordOverview({ keyword: 'nothing known' });
  assert.equal(bare.searchVolume, null);
  assert.equal(bare.keywordDifficulty, null);
  assert.equal(bare.cpc, null);

  const totals = aggregateKeywordMetrics([bare], {}).totals;
  assert.equal(totals.tracked, 1);
  assert.equal(totals.measured, 0);
  // "we have no readings" must not render as "these keywords have no volume".
  assert.equal(totals.totalVolume, null);
  assert.equal(totals.averageDifficulty, null);
});

test('a competitor row keeps the shared metrics APART from the whole-domain ones', async () => {
  resetPool();
  const world = stubWorld();
  const { client } = stubClient();

  let out;
  try {
    out = await runLabsKind(getKind('competitors'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
  } finally {
    world.restore();
  }

  const row = out.data.competitors[0];
  assert.equal(row.domain, 'rival.com');
  assert.equal(row.intersections, 42);
  /**
   * The distinction the whole panel turns on: `metrics` is only the keywords we
   * share, `full_domain_metrics` is everything they rank for. Merged, Wikipedia
   * looks like a competitor.
   */
  assert.equal(row.sharedMetrics.count, 42);
  assert.equal(row.fullMetrics.count, 21000);
  assert.notEqual(row.sharedMetrics.count, row.fullMetrics.count);
});

test('the gap snapshot keeps one comparison per competitor, each naming its own', async () => {
  resetPool();
  const world = stubWorld();
  const { client } = stubClient();

  let out;
  try {
    out = await runLabsKind(getKind('keyword_gap'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
  } finally {
    world.restore();
  }

  assert.equal(out.data.comparisons.length, 2);
  assert.deepEqual(
    out.data.comparisons.map((c) => c.competitor),
    ['rival.com', 'other.com']
  );
  // Flattened, one keyword would appear twice with two "their rank" values and
  // no column saying whose.
  for (const comparison of out.data.comparisons) {
    assert.equal(comparison.totals.missing, 1);
    assert.equal(comparison.totals.volumeAtStake, 880);
    assert.equal(comparison.indexUpdatedAt, '2026-08-24T00:00:00.000Z');
  }
});

test('top pages carry the position ladder and an estimated traffic value', async () => {
  resetPool();
  const world = stubWorld();
  const { client } = stubClient();

  let out;
  try {
    out = await runLabsKind(getKind('top_pages'), {
      session,
      client,
      project: project(),
      variant: VARIANT,
      now: NOW,
    });
  } finally {
    world.restore();
  }

  assert.equal(out.data.pages[0].url, 'https://acme.com/crm');
  assert.equal(out.data.pages[0].etv, 1420);
  assert.equal(out.data.pages[0].buckets.pos_1, 3);
  assert.equal(out.data.totals.totalEtv, 1420);
});

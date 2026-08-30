const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./constants');
const T = require('./tasks');
const S = require('./serpCache');
const { describeUsage } = require('./usage');
const { getKind, KINDS } = require('./kinds');
const { variantKeyFor } = require('./sites');
const { fetchKind } = require('./fetchers');
const { createDfsClient } = require('./client');
const DfsTask = require('../../../models/DfsTask');
const DfsSerpResult = require('../../../models/DfsSerpResult');
const DfsSerpCache = require('../../../models/DfsSerpCache');
const DfsCacheProbe = require('../../../models/DfsCacheProbe');
const ConnectorBudget = require('../../../models/ConnectorBudget');

/**
 * PHASE 11 — the measurement, and the cache that is switched off behind it.
 *
 * ---- What this file has to prove, in order of how expensive it is to get
 * wrong ----------------------------------------------------------------------
 *
 *   1. WITH THE CACHE OFF, NOTHING CHANGED. The allowlist is empty by default,
 *      and with it empty the purchase path must be byte-identical to phase 10 —
 *      same posts, same polls, same stored rows, same aggregate. Proved by
 *      making every `DfsSerpCache` method THROW and running a complete buy →
 *      poll → collect cycle through it, which passes only if not one cache code
 *      path is reached.
 *   2. THE MEASUREMENT IS A RATE, PER KIND, AND DURABLE. Phase 2's log line was
 *      none of those things, and it counted the wrong population as well.
 *   3. THE FOUR COMPLICATIONS ARE ACTUALLY ANSWERED, not noted: the refcount,
 *      the same-day window, the missing claim, and the fact that a human's own
 *      Refresh button can never probe the cache for another tenant's keywords.
 *   4. SERP ONLY. Phase 10 was explicit that a shared backlink or GBP body is
 *      not a public search result.
 *
 * Every test runs against fixtures. There is no live credential, the sandbox is
 * still the default origin, and nothing here contacts DataForSEO.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEYWORDS = ['best crm for agencies', 'agency crm pricing', 'crm for seo agency'];

const VARIANT = { locationCode: 2840, languageCode: 'en', device: 'desktop' };
const VARIANT_KEY = variantKeyFor(VARIANT);

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const project = (overrides = {}) => ({
  _id: 'proj-1',
  externalId: 'proj-1',
  name: 'Acme',
  domain: 'acme.com',
  organisation: ORG_A,
  account: 'acct-1',
  trackedKeywords: [...KEYWORDS],
  targets: [VARIANT],
  ...overrides,
});

const session = { accountId: 'acct-1', getCredentials: () => ({ login: 'l', password: 'p' }) };

const kind = (key = 'positions') => getKind(key);
const AT = (iso) => new Date(iso);

/** One SERP result row as DataForSEO returns it, with acme at rank 4. */
const serpRow = (keyword, { rank = 4, datetime = '2026-09-01 04:12:07 +00:00' } = {}) => ({
  keyword,
  type: 'organic',
  location_code: 2840,
  language_code: 'en',
  datetime,
  item_types: ['organic', 'people_also_ask'],
  se_results_count: 1_240_000,
  items: [
    { type: 'organic', rank_group: 1, rank_absolute: 1, domain: 'rival.com', url: 'https://rival.com/a' },
    { type: 'people_also_ask', rank_group: 2, rank_absolute: 2 },
    {
      type: 'organic',
      rank_group: rank,
      rank_absolute: rank + 1,
      domain: 'blog.acme.com',
      url: 'https://blog.acme.com/crm',
    },
  ],
});

// ---------------------------------------------------------------------------
// The collections, in memory
// ---------------------------------------------------------------------------

const same = (a, b) => String(a) === String(b);

const matches = (row, filter) =>
  Object.entries(filter).every(([key, want]) => {
    // `describeUsage` unions "posted inside the window" with "still open", so the
    // stub has to understand `$or` or it silently matches nothing and every
    // spend assertion reads zero.
    if (key === '$or') return want.some((clause) => matches(row, clause));
    const got = key.split('.').reduce((o, k) => (o == null ? o : o[k]), row);
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      if ('$in' in want) return want.$in.some((v) => same(v, got));
      if ('$ne' in want) return !same(want.$ne, got);
      if ('$gte' in want) {
        if (typeof want.$gte === 'string') return String(got ?? '') >= want.$gte;
        return got != null && new Date(got) >= new Date(want.$gte);
      }
      if ('$size' in want) return Array.isArray(got) && got.length === want.$size;
      return true;
    }
    if (Array.isArray(got)) return got.some((v) => same(v, want));
    return same(want, got);
  });

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

const applyUpdate = (row, update) => {
  for (const [k, v] of Object.entries(update.$set || {})) row[k] = v;
  for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
  for (const [k, v] of Object.entries(update.$max || {})) {
    const cur = row[k];
    if (cur === undefined || cur === null || new Date(v) > new Date(cur) || v > cur) row[k] = v;
  }
  for (const [k, v] of Object.entries(update.$addToSet || {})) {
    row[k] = Array.isArray(row[k]) ? row[k] : [];
    if (!row[k].some((x) => same(x, v))) row[k].push(v);
  }
  for (const [k, v] of Object.entries(update.$pull || {})) {
    row[k] = (Array.isArray(row[k]) ? row[k] : []).filter((x) => !same(x, v));
  }
};

/** `DfsTask`, enforcing the partial unique index exactly where Mongo would. */
const stubTasks = () => {
  const rows = [];
  let seq = 0;
  const originals = {
    create: DfsTask.create,
    findOne: DfsTask.findOne,
    find: DfsTask.find,
    updateOne: DfsTask.updateOne,
    countDocuments: DfsTask.countDocuments,
  };

  DfsTask.create = async (input) => {
    if (
      input.state === 'open' &&
      rows.some(
        (r) =>
          r.state === 'open' &&
          same(r.project, input.project) &&
          r.kind === input.kind &&
          r.variant === input.variant
      )
    ) {
      const err = new Error('E11000 duplicate key error collection: dfstasks');
      err.code = 11000;
      throw err;
    }
    const row = {
      _id: `dfs-${(seq += 1)}`,
      provider: 'dataforseo',
      source: 'provider',
      state: 'reserving',
      attempt: 1,
      estimateUsd: 0,
      costUsd: 0,
      budgetDocs: [],
      postedAt: null,
      readyAt: null,
      closedAt: null,
      expiresAt: null,
      periodKey: null,
      note: '',
      items: [],
      createdAt: new Date(),
      ...input,
    };
    row.save = async () => row;
    rows.push(row);
    return row;
  };

  DfsTask.findOne = (filter) =>
    thenable([...rows].reverse().find((r) => matches(r, filter)) || null);
  DfsTask.find = (filter) => thenable(rows.filter((r) => matches(r, filter)));
  DfsTask.countDocuments = async (filter) => rows.filter((r) => matches(r, filter)).length;
  DfsTask.updateOne = async (filter, update) => {
    const row = rows.find((r) => matches(r, filter));
    if (!row) return { acknowledged: true, matchedCount: 0 };
    applyUpdate(row, update);
    for (const [k, v] of Object.entries(update.$push || {})) {
      row[k] = [...(row[k] || []), ...(v.$each || [v])];
    }
    return { acknowledged: true, matchedCount: 1 };
  };

  return { rows, restore: () => Object.assign(DfsTask, originals) };
};

/** The money ledger, with the cap guard implemented faithfully. */
const stubBudget = ({ capUsd = 1000 } = {}) => {
  const rows = [];
  const find = (f) =>
    rows.find(
      (r) =>
        same(r.organisation, f.organisation) &&
        r.provider === f.provider &&
        r.scope === f.scope &&
        same(r.scopeId, f.scopeId) &&
        r.periodKey === f.periodKey
    ) || null;

  const originals = {
    updateOne: ConnectorBudget.updateOne,
    findOneAndUpdate: ConnectorBudget.findOneAndUpdate,
    findOne: ConnectorBudget.findOne,
  };

  ConnectorBudget.updateOne = async (filter, update, opts = {}) => {
    let row = find(filter);
    if (!row && opts.upsert) {
      row = {
        ...filter,
        reservedUsd: 0,
        spentUsd: 0,
        releasedUsd: 0,
        capUsd,
        ...(update.$setOnInsert || {}),
      };
      rows.push(row);
      return { acknowledged: true, upsertedCount: 1 };
    }
    if (!row) return { acknowledged: true, matchedCount: 0 };
    applyUpdate(row, update);
    return { acknowledged: true, matchedCount: 1 };
  };

  ConnectorBudget.findOneAndUpdate = (filter, update) => {
    const row = find(filter);
    const add = filter.$expr?.$lte?.[0]?.$add || [];
    const estimate = add.find((x) => typeof x === 'number') || 0;
    const ok = row && (row.reservedUsd || 0) + (row.spentUsd || 0) + estimate <= row.capUsd;
    if (ok) applyUpdate(row, update);
    const value = ok ? { ...row } : null;
    return { lean: async () => value, then: (r, j) => Promise.resolve(value).then(r, j) };
  };

  ConnectorBudget.findOne = (filter) => {
    const value = find(filter);
    return { lean: async () => value, then: (r, j) => Promise.resolve(value).then(r, j) };
  };

  return { rows, restore: () => Object.assign(ConnectorBudget, originals) };
};

const stubSerpResults = () => {
  const writes = [];
  const original = DfsSerpResult.updateOne;
  DfsSerpResult.updateOne = async (filter, update) => {
    writes.push({ filter, set: update.$set });
    return { acknowledged: true };
  };
  return { writes, restore: () => { DfsSerpResult.updateOne = original; } };
};

/** `DfsCacheProbe` — the durable measurement, upserted and incremented. */
const stubProbes = () => {
  const rows = [];
  let seq = 0;
  const originals = {
    updateOne: DfsCacheProbe.updateOne,
    find: DfsCacheProbe.find,
    deleteMany: DfsCacheProbe.deleteMany,
  };

  DfsCacheProbe.updateOne = async (filter, update, opts = {}) => {
    let row = rows.find((r) => matches(r, filter));
    if (!row && opts.upsert) {
      row = { _id: `probe-${(seq += 1)}`, ...filter, ...(update.$setOnInsert || {}) };
      rows.push(row);
    }
    if (!row) return { acknowledged: true, matchedCount: 0 };
    applyUpdate(row, update);
    return { acknowledged: true, matchedCount: 1 };
  };
  DfsCacheProbe.find = (filter) => thenable(rows.filter((r) => matches(r, filter)));
  DfsCacheProbe.deleteMany = async (filter) => {
    const keep = rows.filter((r) => !matches(r, filter));
    const removed = rows.length - keep.length;
    rows.length = 0;
    rows.push(...keep);
    return { deletedCount: removed };
  };

  return { rows, restore: () => Object.assign(DfsCacheProbe, originals) };
};

/** `DfsSerpCache` — the shared corpus, with its refcount. */
const stubCache = () => {
  const rows = [];
  const finds = [];
  let seq = 0;
  const originals = {
    find: DfsSerpCache.find,
    updateOne: DfsSerpCache.updateOne,
    updateMany: DfsSerpCache.updateMany,
    deleteMany: DfsSerpCache.deleteMany,
  };

  DfsSerpCache.find = (filter) => {
    finds.push(filter);
    return thenable(rows.filter((r) => matches(r, filter)));
  };
  DfsSerpCache.updateOne = async (filter, update, opts = {}) => {
    let row = rows.find((r) => matches(r, filter));
    if (!row && opts.upsert) {
      row = { _id: `cache-${(seq += 1)}`, orgs: [], reads: 0, ...(update.$setOnInsert || {}) };
      rows.push(row);
    }
    if (!row) return { acknowledged: true, matchedCount: 0 };
    applyUpdate(row, update);
    return { acknowledged: true, matchedCount: 1 };
  };
  DfsSerpCache.updateMany = async (filter, update) => {
    let n = 0;
    for (const row of rows.filter((r) => matches(r, filter))) {
      applyUpdate(row, update);
      n += 1;
    }
    return { acknowledged: true, matchedCount: n };
  };
  DfsSerpCache.deleteMany = async (filter) => {
    const keep = rows.filter((r) => !matches(r, filter));
    const removed = rows.length - keep.length;
    rows.length = 0;
    rows.push(...keep);
    return { deletedCount: removed };
  };

  return { rows, finds, restore: () => Object.assign(DfsSerpCache, originals) };
};

/** Every `DfsSerpCache` method THROWS. The proof that "off" reaches none of them. */
const forbidCache = () => {
  const originals = {
    find: DfsSerpCache.find,
    updateOne: DfsSerpCache.updateOne,
    updateMany: DfsSerpCache.updateMany,
    deleteMany: DfsSerpCache.deleteMany,
  };
  const boom = () => {
    throw new Error('the shared SERP cache was reached while it was switched off');
  };
  DfsSerpCache.find = boom;
  DfsSerpCache.updateOne = boom;
  DfsSerpCache.updateMany = boom;
  DfsSerpCache.deleteMany = boom;
  return { restore: () => Object.assign(DfsSerpCache, originals) };
};

/** Put a body into the shared corpus, as a completed collection would have. */
const seedCache = (cache, keyword, { k = kind(), day = '2026-09-01', datetime = '2026-09-01 04:12:07 +00:00', orgs = [ORG_B] } = {}) => {
  const row = serpRow(keyword, { datetime });
  cache.rows.push({
    _id: `cache-seed-${cache.rows.length + 1}`,
    cacheKey: S.cacheKeyFor({
      endpoint: k.getEndpoint,
      depth: k.depth,
      ...S.marketFromVariant(VARIANT_KEY),
      keyword,
    }),
    periodKey: day,
    keyword,
    depth: k.depth,
    endpoint: k.getEndpoint,
    collectedAt: new Date(datetime.replace(' +00:00', 'Z').replace(' ', 'T')),
    items: row.items,
    itemTypes: row.item_types,
    seResultsCount: row.se_results_count,
    bytes: 512,
    oversized: false,
    orgs: [...orgs],
    reads: 0,
    expiresAt: new Date('2026-09-03T04:12:07Z'),
  });
};

/** The env switch, driven directly. Empty is the shipped default. */
const withCacheOn = (...orgIds) => {
  const before = [...C.SERP_CACHE_ORG_IDS];
  C.SERP_CACHE_ORG_IDS.clear();
  for (const id of orgIds) C.SERP_CACHE_ORG_IDS.add(id);
  return {
    restore: () => {
      C.SERP_CACHE_ORG_IDS.clear();
      for (const id of before) C.SERP_CACHE_ORG_IDS.add(id);
    },
  };
};

/** A `fetch` stand-in that counts what was bought. `posts` is the bill. */
const stubTransport = ({ ready = false } = {}) => {
  const state = { posts: 0, gets: 0, ready };

  const impl = async (url, init) => {
    let body;
    if (url.includes('/task_post')) {
      state.posts += 1;
      const sent = JSON.parse(init.body);
      body = {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.0006 * sent.length,
        tasks_count: sent.length,
        tasks_error: 0,
        tasks: sent.map((t) => ({
          id: `task-${t.tag}`,
          status_code: 20100,
          status_message: 'Task Created.',
          cost: 0.0006,
          result_count: 0,
          data: { api: 'serp', function: 'task_post', tag: t.tag },
          result: null,
        })),
      };
    } else if (url.includes('/task_get/')) {
      state.gets += 1;
      const id = url.split('/').pop();
      const index = Number(id.split('.').pop());
      body = state.ready
        ? {
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0,
            tasks_count: 1,
            tasks_error: 0,
            tasks: [
              {
                id: 'x',
                status_code: 20000,
                status_message: 'Ok.',
                cost: 0,
                data: {},
                result: [serpRow(KEYWORDS[index] ?? KEYWORDS[0])],
              },
            ],
          }
        : {
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0,
            tasks_count: 1,
            tasks_error: 1,
            tasks: [
              {
                id: 'x',
                status_code: 40602,
                status_message: 'Task In Queue.',
                cost: 0,
                data: {},
                result: null,
              },
            ],
          };
    } else {
      throw new Error(`unexpected URL ${url}`);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  return { state, client: createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] }) };
};

const runFetch = (client, { now, force = false, kindKey = 'positions', proj = project() } = {}) =>
  fetchKind(kindKey, {
    session,
    client,
    project: proj,
    variant: { key: VARIANT_KEY, ...VARIANT },
    now,
    force,
  });

// ===========================================================================
// 1. THE SWITCH — and the proof that "off" changes nothing
// ===========================================================================

test('the cache is OFF by default, and off means an EMPTY ALLOWLIST', () => {
  // Same shape and same spirit as `DATAFORSEO_LIVE_PROJECTS`: empty means
  // nobody, so pointing a deployment at anything is not on its own enough to
  // share a single SERP body across two workspaces.
  assert.equal(process.env.DATAFORSEO_SERP_CACHE_ORGS, undefined);
  assert.equal(C.SERP_CACHE_ORG_IDS.size, 0);
  assert.equal(S.anyEnabled(), false);
  assert.equal(S.isEnabledFor(ORG_A), false);
});

test('with the cache off, NOT ONE cache code path is reached — buy, poll, collect', async () => {
  /**
   * THE BYTE-IDENTICAL PROOF, and it is a proof rather than an assertion:
   * every `DfsSerpCache` method throws for the whole run, so any read, any
   * write-through and any refcount update would fail the test rather than pass
   * it quietly. What must still happen is the entire phase-10 sequence.
   */
  const forbidden = forbidCache();
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const probes = stubProbes();
  const { state, client } = stubTransport();
  try {
    const bought = await runFetch(client, { now: AT('2026-09-01T00:17:00Z') });
    assert.equal(bought.status, 'pending');
    assert.equal(state.posts, 1, 'one post, exactly as phase 10');

    const polled = await runFetch(client, { now: AT('2026-09-01T01:17:00Z') });
    assert.equal(polled.status, 'pending');
    assert.equal(state.posts, 1, 'and the free poll bought nothing');

    state.ready = true;
    const collected = await runFetch(client, { now: AT('2026-09-01T05:17:00Z') });
    assert.equal(collected.status, 'ok');
    assert.equal(collected.data.totals.tracked, KEYWORDS.length);
    assert.equal(collected.data.totals.ranked, KEYWORDS.length);
    assert.equal(collected.raw, null, 'the snapshot body stays aggregate-only');
    assert.equal(
      collected.collectedAt.toISOString(),
      '2026-09-01T04:12:07.000Z',
      'and it is still THE PROVIDER’S OWN datetime that dates the reading'
    );

    assert.equal(serps.writes.length, KEYWORDS.length, 'one SERP body per keyword');
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].source, 'provider', 'nothing came from a cache');
    assert.equal(db.rows[0].state, 'done');

    // Half A DOES run with the cache off — that is the whole point of it.
    assert.equal(probes.rows.length, 1, 'the measurement is taken either way');
  } finally {
    forbidden.restore();
    probes.restore();
    serps.restore();
    money.restore();
    db.restore();
  }
});

test('serve and publisherFor answer without a query while the allowlist is empty', async () => {
  const forbidden = forbidCache();
  try {
    assert.equal(
      await S.serve({
        project: project(),
        kind: kind(),
        variant: VARIANT_KEY,
        keywords: KEYWORDS,
        session,
        now: AT('2026-09-01T09:00:00Z'),
      }),
      null
    );
    assert.equal(
      S.publisherFor({ project: project(), kind: kind(), variant: VARIANT_KEY, now: new Date() }),
      null,
      'no callback at all, so `pollJob` carries no untrimmed body out of its loop'
    );
  } finally {
    forbidden.restore();
  }
});

// ===========================================================================
// 2. THE KEY — and the phase-2 assumption that turned out to be wrong
// ===========================================================================

test('`requestHash` CANNOT be the cache key, and that is a correction to phase 2', () => {
  /**
   * Phase 2 recorded that `requestHash` "is the exact value a phase-11
   * cross-tenant cache would key on". It is not, and the reason is structural
   * rather than a detail: `buildRequest` hashes the DOMAIN and the FULL KEYWORD
   * ARRAY, so two workspaces asking Google the same question hash differently
   * unless they track the same list for the same site. Keyed on it, the cache
   * would have a guaranteed hit rate of zero — and the measurement built to gate
   * the decision would have been measuring the key rather than the world.
   */
  const a = T.requestHashFor(
    T.buildRequest({ kind: kind(), variant: VARIANT, domain: 'acme.com', keywords: KEYWORDS })
  );
  const b = T.requestHashFor(
    T.buildRequest({
      kind: kind(),
      variant: VARIANT,
      domain: 'rival.co',
      keywords: [KEYWORDS[0], 'something else entirely'],
    })
  );
  assert.notEqual(a, b, 'two tenants asking the same question hash differently');

  // The narrower key, over only what is genuinely shared, DOES collide — which
  // is the entire mechanism. `requestHash` keeps its phase-2 shape untouched.
  const market = S.marketFromVariant(VARIANT_KEY);
  assert.equal(
    S.cacheKeyFor({ endpoint: kind().getEndpoint, depth: 100, ...market, keyword: KEYWORDS[0] }),
    S.cacheKeyFor({ endpoint: kind().getEndpoint, depth: 100, ...market, keyword: KEYWORDS[0] })
  );
});

test('the key separates market, device and DEPTH, and no keyword can alias into another', () => {
  const base = {
    endpoint: kind().getEndpoint,
    depth: 100,
    locationCode: 2840,
    languageCode: 'en',
    device: 'desktop',
    keyword: 'crm',
  };
  const k = (o) => S.cacheKeyFor({ ...base, ...o });

  assert.notEqual(k({}), k({ locationCode: 2826 }), 'a UK SERP is not a US one');
  assert.notEqual(k({}), k({ languageCode: 'fr' }));
  assert.notEqual(k({}), k({ device: 'mobile' }));
  assert.notEqual(
    k({}),
    k({ depth: 10 }),
    'a depth-100 body may not answer a depth-10 request — see `comparability.js`'
  );

  // The only free-form field is the keyword and it is LAST in the encoded array,
  // so a keyword carrying a separator cannot be confused with another market.
  assert.notEqual(k({ keyword: 'a|b' }), k({ keyword: 'a', device: 'b' }));
});

test('the cache is SERP ONLY — phase 10 said a shared backlink body is not a search result', () => {
  assert.equal(S.isCacheableKind(getKind('positions')), true);
  assert.equal(S.isCacheableKind(getKind('movement')), true);

  const refused = KINDS.filter((k) => !S.isCacheableKind(k)).map((k) => k.key);
  for (const key of [
    'keyword_metrics',
    'competitors',
    'keyword_gap',
    'top_pages',
    'backlinks_summary',
    'backlinks_timeseries',
    'referring_domains',
    'anchors',
    'referring_networks',
    'site_audit',
    'business_profile',
  ]) {
    assert.ok(refused.includes(key), `${key} must never be shared across tenants`);
  }
  assert.deepEqual(
    KINDS.filter((k) => S.isCacheableKind(k)).map((k) => k.key),
    ['positions', 'movement']
  );
});

// ===========================================================================
// 3. HALF A — the measurement
// ===========================================================================

test('the probe splits READY hits from IN-FLIGHT ones, which the log line never did', async () => {
  const db = stubTasks();
  const probes = stubProbes();
  try {
    // Another tenant COLLECTED one of these today...
    await DfsTask.create({
      organisation: ORG_B,
      project: 'proj-9',
      kind: 'positions',
      variant: VARIANT_KEY,
      state: 'done',
      keywords: [KEYWORDS[0], 'unrelated'],
      postedAt: AT('2026-09-01T02:00:00Z'),
    });
    // ...and has another still in flight.
    await DfsTask.create({
      organisation: 'org-c',
      project: 'proj-8',
      kind: 'positions',
      variant: VARIANT_KEY,
      state: 'open',
      keywords: [KEYWORDS[1]],
      postedAt: AT('2026-09-01T03:00:00Z'),
    });

    const lines = [];
    const out = await S.probe({
      project: project(),
      kind: kind(),
      variant: VARIANT_KEY,
      keywords: KEYWORDS,
      now: AT('2026-09-01T09:00:00Z'),
      log: (l) => lines.push(l),
    });

    assert.equal(out.units, 3, 'THE DENOMINATOR, which a log line threw away');
    assert.equal(out.readyHits, 1, 'in hand, free to copy — the strict rule');
    assert.equal(
      out.openHits,
      1,
      'money spent and no answer yet — serving this needs the claim phase 11 refused'
    );
    assert.equal(out.covered, false, 'and one of three is not a whole batch');
    assert.equal(out.wouldSaveUsd, 0, 'so the all-or-nothing cache would have saved nothing');
    assert.equal(out.otherOrgs, 2);
    assert.match(lines[0], /collectedToday=1/);
    assert.match(lines[0], /inFlightToday=1/);
  } finally {
    probes.restore();
    db.restore();
  }
});

test('a WHOLE batch that is already collected is `covered`, and priced', async () => {
  const db = stubTasks();
  const probes = stubProbes();
  try {
    await DfsTask.create({
      organisation: ORG_B,
      project: 'proj-9',
      kind: 'positions',
      variant: VARIANT_KEY,
      state: 'done',
      keywords: [...KEYWORDS],
      postedAt: AT('2026-09-01T02:00:00Z'),
    });

    const out = await S.probe({
      project: project(),
      kind: kind(),
      variant: VARIANT_KEY,
      keywords: KEYWORDS,
      now: AT('2026-09-01T09:00:00Z'),
      log: () => {},
    });

    assert.equal(out.covered, true);
    // 3 keywords x depth 100 (a x10 multiplier) x $0.0006.
    assert.equal(out.wouldSaveUsd, 0.018);
  } finally {
    probes.restore();
    db.restore();
  }
});

test('yesterday’s purchase is not a hit — the window is the UTC DAY and is not widened', async () => {
  const db = stubTasks();
  const probes = stubProbes();
  try {
    await DfsTask.create({
      organisation: ORG_B,
      project: 'proj-9',
      kind: 'positions',
      variant: VARIANT_KEY,
      state: 'done',
      keywords: [...KEYWORDS],
      postedAt: AT('2026-09-01T02:00:00Z'),
    });

    const out = await S.probe({
      project: project(),
      kind: kind(),
      variant: VARIANT_KEY,
      keywords: KEYWORDS,
      now: AT('2026-09-02T09:00:00Z'),
      log: () => {},
    });

    assert.equal(out.readyHits, 0);
    assert.equal(
      out.covered,
      false,
      'serving a six-day-old SERP out of a rank tracker breaks the product’s core claim'
    );
  } finally {
    probes.restore();
    db.restore();
  }
});

test('the measurement is DURABLE, per (site, kind, market, day), and INCREMENTS', async () => {
  const db = stubTasks();
  const probes = stubProbes();
  try {
    await DfsTask.create({
      organisation: ORG_B,
      project: 'proj-9',
      kind: 'positions',
      variant: VARIANT_KEY,
      state: 'done',
      keywords: [KEYWORDS[0]],
      postedAt: AT('2026-09-01T02:00:00Z'),
    });

    const args = {
      project: project(),
      kind: kind(),
      variant: VARIANT_KEY,
      keywords: KEYWORDS,
      log: () => {},
    };
    await S.probe({ ...args, now: AT('2026-09-01T09:00:00Z') });
    await S.probe({ ...args, now: AT('2026-09-01T17:00:00Z') });
    // A different KIND is a different row. Phase 10: an average across kinds
    // describes neither, because `movement` is bought at a tenth of the depth.
    await S.probe({ ...args, kind: kind('movement'), now: AT('2026-09-01T17:00:00Z') });

    assert.equal(probes.rows.length, 2, 'one row per kind, not one row per probe');

    const positions = probes.rows.find((r) => r.kind === 'positions');
    assert.equal(positions.probes, 2, 'two buying decisions rolled into one day');
    assert.equal(positions.units, 6, 'and their denominators added up');
    assert.equal(positions.readyHits, 2);
    assert.equal(positions.periodKey, '2026-09-01');
    assert.equal(positions.depth, C.DEPTH_CENSUS);
    assert.equal(positions.servedUnits, 0, 'nothing was actually served — the cache is off');

    const movement = probes.rows.find((r) => r.kind === 'movement');
    assert.equal(movement.depth, C.DEPTH_MOVEMENT);
  } finally {
    probes.restore();
    db.restore();
  }
});

test('the measurement stores a COUNT of other tenants and never an identity', async () => {
  const db = stubTasks();
  const probes = stubProbes();
  try {
    await DfsTask.create({
      organisation: ORG_B,
      project: 'proj-9',
      kind: 'positions',
      variant: VARIANT_KEY,
      state: 'done',
      keywords: [KEYWORDS[0]],
      postedAt: AT('2026-09-01T02:00:00Z'),
    });

    await S.probe({
      project: project(),
      kind: kind(),
      variant: VARIANT_KEY,
      keywords: KEYWORDS,
      now: AT('2026-09-01T09:00:00Z'),
      log: () => {},
    });

    const row = probes.rows[0];
    assert.equal(row.otherOrgs, 1);
    assert.equal(
      JSON.stringify(row).includes(ORG_B),
      false,
      '"is anyone else tracking this" is the leak this phase is careful about — ' +
        'a measurement that answered "yes, and it was org X" would be that leak, ' +
        'written by the code that exists to decide whether to risk it'
    );
    assert.equal(String(row.organisation), ORG_A, 'the ASKING org, for `orgCascade`');
  } finally {
    probes.restore();
    db.restore();
  }
});

test('the verdict is THREE answers, and the threshold arithmetic is named', () => {
  assert.equal(C.CACHE_HIT_RATE_THRESHOLD, 0.2);
  assert.equal(C.CACHE_MIN_OBSERVED_UNITS, 1000);
  assert.equal(C.CACHE_MEASUREMENT_WINDOW_DAYS, 28);

  // "Not enough evidence" and "no" are different answers and only one is a
  // decision. A rate read off nine events is not a rate.
  const thin = S.verdictFor({ units: 40, servableUnits: 40 });
  assert.equal(thin.verdict, 'insufficient');
  assert.equal(thin.rate, 1);
  assert.equal(thin.shortfallUnits, 960);

  assert.equal(S.verdictFor({ units: 5000, servableUnits: 990 }).verdict, 'below');
  assert.equal(S.verdictFor({ units: 5000, servableUnits: 1000 }).verdict, 'clears');
  assert.equal(S.verdictFor({ units: 5000, servableUnits: 1000 }).rate, 0.2);
});

test('summarise rolls up PER KIND and carries the ceiling the shipped rule gives up', async () => {
  const probes = stubProbes();
  try {
    probes.rows.push(
      {
        project: 'proj-1',
        kind: 'positions',
        periodKey: '2026-09-01',
        depth: 100,
        units: 2000,
        readyHits: 900,
        openHits: 400,
        batches: 10,
        coveredBatches: 3,
        servableUnits: 600,
        wouldSaveUsd: 3.6,
        servedUnits: 0,
        savedUsd: 0,
        otherOrgs: 4,
      },
      {
        project: 'proj-1',
        kind: 'movement',
        periodKey: '2026-09-02',
        depth: 10,
        units: 4000,
        readyHits: 200,
        openHits: 100,
        batches: 20,
        coveredBatches: 1,
        servableUnits: 200,
        wouldSaveUsd: 0.12,
        servedUnits: 0,
        savedUsd: 0,
        otherOrgs: 2,
      }
    );

    const out = await S.summarise({
      projects: [{ _id: 'proj-1' }],
      now: AT('2026-09-15T00:00:00Z'),
    });

    assert.equal(out.enabled, false, 'the switch travels with the number');
    assert.equal(out.thresholdPct, 20);
    assert.equal(out.kinds.length, 2);

    const positions = out.kinds.find((k) => k.kind === 'positions');
    assert.equal(positions.rate, 0.3, '600 servable of 2000 asked');
    assert.equal(positions.verdict, 'clears');
    assert.equal(
      positions.ceilingRate,
      0.65,
      'what a cache WITH partial serving and WITH a pre-post claim could reach — ' +
        'carried so both refusals stay visible as choices with a price'
    );

    const movement = out.kinds.find((k) => k.kind === 'movement');
    assert.equal(movement.rate, 0.05);
    assert.equal(movement.verdict, 'below');

    // The two are NEVER averaged into one percentage. A blended 13% would be a
    // number about neither, and `movement` saves a tenth per hit either way.
    assert.equal(out.kinds.some((k) => k.kind === 'blended'), false);
    assert.equal(out.totals.units, 6000);
  } finally {
    probes.restore();
  }
});

test('summarise reads nothing at all for a board with no sites', async () => {
  const probes = stubProbes();
  try {
    const out = await S.summarise({ projects: [], now: AT('2026-09-15T00:00:00Z') });
    assert.deepEqual(out.kinds, []);
    assert.equal(out.from, null);
  } finally {
    probes.restore();
  }
});

// ===========================================================================
// 4. HALF B — the cache, switched on
// ===========================================================================

test('a batch that is entirely in the corpus is served with NO task_post at all', async () => {
  const on = withCacheOn(ORG_A, ORG_B);
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const probes = stubProbes();
  const cache = stubCache();
  const { state, client } = stubTransport();
  try {
    for (const keyword of KEYWORDS) seedCache(cache, keyword);

    const out = await runFetch(client, { now: AT('2026-09-01T09:17:00Z') });

    assert.equal(state.posts, 0, 'THE POINT: nothing was bought');
    assert.equal(out.status, 'ok');
    assert.equal(out.data.totals.tracked, 3);
    assert.equal(out.data.totals.ranked, 3, 'and our own rank came out of somebody else’s page');
    assert.equal(out.data.keywords[0].rank, 4);
    assert.equal(
      out.collectedAt.toISOString(),
      '2026-09-01T04:12:07.000Z',
      'the reading is dated by DataForSEO’s OWN datetime, so it lands on the day ' +
        'the SERP was crawled rather than the day it was copied'
    );
    assert.equal(out.raw, null, 'aggregate only, exactly as the paid path');

    // The serving workspace gets its own evidence rows, through the same writer.
    assert.equal(serps.writes.length, 3);
    assert.equal(String(serps.writes[0].set.organisation), ORG_A);

    // The ledger entry: a real collection with no money behind it.
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].source, 'cache');
    assert.equal(db.rows[0].costUsd, 0);
    assert.equal(db.rows[0].budgetState, 'none');
    assert.equal(
      db.rows[0].state,
      'done',
      'NEVER `open` — that is the state the anti-repost index covers, and a row ' +
        'that never posted has no business holding the claim'
    );
    assert.equal(money.rows.length, 0, 'and no reservation was ever taken');
  } finally {
    cache.restore();
    probes.restore();
    serps.restore();
    money.restore();
    db.restore();
    on.restore();
  }
});

test('a PARTIAL hit buys the whole batch — the cache is all-or-nothing per snapshot', async () => {
  const on = withCacheOn(ORG_A, ORG_B);
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const probes = stubProbes();
  const cache = stubCache();
  const { state, client } = stubTransport();
  try {
    // Two of three. A snapshot is ONE measurement of one market on one day, so
    // half served now and half arriving through the queue in four hours would be
    // two measurements in one row with one `collectedAt`.
    seedCache(cache, KEYWORDS[0]);
    seedCache(cache, KEYWORDS[1]);

    const out = await runFetch(client, { now: AT('2026-09-01T09:17:00Z') });

    assert.equal(state.posts, 1, 'the whole batch was bought');
    assert.equal(out.status, 'pending');
    assert.equal(db.rows[0].source, 'provider');
    assert.equal(db.rows[0].keywords.length, 3, 'including the two it could have had free');
  } finally {
    cache.restore();
    probes.restore();
    serps.restore();
    money.restore();
    db.restore();
    on.restore();
  }
});

test('FORCE bypasses the cache and buys — this is the timing side-channel closed', async () => {
  /**
   * A shared cache makes "is anyone else tracking this keyword" observable by how
   * fast an answer arrives. `force` is the ONLY way a person orders a collection
   * on this provider — the descriptor declares `forceRefetchIsFree: false`, so a
   * plain Refresh does not set it — and here it means BUY. Type a rival's
   * keyword, press Refresh and confirm, and you have bought a SERP and learnt
   * nothing about anybody. The only actor that can observe a hit is the cron.
   */
  const on = withCacheOn(ORG_A, ORG_B);
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const probes = stubProbes();
  const cache = stubCache();
  const { state, client } = stubTransport();
  try {
    for (const keyword of KEYWORDS) seedCache(cache, keyword);

    const out = await runFetch(client, { now: AT('2026-09-01T09:17:00Z'), force: true });

    assert.equal(state.posts, 1, 'a human asking always pays');
    assert.equal(out.status, 'pending');
    assert.equal(
      cache.finds.length,
      0,
      'and the corpus was not even LOOKED AT, so the latency carries no signal'
    );
  } finally {
    cache.restore();
    probes.restore();
    serps.restore();
    money.restore();
    db.restore();
    on.restore();
  }
});

test('a depth-100 body may not answer a depth-10 movement request', async () => {
  const on = withCacheOn(ORG_A, ORG_B);
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const probes = stubProbes();
  const cache = stubCache();
  const { state, client } = stubTransport();
  try {
    // The census body CONTAINS the top ten, so allowing this would roughly double
    // the hit rate. It is refused: a `movement` reading secretly bought at depth
    // 100 would be the one row in its series that could see past position ten,
    // which is a discontinuity arriving from a cache with nothing in the payload
    // to notice it by. `comparability.js` already owns that rule.
    for (const keyword of KEYWORDS) seedCache(cache, keyword, { k: kind('positions') });

    const out = await runFetch(client, {
      now: AT('2026-09-01T09:17:00Z'),
      kindKey: 'movement',
    });

    assert.equal(state.posts, 1);
    assert.equal(out.status, 'pending');
  } finally {
    cache.restore();
    probes.restore();
    serps.restore();
    money.restore();
    db.restore();
    on.restore();
  }
});

test('a body from YESTERDAY does not serve today, even when it is still in the corpus', async () => {
  const on = withCacheOn(ORG_A, ORG_B);
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const probes = stubProbes();
  const cache = stubCache();
  const { state, client } = stubTransport();
  try {
    for (const keyword of KEYWORDS) {
      seedCache(cache, keyword, { day: '2026-08-31', datetime: '2026-08-31 04:12:07 +00:00' });
    }

    const out = await runFetch(client, { now: AT('2026-09-01T09:17:00Z') });

    assert.equal(state.posts, 1, 'the day is the whole freshness policy');
    assert.equal(out.status, 'pending');
  } finally {
    cache.restore();
    probes.restore();
    serps.restore();
    money.restore();
    db.restore();
    on.restore();
  }
});

test('a workspace that is not on the allowlist neither reads nor contributes', async () => {
  const on = withCacheOn(ORG_B);
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const probes = stubProbes();
  const cache = stubCache();
  const { state, client } = stubTransport();
  try {
    for (const keyword of KEYWORDS) seedCache(cache, keyword);

    // ORG_A is not a participant, so the corpus ORG_B contributed is invisible.
    const out = await runFetch(client, { now: AT('2026-09-01T09:17:00Z') });
    assert.equal(state.posts, 1);
    assert.equal(out.status, 'pending');
    assert.equal(cache.finds.length, 0, 'not even a lookup');

    // And the reverse: participation is symmetric, so a non-participant's
    // collections never enter the corpus either.
    assert.equal(
      S.publisherFor({ project: project(), kind: kind(), variant: VARIANT_KEY, now: new Date() }),
      null
    );
  } finally {
    cache.restore();
    probes.restore();
    serps.restore();
    money.restore();
    db.restore();
    on.restore();
  }
});

test('the write-through publishes each keyword as it lands, and refcounts the contributor', async () => {
  const on = withCacheOn(ORG_A);
  const cache = stubCache();
  try {
    const publish = S.publisherFor({
      project: project(),
      kind: kind(),
      variant: VARIANT_KEY,
      now: AT('2026-09-01T05:00:00Z'),
    });
    assert.ok(publish, 'a participant gets a publisher');

    await publish({
      keyword: KEYWORDS[0],
      row: serpRow(KEYWORDS[0]),
      collectedAt: AT('2026-09-01T04:12:07Z'),
    });

    assert.equal(cache.rows.length, 1);
    const row = cache.rows[0];
    assert.equal(row.periodKey, '2026-09-01', 'filed under the day the SERP was CRAWLED');
    assert.deepEqual(row.orgs.map(String), [ORG_A], 'the refcount starts at its contributor');
    assert.equal(
      row.items.length,
      3,
      'UNTRIMMED — a serving workspace’s domain may rank at 45, and a corpus ' +
        'trimmed to render depth would answer "not in the top 100" for it'
    );
    assert.equal(
      row.expiresAt.toISOString(),
      new Date(AT('2026-09-01T05:00:00Z').getTime() + 48 * 3_600_000).toISOString()
    );
    assert.equal(
      JSON.stringify(row).includes('acme.com') && !!row.keyword,
      true,
      'the page is stored as it was; nothing about WHO asked for it is'
    );
    assert.equal(row.domain, undefined, 'no domain, no project, no board, no keyword list');
    assert.equal(row.organisation, undefined, 'and no organisation — see the refcount');
  } finally {
    cache.restore();
    on.restore();
  }
});

test('serving adds the READER to the refcount, so a teardown can still find it', async () => {
  const on = withCacheOn(ORG_A, ORG_B);
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const probes = stubProbes();
  const cache = stubCache();
  const { client } = stubTransport();
  try {
    for (const keyword of KEYWORDS) seedCache(cache, keyword, { orgs: [ORG_B] });

    await runFetch(client, { now: AT('2026-09-01T09:17:00Z') });

    for (const row of cache.rows) {
      assert.deepEqual(
        row.orgs.map(String).sort(),
        [ORG_A, ORG_B].sort(),
        'both the workspace that paid and the workspace that read'
      );
      assert.equal(row.reads, 1);
    }
  } finally {
    cache.restore();
    probes.restore();
    serps.restore();
    money.restore();
    db.restore();
    on.restore();
  }
});

test('the cascade is a $pull and then a delete of the unreferenced — complication 1', async () => {
  /**
   * `orgCascade` deletes every connector collection by `organisation` and a
   * shared body cannot carry one. The answer is a refcount, and it is a SET OF
   * IDS rather than a counter because `$pull` is idempotent and `$inc: -1` is
   * not: a cascade retried after a partial failure must not be able to delete a
   * body two other workspaces are still using.
   */
  const cache = stubCache();
  try {
    cache.rows.push(
      { _id: 'c1', cacheKey: 'k1', periodKey: '2026-09-01', orgs: [ORG_A, ORG_B] },
      { _id: 'c2', cacheKey: 'k2', periodKey: '2026-09-01', orgs: [ORG_A] }
    );

    const tearDown = async () => {
      await DfsSerpCache.updateMany({ orgs: ORG_A }, { $pull: { orgs: ORG_A } });
      await DfsSerpCache.deleteMany({ orgs: { $size: 0 } });
    };

    await tearDown();
    assert.equal(cache.rows.length, 1, 'the body nobody else refers to is gone');
    assert.deepEqual(cache.rows[0].orgs.map(String), [ORG_B]);

    // Idempotent: running it again cannot take ORG_B's row with it.
    await tearDown();
    assert.equal(cache.rows.length, 1);
    assert.deepEqual(cache.rows[0].orgs.map(String), [ORG_B]);
  } finally {
    cache.restore();
  }
});

test('a served reading carries NO per-keyword provenance anywhere a reader can see', async () => {
  const on = withCacheOn(ORG_A, ORG_B);
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const probes = stubProbes();
  const cache = stubCache();
  const { client } = stubTransport();
  try {
    for (const keyword of KEYWORDS) seedCache(cache, keyword);
    const out = await runFetch(client, { now: AT('2026-09-01T09:17:00Z') });

    // A "served from cache" flag per keyword would be the timing side-channel
    // rendered as a feature: it would answer "is anyone else tracking this" for
    // every row of the table at once, with no timing required at all.
    const body = JSON.stringify(out.data);
    assert.equal(/cache/i.test(body), false);
    assert.equal(out.note, '', 'and the note says nothing either');
    for (const write of serps.writes) {
      assert.equal(/cache/i.test(JSON.stringify(write.set)), false);
    }
  } finally {
    cache.restore();
    probes.restore();
    serps.restore();
    money.restore();
    db.restore();
    on.restore();
  }
});

test('the served collection is measured too, so `servedUnits` is what actually happened', async () => {
  const on = withCacheOn(ORG_A, ORG_B);
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const probes = stubProbes();
  const cache = stubCache();
  const { client } = stubTransport();
  try {
    for (const keyword of KEYWORDS) seedCache(cache, keyword);
    await runFetch(client, { now: AT('2026-09-01T09:17:00Z') });

    assert.equal(probes.rows.length, 1);
    const row = probes.rows[0];
    assert.equal(row.units, 3);
    assert.equal(row.servableUnits, 3);
    assert.equal(row.servedUnits, 3, 'the "would have" and the "did" are different fields');
    assert.equal(row.savedUsd, 0.018);
    assert.equal(row.coveredBatches, 1);
  } finally {
    cache.restore();
    probes.restore();
    serps.restore();
    money.restore();
    db.restore();
    on.restore();
  }
});

// ===========================================================================
// 5. The ledger, and the model
// ===========================================================================

test('the usage ledger counts a cache-served collection APART from spend', async () => {
  const db = stubTasks();
  const probes = stubProbes();
  try {
    await DfsTask.create({
      organisation: ORG_A,
      project: 'proj-1',
      kind: 'positions',
      variant: VARIANT_KEY,
      state: 'done',
      source: 'provider',
      keywords: [...KEYWORDS],
      costUsd: 0.018,
      postedAt: AT('2026-09-02T04:17:00Z'),
    });
    await DfsTask.create({
      organisation: ORG_A,
      project: 'proj-1',
      kind: 'positions',
      variant: VARIANT_KEY,
      state: 'done',
      source: 'cache',
      keywords: [...KEYWORDS],
      costUsd: 0,
      postedAt: AT('2026-09-09T04:17:00Z'),
    });

    const out = await describeUsage({
      projects: [{ _id: 'proj-1', domain: 'acme.com' }],
      now: AT('2026-09-15T00:00:00Z'),
    });

    const sept = out.months.find((m) => m.periodKey === '2026-09');
    assert.equal(sept.spentUsd, 0.018);
    assert.equal(
      sept.tasks,
      1,
      'counted as a purchase it would report an order that never happened at a ' +
        'price of zero, which reads as a discount'
    );
    assert.equal(sept.cacheServed, 1, 'and dropped entirely it would under-report collections');
    assert.equal(
      out.lastPostedAt.toISOString(),
      '2026-09-02T04:17:00.000Z',
      '"last charged" must not move for a collection nobody was charged for'
    );

    const positions = out.byKind.find((k) => k.kind === 'positions');
    assert.equal(positions.tasks, 1);
    assert.equal(positions.cacheServed, 1);

    // The measurement travels with the ledger, which is how a human ever sees it.
    assert.equal(out.cache.enabled, false);
    assert.equal(out.cache.thresholdPct, 20);
    assert.equal(out.cache.minUnits, 1000);
  } finally {
    probes.restore();
    db.restore();
  }
});

test('DfsSerpCache carries the refcount index and a TTL, and NO organisation field', () => {
  const paths = Object.keys(DfsSerpCache.schema.paths);
  assert.equal(
    paths.includes('organisation'),
    false,
    'the field phase 11 had to give up — that is complication 1, stated as a schema'
  );
  assert.ok(paths.includes('orgs'), 'and the refcount that answers it');

  const spec = DfsSerpCache.schema.indexes().map(([keys, opts]) => ({ keys, opts: opts || {} }));
  const has = (keys) => spec.find((i) => JSON.stringify(i.keys) === JSON.stringify(keys));

  const identity = has({ cacheKey: 1, periodKey: 1 });
  assert.ok(identity, 'one row per keyword per day');
  assert.equal(identity.opts.unique, true);

  assert.ok(has({ orgs: 1 }), 'the cascade’s $pull');

  const ttl = has({ expiresAt: 1 });
  assert.ok(ttl);
  assert.equal(ttl.opts.expireAfterSeconds, 0);
  assert.equal(
    DfsSerpCache.schema.path('expiresAt').isRequired,
    true,
    'never null — unlike DfsSerpResult there is no pinning here, because a ' +
      'shared row is nobody’s evidence'
  );
});

test('DfsCacheProbe is unique per (site, kind, market, day) and cascades by organisation', () => {
  const spec = DfsCacheProbe.schema.indexes().map(([keys, opts]) => ({ keys, opts: opts || {} }));
  const has = (keys) => spec.find((i) => JSON.stringify(i.keys) === JSON.stringify(keys));

  const identity = has({ project: 1, kind: 1, variant: 1, periodKey: 1 });
  assert.ok(identity);
  assert.equal(
    identity.opts.unique,
    true,
    'two concurrent passes must not mint two rows for one day and halve the rate ' +
      'by splitting its denominator'
  );
  assert.ok(has({ organisation: 1 }), '`orgCascade` deletes by this and nothing else');
  assert.ok(has({ kind: 1, periodKey: -1 }), 'the per-kind question phase 10 insisted on');
  assert.equal(DfsCacheProbe.schema.path('organisation').isRequired, true);
});

test('orgCascade names both new collections, and refcounts rather than deleting by org', () => {
  // Same shape as `serpResults.test.js`'s cascade assertion: the cascade is a
  // long sequence of deletes and what a new collection can get wrong is being
  // absent from it, or being scoped by the wrong thing.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../orgCascade.js'),
    'utf8'
  );

  assert.match(source, /DfsCacheProbe\.deleteMany\(\{\s*organisation: orgId\s*\}\)/);

  // And the one collection that CANNOT be deleted by organisation, because it
  // has none. `$pull` then delete-the-unreferenced, in that order.
  assert.match(source, /DfsSerpCache\.updateMany\(\{\s*orgs: orgId\s*\}/);
  assert.match(source, /DfsSerpCache\.deleteMany\(\{\s*orgs:\s*\{\s*\$size:\s*0\s*\}\s*\}\)/);
  assert.ok(
    source.indexOf('DfsSerpCache.updateMany') < source.indexOf('DfsSerpCache.deleteMany'),
    'pull the claim before collecting the rows nobody claims'
  );
  assert.equal(
    /DfsSerpCache\.deleteMany\(\{\s*organisation/.test(source),
    false,
    'deleting a shared body by organisation would take another workspace’s reading with it'
  );
});

test('DfsTask.source is the only thing that says a collection was free', () => {
  const path = DfsTask.schema.path('source');
  assert.ok(path);
  assert.deepEqual(path.enumValues, ['provider', 'cache']);
  assert.equal(path.defaultValue, 'provider');
});

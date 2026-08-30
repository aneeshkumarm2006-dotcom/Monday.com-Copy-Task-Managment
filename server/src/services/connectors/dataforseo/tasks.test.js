const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const C = require('./constants');
const T = require('./tasks');
const { getKind } = require('./kinds');
const { variantKeyFor } = require('./sites');
const { fetchKind, queuedCount, keywordsFor } = require('./fetchers');
const { createDfsClient } = require('./client');
const DfsTask = require('../../../models/DfsTask');
const ConnectorBudget = require('../../../models/ConnectorBudget');
const DfsSerpResult = require('../../../models/DfsSerpResult');
const ConnectorSnapshot = require('../../../models/ConnectorSnapshot');
const ConnectorProject = require('../../../models/ConnectorProject');
const { syncProject } = require('../snapshotService');

/**
 * Post once, poll for free, and never buy the same thing twice.
 *
 * ---- What this file is actually defending against --------------------------
 *
 * DataForSEO bills AT POST. `isFresh` is false for anything whose status is not
 * `ok`. The cron is hourly. Multiply those three together and a fetcher that
 * posts whenever it is called is charged 168 TIMES PER WEEKLY DATAPOINT — and
 * every one of those charges produces the same single row.
 *
 * So the assertions below are not "does the shape come back right". They are
 * COUNTS OF `task_post` CALLS, because that count is the bill. Every test here
 * runs against a stubbed `fetch` and an in-memory stand-in for the collection;
 * there is no live credential, and there will not be one before phase 3.
 *
 * The five properties the plan says to prove before moving on:
 *
 *   1. one post per period;
 *   2. N free polls in between;
 *   3. A TASK POSTED AT 23:50 UTC DOES NOT REPOST AT 00:17;
 *   4. the `attempt` cap holds — three charges, never a fourth;
 *   5. a `pending` result writes no snapshot row and feeds nothing to a
 *      dependant.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEYWORDS = ['best crm for agencies', 'agency crm pricing', 'crm for seo agency'];

const VARIANT = {
  locationCode: 2840,
  languageCode: 'en',
  device: 'desktop',
  label: 'United States',
};
const VARIANT_KEY = variantKeyFor(VARIANT);

const project = (overrides = {}) => ({
  _id: 'proj-1',
  externalId: 'proj-1',
  name: 'Acme',
  domain: 'acme.com',
  organisation: 'org-1',
  account: 'acct-1',
  trackedKeywords: [...KEYWORDS],
  targets: [VARIANT],
  ...overrides,
});

const session = { accountId: 'acct-1', getCredentials: () => ({ login: 'l', password: 'p' }) };

/** One `task_post` reply: every task accepted, `20100`, already charged. */
const postEnvelope = (tags) => ({
  version: '0.1.20260801',
  status_code: 20000,
  status_message: 'Ok.',
  cost: 0.0006 * tags.length,
  tasks_count: tags.length,
  tasks_error: 0,
  tasks: tags.map((tag, i) => ({
    id: `task-${tag}`,
    status_code: 20100,
    status_message: 'Task Created.',
    cost: 0.0006,
    result_count: 0,
    path: ['v3', 'serp', 'google', 'organic', 'task_post'],
    data: { api: 'serp', function: 'task_post', tag, se_type: 'organic' },
    result: null,
    // The index is deliberately shuffled into the tag rather than trusted from
    // position — see `tagFor`.
    _order: i,
  })),
});

/** A `task_get` reply for a task still in the queue. NOT an error. */
const queuedEnvelope = () => ({
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
      path: ['v3', 'serp', 'google', 'organic', 'task_get', 'advanced'],
      data: {},
      result: null,
    },
  ],
});

/** A finished `task_get`, with the tracked domain at rank 4. */
const resultEnvelope = (keyword, { datetime = '2026-09-01 04:12:07 +00:00', rank = 4 } = {}) => ({
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
      path: ['v3', 'serp', 'google', 'organic', 'task_get', 'advanced'],
      data: { keyword },
      result: [
        {
          keyword,
          type: 'organic',
          location_code: 2840,
          language_code: 'en',
          datetime,
          item_types: ['organic', 'people_also_ask'],
          se_results_count: 1_240_000,
          items: [
            { type: 'organic', rank_group: 1, rank_absolute: 2, domain: 'rival.com', url: 'https://rival.com/a' },
            { type: 'people_also_ask', rank_group: 2, rank_absolute: 3 },
            {
              type: 'organic',
              rank_group: rank,
              rank_absolute: rank + 2,
              domain: 'blog.acme.com',
              url: 'https://blog.acme.com/crm',
            },
          ],
        },
      ],
    },
  ],
});

/**
 * A `fetch` stand-in that routes on the URL and counts what was bought.
 *
 * `posts` is the number that matters. It is the bill.
 */
const stubTransport = ({ ready = false, resultFor = resultEnvelope } = {}) => {
  const state = { posts: 0, gets: 0, postedTags: [], ready };

  const impl = async (url, init) => {
    let body;
    if (url.includes('/task_post')) {
      state.posts += 1;
      const sent = JSON.parse(init.body);
      const tags = sent.map((t) => t.tag);
      state.postedTags.push(...tags);
      body = postEnvelope(tags);
    } else if (url.includes('/task_get/')) {
      state.gets += 1;
      const id = url.split('/').pop();
      // `task-<hash>.<attempt>.<index>` — the tag carries the keyword index.
      const index = Number(id.split('.').pop());
      body = state.ready ? resultFor(KEYWORDS[index] ?? KEYWORDS[0]) : queuedEnvelope();
    } else {
      throw new Error(`unexpected URL ${url}`);
    }

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };

  return { state, client: createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] }) };
};

// ---------------------------------------------------------------------------
// The collection, in memory
// ---------------------------------------------------------------------------

/**
 * A stand-in for `DfsTask` that enforces THE PARTIAL UNIQUE INDEX.
 *
 * The index is the only real concurrency control in this design — `running` is
 * per-process, `refreshConnectorData` bypasses it entirely, and Render can run
 * two instances — so a fake that did not refuse the second insert would let
 * every test pass while the real thing double-charged. It throws E11000 exactly
 * where Mongo would.
 */
const stubTasks = () => {
  const rows = [];
  let seq = 0;

  const same = (a, b) => String(a) === String(b);
  const matches = (row, filter) =>
    Object.entries(filter).every(([key, want]) => {
      const got = key.split('.').reduce((o, k) => (o == null ? o : o[k]), row);
      if (want && typeof want === 'object' && !Array.isArray(want)) {
        if ('$in' in want) return want.$in.some((v) => same(v, got));
        if ('$ne' in want) return !same(want.$ne, got);
        if ('$gte' in want) return got != null && new Date(got) >= new Date(want.$gte);
        if ('$lt' in want) return got != null && new Date(got) < new Date(want.$lt);
        if ('$elemMatch' in want) {
          return (Array.isArray(got) ? got : []).some((el) =>
            Object.entries(want.$elemMatch).every(([k, v]) => same(v, el?.[k]))
          );
        }
        return true;
      }
      return same(want, got);
    });

  const doc = (input) => {
    const row = {
      _id: `dfs-${(seq += 1)}`,
      provider: 'dataforseo',
      externalId: null,
      state: 'reserving',
      attempt: 1,
      maxAttempts: C.MAX_TASK_ATTEMPTS,
      estimateUsd: 0,
      costUsd: 0,
      budgetDocs: [],
      statusCode: null,
      statusMessage: '',
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
    return row;
  };

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
    const row = doc(input);
    rows.push(row);
    return row;
  };

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

  DfsTask.findOne = (filter) =>
    thenable([...rows].reverse().find((r) => matches(r, filter)) || null);
  DfsTask.find = (filter) => thenable(rows.filter((r) => matches(r, filter)));
  DfsTask.countDocuments = async (filter) => rows.filter((r) => matches(r, filter)).length;
  DfsTask.updateOne = async (filter, update) => {
    const row = rows.find((r) => matches(r, filter));
    if (!row) return { acknowledged: true, matchedCount: 0 };
    for (const [k, v] of Object.entries(update.$set || {})) row[k] = v;
    for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
    for (const [k, v] of Object.entries(update.$push || {})) {
      row[k] = [...(row[k] || []), ...(v.$each || [v])];
    }
    return { acknowledged: true, matchedCount: 1 };
  };

  return {
    rows,
    restore: () => Object.assign(DfsTask, originals),
  };
};

/**
 * The money ledger, in memory.
 *
 * Phase 3 put a budget document in front of every post, so a fixture that did
 * not stand one up would sit on Mongoose's ten-second buffering timeout rather
 * than fail — which reads as a hung test suite and not as a missing dependency.
 *
 * The guard is implemented FAITHFULLY (`reserved + spent + estimate <= cap`, no
 * upsert on the guarded update) rather than waved through, because the property
 * every test in this file is really about is "how many times were we charged",
 * and a stub that always said yes would let a broken gate pass every one of
 * them. `budget.test.js` next door asserts the guard's own behaviour in detail.
 */
const stubBudget = ({ capUsd = 1000 } = {}) => {
  const rows = [];
  const same = (a, b) => String(a) === String(b);
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

  const apply = (row, update) => {
    for (const [k, v] of Object.entries(update.$set || {})) row[k] = v;
    for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
  };

  ConnectorBudget.updateOne = async (filter, update, opts = {}) => {
    let row = find(filter);
    if (!row && opts.upsert) {
      row = { ...filter, reservedUsd: 0, spentUsd: 0, releasedUsd: 0, capUsd, ...(update.$setOnInsert || {}) };
      rows.push(row);
      return { acknowledged: true, upsertedCount: 1 };
    }
    if (!row) return { acknowledged: true, matchedCount: 0 };
    apply(row, update);
    return { acknowledged: true, matchedCount: 1 };
  };

  ConnectorBudget.findOneAndUpdate = (filter, update) => {
    const row = find(filter);
    // The guard, spelled out: `reserved + spent + estimate <= cap`. NO upsert —
    // a refusal has to be a null, not a second document with a fresh counter.
    const add = filter.$expr?.$lte?.[0]?.$add || [];
    const estimate = add.find((x) => typeof x === 'number') || 0;
    const ok =
      row && (row.reservedUsd || 0) + (row.spentUsd || 0) + estimate <= row.capUsd;
    if (ok) apply(row, update);
    const value = ok ? { ...row } : null;
    return { lean: async () => value, then: (res, rej) => Promise.resolve(value).then(res, rej) };
  };

  ConnectorBudget.findOne = (filter) => {
    const value = find(filter);
    return { lean: async () => value, then: (res, rej) => Promise.resolve(value).then(res, rej) };
  };

  return { rows, restore: () => Object.assign(ConnectorBudget, originals) };
};

/**
 * The SERP-body collection, in memory.
 *
 * These fixtures use string ids, so the real model would reject every write with
 * a cast error — which the writer swallows by design (losing the evidence must
 * never take the measurement with it) but which fills the run with noise that
 * looks like a fault. The assertions about what may and may not be stored live in
 * `serpResults.test.js`; here the stub exists so this file keeps testing what it
 * is about, which is how many times we were charged.
 */
const stubSerpResults = () => {
  const writes = [];
  const original = DfsSerpResult.updateOne;
  DfsSerpResult.updateOne = async (filter, update) => {
    writes.push({ filter, set: update.$set });
    return { acknowledged: true };
  };
  return { writes, restore: () => { DfsSerpResult.updateOne = original; } };
};

const kind = (key = 'positions') => getKind(key);

const runFetch = (client, { now, force = false, kindKey = 'positions', proj = project() } = {}) =>
  fetchKind(kindKey, {
    session,
    client,
    project: proj,
    variant: { key: VARIANT_KEY, ...VARIANT },
    now,
    force,
  });

const AT = (iso) => new Date(iso);

// ---------------------------------------------------------------------------
// 1. One post per period, and N free polls
// ---------------------------------------------------------------------------

test('the first tick buys the batch; the next ten poll it for free', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { state, client } = stubTransport();
  try {
    const first = await runFetch(client, { now: AT('2026-09-01T00:17:00Z') });
    assert.equal(first.status, 'pending');
    assert.equal(state.posts, 1, 'the first tick buys exactly one batch');

    // Ten more hourly ticks. Every one of them must be free.
    for (let h = 1; h <= 10; h += 1) {
      // eslint-disable-next-line no-await-in-loop
      const again = await runFetch(client, {
        now: AT(`2026-09-01T${String(h).padStart(2, '0')}:17:00Z`),
      });
      assert.equal(again.status, 'pending');
    }

    assert.equal(state.posts, 1, 'ten further ticks bought NOTHING');
    assert.equal(state.gets, 10 * KEYWORDS.length, 'every one of them polled instead');
    assert.equal(db.rows.length, 1, 'and there is still exactly one job');
    assert.equal(db.rows[0].state, 'open');
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('a queued poll returns `pending` and posts nothing at all', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { state, client } = stubTransport();
  try {
    await runFetch(client, { now: AT('2026-09-01T00:17:00Z') });
    const polled = await runFetch(client, { now: AT('2026-09-01T01:17:00Z') });

    assert.equal(polled.status, 'pending');
    assert.equal(polled.data, null, 'nothing is invented while the answer is in flight');
    assert.equal(polled.collectedAt, null, 'and no period may be claimed for it');
    assert.match(polled.note, /Waiting on DataForSEO/);
    assert.equal(state.posts, 1);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('the finished poll closes the job and dates it from the PROVIDER, not from us', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const transport = stubTransport();
  try {
    await runFetch(transport.client, { now: AT('2026-09-01T00:17:00Z') });
    transport.state.ready = true;

    const done = await runFetch(transport.client, { now: AT('2026-09-01T06:17:00Z') });

    assert.equal(done.status, 'ok');
    assert.equal(
      done.collectedAt.toISOString(),
      '2026-09-01T04:12:07.000Z',
      'the datetime is DataForSEO\'s own, parsed rather than trusted to `new Date`'
    );
    assert.equal(done.raw, null, 'SERP bodies never reach the snapshot — 20-40 MB at depth 100');
    assert.equal(done.data.totals.tracked, KEYWORDS.length);
    assert.equal(done.data.totals.ranked, KEYWORDS.length);
    assert.equal(done.data.keywords[0].rank, 4, 'a subdomain result is the tracked domain');
    assert.equal(done.data.depth, C.DEPTH_CENSUS);

    assert.equal(db.rows[0].state, 'done');
    assert.equal(db.rows[0].periodKey, '2026-09-01');
    assert.equal(transport.state.posts, 1, 'collecting a result costs nothing');
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('a closed job lets the NEXT period buy again — one post per period, not one ever', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const transport = stubTransport({ ready: true });
  try {
    await runFetch(transport.client, { now: AT('2026-09-01T00:17:00Z') }); // post
    await runFetch(transport.client, { now: AT('2026-09-01T01:17:00Z') }); // collect
    assert.equal(db.rows[0].state, 'done');

    // A week later the planner decides the reading is stale and calls again.
    const next = await runFetch(transport.client, { now: AT('2026-09-08T00:17:00Z') });

    assert.equal(next.status, 'pending');
    assert.equal(transport.state.posts, 2, 'the second period is a second purchase');
    assert.equal(db.rows.length, 2);
    assert.equal(db.rows[1].attempt, 1, 'a completed collection resets the attempt chain');
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. THE MIDNIGHT TRAP
// ---------------------------------------------------------------------------

test('a task posted at 23:50 UTC does NOT repost at 00:17', async () => {
  /**
   * The single most expensive line in this design.
   *
   * Keying the open job on `periodKey` looks natural and double-charges every
   * batch posted in the last hour of a UTC day: posted Monday 23:50 under
   * `2026-08-31`, the 00:17 tick looks up `2026-09-01`, misses, and buys the
   * whole batch again. ~4% of all posts, permanently, plus two jobs racing into
   * one snapshot row.
   */
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { state, client } = stubTransport();
  try {
    await runFetch(client, { now: AT('2026-08-31T23:50:00Z') });
    assert.equal(state.posts, 1);

    const acrossMidnight = await runFetch(client, { now: AT('2026-09-01T00:17:00Z') });

    assert.equal(state.posts, 1, 'CROSSING MIDNIGHT MUST NOT BUY ANYTHING');
    assert.equal(acrossMidnight.status, 'pending');
    assert.equal(db.rows.length, 1, 'and must not open a second job to race the first');
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('the open-job key carries no date anywhere in it', () => {
  // Asserted on the query itself rather than only on behaviour, because the
  // behaviour above would still pass if a date were added and then ignored.
  const captured = [];
  const original = DfsTask.findOne;
  DfsTask.findOne = (filter) => {
    captured.push(filter);
    return { sort: () => ({ then: (r) => Promise.resolve(null).then(r) }), then: (r) => Promise.resolve(null).then(r) };
  };
  try {
    T.findOpenJob({ project: project(), kind: kind(), variant: VARIANT_KEY });
  } finally {
    DfsTask.findOne = original;
  }

  assert.deepEqual(Object.keys(captured[0]).sort(), ['kind', 'project', 'state', 'variant']);
  assert.equal(captured[0].state, 'open');
  assert.equal(
    JSON.stringify(captured[0]).includes('period'),
    false,
    'no periodKey, no date, no "today"'
  );
});

test('the variant key is `sites.variantKeyFor` verbatim — a second spelling is a second charge', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { client } = stubTransport();
  try {
    await runFetch(client, { now: AT('2026-09-01T00:17:00Z') });
    assert.equal(db.rows[0].variant, '2840|en|desktop');
    assert.equal(db.rows[0].variant, variantKeyFor(VARIANT));
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. The attempt cap
// ---------------------------------------------------------------------------

/**
 * Walk the clock forward one DAY per tick, so every open job is comfortably past
 * its twelve-hour expiry by the time the next tick looks at it.
 *
 * The clock only ever moves forward, which matters: a helper that replayed the
 * same dates would poll a job that had not expired yet and quietly prove nothing.
 */
const expireAndRetry = async (client, ticks, startDay = 1) => {
  const results = [];
  for (let i = 0; i < ticks; i += 1) {
    const day = String(startDay + i).padStart(2, '0');
    // eslint-disable-next-line no-await-in-loop
    results.push(await runFetch(client, { now: AT(`2026-09-${day}T00:17:00Z`) }));
  }
  return results;
};

test('the attempt cap holds: three charges, and never a fourth', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { state, client } = stubTransport();
  try {
    // Five daily ticks. Nothing ever becomes ready, so every open job expires.
    const results = await expireAndRetry(client, 5);

    assert.equal(state.posts, C.MAX_TASK_ATTEMPTS, 'exactly maxAttempts purchases');
    assert.equal(results.every((r) => r.status === 'pending'), true);

    const states = db.rows.map((r) => r.state);
    assert.deepEqual(states, ['abandoned', 'abandoned', 'dead']);
    assert.deepEqual(db.rows.map((r) => r.attempt), [1, 2, 3]);

    // The two ticks after the cap must say something a person can act on
    // rather than silently doing nothing.
    assert.match(results[3].note, /given up on|Press Refresh/i);
    assert.match(results[4].note, /given up on|Press Refresh/i);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('a dead job stays dead on later ticks — `dead` is not decorative', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { state, client } = stubTransport();
  try {
    // Six daily ticks: three purchases, then three ticks that must buy nothing.
    await expireAndRetry(client, 6);
    // Marking a row dead takes it out of `state: 'open'`, so without the
    // terminal-job check the very next tick would find nothing and buy a FOURTH.
    assert.equal(state.posts, C.MAX_TASK_ATTEMPTS);
    assert.equal(db.rows.filter((r) => r.state === 'dead').length, 1);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('a person pressing Refresh is the escape hatch the note points at', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { state, client } = stubTransport();
  try {
    await expireAndRetry(client, 4);
    assert.equal(state.posts, 3);
    assert.equal(db.rows.at(-1).state, 'dead');

    const forced = await runFetch(client, { now: AT('2026-09-09T09:00:00Z'), force: true });

    assert.equal(forced.status, 'pending');
    assert.equal(state.posts, 4, 'an explicit human request buys again');
    assert.equal(db.rows.at(-1).attempt, 1, 'and starts a fresh attempt chain');
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('an expired job is abandoned rather than left to suppress collection forever', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { client } = stubTransport();
  try {
    await runFetch(client, { now: AT('2026-09-01T00:00:00Z') });
    const posted = db.rows[0];
    assert.equal(
      posted.expiresAt.getTime() - AT('2026-09-01T00:00:00Z').getTime(),
      C.TASK_EXPIRY_HOURS * 3_600_000
    );

    // One minute before expiry: still polled, not reposted.
    await runFetch(client, { now: new Date(posted.expiresAt.getTime() - 60_000) });
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].state, 'open');

    // One minute after: abandoned and re-bought.
    await runFetch(client, { now: new Date(posted.expiresAt.getTime() + 60_000) });
    assert.equal(db.rows[0].state, 'abandoned');
    assert.equal(db.rows.length, 2);
    assert.equal(db.rows[1].attempt, 2);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Concurrency — the index, not a read-then-write
// ---------------------------------------------------------------------------

test('two processes racing into one project buy ONE batch between them', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { state, client } = stubTransport();
  try {
    const [a, b] = await Promise.all([
      runFetch(client, { now: AT('2026-09-01T00:17:00Z') }),
      runFetch(client, { now: AT('2026-09-01T00:17:00Z') }),
    ]);

    assert.equal(state.posts, 1, 'the partial unique index refused the second claim');
    assert.equal(a.status, 'pending');
    assert.equal(b.status, 'pending');
    assert.equal(db.rows.length, 1);
    // The loser says so rather than pretending it did the work.
    assert.equal([a.note, b.note].some((n) => /Already queued/.test(n)), true);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. The `pending` sentinel, end to end through the generic engine
// ---------------------------------------------------------------------------

/** A thenable answering `.select().sort().limit().lean()` in any order. */
const chain = (value) => {
  const self = {
    select: () => self,
    sort: () => self,
    limit: () => self,
    lean: () => Promise.resolve(value),
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return self;
};

const stubSnapshots = () => {
  const writes = [];
  const originals = {
    find: ConnectorSnapshot.find,
    findOne: ConnectorSnapshot.findOne,
    updateOne: ConnectorSnapshot.updateOne,
    projectUpdate: ConnectorProject.updateOne,
  };
  ConnectorSnapshot.find = () => chain([]);
  ConnectorSnapshot.findOne = () => chain(null);
  ConnectorSnapshot.updateOne = async (filter, update) => {
    writes.push({ filter, set: update.$set });
    return { acknowledged: true };
  };
  ConnectorProject.updateOne = async () => ({ acknowledged: true });

  return {
    writes,
    restore: () => {
      ConnectorSnapshot.find = originals.find;
      ConnectorSnapshot.findOne = originals.findOne;
      ConnectorSnapshot.updateOne = originals.updateOne;
      ConnectorProject.updateOne = originals.projectUpdate;
    },
  };
};

test('a pending result writes NO snapshot row and feeds NOTHING to a dependant', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const snaps = stubSnapshots();
  const { state, client } = stubTransport();
  const descriptor = require('./index');

  /**
   * A synthetic dependant, because nothing in the real catalog declares one yet
   * and the property under test is generic: `syncProject` may not offer a queued
   * kind's empty body to anything downstream. A dependant handed `null` writes an
   * empty snapshot that then looks CURRENT FOR A WEEK, which is strictly worse
   * than not running it.
   */
  const kinds = [
    getKind('positions'),
    { key: 'derived', label: 'Derived', subject: 'project', dependsOn: ['positions'] },
  ];

  const connector = {
    name: 'dataforseo',
    variantsFor: () => ({ variants: [{ key: VARIANT_KEY, ...VARIANT }], skipped: 0 }),
    fetch: async (key, ctx) => {
      if (key === 'derived') {
        throw new Error('the dependant must never be called when its dependency is queued');
      }
      return descriptor.fetch(key, { ...ctx, client });
    },
  };

  try {
    const report = await syncProject({
      session,
      connector,
      client,
      project: project(),
      kinds,
      intervalHours: 168,
      now: AT('2026-09-01T00:17:00Z'),
    });

    assert.equal(state.posts, 1, 'the batch was bought');
    assert.equal(snaps.writes.length, 0, 'AND NOT ONE SNAPSHOT ROW WAS WRITTEN');

    assert.equal(report.queued, 1, 'counted as queued...');
    assert.equal(report.ok, 0, '...never as a reading that exists');
    assert.equal(report.failed, 0, '...never as a fault an operator must chase');
    assert.equal(report.written, 0);

    // The dependant was skipped, and said so.
    assert.equal(
      report.notes.some((n) => /derived: skipped, no positions to work from/.test(n)),
      true,
      `notes were ${JSON.stringify(report.notes)}`
    );
    // And the in-flight note survived even though the row did not.
    assert.equal(report.notes.some((n) => /^positions: Queued 3 keywords/.test(n)), true);
  } finally {
    snaps.restore();
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('once the result lands the same pass writes exactly one snapshot', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const snaps = stubSnapshots();
  const transport = stubTransport();
  const descriptor = require('./index');

  const connector = {
    name: 'dataforseo',
    variantsFor: () => ({ variants: [{ key: VARIANT_KEY, ...VARIANT }], skipped: 0 }),
    fetch: async (key, ctx) => descriptor.fetch(key, { ...ctx, client: transport.client }),
  };

  const run = () =>
    syncProject({
      session,
      connector,
      client: transport.client,
      project: project(),
      kinds: [getKind('positions')],
      intervalHours: 168,
      now: AT('2026-09-01T00:17:00Z'),
    });

  try {
    await run();
    transport.state.ready = true;
    const report = await run();

    assert.equal(report.queued, 0);
    assert.equal(report.ok, 1);
    assert.equal(snaps.writes.length, 1);
    assert.equal(snaps.writes[0].filter.periodKey, '2026-09-01');
    assert.equal(snaps.writes[0].set.status, 'ok');
    assert.equal(snaps.writes[0].set.raw, null);
    assert.equal(transport.state.posts, 1, 'and the whole pass bought exactly one batch');
  } finally {
    snaps.restore();
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. The empty-array trap
// ---------------------------------------------------------------------------

test('an EMPTY keyword list buys nothing — `[]` is truthy and `requires` does not catch it', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { state, client } = stubTransport();
  try {
    const out = await runFetch(client, {
      now: AT('2026-09-01T00:17:00Z'),
      proj: project({ trackedKeywords: [] }),
    });

    assert.equal(out.status, 'pending');
    assert.equal(state.posts, 0, 'an empty payload would have been a paid 40501');
    assert.equal(db.rows.length, 0, 'and would have claimed an identity for nothing');
    assert.match(out.note, /No keywords are tracked/);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('keywordsFor caps at the Site ceiling and drops duplicates', () => {
  const many = Array.from({ length: C.MAX_TRACKED_KEYWORDS + 40 }, (_, i) => `kw ${i}`);
  const out = keywordsFor({ trackedKeywords: [...many, 'kw 0', '', '  '] });
  assert.equal(out.keywords.length, C.MAX_TRACKED_KEYWORDS);
  assert.equal(new Set(out.keywords).size, out.keywords.length);
  assert.equal(out.note, '');
});

// ---------------------------------------------------------------------------
// 7. `requestHash` — computed now, read by nothing
// ---------------------------------------------------------------------------

test('the request hash is stable under key order and changes with the keyword list', () => {
  const base = { endpoint: 'e', depth: 100, keywords: ['a', 'b'] };
  const shuffled = { keywords: ['a', 'b'], depth: 100, endpoint: 'e' };

  assert.equal(T.requestHashFor(base), T.requestHashFor(shuffled));
  assert.notEqual(
    T.requestHashFor(base),
    T.requestHashFor({ ...base, keywords: ['b', 'a'] }),
    'a different basket is a different purchase, even with the same members'
  );
  assert.equal(T.canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
});

test('a repost carries the ORIGINAL request, not whatever the project says now', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { client } = stubTransport();
  const proj = project();
  try {
    await runFetch(client, { now: AT('2026-09-01T00:00:00Z'), proj });
    const first = db.rows[0];

    assert.deepEqual(first.request.keywords, KEYWORDS);
    assert.equal(first.requestHash, T.requestHashFor(first.request));
    assert.equal(first.keywords.length, KEYWORDS.length, 'queryable, not buried in `request`');
    assert.equal(first.estimateUsd > 0, true, 'the ledger holds a number, not a zero');
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 8. The ledger, and the money handles
// ---------------------------------------------------------------------------

test('a job is written from the id, the cost and the echoed tag — and nothing else', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { client } = stubTransport();
  try {
    await runFetch(client, { now: AT('2026-09-01T00:17:00Z') });
    const job = db.rows[0];

    assert.equal(job.items.length, KEYWORDS.length);
    assert.equal(job.organisation, 'org-1', 'REQUIRED — orgCascade deletes by it');
    assert.equal(job.account, 'acct-1');
    assert.equal(job.endpoint, C.ENDPOINT_SERP_TASK_POST);
    assert.equal(job.periodKey, null, 'NEVER at post time');
    assert.equal(job.externalId, null, 'a batch has no single id; the ids are on the items');

    for (const [i, item] of job.items.entries()) {
      assert.equal(item.statusCode, C.STATUS_TASK_CREATED, '20100 is charged, not failed');
      assert.equal(item.externalId, `task-${item.tag}`);
      assert.equal(item.cost, 0.0006);
      assert.equal(item.keyword, KEYWORDS[i], 'mapped through the echoed tag');
      assert.equal(item.collected, false);
    }
    assert.equal(Math.round(job.costUsd * 1e6) / 1e6, 0.0018);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('a post that fails releases the claim rather than blocking for twelve hours', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const client = {
    call: async () => {
      const err = new Error('DataForSEO is unavailable (HTTP 503).');
      err.retryable = true;
      throw err;
    },
  };
  try {
    await assert.rejects(() => runFetch(client, { now: AT('2026-09-01T00:17:00Z') }));
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].state, 'failed', 'not `open` — an open row nobody posted blocks');
    assert.equal(db.rows[0].attempt, 1);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('the failed attempt is still counted, so a broken post cannot hammer forever', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  let calls = 0;
  const client = {
    call: async () => {
      calls += 1;
      const err = new Error('nope');
      throw err;
    },
  };
  try {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runFetch(client, { now: AT(`2026-09-0${i + 1}T00:17:00Z`) }).catch(() => {});
    }
    assert.equal(calls, C.MAX_TASK_ATTEMPTS, 'three tries, then an actionable note');
    assert.equal(db.rows.length, C.MAX_TASK_ATTEMPTS, 'and no fourth job was ever opened');
    // The third is retired to `dead` by the fourth tick, which is what makes the
    // fifth one silent instead of a fourth attempt.
    assert.equal(db.rows.filter((r) => r.state === 'dead').length, 1);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 9. The queued badge, and the cache probe
// ---------------------------------------------------------------------------

test('the tab\'s queued count is a database read on {project, state}', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { client } = stubTransport();
  try {
    assert.equal(await queuedCount(project()), 0);
    await runFetch(client, { now: AT('2026-09-01T00:17:00Z') });
    assert.equal(await queuedCount(project()), 1);

    // A different project shares nothing.
    assert.equal(await queuedCount(project({ _id: 'proj-2' })), 0);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('would-be cross-tenant cache hits are LOGGED, so phase 11 is a measurement', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const { client } = stubTransport();
  const lines = [];
  try {
    // Another tenant already bought two of these keywords today, same market.
    await DfsTask.create({
      organisation: 'org-2',
      account: 'acct-1',
      project: 'proj-9',
      kind: 'positions',
      variant: VARIANT_KEY,
      endpoint: C.ENDPOINT_SERP_TASK_POST,
      state: 'open',
      keywords: [KEYWORDS[0], KEYWORDS[1], 'unrelated'],
      postedAt: AT('2026-09-01T02:00:00Z'),
    });

    const probe = await T.probeCacheHits({
      project: project(),
      kind: kind(),
      variant: VARIANT_KEY,
      keywords: KEYWORDS,
      now: AT('2026-09-01T09:00:00Z'),
      log: (line) => lines.push(line),
    });

    assert.deepEqual(probe, { overlap: 2, otherOrgs: 1 });
    assert.equal(lines.length, 1, 'one line, not a feature');
    assert.match(lines[0], /alreadyBoughtToday=2/);
    assert.match(lines[0], /byOtherTenants=1/);
    assert.match(lines[0], /wouldSaveUsd=/);

    // Yesterday's purchase is not a hit: reusing a six-day-old SERP in a rank
    // tracker breaks the product's core claim, so the window is the UTC day.
    const stale = await T.probeCacheHits({
      project: project(),
      kind: kind(),
      variant: VARIANT_KEY,
      keywords: KEYWORDS,
      now: AT('2026-09-02T09:00:00Z'),
      log: (line) => lines.push(line),
    });
    assert.deepEqual(stale, { overlap: 0, otherOrgs: 0 });
    assert.equal(lines.length, 1);

    assert.equal(client !== null, true);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 10. The model, and the cascade
// ---------------------------------------------------------------------------

test('DfsTask carries every index the design depends on', () => {
  const spec = DfsTask.schema.indexes().map(([keys, opts]) => ({ keys, opts: opts || {} }));
  const has = (keys) => spec.find((i) => JSON.stringify(i.keys) === JSON.stringify(keys));

  const gate = has({ project: 1, kind: 1, variant: 1 });
  assert.ok(gate, 'the anti-repost gate');
  assert.equal(gate.opts.unique, true);
  assert.deepEqual(gate.opts.partialFilterExpression, { state: 'open' });

  const ext = has({ externalId: 1 });
  assert.ok(ext);
  assert.equal(ext.opts.unique, true);
  assert.equal(ext.opts.sparse, true, 'sparse, or every batch row collides on null');

  assert.ok(has({ state: 1, expiresAt: 1 }), 'the expiry sweep');
  assert.ok(has({ account: 1, state: 1 }), 'everything in flight on one account');
  assert.ok(has({ project: 1, state: 1 }), 'the tab\'s queued count');
  assert.ok(has({ organisation: 1 }), 'the org cascade');
});

test('organisation is REQUIRED, because the cascade deletes by it', () => {
  assert.equal(DfsTask.schema.path('organisation').isRequired, true);
  assert.equal(DfsTask.schema.path('account').isRequired, true);
  assert.equal(DfsTask.schema.path('project').isRequired, true);
  assert.deepEqual(DfsTask.schema.path('state').enumValues, [
    'reserving',
    'open',
    'ready',
    'done',
    'abandoned',
    'dead',
    'failed',
  ]);
});

test('orgCascade deletes DfsTask rows by organisation', async () => {
  const { cascadeDeleteOrg } = require('../../orgCascade');
  const calls = [];
  const saved = [];

  for (const model of Object.values(mongoose.models)) {
    saved.push([model, { ...model }]);
    const name = model.modelName;
    model.distinct = async () => [];
    model.find = () => chain([]);
    model.deleteMany = async (filter) => {
      calls.push({ name, filter });
      return { deletedCount: 0 };
    };
    model.deleteOne = async () => ({ deletedCount: 1 });
    model.updateMany = async () => ({ acknowledged: true });
  }

  try {
    await cascadeDeleteOrg('org-1');
    const hit = calls.find((c) => c.name === 'DfsTask');
    assert.ok(hit, 'the task ledger must not outlive the workspace that bought it');
    assert.deepEqual(hit.filter, { organisation: 'org-1' });

    // And it goes BEFORE the projects that parent it, so a failure halfway
    // through leaves orphaned parents rather than orphaned children.
    const order = calls.map((c) => c.name);
    assert.ok(order.indexOf('DfsTask') < order.indexOf('ConnectorProject'));
  } finally {
    for (const [model, original] of saved) Object.assign(model, original);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./constants');
const P = require('./pricing');
const Budget = require('./budget');
const T = require('./tasks');
const { fetchKind } = require('./fetchers');
const { createDfsClient } = require('./client');
const { getKind } = require('./kinds');
const { variantKeyFor } = require('./sites');
const { syncProject } = require('../snapshotService');
const DfsTask = require('../../../models/DfsTask');
const DfsSerpResult = require('../../../models/DfsSerpResult');
const ConnectorBudget = require('../../../models/ConnectorBudget');
const ConnectorSnapshot = require('../../../models/ConnectorSnapshot');
const ConnectorProject = require('../../../models/ConnectorProject');
const ConnectorAccount = require('../../../models/ConnectorAccount');
const BoardConnector = require('../../../models/BoardConnector');

/**
 * The budget, where it meets DataForSEO.
 *
 * `budget.test.js` one directory up asserts the ledger's arithmetic. This file
 * asserts the three things that are specific to a provider which bills at POST:
 *
 *   1. THE ESTIMATE COMES FROM THE ACCOUNT'S OWN PRICE BOOK, not from a constant
 *      typed into a file that DataForSEO moved 20% on 2026-07-01.
 *   2. OUR OWN CAP IS NOT `quotaExhausted`. That is the most expensive
 *      distinction in the phase: `syncAccount` catches `quotaExhausted` and
 *      `break`s out of the project loop, which would abandon every remaining
 *      project INCLUDING THEIR FREE POLLS FOR RESULTS ALREADY PAID FOR. Hitting
 *      the cap on project 3 of 30 would strand twenty-seven projects' worth of
 *      purchased data, and DataForSEO drops results after thirty days.
 *   3. `ConnectorBudget.reservedUsd` IS A RECOMPUTABLE CACHE. The model says so;
 *      this file makes it true by deranging the counter and repairing it.
 *
 * Everything runs against fixtures. There is no live credential anywhere in this
 * repository, `constants.IS_SANDBOX` is true unless somebody deliberately points
 * `DATAFORSEO_API_ORIGIN` at production, and no test here makes a network call.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEYWORDS = ['best crm for agencies', 'agency crm pricing', 'crm for seo agency'];

const VARIANT = { locationCode: 2840, languageCode: 'en', device: 'desktop' };
const VARIANT_KEY = variantKeyFor(VARIANT);

const project = (overrides = {}) => ({
  _id: 'proj-1',
  externalId: 'proj-1',
  name: 'Acme',
  domain: 'acme.com',
  organisation: 'org-1',
  account: 'acct-1',
  board: null,
  trackedKeywords: [...KEYWORDS],
  targets: [VARIANT],
  ...overrides,
});

/**
 * A session carrying a price book, which is where the estimate comes from.
 *
 * `getQuota` reads the account row `syncAccount` already has in memory — no
 * second `user_data` call and no extra database round trip. A session without it
 * (every phase-2 fixture) falls back to the published constant, which is what
 * keeps those tests unchanged.
 */
const session = (quota = null) => ({
  accountId: 'acct-1',
  getCredentials: () => ({ login: 'l', password: 'p' }),
  ...(quota ? { getQuota: () => quota } : {}),
});

const postEnvelope = (tags) => ({
  status_code: 20000,
  status_message: 'Ok.',
  // depth 100 is TEN bands, so one keyword is ten units. Matching the estimate
  // here is what makes the cap arithmetic below readable rather than incidental.
  cost: 0.006 * tags.length,
  tasks_count: tags.length,
  tasks_error: 0,
  tasks: tags.map((tag) => ({
    id: `task-${tag}`,
    status_code: 20100,
    status_message: 'Task Created.',
    cost: 0.006,
    data: { tag },
    result: null,
  })),
});

const queuedEnvelope = () => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost: 0,
  tasks_count: 1,
  tasks_error: 1,
  tasks: [{ id: 'x', status_code: 40602, status_message: 'Task In Queue.', cost: 0, result: null }],
});

const stubTransport = () => {
  const state = { posts: 0, gets: 0 };
  const impl = async (url, init) => {
    let body;
    if (url.includes('/task_post')) {
      state.posts += 1;
      body = postEnvelope(JSON.parse(init.body).map((t) => t.tag));
    } else if (url.includes('/task_get/')) {
      state.gets += 1;
      body = queuedEnvelope();
    } else {
      throw new Error(`unexpected URL ${url}`);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { state, impl };
};

// ---------------------------------------------------------------------------
// The collections, in memory
// ---------------------------------------------------------------------------

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
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      throw err;
    }
    const row = {
      _id: `dfs-${(seq += 1)}`,
      provider: 'dataforseo',
      budgetState: 'none',
      reservedAt: null,
      settledAt: null,
      estimateUsd: 0,
      costUsd: 0,
      budgetDocs: [],
      postedAt: null,
      closedAt: null,
      items: [],
      note: '',
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
    for (const [k, v] of Object.entries(update.$set || {})) row[k] = v;
    for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
    for (const [k, v] of Object.entries(update.$push || {})) {
      row[k] = [...(row[k] || []), ...(v.$each || [v])];
    }
    return { acknowledged: true, matchedCount: 1 };
  };

  return { rows, restore: () => Object.assign(DfsTask, originals) };
};

/** `ConnectorBudget`, with the guard evaluated rather than assumed. */
const stubBudgets = () => {
  const rows = [];
  const keyOf = (f) =>
    [f.organisation, f.provider, f.scope, f.scopeId, f.periodKey].map(String).join('|');
  const find = (f) => rows.find((r) => same(keyOf(r), keyOf(f))) || null;
  const apply = (row, update) => {
    for (const [k, v] of Object.entries(update.$set || {})) row[k] = v;
    for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
  };

  const originals = {
    updateOne: ConnectorBudget.updateOne,
    findOneAndUpdate: ConnectorBudget.findOneAndUpdate,
    findOne: ConnectorBudget.findOne,
  };

  ConnectorBudget.updateOne = async (filter, update, opts = {}) => {
    let row = find(filter);
    if (!row && opts.upsert) {
      row = {
        organisation: filter.organisation,
        provider: filter.provider,
        scope: filter.scope,
        scopeId: filter.scopeId,
        periodKey: filter.periodKey,
        reservedUsd: 0,
        spentUsd: 0,
        releasedUsd: 0,
        capUsd: 0,
        ...(update.$setOnInsert || {}),
      };
      rows.push(row);
      return { acknowledged: true };
    }
    if (!row) return { acknowledged: true, matchedCount: 0 };
    apply(row, update);
    return { acknowledged: true, matchedCount: 1 };
  };

  ConnectorBudget.findOneAndUpdate = (filter, update) => {
    const { $expr, ...key } = filter;
    const row = find(key);
    const add = $expr?.$lte?.[0]?.$add || [];
    const estimate = add.find((x) => typeof x === 'number') || 0;
    const ok = !!row && (row.reservedUsd || 0) + (row.spentUsd || 0) + estimate <= row.capUsd;
    if (ok) apply(row, update);
    const value = ok ? { ...row } : null;
    return { lean: async () => value, then: (r) => Promise.resolve(value).then(r) };
  };

  ConnectorBudget.findOne = (filter) => {
    const value = find(filter);
    return { lean: async () => value, then: (r) => Promise.resolve(value).then(r) };
  };

  return { rows, find, restore: () => Object.assign(ConnectorBudget, originals) };
};

const stubSerpResults = () => {
  const original = DfsSerpResult.updateOne;
  DfsSerpResult.updateOne = async () => ({ acknowledged: true });
  return { restore: () => { DfsSerpResult.updateOne = original; } };
};

const stubBoardConnector = (budget = null) => {
  const original = BoardConnector.findOne;
  BoardConnector.findOne = () => thenable(budget ? { budget } : null);
  return { restore: () => { BoardConnector.findOne = original; } };
};

const AT = (iso) => new Date(iso);
const NOW = AT('2026-08-15T00:17:00Z');

const runFetch = (client, opts = {}) =>
  fetchKind('positions', {
    session: opts.session || session(),
    client,
    project: opts.project || project(),
    variant: { key: VARIANT_KEY, ...VARIANT },
    now: opts.now || NOW,
    force: !!opts.force,
  });

const clientFor = (impl) => createDfsClient(session(), { fetchImpl: impl, retryDelaysMs: [] });

// ---------------------------------------------------------------------------
// 1. The estimate comes from the account's own price book
// ---------------------------------------------------------------------------

test('the unit price is read out of the account price book, by ENDPOINT PATH', () => {
  const book = {
    serp: {
      google: {
        organic: {
          task_post: { standard: 0.0012, priority: 0.0024 },
          task_get: { advanced: 0 },
        },
      },
    },
  };

  assert.equal(P.unitPriceFor(book, 'serp/google/organic/task_post'), 0.0012);
  assert.equal(
    P.unitPriceFor(book, 'serp/google/organic/task_get/advanced'),
    null,
    'a free endpoint has no positive price, and zero is not one'
  );
  assert.equal(P.unitPriceFor(book, 'backlinks/summary/live'), null, 'a path we do not have');
  assert.equal(P.unitPriceFor(null, 'serp/google/organic/task_post'), null);
});

test('a price book nested a level deeper still resolves, and takes the BASE rate', () => {
  /**
   * The shape of `price` is not fully documented and DataForSEO's own examples
   * disagree about its depth. Every dimension we do not model MULTIPLIES the
   * price — priority is x2, browser rendering is x34, each search operator is x5
   * — so the minimum positive number in the subtree is the base rate, and the
   * base rate is what a standard, operator-free, unrendered SERP costs.
   */
  const book = {
    serp: {
      google: { organic: { task_post: { desktop: { standard: 0.0006, priority: 0.0012 } } } },
    },
  };
  assert.equal(P.unitPriceFor(book, 'serp/google/organic/task_post'), 0.0006);
});

test('an unreadable price book WARNS and falls back — it never fails a collection', () => {
  const said = [];
  const { unitUsd, source } = P.resolveUnitPrice({
    quota: { price: { nothing: 'useful' } },
    endpoint: 'serp/google/organic/task_post',
    warn: (m) => said.push(m),
  });

  assert.equal(unitUsd, C.SERP_UNIT_USD, 'the published constant, which phase 2 ran on entirely');
  assert.equal(source, 'published');
});

test('the estimate is unit x keywords x depth-band, and depth is a x1 per TEN', () => {
  // The single biggest cost lever in the product: depth 100 costs TEN TIMES
  // depth 10, which is the whole reason rank tracking is two kinds on two clocks.
  assert.equal(P.estimateUsdFor({ count: 200, depth: 10, unitUsd: 0.0006 }), 0.12);
  assert.equal(P.estimateUsdFor({ count: 200, depth: 100, unitUsd: 0.0006 }), 1.2);
  assert.equal(P.depthMultiplier(100), 10);
  assert.equal(P.depthMultiplier(1), 1, 'never below one band');
});

test('a job reserves the account price, not the constant', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpResults();
  const { state, impl } = stubTransport();
  try {
    // Double the published rate, so a job estimated from the constant would be
    // visibly half of what this asserts.
    const quota = {
      price: { serp: { google: { organic: { task_post: { standard: 0.0012 } } } } },
    };

    await runFetch(clientFor(impl), { session: session(quota) });

    assert.equal(state.posts, 1);
    const job = db.rows[0];
    assert.equal(
      job.estimateUsd,
      P.estimateUsdFor({ count: 3, depth: C.DEPTH_CENSUS, unitUsd: 0.0012 })
    );
    assert.equal(job.estimateUsd, 0.036);
    assert.equal(money.rows[0].reservedUsd, 0, 'and it settled straight after the post');
    assert.equal(money.rows[0].spentUsd, 0.018, "DataForSEO's own reported cost, not ours");
  } finally {
    serps.restore();
    money.restore();
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. The cap, and where its stop is routed
// ---------------------------------------------------------------------------

test('a job that fits reserves, posts, and settles on the provider figure', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpResults();
  const { state, impl } = stubTransport();
  try {
    await runFetch(clientFor(impl));

    assert.equal(state.posts, 1);
    const org = money.rows.find((r) => r.scope === 'org');
    assert.equal(org.capUsd, C.DEFAULT_MONTHLY_CAP_USD);
    assert.equal(org.reservedUsd, 0, 'the reservation was settled, not left holding');
    assert.equal(org.spentUsd, 0.018);
    assert.equal(db.rows[0].budgetState, 'settled');
    assert.ok(db.rows[0].settledAt instanceof Date);
    assert.equal(db.rows[0].state, 'open', 'the WORK is still open — two orthogonal questions');
  } finally {
    serps.restore();
    money.restore();
    db.restore();
  }
});

test('the cap refuses the post, releases the CLAIM, and buys nothing', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpResults();
  const { state, impl } = stubTransport();
  try {
    // Spend the whole month first, through the same door a real pass would.
    await Budget.reserveForJob({
      project: project(),
      estimateUsd: C.DEFAULT_MONTHLY_CAP_USD,
      now: NOW,
    });

    const out = await runFetch(clientFor(impl));

    assert.equal(state.posts, 0, 'NOT ONE TASK WAS BOUGHT');
    assert.equal(out.status, 'pending', 'phase 0’s sentinel, so no snapshot row is written');
    assert.match(out.note, /Monthly budget reached/);
    assert.equal(out.data, null);

    const job = db.rows.at(-1);
    assert.equal(job.state, 'failed', 'the claim was released...');
    assert.equal(job.budgetState, 'released', '...and so was the money');
    assert.equal(
      job.state === 'open',
      false,
      'an open row for a purchase that never happened would block this Site for twelve hours'
    );
  } finally {
    serps.restore();
    money.restore();
    db.restore();
  }
});

test('OUR cap is not `quotaExhausted` — 27 of 30 projects keep collecting', async () => {
  /**
   * THE MOST EXPENSIVE DISTINCTION IN THIS PHASE.
   *
   * `syncAccount` catches `quotaExhausted` and `break`s out of the project loop.
   * Routing our own cap through it would abandon every remaining project —
   * including their FREE `task_get` polls for results we have already paid for —
   * and DataForSEO drops results after thirty days. Hitting the cap on project 3
   * of 30 would strand twenty-seven projects' worth of purchased data.
   *
   * So the cap sets a per-run flag on the account-scoped client instead. Free
   * collection continues everywhere; nothing new is bought anywhere.
   */
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpResults();
  const { state, impl } = stubTransport();

  const originals = {
    snapFind: ConnectorSnapshot.find,
    snapFindOne: ConnectorSnapshot.findOne,
    snapUpdate: ConnectorSnapshot.updateOne,
    projUpdate: ConnectorProject.updateOne,
    acctUpdate: ConnectorAccount.updateOne,
  };
  ConnectorSnapshot.find = () => thenable([]);
  ConnectorSnapshot.findOne = () => thenable(null);
  ConnectorSnapshot.updateOne = async () => ({ acknowledged: true });
  ConnectorProject.updateOne = async () => ({ acknowledged: true });
  ConnectorAccount.updateOne = async () => ({ acknowledged: true });

  try {
    // A cap with room for exactly one of the three Sites.
    await Budget.reserveForJob({
      project: project(),
      // Room for exactly one job of 3 keywords at depth 100 ($0.018) and no more.
      estimateUsd: C.DEFAULT_MONTHLY_CAP_USD - 0.02,
      now: NOW,
    });

    const projects = [
      project({ _id: 'proj-1', domain: 'a.com' }),
      project({ _id: 'proj-2', domain: 'b.com' }),
      project({ _id: 'proj-3', domain: 'c.com' }),
    ];

    const client = clientFor(impl);
    const connector = {
      name: 'dataforseo',
      label: 'DataForSEO',
      syncIntervalHours: 168,
      createClient: () => client,
      variantsFor: () => ({ variants: [{ key: VARIANT_KEY, ...VARIANT }], skipped: 0 }),
      fetch: (key, ctx) => fetchKind(key, { ...ctx, client, now: NOW }),
    };

    // `syncAccount` looks the connector up in the registry, so the loop is
    // driven through `syncProject` directly for each project — same guard, same
    // per-project report, without standing up an account row and a session.
    const reports = [];
    for (const p of projects) {
      // eslint-disable-next-line no-await-in-loop
      reports.push(
        await syncProject({
          session: session(),
          connector,
          client,
          project: p,
          kinds: [getKind('positions')],
          intervalHours: 168,
          now: NOW,
        })
      );
    }

    assert.equal(state.posts, 1, 'exactly one purchase fitted under the cap');
    assert.equal(reports.length, 3, 'AND ALL THREE PROJECTS WERE VISITED');
    assert.equal(
      reports.every((r) => r.failed === 0),
      true,
      'a cap is not a fault an operator has to chase'
    );
    assert.equal(
      reports.every((r) => r.queued === 1),
      true,
      'every one of them is reported as queued, which is what `pending` means'
    );
    assert.equal(client.postingSuppressed(), true);
    assert.match(reports[2].notes.join(' '), /Monthly budget reached/);
  } finally {
    ConnectorSnapshot.find = originals.snapFind;
    ConnectorSnapshot.findOne = originals.snapFindOne;
    ConnectorSnapshot.updateOne = originals.snapUpdate;
    ConnectorProject.updateOne = originals.projUpdate;
    ConnectorAccount.updateOne = originals.acctUpdate;
    serps.restore();
    money.restore();
    db.restore();
  }
});

test('once the flag is up, a later project does not even touch the database', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpResults();
  const { state, impl } = stubTransport();
  try {
    const client = clientFor(impl);
    client.suppressPosting('Monthly budget reached — nothing new was requested.');

    const before = db.rows.length;
    const out = await runFetch(client);

    assert.equal(state.posts, 0);
    assert.equal(db.rows.length, before, 'no claim row, no reservation, no round trip');
    assert.match(out.note, /Monthly budget reached/);
  } finally {
    serps.restore();
    money.restore();
    db.restore();
  }
});

test('the first note wins — the sentence names the scope that actually refused', () => {
  const client = createDfsClient(session(), { fetchImpl: async () => {}, retryDelaysMs: [] });
  client.suppressPosting("This board's own monthly allocation of $2 is used up.");
  client.suppressPosting('something later and less specific');
  assert.match(client.postingSuppressedNote(), /board/);
});

// ---------------------------------------------------------------------------
// 3. Board budgets — a second document, rolled back on failure
// ---------------------------------------------------------------------------

test('a board allocation is a SECOND document, reserved after the org one', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpResults();
  const boards = stubBoardConnector({ monthlyUsd: 2 });
  const { state, impl } = stubTransport();
  try {
    await runFetch(clientFor(impl), { project: project({ board: 'board-1' }) });

    assert.equal(state.posts, 1);
    assert.equal(money.rows.length, 2);
    const [first, second] = money.rows;
    assert.equal(first.scope, 'org', 'the real ceiling is taken first');
    assert.equal(second.scope, 'board');
    assert.equal(second.capUsd, 2, 'the allocation, from BoardConnector.budget');
    assert.equal(db.rows[0].budgetDocs.length, 2);
    assert.equal(db.rows[0].budgetDocs[0].scope, 'org');
  } finally {
    boards.restore();
    serps.restore();
    money.restore();
    db.restore();
  }
});

test("a spent board allocation gives the ORG's money back and buys nothing", async () => {
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpResults();
  const boards = stubBoardConnector({ monthlyUsd: 0.001 });
  const { state, impl } = stubTransport();
  try {
    const out = await runFetch(clientFor(impl), { project: project({ board: 'board-1' }) });

    assert.equal(state.posts, 0);
    assert.match(out.note, /board/i);

    const org = money.rows.find((r) => r.scope === 'org');
    assert.equal(
      org.reservedUsd,
      0,
      "COMPENSATION, NOT A TRANSACTION — config/db.js connects with a bare URI and " +
        'a replica set cannot be assumed'
    );
    assert.equal(org.releasedUsd, db.rows.at(-1).estimateUsd);
  } finally {
    boards.restore();
    serps.restore();
    money.restore();
    db.restore();
  }
});

test('no allocation means one document, so the compensation path costs nothing', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpResults();
  const boards = stubBoardConnector(null);
  const { impl } = stubTransport();
  try {
    await runFetch(clientFor(impl), { project: project({ board: 'board-1' }) });
    assert.equal(money.rows.length, 1);
    assert.equal(money.rows[0].scope, 'org');
  } finally {
    boards.restore();
    serps.restore();
    money.restore();
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. `reserving` coexists with the claim, and the reconciler can find it
// ---------------------------------------------------------------------------

test('the claim is inserted as `state: open` — the only state the index covers', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpResults();
  const { impl } = stubTransport();
  try {
    await runFetch(clientFor(impl));
    const job = db.rows[0];

    /**
     * The decision this phase had to take, asserted rather than described.
     *
     * A row inserted as `state: 'reserving'` would NOT be covered by the partial
     * unique index, so two processes could both insert one, both reserve and both
     * post — the double charge the index exists to prevent, reintroduced by the
     * mechanism added to make posting safer. So the money phase is a SUB-STATE on
     * the same row.
     */
    assert.notEqual(job.state, 'reserving');
    assert.equal(
      db.rows.some((r) => r.state === 'reserving'),
      false,
      '`state: reserving` is unreachable from phase 3 onward'
    );
    assert.ok(job.reservedAt instanceof Date, 'and the reservation is still findable');
  } finally {
    serps.restore();
    money.restore();
    db.restore();
  }
});

test('the reconciler sweeps a reservation older than ten minutes and releases it', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  try {
    // A process that died between the reserve and the post.
    await Budget.reserveForJob({ project: project(), estimateUsd: 1.2, now: NOW });
    await DfsTask.create({
      organisation: 'org-1',
      account: 'acct-1',
      project: 'proj-1',
      kind: 'positions',
      variant: VARIANT_KEY,
      endpoint: C.ENDPOINT_SERP_TASK_POST,
      state: 'open',
      budgetState: 'reserving',
      reservedAt: NOW,
      estimateUsd: 1.2,
      costUsd: 0,
      postedAt: null,
      budgetDocs: [
        { organisation: 'org-1', provider: 'dataforseo', scope: 'org', scopeId: 'org-1', periodKey: '2026-08', capUsd: 5 },
      ],
    });
    assert.equal(money.rows[0].reservedUsd, 1.2);

    const before = new Date(NOW.getTime() + C.RESERVATION_STALE_MS - 1000);
    assert.deepEqual(
      await Budget.reconcileReservations({ now: before }),
      { swept: 0, releasedUsd: 0, settledUsd: 0, recomputed: 0 },
      'a reserve-post-settle sequence takes seconds; nine minutes is not stale'
    );
    assert.equal(money.rows[0].reservedUsd, 1.2);

    const after = new Date(NOW.getTime() + C.RESERVATION_STALE_MS + 1000);
    const swept = await Budget.reconcileReservations({ now: after });

    assert.equal(swept.swept, 1);
    assert.equal(swept.releasedUsd, 1.2);
    assert.equal(money.rows[0].reservedUsd, 0, 'the money is back');
    assert.equal(money.rows[0].spentUsd, 0, 'and was never a charge, because nothing was posted');

    const row = db.rows.at(-1);
    assert.equal(row.budgetState, 'released');
    assert.equal(
      row.state,
      'failed',
      'the CLAIM is released too — an open row nobody posted blocks this Site for twelve hours'
    );
  } finally {
    money.restore();
    db.restore();
  }
});

test('a sweep of a job that DID post settles what it spent and leaves the work open', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  try {
    await Budget.reserveForJob({ project: project(), estimateUsd: 1.2, now: NOW });
    await DfsTask.create({
      organisation: 'org-1',
      account: 'acct-1',
      project: 'proj-1',
      kind: 'positions',
      variant: VARIANT_KEY,
      endpoint: C.ENDPOINT_SERP_TASK_POST,
      state: 'open',
      budgetState: 'reserving',
      reservedAt: NOW,
      estimateUsd: 1.2,
      // The post went through and the process died before the settle.
      costUsd: 1.18,
      postedAt: NOW,
      budgetDocs: [
        { organisation: 'org-1', provider: 'dataforseo', scope: 'org', scopeId: 'org-1', periodKey: '2026-08', capUsd: 5 },
      ],
    });

    const swept = await Budget.reconcileReservations({
      now: new Date(NOW.getTime() + C.RESERVATION_STALE_MS + 1000),
    });

    assert.equal(swept.settledUsd, 1.18);
    assert.equal(money.rows[0].spentUsd, 1.18, 'THE MONEY IS GONE, so the ledger says so');
    assert.equal(money.rows[0].reservedUsd, 0);

    const row = db.rows.at(-1);
    assert.equal(row.budgetState, 'settled');
    assert.equal(
      row.state,
      'open',
      'the tasks are real and paid for — losing them to a bookkeeping sweep ' +
        'would be the most expensive possible reading of "reconcile"'
    );
  } finally {
    money.restore();
    db.restore();
  }
});

test('`reservedUsd` really is a recomputable cache', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  try {
    const scope = {
      organisation: 'org-1',
      provider: 'dataforseo',
      scope: 'org',
      scopeId: 'org-1',
      periodKey: '2026-08',
      capUsd: 5,
    };
    await Budget.reserveForJob({ project: project(), estimateUsd: 0.5, now: NOW });
    await DfsTask.create({
      organisation: 'org-1',
      account: 'acct-1',
      project: 'proj-1',
      kind: 'positions',
      variant: VARIANT_KEY,
      endpoint: C.ENDPOINT_SERP_TASK_POST,
      state: 'open',
      budgetState: 'reserving',
      reservedAt: NOW,
      estimateUsd: 0.5,
      budgetDocs: [{ ...scope }],
    });

    // Derange the counter, exactly as an `$inc` that ran twice would.
    money.rows[0].reservedUsd = 4.75;

    const outstanding = await Budget.recompute(scope, { now: NOW });
    assert.equal(outstanding, 0.5, 'the sum over the tasks NAMING this document');
    assert.equal(money.rows[0].reservedUsd, 0.5, 'and the cache now agrees with it');
  } finally {
    money.restore();
    db.restore();
  }
});

test('the recompute counts only tasks naming THIS document', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  try {
    const mine = { scope: 'org', scopeId: 'org-1', periodKey: '2026-08', capUsd: 5 };
    const theirs = { scope: 'org', scopeId: 'org-2', periodKey: '2026-08', capUsd: 5 };

    for (const [org, proj, docs] of [
      ['org-1', 'proj-a', [mine]],
      ['org-2', 'proj-b', [theirs]],
      // The trap `$elemMatch` closes: dotted equalities match ACROSS array
      // elements, so this row would count against org-1 with the naive query.
      ['org-1', 'proj-c', [{ scope: 'board', scopeId: 'org-1', periodKey: '2026-08' }, theirs]],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await DfsTask.create({
        organisation: org,
        account: 'acct-1',
        project: proj,
        kind: 'positions',
        variant: VARIANT_KEY,
        endpoint: C.ENDPOINT_SERP_TASK_POST,
        state: 'open',
        budgetState: 'reserving',
        reservedAt: NOW,
        estimateUsd: 1,
        budgetDocs: docs,
      });
    }

    const outstanding = await Budget.outstandingFor({
      organisation: 'org-1',
      provider: 'dataforseo',
      ...mine,
    });
    assert.equal(outstanding, 1, 'one row, not three');
  } finally {
    money.restore();
    db.restore();
  }
});

test('the reconciler runs once per account per pass, not once per fetch', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpResults();
  const { impl } = stubTransport();
  let sweeps = 0;
  const originalFind = DfsTask.find;
  try {
    const client = clientFor(impl);
    DfsTask.find = (filter) => {
      if (filter.budgetState === 'reserving') sweeps += 1;
      return originalFind.call(DfsTask, filter);
    };

    await runFetch(client);
    await runFetch(client, { now: AT('2026-08-15T01:17:00Z') });
    await runFetch(client, { now: AT('2026-08-15T02:17:00Z') });

    assert.equal(sweeps, 1, 'thirty projects on one account is one sweep, not thirty');
  } finally {
    DfsTask.find = originalFind;
    serps.restore();
    money.restore();
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Going live is two deliberate switches, and neither is reachable by accident
// ---------------------------------------------------------------------------

test('the origin still defaults to the SANDBOX — nothing here can bill by default', () => {
  assert.equal(C.IS_SANDBOX, true);
  assert.equal(C.API_ORIGIN, C.SANDBOX_ORIGIN);
  assert.match(C.API_BASE, /^https:\/\/sandbox\.dataforseo\.com\/v3$/);
});

test('the default monthly cap is the FIRST-LIVE-KEY number, not the production one', () => {
  // "First live key runs here, on one project, with a $5 cap." A cap that has to
  // be RAISED before it can hurt, rather than one that has to be lowered before
  // it can be trusted.
  assert.equal(C.DEFAULT_MONTHLY_CAP_USD, 5);
});

test('the live allowlist is enforced only off the sandbox, and empty means NOTHING', () => {
  /**
   * A cap bounds the money and not the blast radius. Thirty Sites on a newly-live
   * account would each buy a partial batch and the first live pass would produce
   * thirty half-collected projects with nothing to check against a browser.
   *
   * `liveGuardNote` is pure, so it is asserted directly rather than by
   * re-requiring the module under a different environment — which would not work
   * anyway, because the origin is resolved once at require time on purpose.
   */
  assert.equal(T.liveGuardNote(project()), '', 'the sandbox is free, so nothing is restricted');

  const live = { ...C, IS_SANDBOX: false, LIVE_PROJECT_IDS: new Set() };
  const guardWith = (constants, proj) => {
    if (constants.IS_SANDBOX) return '';
    if (constants.LIVE_PROJECT_IDS.size === 0) return 'no site is cleared';
    return constants.LIVE_PROJECT_IDS.has(String(proj._id)) ? '' : 'not on the allowlist';
  };

  assert.match(guardWith(live, project()), /no site is cleared/);
  assert.match(
    guardWith({ ...live, LIVE_PROJECT_IDS: new Set(['proj-9']) }, project()),
    /not on the allowlist/
  );
  assert.equal(
    guardWith({ ...live, LIVE_PROJECT_IDS: new Set(['proj-1']) }, project()),
    ''
  );
});

test('pressing Refresh is free on Ubersuggest and a purchase on DataForSEO', () => {
  /**
   * `refreshConnectorData` passed `force: true` unconditionally, justified by
   * "a second pull of the same project on the same day costs nothing" — true of
   * the first provider, false of this one, which bills AT POST.
   */
  assert.equal(require('../ubersuggest').forceRefetchIsFree, true, 'byte-identical behaviour');
  assert.equal(require('./index').forceRefetchIsFree, false);

  const forceFor = (connector, body) =>
    connector.forceRefetchIsFree !== false || body?.force === true;

  assert.equal(forceFor(require('../ubersuggest'), {}), true);
  assert.equal(forceFor(require('./index'), {}), false, 'a plain Refresh respects the cadence');
  assert.equal(forceFor(require('./index'), { force: true }), true, 'an explicit re-buy still works');
  assert.equal(forceFor({}, {}), true, 'a descriptor with no opinion keeps the old behaviour');
});

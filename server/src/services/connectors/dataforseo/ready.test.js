const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./constants');
const R = require('./ready');
const { getKind } = require('./kinds');
const { variantKeyFor } = require('./sites');
const { fetchKind } = require('./fetchers');
const { readySetFor } = require('./collect');
const { createDfsClient } = require('./client');
const DfsTask = require('../../../models/DfsTask');
const ConnectorBudget = require('../../../models/ConnectorBudget');
const DfsSerpResult = require('../../../models/DfsSerpResult');

/**
 * `tasks_ready` — and the one ordering that makes a destructive read survivable.
 *
 * ---- What this file is defending against -----------------------------------
 *
 * `tasks_ready` hands back the ids of finished tasks EXACTLY ONCE. There is no
 * acknowledgement, no cursor, and no way to ask again: reading the list is what
 * empties it. So the sequence is not a preference —
 *
 *   read `tasks_ready` → PERSIST `readyAt` in one `bulkWrite`, including ids
 *   that match nothing → and only then `task_get`
 *
 * — and the failure it prevents is the expensive kind. An id read and lost to a
 * crash before the persist is gone from the announcement forever; the result
 * still exists for thirty days, but nothing knows to go and get it, so the
 * twelve-hour expiry sweep eventually RE-BUYS a batch that was already paid for
 * and already finished.
 *
 * The centrepiece below is therefore a crash test with a matched negative
 * control: the same three-pass scenario run once WITH the persist and once
 * WITHOUT it, asserting that the first collects everything and the second
 * collects nothing. A test that only proved the happy path would pass just as
 * well against code that persisted after `task_get`.
 *
 * Everything here runs against a stubbed `fetch` and an in-memory stand-in for
 * the collection. There is no live credential.
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

const session = {
  accountId: 'acct-1',
  getCredentials: () => ({ login: 'l', password: 'p' }),
};

const AT = (iso) => new Date(iso);

const postEnvelope = (tags) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost: 0.0006 * tags.length,
  tasks_count: tags.length,
  tasks_error: 0,
  tasks: tags.map((tag) => ({
    id: `task-${tag}`,
    status_code: 20100,
    status_message: 'Task Created.',
    cost: 0.0006,
    data: { api: 'serp', function: 'task_post', tag },
    result: null,
  })),
});

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
      data: {},
      result: null,
    },
  ],
});

const resultEnvelope = (keyword, { datetime = '2026-09-01 04:12:07 +00:00' } = {}) => ({
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
      data: { keyword },
      result: [
        {
          keyword,
          type: 'organic',
          location_code: 2840,
          language_code: 'en',
          datetime,
          item_types: ['organic'],
          se_results_count: 1_240_000,
          items: [
            {
              type: 'organic',
              rank_group: 1,
              rank_absolute: 1,
              domain: 'rival.com',
              url: 'https://rival.com/a',
            },
            {
              type: 'organic',
              rank_group: 4,
              rank_absolute: 4,
              domain: 'acme.com',
              url: 'https://acme.com/crm',
            },
          ],
        },
      ],
    },
  ],
});

/**
 * The `tasks_ready` envelope: one wrapper task carrying a `result[]` of ids.
 *
 * Modelled on the real shape rather than on what the parser happens to need —
 * the ids are nested two levels deep and each row carries a `tag` and an
 * `endpoint` beside them.
 */
const readyEnvelope = (ids) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost: 0,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [
    {
      id: 'ready-call',
      status_code: 20000,
      status_message: 'Ok.',
      cost: 0,
      result: ids.map((id) => ({
        id,
        se: 'google',
        se_type: 'organic',
        date_posted: '2026-09-01 04:00:00 +00:00',
        tag: null,
        endpoint: `/v3/serp/google/organic/task_get/advanced/${id}`,
      })),
    },
  ],
});

const errorsEnvelope = (rows) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost: 0,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [{ id: 'errors-call', status_code: 20000, cost: 0, result: rows }],
});

/**
 * A `fetch` stand-in that routes on the URL and counts every kind of call.
 *
 * `readyQueue` models the DESTRUCTIVE read: each `tasks_ready` shifts one entry
 * off the front, and an exhausted queue answers with an empty list forever —
 * which is exactly what the provider does once an id has been handed over.
 */
const stubTransport = ({ ready = false, readyQueue = [], errors = [] } = {}) => {
  const state = {
    posts: 0,
    gets: 0,
    readyCalls: 0,
    errorCalls: 0,
    ready,
    readyQueue: [...readyQueue],
    /** Every call, in order — the ordering assertions read this. */
    log: [],
  };

  const impl = async (url, init) => {
    let body;
    if (url.includes('/tasks_ready')) {
      state.readyCalls += 1;
      state.log.push('tasks_ready');
      body = readyEnvelope(state.readyQueue.shift() || []);
    } else if (url.includes('/serp/errors')) {
      state.errorCalls += 1;
      state.log.push('errors');
      body = errorsEnvelope(errors);
    } else if (url.includes('/task_post')) {
      state.posts += 1;
      state.log.push('task_post');
      const tags = JSON.parse(init.body).map((t) => t.tag);
      body = postEnvelope(tags);
    } else if (url.includes('/task_get/')) {
      state.gets += 1;
      const id = url.split('/').pop();
      state.log.push(`task_get:${id}`);
      const index = Number(id.split('.').pop());
      body = state.ready ? resultEnvelope(KEYWORDS[index] ?? KEYWORDS[0]) : queuedEnvelope();
    } else {
      throw new Error(`unexpected URL ${url}`);
    }

    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  return {
    state,
    /** A NEW client per pass — `runOnce` is scoped to one account for one pass. */
    newClient: () => createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] }),
  };
};

// ---------------------------------------------------------------------------
// The collection, in memory
// ---------------------------------------------------------------------------

/**
 * A stand-in for `DfsTask` that enforces the partial unique index AND
 * implements `bulkWrite` faithfully for the one operation shape this phase
 * issues — `$or` on the two id paths, `$set` through an array filter.
 *
 * Faithfully, because the crash test's whole claim is that the persisted
 * `readyAt` is what a later pass reads. A `bulkWrite` stub that recorded the
 * call without applying it would let that test pass against code that never
 * wrote anything.
 */
const stubTasks = () => {
  const rows = [];
  const bulkCalls = [];
  let seq = 0;

  const same = (a, b) => String(a) === String(b);
  const matches = (row, filter) =>
    Object.entries(filter).every(([key, want]) => {
      if (key === '$or') return want.some((f) => matches(row, f));
      const got = key.split('.').reduce((o, k) => (o == null ? o : o[k]), row);
      // `items.externalId` on an array of items is a multikey path.
      if (key.includes('.') && Array.isArray(row.items) && key.startsWith('items.')) {
        const leaf = key.slice('items.'.length);
        return row.items.some((it) => same(want, it?.[leaf]));
      }
      if (want && typeof want === 'object' && !Array.isArray(want)) {
        if ('$in' in want) return want.$in.some((v) => same(v, got));
        if ('$ne' in want) return !same(want.$ne, got);
        if ('$gte' in want) return got != null && new Date(got) >= new Date(want.$gte);
        if ('$lt' in want) return got != null && new Date(got) < new Date(want.$lt);
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
    bulkWrite: DfsTask.bulkWrite,
    countDocuments: DfsTask.countDocuments,
    distinct: DfsTask.distinct,
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
  DfsTask.distinct = async (field, filter) => [
    ...new Set(rows.filter((r) => matches(r, filter)).map((r) => String(r[field]))),
  ];
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

  DfsTask.bulkWrite = async (ops, opts) => {
    bulkCalls.push({ ops, opts });
    let matchedCount = 0;
    let modifiedCount = 0;

    for (const op of ops) {
      const { filter, update, arrayFilters = [] } = op.updateOne;
      const row = rows.find((r) => matches(r, filter));
      if (!row) continue;
      matchedCount += 1;

      for (const [path, value] of Object.entries(update.$set || {})) {
        const m = /^items\.\$\[(\w+)\]\.(\w+)$/.exec(path);
        if (!m) {
          row[path] = value;
          modifiedCount += 1;
          continue;
        }
        const [, identifier, leaf] = m;
        const conds = arrayFilters.find((f) =>
          Object.keys(f).every((k) => k.startsWith(`${identifier}.`))
        );
        for (const item of row.items || []) {
          const ok = Object.entries(conds || {}).every(([k, want]) => {
            const key = k.slice(identifier.length + 1);
            return want === null ? item[key] == null : same(want, item[key]);
          });
          if (!ok) continue;
          item[leaf] = value;
          modifiedCount += 1;
        }
      }
    }

    return { matchedCount, modifiedCount };
  };

  return {
    rows,
    bulkCalls,
    restore: () => Object.assign(DfsTask, originals),
  };
};

/** The money ledger, in memory. See `tasks.test.js` for why the guard is real. */
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
    apply(row, update);
    return { acknowledged: true, matchedCount: 1 };
  };

  ConnectorBudget.findOneAndUpdate = (filter, update) => {
    const row = find(filter);
    const add = filter.$expr?.$lte?.[0]?.$add || [];
    const estimate = add.find((x) => typeof x === 'number') || 0;
    const ok = row && (row.reservedUsd || 0) + (row.spentUsd || 0) + estimate <= row.capUsd;
    if (ok) apply(row, update);
    const value = ok ? { ...row } : null;
    return {
      lean: async () => value,
      then: (res, rej) => Promise.resolve(value).then(res, rej),
    };
  };

  ConnectorBudget.findOne = (filter) => {
    const value = find(filter);
    return {
      lean: async () => value,
      then: (res, rej) => Promise.resolve(value).then(res, rej),
    };
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
  return {
    writes,
    restore: () => {
      DfsSerpResult.updateOne = original;
    },
  };
};

const runFetch = (client, { now, force = false, kindKey = 'positions' } = {}) =>
  fetchKind(kindKey, {
    session,
    client,
    project: project(),
    variant: { key: VARIANT_KEY, ...VARIANT },
    now,
    force,
  });

/** The three ids a post of KEYWORDS produces, read off the row it wrote. */
const idsOf = (row) => row.items.map((it) => it.externalId);

// ---------------------------------------------------------------------------
// 1. Reading the announcement
// ---------------------------------------------------------------------------

test('readReadyRows digs the ids out of the nested envelope and de-duplicates', () => {
  const rows = R.readReadyRows(readyEnvelope(['a', 'b', 'a']));
  assert.deepEqual(
    rows.map((r) => r.id),
    ['a', 'b'],
    'an id announced twice in one read is still one id'
  );
  assert.equal(rows[0].endpoint, '/v3/serp/google/organic/task_get/advanced/a');
});

test('a shape we did not expect announces nothing rather than throwing', () => {
  // Costing a grace window is recoverable; taking the collection pass down with
  // a TypeError is not.
  assert.deepEqual(R.readReadyRows(null), []);
  assert.deepEqual(R.readReadyRows({ tasks: 'nope' }), []);
  assert.deepEqual(R.readReadyRows({ tasks: [{ result: [{ id: 42 }, {}] }] }), []);
});

test('the read is capped, because the list is drained rather than acknowledged', () => {
  const many = Array.from({ length: C.MAX_READY_IDS + 50 }, (_, i) => `id-${i}`);
  assert.equal(R.readReadyRows(readyEnvelope(many)).length, C.MAX_READY_IDS);
});

// ---------------------------------------------------------------------------
// 2. THE PERSIST — one bulkWrite, and it includes ids that match nothing
// ---------------------------------------------------------------------------

test('every announced id is written in ONE bulkWrite, including ids matching nothing', async () => {
  const db = stubTasks();
  try {
    db.rows.push({
      _id: 'dfs-1',
      state: 'open',
      items: [
        { externalId: 'known-1', readyAt: null, collected: false },
        { externalId: 'known-2', readyAt: null, collected: false },
      ],
      save: async () => {},
    });

    const now = AT('2026-09-01T05:00:00Z');
    const out = await R.persistReady({
      rows: [{ id: 'known-1' }, { id: 'ghost' }, { id: 'known-2' }],
      now,
    });

    assert.equal(db.bulkCalls.length, 1, 'ONE round trip — the list is perishable');
    assert.equal(
      db.bulkCalls[0].ops.length,
      3,
      'one operation per ANNOUNCED id, not per recognised id: filtering the ' +
        'list first needs a read, and a read that races drops announcements'
    );
    assert.equal(db.bulkCalls[0].opts.ordered, false, 'one bad id must not abandon the rest');

    assert.equal(out.announced, 3);
    assert.equal(out.matched, 2);
    assert.equal(out.unmatched, 1, 'the ghost is REPORTED, never filtered out beforehand');

    assert.equal(db.rows[0].items[0].readyAt, now);
    assert.equal(db.rows[0].items[1].readyAt, now);
  } finally {
    db.restore();
  }
});

test('a re-announced id keeps its FIRST timestamp', async () => {
  const db = stubTasks();
  try {
    const first = AT('2026-09-01T05:00:00Z');
    db.rows.push({
      _id: 'dfs-1',
      state: 'open',
      items: [{ externalId: 'a', readyAt: first, collected: false }],
      save: async () => {},
    });

    await R.persistReady({ rows: [{ id: 'a' }], now: AT('2026-09-01T09:00:00Z') });

    assert.equal(
      db.rows[0].items[0].readyAt,
      first,
      'results live thirty days and the same id can arrive twice; the earliest ' +
        'sighting is the true one'
    );
  } finally {
    db.restore();
  }
});

test('nothing announced is no round trip at all', async () => {
  const db = stubTasks();
  try {
    const out = await R.persistReady({ rows: [], now: new Date() });
    assert.equal(db.bulkCalls.length, 0);
    assert.deepEqual(out, { announced: 0, matched: 0, unmatched: 0 });
  } finally {
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. THE ORDERING — persist BEFORE task_get, and the crash that proves it
// ---------------------------------------------------------------------------

test('the announcement is made durable BEFORE a single task_get is issued', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const transport = stubTransport();
  try {
    await runFetch(transport.newClient(), { now: AT('2026-09-01T00:17:00Z') });
    const ids = idsOf(db.rows[0]);

    transport.state.ready = true;
    transport.state.readyQueue = [ids];

    // A fresh client is a fresh pass: `runOnce` is scoped to one account for one
    // pass, so the ready set is read again.
    const order = [];
    const realBulk = DfsTask.bulkWrite;
    DfsTask.bulkWrite = async (...args) => {
      order.push('persist');
      return realBulk(...args);
    };
    transport.state.log.length = 0;
    const readsBefore = transport.state.readyCalls;

    await runFetch(transport.newClient(), { now: AT('2026-09-01T06:17:00Z') });
    DfsTask.bulkWrite = realBulk;

    const calls = transport.state.log;
    const readAt = calls.indexOf('tasks_ready');
    const firstGet = calls.findIndex((c) => c.startsWith('task_get:'));

    assert.ok(readAt >= 0 && firstGet > readAt, 'the read comes first');
    assert.equal(order[0], 'persist', 'and the persist comes before any collection');
    assert.equal(
      transport.state.readyCalls - readsBefore,
      1,
      'ONE tasks_ready for the whole account, memoised on the client'
    );
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('A CRASH BETWEEN THE READ AND THE task_get LOSES NOTHING', async () => {
  /**
   * The whole phase, as one scenario.
   *
   * Pass 1 buys the batch. Pass 2 reads `tasks_ready`, persists what it
   * announced, and then dies — the ids are now GONE from the provider's list and
   * will never be announced again. Pass 3 must still collect all three, because
   * the announcement was written onto the rows before anything was collected.
   */
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const transport = stubTransport();
  try {
    await runFetch(transport.newClient(), { now: AT('2026-09-01T00:17:00Z') });
    const ids = idsOf(db.rows[0]);
    assert.equal(ids.length, KEYWORDS.length);

    transport.state.ready = true;
    // Announced ONCE. Every later read answers empty — the destructive read.
    transport.state.readyQueue = [ids];

    // ---- Pass 2: read, persist, then die -----------------------------------
    const dyingClient = transport.newClient();
    await readySetFor(dyingClient, { now: AT('2026-09-01T00:30:00Z') });
    assert.equal(transport.state.gets, 0, 'nothing was collected before the crash');
    assert.equal(
      db.rows[0].items.filter((it) => it.readyAt).length,
      3,
      'but every announced id was written down first'
    );

    // ---- Pass 3: the list is empty now. Collect anyway. ---------------------
    const done = await runFetch(transport.newClient(), { now: AT('2026-09-01T00:40:00Z') });

    assert.equal(
      transport.state.readyQueue.length,
      0,
      'the second read found nothing — the ids were consumed by the pass that died'
    );
    assert.equal(done.status, 'ok', 'and the collection still completed');
    assert.equal(transport.state.gets, KEYWORDS.length, 'all three were asked for');
    assert.equal(transport.state.posts, 1, 'AND NOTHING WAS RE-BOUGHT');
    assert.equal(db.rows[0].state, 'done');
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('the negative control: crashing BEFORE the persist strands the result', async () => {
  /**
   * The same scenario with the durable write removed, which is what a
   * `task_get`-then-persist ordering would amount to. If this collected anyway,
   * the test above would be proving nothing.
   */
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const transport = stubTransport();
  try {
    await runFetch(transport.newClient(), { now: AT('2026-09-01T00:17:00Z') });
    const ids = idsOf(db.rows[0]);
    transport.state.ready = true;
    transport.state.readyQueue = [ids];

    // Pass 2 reads the list and dies before writing anything down.
    const realBulk = DfsTask.bulkWrite;
    DfsTask.bulkWrite = async () => {
      throw new Error('the process died here');
    };
    await readySetFor(transport.newClient(), { now: AT('2026-09-01T00:30:00Z') });
    DfsTask.bulkWrite = realBulk;

    assert.equal(
      db.rows[0].items.filter((it) => it.readyAt).length,
      0,
      'nothing was written down'
    );

    // Pass 3, still inside the grace window: the announcement is gone and there
    // is nothing on the row to replace it.
    const stranded = await runFetch(transport.newClient(), {
      now: AT('2026-09-01T00:40:00Z'),
    });

    assert.equal(stranded.status, 'pending');
    assert.equal(
      transport.state.gets,
      0,
      'a paid-for, finished result nothing knows to collect — which is what the ' +
        'persist-first ordering exists to prevent'
    );
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. The gate itself
// ---------------------------------------------------------------------------

test('isPollable: the four ways an item earns a task_get', () => {
  const job = { postedAt: AT('2026-09-01T00:00:00Z') };
  const now = AT('2026-09-01T00:30:00Z');
  const item = { externalId: 'a', readyAt: null, collected: false };

  assert.equal(
    R.isPollable(item, { readySet: null, job, now }),
    true,
    'no announcement channel at all polls everything — phase 3, always correct'
  );
  assert.equal(R.isPollable(item, { readySet: new Set(), job, now }), false);
  assert.equal(R.isPollable(item, { readySet: new Set(['a']), job, now }), true);
  assert.equal(
    R.isPollable({ ...item, readyAt: now }, { readySet: new Set(), job, now }),
    true,
    'persisted in an earlier pass — the clause that survives the destructive read'
  );
  assert.equal(
    R.isPollable(item, { readySet: new Set(), job, now: AT('2026-09-01T02:30:00Z') }),
    true,
    'the grace window: results live 30 days and asking directly is free'
  );
  assert.equal(
    R.isPollable({ ...item, collected: true }, { readySet: null, job, now }),
    false
  );
  assert.equal(R.isPollable({ externalId: null }, { readySet: null, job, now }), false);
});

test('an unannounced job is not polled at all inside the grace window', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const transport = stubTransport();
  try {
    await runFetch(transport.newClient(), { now: AT('2026-09-01T00:17:00Z') });
    transport.state.ready = true;
    // `tasks_ready` announces nothing: the batch is genuinely still running.

    const polled = await runFetch(transport.newClient(), {
      now: AT('2026-09-01T01:17:00Z'),
    });

    assert.equal(polled.status, 'pending');
    assert.equal(
      transport.state.gets,
      0,
      'ONE free call for the account replaced three — this is the whole saving, ' +
        'and at 200 keywords x 6 ticks an hour it is 1,200 calls an hour'
    );
    assert.match(polled.note, /Waiting on DataForSEO for 3 of 3/);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('past the grace window an unannounced id is polled blind — the 30-day rescue', async () => {
  /**
   * `tasks_ready` is retained for THREE DAYS; results for THIRTY. So a lost
   * announcement must never become an uncollected result, because the expiry
   * sweep would then RE-BUY a batch that finished days ago. Asking directly
   * costs nothing.
   */
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const transport = stubTransport();
  try {
    await runFetch(transport.newClient(), { now: AT('2026-09-01T00:17:00Z') });
    transport.state.ready = true;

    const pastGrace = new Date(
      AT('2026-09-01T00:17:00Z').getTime() + R.READY_GRACE_MS + 60_000
    );
    const graced = await runFetch(transport.newClient(), { now: pastGrace });

    assert.equal(graced.status, 'ok', 'collected without ever having been announced');
    assert.equal(transport.state.gets, KEYWORDS.length);
    assert.equal(transport.state.posts, 1, 'and still nothing was re-bought');
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('a tasks_ready outage polls everything rather than collecting nothing', async () => {
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  try {
    const impl = async (url, init) => {
      if (url.includes('/tasks_ready')) throw new Error('socket hang up');
      if (url.includes('/serp/errors')) throw new Error('socket hang up');
      let body;
      if (url.includes('/task_post')) {
        body = postEnvelope(JSON.parse(init.body).map((t) => t.tag));
      } else {
        const id = url.split('/').pop();
        body = resultEnvelope(KEYWORDS[Number(id.split('.').pop())] ?? KEYWORDS[0]);
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const newClient = () => createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] });

    await runFetch(newClient(), { now: AT('2026-09-01T00:17:00Z') });
    const done = await runFetch(newClient(), { now: AT('2026-09-01T01:17:00Z') });

    assert.equal(
      done.status,
      'ok',
      'a broken announcement channel must cost CALLS, never DATA'
    );
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. The state the sweep must never write
// ---------------------------------------------------------------------------

test('an announced job stays `state: open` — `ready` would leave the anti-repost gate', async () => {
  /**
   * `DfsTask.state` has a `'ready'` value and nothing writes it, deliberately.
   * The partial unique index covers `state: 'open'` AND NOTHING ELSE, so a job
   * moved out of `open` on announcement is a job the next `fetch` cannot find —
   * and it would buy the whole batch again, for results sitting free on the
   * other end. Same reason `'reserving'` is unreachable.
   */
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const transport = stubTransport();
  try {
    await runFetch(transport.newClient(), { now: AT('2026-09-01T00:17:00Z') });
    transport.state.readyQueue = [idsOf(db.rows[0])];

    await readySetFor(transport.newClient(), { now: AT('2026-09-01T00:30:00Z') });

    assert.equal(db.rows[0].state, 'open', 'still inside the gate');
    assert.equal(db.rows[0].items.every((it) => it.readyAt), true);

    // And the proof that it matters: another tick buys nothing.
    transport.state.ready = false;
    await runFetch(transport.newClient(), { now: AT('2026-09-01T00:40:00Z') });
    assert.equal(transport.state.posts, 1);
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. The repair pair: {api}/errors
// ---------------------------------------------------------------------------

test('the errors feed makes a FAILED id pollable, which tasks_ready never can', async () => {
  /**
   * `tasks_ready` only ever announces success. Without the errors feed a task
   * that failed inside DataForSEO waits out the whole grace window before
   * anybody asks about it — two hours to learn something the provider already
   * knew.
   */
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  try {
    let ids = [];
    const state = { gets: 0, posts: 0 };
    const impl = async (url, init) => {
      let body;
      if (url.includes('/tasks_ready')) {
        body = readyEnvelope([]);
      } else if (url.includes('/serp/errors')) {
        body = errorsEnvelope(
          ids.map((id) => ({
            datetime: '2026-09-01 04:00:00 +00:00',
            function: 'task_get',
            error_code: 40501,
            error_message: 'Invalid Field.',
            http_url: `https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/${id}`,
          }))
        );
      } else if (url.includes('/task_post')) {
        state.posts += 1;
        const envelope = postEnvelope(JSON.parse(init.body).map((t) => t.tag));
        // DataForSEO's real ids are UUID-shaped, which is what makes reading one
        // back out of an `http_url` safe to do at all.
        envelope.tasks.forEach((t, i) => {
          t.id = `07281045-1535-0066-0000-2ea4e6d3d5d${i}`;
        });
        body = envelope;
      } else {
        state.gets += 1;
        body = {
          status_code: 20000,
          status_message: 'Ok.',
          cost: 0,
          tasks_count: 1,
          tasks_error: 1,
          tasks: [
            {
              id: 'x',
              status_code: 40501,
              status_message: 'Invalid Field.',
              cost: 0,
              data: {},
              result: null,
            },
          ],
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const newClient = () => createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] });

    await runFetch(newClient(), { now: AT('2026-09-01T00:17:00Z') });
    ids = idsOf(db.rows[0]);

    // Ten minutes later — nowhere near the two-hour grace window.
    const out = await runFetch(newClient(), { now: AT('2026-09-01T00:27:00Z') });

    assert.equal(state.gets, KEYWORDS.length, 'the failed ids were asked about immediately');
    assert.equal(out.status, 'pending');
    assert.equal(db.rows[0].state, 'failed', 'and the job was closed rather than left open');
    assert.equal(state.posts, 1, 'a failure is not a reason to buy again in the same tick');
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

test('an errors row that names its id directly is read without touching the URL', async () => {
  const db = stubTasks();
  try {
    db.rows.push({
      _id: 'dfs-1',
      state: 'open',
      items: [{ externalId: 'abc', readyAt: null, collected: false }],
      save: async () => {},
    });

    const client = {
      call: async () =>
        errorsEnvelope([{ id: 'abc', error_code: 40501, error_message: 'Invalid Field.' }]),
    };
    const out = await R.sweepErrors({ client, now: AT('2026-09-01T05:00:00Z') });

    assert.equal(out.applied, 1);
    assert.ok(db.rows[0].items[0].readyAt, 'stop waiting on an id the provider gave up on');
  } finally {
    db.restore();
  }
});

test('an unavailable errors endpoint is a shrug, not a failed pass', async () => {
  const db = stubTasks();
  try {
    const client = {
      call: async (endpoint) => {
        if (endpoint === C.ENDPOINT_SERP_ERRORS) throw new Error('404');
        return { tasks: [] };
      },
    };
    const out = await R.sweepErrors({ client, now: new Date() });
    assert.deepEqual(out.applied, 0);
    assert.equal(db.bulkCalls.length, 0);
  } finally {
    db.restore();
  }
});

test('the two account stops still travel out of the sweep', async () => {
  const stop = Object.assign(new Error('no funds'), { quotaExhausted: true });
  const client = {
    call: async () => {
      throw stop;
    },
  };
  await assert.rejects(() => R.sweepReady({ client, now: new Date() }), /no funds/);
  await assert.rejects(() => R.sweepErrors({ client, now: new Date() }), /no funds/);
});

// ---------------------------------------------------------------------------
// 7. The contract phase 3 asked phase 4 not to break
// ---------------------------------------------------------------------------

test('pollJob still returns SERP bodies trimmed to render depth', async () => {
  /**
   * Phase 3's explicit warning: whatever replaces the N `task_get` calls must
   * produce the same `bodies` shape, because a `bodies` array that stopped being
   * produced would stop SERP evidence being stored while the snapshot kept
   * writing — and nothing would look broken.
   */
  const db = stubTasks();
  const money = stubBudget();
  const serps = stubSerpResults();
  const transport = stubTransport();
  try {
    await runFetch(transport.newClient(), { now: AT('2026-09-01T00:17:00Z') });
    transport.state.ready = true;
    transport.state.readyQueue = [idsOf(db.rows[0])];

    await runFetch(transport.newClient(), { now: AT('2026-09-01T06:17:00Z') });

    assert.equal(serps.writes.length, KEYWORDS.length, 'one body per keyword, still stored');
    const [first] = serps.writes;
    assert.equal(first.set.renderDepth, C.SERP_RENDER_DEPTH);
    assert.equal(typeof first.set.returnedCount, 'number');
    assert.equal(typeof first.set.truncated, 'boolean');
    assert.equal(first.set.purchasedDepth, C.DEPTH_CENSUS);
    assert.equal(first.filter.variant, VARIANT_KEY, 'keyed on the MEASUREMENT, not the task');
    assert.equal(first.filter.periodKey, '2026-09-01');
  } finally {
    db.restore();
    money.restore();
    serps.restore();
  }
});

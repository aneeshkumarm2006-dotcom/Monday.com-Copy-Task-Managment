const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./constants');
const { variantKeyFor } = require('./sites');
const descriptor = require('./index');
const { pingback } = require('./pingback');
const {
  isFreeEndpoint,
  collectOnlyClient,
  collectAllReady,
} = require('./collect');
const { createDfsClient } = require('./client');
const DfsTask = require('../../../models/DfsTask');
const DfsSerpResult = require('../../../models/DfsSerpResult');
const ConnectorProject = require('../../../models/ConnectorProject');
const snapshotService = require('../snapshotService');
const collectRunner = require('../../connectorCollectRunner');
const { getConnector } = require('../index');

/**
 * The ten-minute collection pass, and the claim that it cannot spend money.
 *
 * ---- Why a second runner at all --------------------------------------------
 *
 * `connectorSyncRunner` is the one that BUYS: it resolves boards, cadences and
 * keyword lists, and purchases when a reading is stale. That is exactly why it
 * has to stay hourly against a provider that bills at POST — six ticks an hour
 * would be six chances an hour to conclude that something is stale.
 *
 * Collecting is a different act with a different risk profile. It starts from
 * rows already in `state: 'open'` and asks a free endpoint what has finished. So
 * the fast clock is attached to the half that has nothing to spend, and
 * DataForSEO's ~5-minute queue stops costing ~30 minutes of median latency.
 *
 * ---- What "cannot spend by construction" has to mean to be worth saying -----
 *
 * Not "there is no call to `postJob` in that file" — that is a fact about today
 * and an invitation for tomorrow. The tests below pin the structural version:
 * THE TRANSPORT ITSELF REFUSES every endpoint that is not free, so even code
 * that deliberately tried to post through this pass would be refused before a
 * request left the process. The allowlist is the mechanism, and a new billable
 * endpoint in phase 6, 7 or 8 is refused by DEFAULT rather than admitted
 * silently.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEYWORDS = ['best crm for agencies', 'agency crm pricing'];

const VARIANT = { locationCode: 2840, languageCode: 'en', device: 'desktop' };
const VARIANT_KEY = variantKeyFor(VARIANT);

const AT = (iso) => new Date(iso);

const session = {
  accountId: 'acct-1',
  organisation: 'org-1',
  getCredentials: () => ({ login: 'l', password: 'p' }),
};

const resultEnvelope = (keyword) => ({
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
          datetime: '2026-09-01 04:12:07 +00:00',
          item_types: ['organic'],
          se_results_count: 900_000,
          items: [
            {
              type: 'organic',
              rank_group: 3,
              rank_absolute: 3,
              domain: 'acme.com',
              url: 'https://acme.com/crm',
            },
          ],
        },
      ],
    },
  ],
});

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
      cost: 0,
      result: ids.map((id) => ({ id, se: 'google', se_type: 'organic' })),
    },
  ],
});

/** The transport for the collection pass. A `task_post` here is a test failure. */
const stubTransport = ({ readyIds = [] } = {}) => {
  const state = { gets: 0, readyCalls: 0, errorCalls: 0, posts: 0 };

  const impl = async (url) => {
    let body;
    if (url.includes('/tasks_ready')) {
      state.readyCalls += 1;
      body = readyEnvelope(readyIds);
    } else if (url.includes('/serp/errors')) {
      state.errorCalls += 1;
      body = { status_code: 20000, cost: 0, tasks_count: 1, tasks_error: 0, tasks: [] };
    } else if (url.includes('/task_get/')) {
      state.gets += 1;
      const id = url.split('/').pop();
      body = resultEnvelope(id === 'ext-1' ? KEYWORDS[0] : KEYWORDS[1]);
    } else if (url.includes('/task_post')) {
      state.posts += 1;
      throw new Error('the collection pass must never reach task_post');
    } else {
      throw new Error(`unexpected URL ${url}`);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  return {
    state,
    factory: () => createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] }),
  };
};

/** One open job, already bought, waiting on two results. */
const openJob = (overrides = {}) => {
  const row = {
    _id: 'dfs-1',
    organisation: 'org-1',
    account: 'acct-1',
    project: 'proj-1',
    provider: 'dataforseo',
    kind: 'positions',
    variant: VARIANT_KEY,
    state: 'open',
    attempt: 1,
    postedAt: AT('2026-09-01T04:00:00Z'),
    expiresAt: AT('2026-09-01T16:00:00Z'),
    periodKey: null,
    note: '',
    keywords: [...KEYWORDS],
    items: [
      { keyword: KEYWORDS[0], externalId: 'ext-1', readyAt: null, collected: false },
      { keyword: KEYWORDS[1], externalId: 'ext-2', readyAt: null, collected: false },
    ],
    ...overrides,
  };
  row.save = async () => row;
  return row;
};

/**
 * `collect.js` memoises `writeSnapshot` on first call — it is required lazily to
 * break a registry cycle — so the spy cannot be a fresh function per test. The
 * INDIRECTION below is installed once, at module load, and never replaced; each
 * test swaps only what it delegates to.
 */
let writeSpy = null;
const realWriteSnapshot = snapshotService.writeSnapshot;
snapshotService.writeSnapshot = (args) =>
  (writeSpy || realWriteSnapshot)(args);

/**
 * Stand-ins for everything `collectAllReady` reads, plus a spy on the one thing
 * it writes.
 */
const stubWorld = ({ jobs = [] } = {}) => {
  const rows = [...jobs];
  const snapshots = [];
  const same = (a, b) => String(a) === String(b);

  const originals = {
    distinct: DfsTask.distinct,
    find: DfsTask.find,
    bulkWrite: DfsTask.bulkWrite,
    projectFind: ConnectorProject.find,
    serpUpdate: DfsSerpResult.updateOne,
  };

  DfsTask.distinct = async (field, filter) => [
    ...new Set(
      rows
        .filter((r) => r.state === filter.state && r.provider === filter.provider)
        .map((r) => String(r[field]))
    ),
  ];

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

  DfsTask.find = (filter) =>
    thenable(
      rows.filter(
        (r) =>
          (!filter.account || same(r.account, filter.account)) &&
          (!filter.state || r.state === filter.state) &&
          (!filter.budgetState || r.budgetState === filter.budgetState)
      )
    );

  DfsTask.bulkWrite = async (ops) => {
    let matchedCount = 0;
    for (const op of ops) {
      const id = op.updateOne.filter.$or?.[0]?.['items.externalId'];
      const row = rows.find((r) => (r.items || []).some((it) => it.externalId === id));
      if (!row) continue;
      matchedCount += 1;
      for (const item of row.items) {
        if (item.externalId === id && item.readyAt == null) {
          item.readyAt = Object.values(op.updateOne.update.$set)[0];
        }
      }
    }
    return { matchedCount, modifiedCount: matchedCount };
  };

  ConnectorProject.find = () =>
    thenable([
      {
        _id: 'proj-1',
        externalId: 'proj-1',
        domain: 'acme.com',
        organisation: 'org-1',
        account: 'acct-1',
        board: 'board-1',
      },
    ]);

  DfsSerpResult.updateOne = async () => ({ acknowledged: true });

  writeSpy = async (args) => {
    snapshots.push(args);
    return { written: true, periodKey: '2026-09-01', pending: false };
  };

  return {
    rows,
    snapshots,
    restore: () => {
      Object.assign(DfsTask, {
        distinct: originals.distinct,
        find: originals.find,
        bulkWrite: originals.bulkWrite,
      });
      ConnectorProject.find = originals.projectFind;
      DfsSerpResult.updateOne = originals.serpUpdate;
      writeSpy = null;
    },
  };
};


// ---------------------------------------------------------------------------
// 1. The allowlist — the thing that makes "cannot spend" structural
// ---------------------------------------------------------------------------

test('the free-endpoint allowlist admits exactly the calls that cost nothing', () => {
  assert.equal(isFreeEndpoint(C.ENDPOINT_SERP_TASKS_READY), true);
  assert.equal(isFreeEndpoint(C.ENDPOINT_SERP_ERRORS), true);
  assert.equal(isFreeEndpoint(C.ENDPOINT_USER_DATA), true);
  assert.equal(isFreeEndpoint(`${C.ENDPOINT_SERP_TASK_GET}/abc-123`), true);

  assert.equal(
    isFreeEndpoint(C.ENDPOINT_SERP_TASK_POST),
    false,
    'the ONLY billable endpoint in this directory, and it does not survive'
  );
  // An ALLOWLIST, so anything phases 6-8 add is refused until it is admitted on
  // purpose. A denylist would admit it silently.
  assert.equal(isFreeEndpoint('dataforseo_labs/google/keyword_ideas/live'), false);
  assert.equal(isFreeEndpoint('backlinks/summary/live'), false);
  assert.equal(isFreeEndpoint('on_page/task_post'), false);
  assert.equal(isFreeEndpoint(''), false);
});

test('the collection client refuses a purchase at the transport, not at a flag', async () => {
  const calls = [];
  const inner = {
    call: async (endpoint) => {
      calls.push(endpoint);
      return { tasks: [] };
    },
    send: async (endpoint) => {
      calls.push(`send:${endpoint}`);
      return { tasks: [] };
    },
    runOnce: (key, fn) => fn(),
  };

  const client = collectOnlyClient(inner);

  await assert.rejects(
    () => client.call(C.ENDPOINT_SERP_TASK_POST, [{ keyword: 'x' }]),
    /may not call/
  );
  await assert.rejects(() => client.send(C.ENDPOINT_SERP_TASK_POST, {}), /may not call/);
  assert.deepEqual(calls, [], 'nothing reached the wire');

  await client.call(C.ENDPOINT_SERP_TASKS_READY, null, { method: 'GET' });
  assert.deepEqual(calls, [C.ENDPOINT_SERP_TASKS_READY], 'the free reads go through');
});

test('the collection client also reports posting as suppressed — the fourth barrier', () => {
  const client = collectOnlyClient({ call: async () => ({}), runOnce: (k, f) => f() });
  assert.equal(
    client.postingSuppressed(),
    true,
    'a fetch wired through this client returns the pending sentinel before it ' +
      'can even claim a row'
  );
  assert.match(client.postingSuppressedNote(), /already bought/);
});

// ---------------------------------------------------------------------------
// 2. The pass itself
// ---------------------------------------------------------------------------

test('a collection pass turns an announced job into a snapshot and buys nothing', async () => {
  const world = stubWorld({ jobs: [openJob()] });
  const transport = stubTransport({ readyIds: ['ext-1', 'ext-2'] });
  try {
    const report = await collectAllReady({
      now: AT('2026-09-01T04:20:00Z'),
      sessionFactory: async () => session,
      clientFactory: transport.factory,
    });

    assert.equal(report.accounts, 1);
    assert.equal(report.jobs, 1);
    assert.equal(report.collected, 1);
    assert.equal(report.written, 1);
    assert.equal(transport.state.posts, 0, 'NOTHING WAS BOUGHT');
    assert.equal(transport.state.readyCalls, 1, 'one free call for the whole account');
    assert.equal(transport.state.gets, 2, 'and one free collection per announced id');

    assert.equal(world.rows[0].state, 'done');
    assert.equal(world.rows[0].periodKey, '2026-09-01');

    const [snap] = world.snapshots;
    assert.equal(snap.provider, 'dataforseo');
    assert.equal(snap.kind.key, 'positions');
    assert.equal(
      snap.variant.key,
      VARIANT_KEY,
      'the variant key comes off the JOB, not re-derived — a second spelling is ' +
        'a second row'
    );
    assert.equal(snap.result.status, 'ok');
    assert.equal(snap.result.raw, null);
    assert.equal(snap.actorId, null, 'nobody was watching');
    assert.deepEqual(report.projectIds, ['proj-1']);
  } finally {
    world.restore();
  }
});

test('a job nobody announced costs one call for the account and no collection', async () => {
  const world = stubWorld({ jobs: [openJob()] });
  const transport = stubTransport({ readyIds: [] });
  try {
    const report = await collectAllReady({
      now: AT('2026-09-01T04:20:00Z'),
      sessionFactory: async () => session,
      clientFactory: transport.factory,
    });

    assert.equal(report.pending, 1);
    assert.equal(report.collected, 0);
    assert.equal(report.written, 0);
    assert.equal(transport.state.gets, 0, 'the whole point: six ticks an hour stay cheap');
    assert.equal(world.rows[0].state, 'open', 'and the job is still inside the gate');
    assert.deepEqual(world.snapshots, []);
  } finally {
    world.restore();
  }
});

test('nothing open anywhere is nothing at all — not even a session', async () => {
  const world = stubWorld({ jobs: [] });
  let sessions = 0;
  try {
    const report = await collectAllReady({
      now: AT('2026-09-01T04:20:00Z'),
      sessionFactory: async () => {
        sessions += 1;
        return session;
      },
      clientFactory: () => {
        throw new Error('no client should be built');
      },
    });
    assert.equal(sessions, 0, 'the pass is proportional to work outstanding');
    assert.equal(report.accounts, 0);
  } finally {
    world.restore();
  }
});

test('one account with a dead credential does not strand the next account', async () => {
  const world = stubWorld({
    jobs: [openJob(), openJob({ _id: 'dfs-2', account: 'acct-2' })],
  });
  const transport = stubTransport({ readyIds: ['ext-1', 'ext-2'] });
  try {
    const report = await collectAllReady({
      now: AT('2026-09-01T04:20:00Z'),
      sessionFactory: async (id) => {
        if (String(id) === 'acct-1') throw new Error('needs reauth');
        return session;
      },
      clientFactory: transport.factory,
    });

    assert.equal(report.accounts, 1, 'the second account still ran');
    assert.equal(report.errors.length, 1);
    assert.ok(report.collected >= 1, 'and its purchased results were collected');
  } finally {
    world.restore();
  }
});

test('collectJob is reached with the rows loaded AFTER the sweep, never before', async () => {
  /**
   * The sweep writes `items[].readyAt`. Rows loaded before it would carry a
   * stale copy and the poll gate would read every one of them as unannounced —
   * a pass that reads the destructive list, throws the announcement away, and
   * then collects nothing.
   */
  const world = stubWorld({ jobs: [openJob()] });
  const transport = stubTransport({ readyIds: ['ext-1', 'ext-2'] });

  const order = [];
  const realFind = DfsTask.find;
  const realBulk = DfsTask.bulkWrite;
  DfsTask.find = (...args) => {
    order.push('find');
    return realFind(...args);
  };
  DfsTask.bulkWrite = async (...args) => {
    order.push('persist');
    return realBulk(...args);
  };

  try {
    await collectAllReady({
      now: AT('2026-09-01T04:20:00Z'),
      sessionFactory: async () => session,
      clientFactory: transport.factory,
    });
    assert.equal(order[0], 'persist', 'the announcement is written before jobs are read');
    assert.ok(order.includes('find'));
  } finally {
    DfsTask.find = realFind;
    DfsTask.bulkWrite = realBulk;
    world.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. The runner
// ---------------------------------------------------------------------------

test('the collection cron runs every ten minutes and the buying cron does not', () => {
  const { CRON_EXPRESSION } = collectRunner;
  assert.equal(CRON_EXPRESSION, '*/10 * * * *');
  assert.equal(
    require('../../connectorSyncRunner').CRON_EXPRESSION,
    '17 * * * *',
    'the pass that can BUY stays hourly — that separation is the whole design'
  );
});

test('only a provider that declares `collectReady` is collected', async () => {
  assert.equal(typeof descriptor.collectReady, 'function');
  assert.equal(
    typeof getConnector('ubersuggest').collectReady,
    'undefined',
    'a provider that answers in the same HTTP call has nothing to collect later, ' +
      'and is never called — Ubersuggest is untouched by construction'
  );

  const real = descriptor.collectReady;
  const seen = [];
  descriptor.collectReady = async (args) => {
    seen.push(args);
    return {
      accounts: 0,
      jobs: 0,
      collected: 0,
      written: 0,
      failed: 0,
      pending: 0,
      projectIds: [],
      errors: [],
    };
  };
  try {
    const now = AT('2026-09-01T04:20:00Z');
    const reports = await collectRunner.tick({ now });
    assert.equal(seen.length, 1, 'called once, for the one provider that declares it');
    assert.equal(seen[0].now, now);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].provider, 'dataforseo');
  } finally {
    descriptor.collectReady = real;
  }
});

test('a provider whose collector throws does not take the tick down', async () => {
  const real = descriptor.collectReady;
  descriptor.collectReady = async () => {
    throw new Error('mongo went away');
  };
  try {
    const reports = await collectRunner.tick({ now: new Date() });
    assert.deepEqual(reports, [], 'logged and skipped — this runs six times an hour');
  } finally {
    descriptor.collectReady = real;
  }
});

// ---------------------------------------------------------------------------
// 4. Webhooks: no — the reserved path
// ---------------------------------------------------------------------------

test('the pingback path is reserved ABOVE the auth middleware, beside the OAuth callback', () => {
  const router = require('../../../routes/connectors');
  const layers = router.stack;

  const authAt = layers.findIndex((l) => !l.route && l.name === 'authMiddleware');
  const pingAt = layers.findIndex(
    (l) => l.route && l.route.path === '/connectors/dataforseo/pingback/:token'
  );
  const callbackAt = layers.findIndex(
    (l) => l.route && l.route.path === '/connectors/callback'
  );

  assert.ok(pingAt >= 0, 'the path exists, so adding a receiver later is additive');
  assert.ok(
    pingAt < authAt,
    'a third party has no session and no Authorization header; below the ' +
      'middleware it would be a 401 nobody outside could debug'
  );
  assert.ok(callbackAt < authAt, 'and the OAuth callback it sits beside is still above it');
  assert.deepEqual(Object.keys(layers[pingAt].route.methods), ['post']);
});

test('the reserved pingback is inert, and says so without echoing the token', () => {
  const sent = {};
  const res = {
    status(code) {
      sent.code = code;
      return this;
    },
    json(body) {
      sent.body = body;
      return this;
    },
  };
  const req = {
    params: { token: 'a-secret-looking-token' },
    body: { tasks: [{ id: 'whatever' }] },
    rawBody: Buffer.from('{}'),
  };

  pingback(req, res);

  assert.equal(sent.code, 501, 'it exists and is not implemented — the honest answer');
  assert.ok(sent.body.error);
  assert.equal(
    JSON.stringify(sent.body).includes('a-secret-looking-token'),
    false,
    'never echo a path segment an attacker controls'
  );
});

test('nothing about the pingback needs raw-body handling', () => {
  /**
   * The reason the path shape is worth reserving at all: a token in the PATH
   * rather than an HMAC over the BODY means `app.js`'s body parsing stays
   * untouched. A signature scheme would need `stashRawBody` to grow a third
   * special case, and the provider offers no signature to verify anyway.
   */
  const source = require('node:fs').readFileSync(require.resolve('./pingback'), 'utf8');
  assert.equal(source.includes('rawBody'), false);
  assert.equal(source.includes('createHmac'), false);
  // And the constant that names the repair we deliberately never call.
  assert.equal(C.ENDPOINT_WEBHOOK_RESEND, 'appendix/webhook_resend');
  const dir = require('node:path').join(__dirname);
  const files = require('node:fs')
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  const mentions = files.filter((f) =>
    require('node:fs')
      .readFileSync(require('node:path').join(dir, f), 'utf8')
      .includes('ENDPOINT_WEBHOOK_RESEND')
  );
  assert.deepEqual(
    mentions,
    ['constants.js', 'pingback.js'],
    'one declaration and one explanation — and nothing else in the provider even ' +
      'names it'
  );

  const invoked = files.filter((f) =>
    /call\(\s*C?\.?ENDPOINT_WEBHOOK_RESEND/.test(
      require('node:fs').readFileSync(require('node:path').join(dir, f), 'utf8')
    )
  );
  assert.deepEqual(
    invoked,
    [],
    'declared so the decision is in the code, and CALLED BY NOTHING — there is ' +
      'no pingback registered for it to repair'
  );
});

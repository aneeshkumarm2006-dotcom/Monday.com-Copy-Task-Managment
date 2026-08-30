const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./constants');
const {
  createDfsClient,
  describeAccount,
  verifyCredentials,
  AUTH_HEADER,
} = require('./client');

/**
 * The transport, against recorded envelope shapes.
 *
 * ---- Everything here is a FIXTURE, and that is a requirement ---------------
 *
 * There is no live key, and there will not be one before phase 3. Nothing in
 * this directory may need a real account to be exercised, so every response
 * below is a hand-built envelope in the shape DataForSEO documents. The sandbox
 * proves plumbing, not parsing; these prove parsing.
 *
 * ---- What is actually under test -------------------------------------------
 *
 * That HTTP 200 IS NOT SUCCESS. There are three places a failure can hide —
 * the HTTP status, the envelope `status_code`, and every `tasks[].status_code` —
 * and reading only the first two is the number-one silent data-loss bug against
 * this API. A `20000` envelope carrying `tasks_error: 3` is three keywords that
 * did not collect inside a request that "worked".
 *
 * And that `20100` is neither. It means "Task Created", arrives with
 * `result: null`, and has ALREADY BEEN CHARGED FOR — so reading it as an error
 * reposts and pays twice, and reading it as a success stores an empty snapshot.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREDENTIALS = { login: 'ops@example.com', password: 'sup3r-secret' };

const envelope = (overrides = {}) => ({
  version: '0.1.20260801',
  status_code: 20000,
  status_message: 'Ok.',
  time: '0.0912 sec.',
  cost: 0,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [],
  ...overrides,
});

const task = (overrides = {}) => ({
  id: '09011200-1535-0066-0000-c1b2f4d59c31',
  status_code: 20000,
  status_message: 'Ok.',
  time: '0.0512 sec.',
  cost: 0,
  result_count: 1,
  path: ['v3', 'appendix', 'user_data'],
  data: { api: 'appendix', function: 'user_data' },
  result: null,
  ...overrides,
});

const USER_DATA_RESULT = [
  {
    login: 'ops@example.com',
    timezone: 'Europe/Kiev',
    rates: { limits: { minute: 2000 } },
    money: { total: 100, balance: 55.5, limits: { minute: 20, day: 100 } },
    price: { serp: { google: { organic: { task_post: 0.0006 } } } },
  },
];

/**
 * A fetch stub that records every call and answers from a queue.
 *
 * @param {Array<{status?: number, body?: any, text?: string, throws?: Error}>} answers
 */
const stubFetch = (answers) => {
  const calls = [];
  const queue = [...answers];

  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next.throws) throw next.throws;
    const text = next.text !== undefined ? next.text : JSON.stringify(next.body);
    return {
      status: next.status ?? 200,
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      text: async () => text,
      headers: { get: () => 'application/json' },
    };
  };

  return { impl, calls };
};

/** A session with only what the transport is allowed to know about. */
const fakeSession = () => {
  const quotas = [];
  return {
    getCredentials: () => ({ ...CREDENTIALS }),
    recordQuota: async (q) => {
      quotas.push(q);
    },
    quotas,
  };
};

const client = (answers, opts = {}) => {
  const { impl, calls } = stubFetch(answers);
  const session = opts.session || fakeSession();
  return {
    calls,
    session,
    client: createDfsClient(session, {
      fetchImpl: impl,
      // The tests assert that a retry HAPPENS. They have no interest in
      // waiting out the real backoff.
      retryDelaysMs: [0, 0],
      ...opts,
    }),
  };
};

// ---------------------------------------------------------------------------
// 1. HTTP Basic, and the sandbox
// ---------------------------------------------------------------------------

test('every call is HTTP Basic against the sandbox, with no live host in sight', async () => {
  const h = client([{ body: envelope({ tasks: [task({ result: USER_DATA_RESULT })] }) }]);
  await h.client.accountData();

  const [{ url, init }] = h.calls;
  assert.ok(url.startsWith('https://sandbox.dataforseo.com/v3/'));
  assert.equal(url, `${C.API_BASE}/${C.ENDPOINT_USER_DATA}`);
  assert.equal(init.headers.Authorization, AUTH_HEADER('ops@example.com', 'sup3r-secret'));
  assert.equal(
    init.headers.Authorization,
    `Basic ${Buffer.from('ops@example.com:sup3r-secret').toString('base64')}`
  );
  // The account read is a GET and carries no body.
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined);
});

test('a POST sends an ARRAY, because a bare object is a 40501 on arrival', async () => {
  const h = client([{ body: envelope({ tasks: [task()] }) }]);
  await h.client.call('serp/google/organic/task_post', [{ keyword: 'best crm' }]);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), [{ keyword: 'best crm' }]);
  assert.equal(h.calls[0].init.method, 'POST');
});

test('an incomplete stored credential is needs_reauth, not a TypeError in a cron job', async () => {
  const h = client([{ body: envelope() }], {
    session: { getCredentials: () => ({ login: 'ops@example.com' }) },
  });
  await assert.rejects(() => h.client.call('anything'), (err) => err.needsReauth === true);
  // And nothing was sent.
  assert.equal(h.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 2. Layer one — the HTTP status
// ---------------------------------------------------------------------------

test('HTTP 401 is needs_reauth, because Basic auth has nothing to refresh', async () => {
  const h = client([{ status: 401, body: { status_code: 40100 } }]);
  await assert.rejects(
    () => h.client.call('anything'),
    (err) => err.needsReauth === true && err.retryable === false
  );
  // One attempt. Retrying a wrong password is how a runner hammers a dead
  // account forever.
  assert.equal(h.calls.length, 1);
});

test('HTTP 429 and 5xx are retried; the retry is what succeeds', async () => {
  const h = client([
    { status: 429, body: {} },
    { body: envelope({ tasks: [task({ result: USER_DATA_RESULT })] }) },
  ]);
  const out = await h.client.accountData();
  assert.equal(out.identity.externalEmail, 'ops@example.com');
  assert.equal(h.calls.length, 2);

  const g = client([
    { status: 503, body: {} },
    { body: envelope({ tasks: [task({ result: USER_DATA_RESULT })] }) },
  ]);
  await g.client.accountData();
  assert.equal(g.calls.length, 2);
});

test('a transport failure is retryable; a 400 is an answer and is not retried', async () => {
  const boom = client([{ throws: new Error('socket hang up') }]);
  await assert.rejects(
    () => boom.client.call('anything', null, { retries: 1 }),
    (err) => err.retryable === true
  );
  assert.equal(boom.calls.length, 2);

  const refused = client([{ status: 400, body: {} }]);
  await assert.rejects(
    () => refused.client.call('anything'),
    (err) => err.retryable === false && /HTTP 400/.test(err.message)
  );
  assert.equal(refused.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 3. Layer two — the envelope
// ---------------------------------------------------------------------------

test('an HTTP 200 with a failing envelope is a failure', async () => {
  const cases = [
    [40100, 'needsReauth'],
    [40200, 'quotaExhausted'],
    [40203, 'quotaExhausted'],
    [40210, 'quotaExhausted'],
    [40202, 'retryable'],
    [40209, 'retryable'],
    [40204, 'forbidden'],
    [40404, 'noData'],
    [50000, 'retryable'],
  ];

  for (const [code, flag] of cases) {
    const h = client([
      { body: envelope({ status_code: code, status_message: `code ${code}` }) },
    ]);
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => h.client.call('anything', null, { retries: 0 }),
      (err) => {
        assert.equal(err[flag], true, `${code} should have set ${flag}`);
        assert.equal(err.statusCode, code);
        return true;
      }
    );
  }
});

test('an unrecognised 4xxxx is fatal and an unrecognised 5xxxx is retryable', async () => {
  // The asymmetry is the point: an unknown 4xxxx is OURS and will be the same
  // answer next time; an unknown 5xxxx is THEIRS and is transient. Against a
  // provider that bills at POST, retrying the first costs money to learn
  // nothing.
  const fatal = client([{ body: envelope({ status_code: 41999 }) }]);
  await assert.rejects(
    () => fatal.client.call('anything'),
    (err) => err.retryable === false
  );
  assert.equal(fatal.calls.length, 1);

  const transient = client([{ body: envelope({ status_code: 59999 }) }]);
  await assert.rejects(
    () => transient.client.call('anything', null, { retries: 1 }),
    (err) => err.retryable === true
  );
  assert.equal(transient.calls.length, 2);
});

test('a body that is not JSON is a failure, not a null result', async () => {
  const h = client([{ text: '<html>gateway</html>' }]);
  await assert.rejects(() => h.client.call('anything'), /could not read/);
});

// ---------------------------------------------------------------------------
// 4. Layer three — every task
// ---------------------------------------------------------------------------

test('a 20000 envelope carrying tasks_error does NOT hide the failed tasks', async () => {
  // The silent-data-loss bug this whole file exists to prevent: three keywords
  // that did not collect, inside a request that "succeeded".
  const h = client([
    {
      body: envelope({
        tasks_count: 3,
        tasks_error: 2,
        cost: 0.0006,
        tasks: [
          task({ id: 'a', cost: 0.0006, result: [{ keyword: 'best crm' }] }),
          task({ id: 'b', status_code: 40501, status_message: 'Invalid Field.', result: null }),
          task({ id: 'c', status_code: 40404, status_message: 'Not Found.', result: null }),
        ],
      }),
    },
  ]);

  const out = await h.client.call('serp/google/organic/task_post', []);
  assert.equal(out.tasksError, 2);
  assert.equal(out.tasks.length, 3);

  assert.equal(out.tasks[0].ok, true);
  assert.equal(out.tasks[0].error, null);
  assert.equal(out.tasks[0].cost, 0.0006);

  // Per-task failures ride BACK rather than throwing. One snapshot is up to 200
  // tasks; collapsing that into one thrown error would discard 199 results to
  // report one.
  assert.equal(out.tasks[1].ok, false);
  assert.equal(out.tasks[1].error.statusCode, 40501);
  assert.equal(out.tasks[1].error.retryable, false);

  assert.equal(out.tasks[2].error.noData, true);
});

test('20100 is Task Created: not ok, not an error, and already paid for', async () => {
  const h = client([
    {
      body: envelope({
        cost: 0.0006,
        tasks: [
          task({
            status_code: 20100,
            status_message: 'Task Created.',
            cost: 0.0006,
            result: null,
            data: { tag: 'site-1|positions|2840|en|desktop' },
          }),
        ],
      }),
    },
  ]);

  const out = await h.client.call('serp/google/organic/task_post', []);
  const [created] = out.tasks;

  assert.equal(created.created, true);
  assert.equal(created.ok, false);
  assert.equal(created.error, null);
  assert.equal(created.result, null);
  // The money is already spent, and the id and the echoed tag are the only
  // handles on it. Phase 2 writes a `DfsTask` row from exactly these.
  assert.equal(created.cost, 0.0006);
  assert.equal(created.id, '09011200-1535-0066-0000-c1b2f4d59c31');
  assert.equal(created.data.tag, 'site-1|positions|2840|en|desktop');
});

test('an ACCOUNT-level code inside a task still stops the account', async () => {
  // DataForSEO reports a spent balance at whichever level noticed it, and a
  // 20000 envelope whose every task says 40200 is a real shape. Reading that as
  // 200 individual failures would let the runner walk the next 29 projects
  // collecting the same answer.
  const h = client([
    {
      body: envelope({
        tasks_error: 2,
        tasks: [
          task({ status_code: 40501, result: null }),
          task({ status_code: 40200, status_message: 'Payment Required.', result: null }),
        ],
      }),
    },
  ]);

  await assert.rejects(
    () => h.client.call('serp/google/organic/task_post', []),
    (err) => err.quotaExhausted === true && err.statusCode === 40200
  );
});

// ---------------------------------------------------------------------------
// 5. The account read — once per account per pass
// ---------------------------------------------------------------------------

test('accountData is memoised, so lastSeenQuota is written ONCE per pass', async () => {
  const h = client([{ body: envelope({ tasks: [task({ result: USER_DATA_RESULT })] }) }]);

  const [a, b, c] = await Promise.all([
    h.client.accountData(),
    h.client.accountData(),
    h.client.accountData(),
  ]);
  await h.client.accountData();

  // One HTTP call for four asks. `user_data` is capped at 6 requests a minute,
  // so a per-fetch read is the first thing that breaks on a 30-project account.
  assert.equal(h.calls.length, 1);
  assert.equal(h.session.quotas.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);

  assert.equal(h.session.quotas[0].balanceUsd, 55.5);
  assert.equal(h.session.quotas[0].price.serp.google.organic.task_post, 0.0006);
});

test('warmAccountData starts the read from createClient itself', async () => {
  const h = client([{ body: envelope({ tasks: [task({ result: USER_DATA_RESULT })] }) }], {
    warmAccountData: true,
  });
  // The client is built by `syncAccount` exactly once per account per pass, and
  // that is the moment the free read is worth making.
  await h.client.accountData();
  assert.equal(h.calls.length, 1);
});

test('a failure to RECORD the quota never fails the call that produced it', async () => {
  // Display and estimation only, never a gate. A write failure on a display
  // value must not take down a pass.
  const session = {
    getCredentials: () => ({ ...CREDENTIALS }),
    recordQuota: async () => {
      throw new Error('mongo is having a moment');
    },
  };
  const h = client([{ body: envelope({ tasks: [task({ result: USER_DATA_RESULT })] }) }], {
    session,
  });
  const out = await h.client.accountData();
  assert.equal(out.identity.externalEmail, 'ops@example.com');
});

test('describeAccount answers in the shape recordIdentity already takes', async () => {
  const { impl } = stubFetch([
    { body: envelope({ tasks: [task({ result: USER_DATA_RESULT })] }) },
  ]);
  const identity = await describeAccount(fakeSession(), {
    fetchImpl: impl,
    retryDelaysMs: [0],
  });
  assert.deepEqual(Object.keys(identity).sort(), [
    'externalAccountId',
    'externalEmail',
    'tier',
  ]);
  assert.equal(identity.externalEmail, 'ops@example.com');
  assert.equal(identity.tier, 'pay-as-you-go');
});

// ---------------------------------------------------------------------------
// 6. Verifying a credential BEFORE it is stored
// ---------------------------------------------------------------------------

test('verifyCredentials works with no account row and no session behind it', async () => {
  // The whole point: the check happens before anything is created, so an account
  // that failed verification never exists rather than existing and being
  // repaired.
  const { impl, calls } = stubFetch([
    { body: envelope({ tasks: [task({ result: USER_DATA_RESULT })] }) },
  ]);
  const identity = await verifyCredentials(CREDENTIALS, {
    fetchImpl: impl,
    retryDelaysMs: [0],
  });
  assert.equal(identity.externalEmail, 'ops@example.com');
  assert.equal(
    calls[0].init.headers.Authorization,
    AUTH_HEADER(CREDENTIALS.login, CREDENTIALS.password)
  );
});

test('a wrong password is a REFUSAL; an outage is not', async () => {
  // These have to be distinguishable, or a DataForSEO outage stops an admin from
  // configuring anything.
  const wrong = stubFetch([{ status: 401, body: {} }]);
  await assert.rejects(
    () => verifyCredentials(CREDENTIALS, { fetchImpl: wrong.impl, retryDelaysMs: [0] }),
    (err) => err.needsReauth === true && err.retryable === false
  );

  const down = stubFetch([{ status: 502, body: {} }]);
  await assert.rejects(
    () => verifyCredentials(CREDENTIALS, { fetchImpl: down.impl, retryDelaysMs: [0, 0] }),
    (err) => err.needsReauth !== true && err.retryable === true
  );
});

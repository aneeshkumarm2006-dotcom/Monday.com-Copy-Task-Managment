const C = require('./constants');
const { DfsError, errorForStatus, isAccountStop, classifyStatusCode } = require('./errors');
const { normaliseUserData } = require('./normalise');
const { withDbBackedSlot } = require('./pool');

/**
 * The DataForSEO transport: HTTP Basic, JSON in, JSON out.
 *
 * ---- Why this is hand-rolled -----------------------------------------------
 *
 * `dataforseo-client` is ~9 MB installed, has no auth, no timeouts, no retries
 * and a history of generated-type defects. The official MCP server is a
 * documentation browser plus a generic HTTP proxy with no retries, no backoff,
 * no timeouts, and a middleware that truncates a batch request body to its FIRST
 * ELEMENT on any `/live/` path — fatal to a batch-of-100 design. Both are
 * developer-time tools. What is left of the protocol is "POST a JSON array, read
 * a JSON envelope", which is this file, and `ubersuggest/mcpClient.js` next door
 * reached the same conclusion about its own SDK.
 *
 * ---- The rule this file exists to enforce: HTTP 200 IS NOT SUCCESS ----------
 *
 * DataForSEO answers almost everything with HTTP 200. There are THREE places a
 * failure can hide and all three have to be read:
 *
 *   1. THE HTTP STATUS. 401 on a wrong password, 429 when we are too fast.
 *   2. THE ENVELOPE `status_code`. 20000 is Ok; anything else applies to the
 *      whole request and no task inside it ran.
 *   3. EVERY `tasks[].status_code`. A `20000` envelope can carry
 *      `tasks_error: 3` — three keywords that failed inside a request that
 *      "succeeded". Reading only the envelope is the number-one silent
 *      data-loss bug against this API.
 *
 * And the fourth reading, which is not a failure at all: `20100` means "Task
 * Created", arrives with `result: null`, and HAS ALREADY BEEN CHARGED FOR.
 * Treating it as an error reposts and pays twice; treating it as a success
 * stores an empty snapshot. It is neither, so `call()` hands it back flagged as
 * `created` and phase 2 writes a `DfsTask` row against it.
 *
 * ---- What throws and what does not -----------------------------------------
 *
 * `call()` throws for anything that applies to the ACCOUNT — a bad credential, a
 * spent balance, a daily cost ceiling — because those are the two stop
 * conditions `snapshotService` already knows how to end a run on, and grinding
 * through 30 more projects to collect the same 40200 helps nobody.
 *
 * It does NOT throw for a per-task failure. One snapshot is up to 200 tasks,
 * each with its own id, its own cost and its own way of failing, and collapsing
 * that into one thrown error would discard 199 results to report one. Per-task
 * errors ride back on the task entries, classified, for the caller to record.
 */

const AUTH_HEADER = (login, password) =>
  `Basic ${Buffer.from(`${login}:${password}`, 'utf8').toString('base64')}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The credential, read off a session, checked before it is used.
 *
 * A missing half is `needsReauth` rather than a TypeError halfway through a
 * fetch: the row exists and cannot authenticate, which is precisely what the
 * Reconnect button is for.
 *
 * @param {Object} credentials
 * @returns {{login: string, password: string}}
 */
const readCredentials = (credentials) => {
  const login = typeof credentials?.login === 'string' ? credentials.login.trim() : '';
  const password =
    typeof credentials?.password === 'string' ? credentials.password.trim() : '';
  if (!login || !password) {
    throw new DfsError(
      'The stored DataForSEO credentials are incomplete. They need to be entered again.',
      { needsReauth: true }
    );
  }
  return { login, password };
};

/**
 * One task entry, normalised, with its own verdict already worked out.
 *
 * @param {Object} task - one element of `tasks[]`
 * @param {string} endpoint
 */
const readTask = (task, endpoint) => {
  const statusCode = Number(task?.status_code);
  const kind = classifyStatusCode(statusCode);

  return {
    id: typeof task?.id === 'string' ? task.id : null,
    statusCode: Number.isFinite(statusCode) ? statusCode : null,
    statusMessage: String(task?.status_message || ''),
    /** Per-task cost in USD. Free per-task attribution; phase 3 settles on it. */
    cost: typeof task?.cost === 'number' ? task.cost : 0,
    path: Array.isArray(task?.path) ? task.path : [],
    /** The request echo, including the `tag` we sent. Phase 2 joins on it. */
    data: task?.data ?? null,
    result: task?.result ?? null,
    /** 20000 — there is a result and it is real. */
    ok: kind === 'ok',
    /** 20100 — accepted, charged, and answering later. NOT an error. */
    created: kind === 'task_created',
    error:
      kind === 'ok' || kind === 'task_created'
        ? null
        : errorForStatus(statusCode, task?.status_message, { endpoint }),
  };
};

/**
 * Bind a client to one authenticated account.
 *
 * @param {Object} session - services/connectors/session.js, or any object with
 *   `getCredentials()`. `recordIdentity` and `recordQuota` are OPTIONAL, which
 *   is what lets `verifyCredentials` run this against a credential that has no
 *   account row yet.
 * @param {Object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] - injected by the tests
 * @param {number[]} [opts.retryDelaysMs] - injected by the tests, which assert a
 *   retry HAPPENS and have no interest in waiting out the backoff
 * @param {boolean} [opts.warmAccountData] - start the free account read
 *   immediately. True from `createClient`, which the runner calls once per
 *   account per pass; false where a caller only wants the transport.
 * @returns {Object} the client
 */
const createDfsClient = (
  session,
  {
    fetchImpl = fetch,
    retryDelaysMs = C.RETRY_DELAYS_MS,
    warmAccountData = false,
    now = () => new Date(),
  } = {}
) => {
  /**
   * Memoised for the LIFETIME OF THE CLIENT, which is one account for one pass.
   *
   * That is the whole mechanism behind "write `lastSeenQuota` once per account
   * per pass": `syncAccount` builds exactly one client per account, every fetch
   * in that pass shares it, and the second caller gets the first caller's
   * promise rather than a second free-but-rate-limited call. `user_data` is
   * capped at 6 requests a minute, so a per-fetch read would be the first thing
   * to break on a 30-project account.
   */
  let accountDataPromise = null;

  /**
   * PER-RUN STATE. One client is one account for one pass, which makes this
   * object exactly account-scoped and pass-scoped without anything having to say
   * so.
   *
   * ---- Why the budget stop lives here and not in a thrown error --------------
   *
   * `err.quotaExhausted` already exists and stops the account for the run:
   * `syncAccount` catches it and `break`s out of the project loop. That is right
   * for DataForSEO's own refusals — a `40200` or a `40203` means nothing on this
   * account can work — and EXACTLY WRONG for our own cap, because the `break`
   * abandons every remaining project including their FREE `task_get` polls for
   * results we have already paid for. Hitting the cap on project 3 of 30 would
   * strand twenty-seven projects' worth of purchased data, and those results
   * expire in thirty days.
   *
   * So our cap sets a flag instead. Free collection continues for the whole
   * pass, in every project; nothing new is bought anywhere. The fetcher checks it
   * before every would-be purchase and returns phase 0's `pending` sentinel with
   * a note a person can act on.
   */
  const runState = {
    postingSuppressed: false,
    postingSuppressedNote: '',
    /** Memoised once-per-pass work, e.g. the reservation reconciler. */
    once: new Map(),
  };

  /** One HTTP round trip, with the three layers of status checked. */
  const sendOnce = async (endpoint, { method = 'POST', payload = null } = {}) => {
    const { login, password } = readCredentials(session.getCredentials());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), C.HTTP_TIMEOUT_MS);

    let res;
    let body;
    try {
      res = await fetchImpl(`${C.API_BASE}/${endpoint}`, {
        method,
        headers: {
          Authorization: AUTH_HEADER(login, password),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        // DataForSEO takes an ARRAY of task objects on every POST, even for one
        // task. A bare object is a 40501 on arrival.
        body: payload === null ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
      body = await res.text();
    } catch (err) {
      // A timeout, a DNS failure, a dropped socket. Transient by nature, so the
      // caller may retry — unlike a refusal, which is an answer.
      throw new DfsError(`Could not reach DataForSEO: ${err.message}`, {
        retryable: true,
        endpoint,
      });
    } finally {
      clearTimeout(timer);
    }

    // ---- Layer 1: the HTTP status ------------------------------------------
    if (res.status === 401 || res.status === 403) {
      // Basic auth has no refresh grant. A 401 means the password is WRONG, not
      // stale, so this goes straight to `needs_reauth` through the catch that is
      // already in `session.refresh()` — no second branch anywhere.
      throw new DfsError(
        'DataForSEO rejected the stored credentials. They need to be entered again.',
        { needsReauth: true, httpStatus: res.status, endpoint }
      );
    }
    if (res.status === 429) {
      throw new DfsError('DataForSEO is rate-limiting us.', {
        retryable: true,
        httpStatus: res.status,
        endpoint,
      });
    }
    if (res.status >= 500) {
      throw new DfsError(`DataForSEO is unavailable (HTTP ${res.status}).`, {
        retryable: true,
        httpStatus: res.status,
        endpoint,
      });
    }
    if (!res.ok) {
      throw new DfsError(`DataForSEO refused the request (HTTP ${res.status}).`, {
        httpStatus: res.status,
        endpoint,
      });
    }

    let envelope;
    try {
      envelope = JSON.parse(body);
    } catch {
      throw new DfsError('DataForSEO returned a response we could not read.', {
        httpStatus: res.status,
        endpoint,
      });
    }

    // ---- Layer 2: the envelope ---------------------------------------------
    const envelopeCode = Number(envelope?.status_code);
    if (envelopeCode !== C.STATUS_OK) {
      throw errorForStatus(envelopeCode, envelope?.status_message, {
        endpoint,
        httpStatus: res.status,
      });
    }

    // ---- Layer 3: every task -----------------------------------------------
    const tasks = (Array.isArray(envelope.tasks) ? envelope.tasks : []).map((t) =>
      readTask(t, endpoint)
    );

    /**
     * An account-level code inside a task entry still stops the account.
     *
     * DataForSEO reports a spent balance at whichever level noticed it, and it
     * is perfectly capable of returning a 20000 envelope whose every task says
     * 40200. Reading that as "200 individual failures" would let the runner walk
     * the next twenty-nine projects collecting the same answer.
     */
    const stop = tasks.find((t) => t.statusCode !== null && isAccountStop(t.statusCode));
    if (stop) throw stop.error;

    return {
      statusCode: envelopeCode,
      statusMessage: String(envelope.status_message || ''),
      /** Envelope cost in USD — the sum of the tasks, and what was charged. */
      cost: typeof envelope.cost === 'number' ? envelope.cost : 0,
      time: typeof envelope.time === 'string' ? envelope.time : '',
      tasksCount: Number(envelope.tasks_count) || tasks.length,
      /** Their own count of failed tasks. Cross-checked against ours in tests. */
      tasksError: Number(envelope.tasks_error) || 0,
      tasks,
      raw: envelope,
    };
  };

  /**
   * The same round trip, holding a slot in the SHARED simultaneity pool.
   *
   * ---- Why the pool is at the transport and not at the call site -------------
   *
   * DataForSEO caps SIMULTANEOUS requests at thirty for its database-backed
   * families, and Labs, Backlinks and OnPage share that one ceiling. Phase 6 is
   * the first of the three to arrive, and the tempting shape is a limiter inside
   * `labs.js` — which is the shape that breaks in phase 7, silently, because a
   * Backlinks limiter of twenty-five beside a Labs limiter of twenty-five is
   * fifty in flight against a ceiling of thirty.
   *
   * Put here, phases 7 and 8 inherit the bound by making a call at all. They add
   * one prefix to `pool.DB_BACKED_PREFIXES` and there is nothing else to
   * remember. See `./pool.js` for what this pool is NOT — it is throughput
   * control, and `40209` → retryable is the correctness backstop.
   *
   * Wrapped around ONE round trip rather than around `call`, so the slot is
   * released while a retry is sleeping out its backoff. A slot held through a
   * two-second sleep is a slot nobody can use for a call that would have
   * succeeded. Queued SERP endpoints are not DB-backed and pass through
   * untouched — their free `task_get` polls must never queue behind a purchase.
   */
  const send = (endpoint, opts = {}) =>
    withDbBackedSlot(endpoint, () => sendOnce(endpoint, opts));

  /**
   * One call, retried only for the failures that are worth retrying.
   *
   * Never retries a `fatal` or a `forbidden`: those are answers, and against a
   * provider that bills at POST an unnecessary retry is not merely wasted time.
   */
  const call = async (endpoint, payload = null, { method = 'POST', retries } = {}) => {
    const max = typeof retries === 'number' ? retries : retryDelaysMs.length;
    let attempt = 0;

    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await send(endpoint, { method, payload });
      } catch (err) {
        if (err.retryable && attempt < max) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]);
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
  };

  /**
   * The free account read: identity, live balance, and the account-specific
   * price book.
   *
   * Memoised, and the memo is the contract — see `accountDataPromise`. The write
   * of `lastSeenQuota` happens HERE rather than in the caller so that every path
   * that reaches the account (a sync pass, a project refresh, a credential
   * check) leaves the same record behind without each remembering to.
   *
   * @returns {Promise<{identity: Object, quota: Object, raw: any}>}
   */
  const accountData = () => {
    if (accountDataPromise) return accountDataPromise;

    accountDataPromise = (async () => {
      const answer = await call(C.ENDPOINT_USER_DATA, null, { method: 'GET' });

      const task = answer.tasks.find((t) => t.ok) || answer.tasks[0] || null;
      if (task?.error) throw task.error;

      const row = Array.isArray(task?.result) ? task.result[0] : task?.result;
      const { identity, quota } = normaliseUserData(row, { now: now() });

      // Display and estimation only, never a gate — the documented status of
      // this field, kept. A session that has no account behind it (a credential
      // being checked before it is stored) simply has nowhere to write it.
      if (typeof session.recordQuota === 'function') {
        try {
          await session.recordQuota(quota);
        } catch (err) {
          // Failing to record a display value must never fail the call that
          // produced it.
          console.warn(
            `[connectors/dataforseo] could not record account quota: ${err.message}`
          );
        }
      }

      return { identity, quota, raw: row ?? null };
    })();

    // A rejected memo is still the answer for this pass — one bad credential
    // should not produce 200 identical failed calls — but it must not become an
    // unhandled rejection while nothing is awaiting it yet.
    accountDataPromise.catch(() => {});

    return accountDataPromise;
  };

  return {
    call,
    accountData,
    /** Exposed for the tests and for phase 2, which needs the raw transport. */
    send,

    /**
     * Stop buying for the rest of this pass. NOT an error, and not a stop.
     *
     * Called when OUR OWN monthly cap refuses a reservation. Deliberately not
     * `throw quotaExhausted`: see `runState` above, and
     * `services/connectors/dataforseo/budget.js` for the twenty-seven stranded
     * projects that reading would cost.
     *
     * Idempotent, and the FIRST note wins — the sentence a person reads should
     * name the scope that actually refused, and every later caller in the same
     * pass is a project that never even asked.
     */
    suppressPosting: (note) => {
      if (runState.postingSuppressed) return;
      runState.postingSuppressed = true;
      runState.postingSuppressedNote = String(note || '');
    },

    /** True once the cap has refused anything in this pass. */
    postingSuppressed: () => runState.postingSuppressed,

    /** What to tell a person about it. */
    postingSuppressedNote: () => runState.postingSuppressedNote,

    /**
     * Run something exactly once per account per pass.
     *
     * The same mechanism `accountData` uses for `user_data`, generalised, and it
     * exists for the reservation reconciler: a sweep that ran once per fetch
     * would be thirty identical queries per pass on a thirty-project account, and
     * one that ran on a cron of its own would be a scheduler entry to forget
     * about. The client's lifetime is already the unit we want.
     *
     * The PROMISE is memoised rather than the result, so concurrent callers share
     * one run, and a rejection is caught here so a failed sweep cannot become an
     * unhandled rejection in a cron nobody is watching.
     */
    runOnce: (key, fn) => {
      if (runState.once.has(key)) return runState.once.get(key);
      const promise = Promise.resolve()
        .then(fn)
        .catch((err) => {
          console.warn(`[connectors/dataforseo] ${key} failed: ${err.message}`);
          return null;
        });
      runState.once.set(key, promise);
      return promise;
    },
  };
};

/**
 * Who DataForSEO says this account is.
 *
 * The descriptor's `describeAccount`. `projectMirror` calls it on every refresh
 * and hands the result to `session.recordIdentity`, which is how
 * `ConnectorAccount.externalEmail` and `tier` stop being null. The quota half is
 * written by `accountData` on the way through.
 *
 * @param {Object} session
 * @param {Object} [opts]
 * @returns {Promise<{externalEmail: string|null, externalAccountId: null, tier: string}>}
 */
const describeAccount = async (session, opts = {}) => {
  const client = opts.client || createDfsClient(session, opts);
  const { identity } = await client.accountData();
  return identity;
};

/**
 * Is this credential real, before it is stored?
 *
 * ---- Why this exists and why it runs at the moment of connecting -----------
 *
 * There is no consent screen to fail. A mistyped API password is sealed, stored,
 * and reported as success, and the first sign of trouble is a weekly cron job
 * silently marking the account `needs_reauth` days later — with a "Reconnect"
 * button and no explanation of what was wrong. The provider hands us a free,
 * 6-per-minute endpoint that answers exactly this question, so the person who
 * just typed the password is the person who finds out.
 *
 * Deliberately SESSIONLESS. It takes the credential directly rather than an
 * account id, so the check happens BEFORE a row exists — an account that failed
 * verification is never created, rather than created and then repaired.
 *
 * Nothing from the answer is persisted here. The login is the account email, and
 * echoing it back in the response to the request that just supplied it would
 * break the one rule the credential endpoint is under: a credential goes in and
 * never comes back out. Identity is recorded later, by the project refresh,
 * through the field built for it.
 *
 * @param {{login: string, password: string}} credentials
 * @param {Object} [opts]
 * @returns {Promise<{externalEmail: string|null, tier: string}>}
 * @throws {DfsError} `.needsReauth` when the credential is refused;
 *   `.retryable` when we could not find out
 */
const verifyCredentials = async (credentials, opts = {}) => {
  const client = createDfsClient(
    { getCredentials: () => ({ ...credentials }) },
    opts
  );
  const { identity } = await client.accountData();
  return identity;
};

module.exports = {
  createDfsClient,
  describeAccount,
  verifyCredentials,
  readCredentials,
  readTask,
  AUTH_HEADER,
};

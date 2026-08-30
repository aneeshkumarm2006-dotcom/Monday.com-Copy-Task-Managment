const C = require('./constants');

/**
 * The DataForSEO error-code switch.
 *
 * ---- Why this is a switch and the first connector had to string-match -------
 *
 * Ubersuggest reports an exhausted quota as an HTTP 200 carrying `isError: true`
 * and a sentence, with no code, no header and no `Retry-After` — so
 * `ubersuggest/constants.js` has to match regular expressions against prose, and
 * the header on that file records what it cost when a bare `403` was matched as
 * exhaustion: every reading the integration was supposed to collect, week after
 * week, because `quotaExhausted` is an ACCOUNT-LEVEL STOP.
 *
 * DataForSEO gives a numeric code at both levels of its envelope. So the same
 * distinction is a lookup here, and the classifications are the ones the generic
 * engine already branches on:
 *
 *   needsReauth     — session.js drives the account to `needs_reauth`
 *   quotaExhausted  — syncAccount stops THIS account for THIS run
 *   retryable       — the transport backs off and tries again
 *   forbidden       — one call is refused; the account keeps working
 *   fatal           — an answer, not a fault to hammer
 *
 * ---- The one classification that is not an error ---------------------------
 *
 * `20100` is "Task Created": HTTP 200, inside a `20000` envelope, with
 * `result: null`, and already charged for. It is not a success (there is no
 * data) and not a failure (nothing went wrong). It gets its own classification
 * so phase 2 can write a `DfsTask` row against it instead of guessing from the
 * shape of a null.
 *
 * ---- And the one that is neither a fault nor a result -----------------------
 *
 * `40404` exists only on the sandbox and means "no prepared data for that
 * request shape". The credential worked, the envelope parsed, the request was
 * understood — only the canned answer is missing. Classifying it as `fatal`
 * would make every sandbox run read as a broken integration, which is exactly
 * the phase we are in.
 */

/**
 * One error type, carrying the flags the generic engine branches on.
 *
 * Deliberately the same flag names `McpCallError` uses. `snapshotService` and
 * `session` read `.quotaExhausted` and `.needsReauth` off whatever a provider
 * throws, and a second spelling would mean a second branch in generic code.
 */
class DfsError extends Error {
  constructor(message, {
    statusCode = null,
    httpStatus = null,
    quotaExhausted = false,
    needsReauth = false,
    retryable = false,
    forbidden = false,
    noData = false,
    notReady = false,
    endpoint = null,
  } = {}) {
    super(message);
    this.name = 'DfsError';
    /** DataForSEO's own code, envelope- or task-level. Null for a transport failure. */
    this.statusCode = statusCode;
    this.httpStatus = httpStatus;
    this.quotaExhausted = quotaExhausted;
    this.needsReauth = needsReauth;
    this.retryable = retryable;
    this.forbidden = forbidden;
    /** Sandbox has no canned answer for this shape. Plumbing proved, data absent. */
    this.noData = noData;
    /**
     * The task exists, is paid for, and is still running.
     *
     * The flag the free polling loop turns on. Anything reading this as a
     * failure closes an open job, and a closed job is one the anti-repost gate
     * no longer protects — so the next hourly tick buys the whole batch again.
     */
    this.notReady = notReady;
    this.endpoint = endpoint;
  }
}

/**
 * @typedef {'ok'|'task_created'|'in_queue'|'auth'|'funds'|'rate_limit'|'forbidden'
 *   |'expired'|'no_sandbox_data'|'invalid'|'retryable'|'fatal'} DfsClass
 */

/** The explicit table. Anything absent falls through to the range rules below. */
const BY_CODE = new Map([
  [C.STATUS_OK, 'ok'],
  [C.STATUS_TASK_CREATED, 'task_created'],
  [C.STATUS_AUTH, 'auth'],
  [C.STATUS_NO_FUNDS, 'funds'],
  [C.STATUS_DAILY_COST_LIMIT, 'funds'],
  [C.STATUS_MONEY_LIMIT, 'funds'],
  [C.STATUS_RATE_LIMIT, 'rate_limit'],
  [C.STATUS_TOO_MANY_SIMULTANEOUS, 'rate_limit'],
  [C.STATUS_FORBIDDEN_ENDPOINT, 'forbidden'],
  [C.STATUS_RESULTS_EXPIRED, 'expired'],
  [C.STATUS_TASK_HANDED, 'in_queue'],
  [C.STATUS_TASK_IN_QUEUE, 'in_queue'],
  [C.STATUS_NO_SANDBOX_DATA, 'no_sandbox_data'],
  [C.STATUS_INVALID_FIELD, 'invalid'],
  [C.STATUS_INTERNAL, 'retryable'],
  [C.STATUS_TIMEOUT, 'retryable'],
  [C.STATUS_TARGET_SLOW, 'retryable'],
]);

/**
 * What one DataForSEO status code means.
 *
 * The fall-through is the interesting half and it is asymmetric on purpose:
 * an unrecognised 5xxxx is THEIRS and transient, so it is retryable; an
 * unrecognised 4xxxx is OURS and will be the same answer next time, so it is
 * fatal. Retrying an unknown 4xxxx would spend money to be told the same thing.
 *
 * @param {number} code
 * @returns {DfsClass}
 */
const classifyStatusCode = (code) => {
  const n = Number(code);
  if (!Number.isFinite(n)) return 'fatal';
  const known = BY_CODE.get(n);
  if (known) return known;
  if (n >= 50000) return 'retryable';
  return 'fatal';
};

/** True for the codes that mean "stop this whole account", not "this call failed". */
const isAccountStop = (code) => {
  const kind = classifyStatusCode(code);
  return kind === 'auth' || kind === 'funds';
};

/**
 * True for the codes that mean "paid for, still running".
 *
 * Kept beside `isAccountStop` because it is the same shape of question and
 * because the poller must never have to remember two numbers. `20100` is
 * included: a `task_get` that answers "Task Created" is answering about a task
 * that has not produced anything yet, which is the same fact by another name.
 */
const isNotReady = (code) => {
  const kind = classifyStatusCode(code);
  return kind === 'in_queue' || kind === 'task_created';
};

/**
 * Turn a code and its message into the error the engine understands.
 *
 * The provider's own `status_message` is carried through because it is the only
 * account of what went wrong that exists — and it is provider-controlled text,
 * so every caller renders it as text and never as markup.
 *
 * @param {number} code
 * @param {string} message - DataForSEO's `status_message`
 * @param {Object} [ctx]
 * @param {string} [ctx.endpoint]
 * @param {number} [ctx.httpStatus]
 * @returns {DfsError}
 */
const errorForStatus = (code, message, { endpoint = null, httpStatus = null } = {}) => {
  const kind = classifyStatusCode(code);
  const said = String(message || '').slice(0, 300);
  const base = { statusCode: Number(code), endpoint, httpStatus };

  switch (kind) {
    case 'auth':
      return new DfsError(
        'DataForSEO rejected the stored credentials. They need to be entered again.',
        { ...base, needsReauth: true }
      );
    case 'funds':
      return new DfsError(
        `DataForSEO will not accept more work on this account right now: ${said}`,
        { ...base, quotaExhausted: true }
      );
    case 'rate_limit':
      return new DfsError(`DataForSEO is rate-limiting us: ${said}`, {
        ...base,
        retryable: true,
      });
    case 'forbidden':
      return new DfsError(
        `DataForSEO will not run ${endpoint || 'that endpoint'} for this account: ${said}`,
        { ...base, forbidden: true }
      );
    case 'in_queue':
      return new DfsError(
        `DataForSEO has not finished that task yet: ${said}`,
        { ...base, notReady: true }
      );
    case 'no_sandbox_data':
      return new DfsError(
        `The DataForSEO sandbox has no prepared answer for this request (${said}). ` +
          'The call itself worked.',
        { ...base, noData: true }
      );
    case 'retryable':
      return new DfsError(`DataForSEO had a problem: ${said}`, { ...base, retryable: true });
    case 'expired':
      return new DfsError(
        `DataForSEO no longer holds that result: ${said}`,
        base
      );
    default:
      return new DfsError(`DataForSEO refused the request: ${said}`, base);
  }
};

module.exports = {
  DfsError,
  classifyStatusCode,
  isAccountStop,
  isNotReady,
  errorForStatus,
};

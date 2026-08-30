const C = require('./constants');

/**
 * ONE bounded pool for the three APIs that share ONE ceiling.
 *
 * ---- The fact this file exists for -----------------------------------------
 *
 * DataForSEO caps SIMULTANEOUS requests at THIRTY for the database-backed
 * families, and Labs, Backlinks and OnPage all count against the same thirty.
 * They are not three budgets of thirty; they are three doors into one room.
 *
 * That is why this is a file of its own in phase 6 rather than a `Promise` queue
 * inside `labs.js`. The obvious shape — a limiter per API, sized at the
 * published ceiling — is the wrong shape by a factor of three: Labs at 30 plus
 * Backlinks at 30 plus OnPage at 30 is ninety in flight against a limit of
 * thirty, and the symptom is not a crash. It is a storm of `40209`s spread
 * across every account on a shared credential, each one retried, each retry
 * consuming a slot somebody else was waiting for. The API that gets starved is
 * whichever one happened to be second.
 *
 * So phases 7 and 8 do not build their own. They add their endpoint prefix to
 * `DB_BACKED_PREFIXES` below and call `withDbBackedSlot`, and the ceiling stays
 * one number in one place.
 *
 * ---- What this is NOT ------------------------------------------------------
 *
 * IT IS NOT THE CORRECTNESS GUARANTEE, and treating it as one would be the
 * mistake worth naming here. Three things it cannot see:
 *
 *   - the ceiling is per ACCOUNT and our account is shared by every
 *     organisation on the deployment;
 *   - this pool is per PROCESS, and Render can run two instances — two pools of
 *     twenty-five is fifty;
 *   - a manual refresh runs outside the cron entirely and gets its own client.
 *
 * The actual backstop is already in `errors.js`: `40209` classifies as
 * `rate_limit`, which means `retryable`, which means the transport backs off and
 * tries again. This pool is what keeps that path RARE rather than what makes it
 * unnecessary. Twenty-five against thirty is the margin those three unknowns
 * live in.
 *
 * ---- Why it is fair, and why that is not decoration ------------------------
 *
 * Waiters are served FIFO. A pool that resolved waiters in arbitrary order
 * starves whichever request arrived while the queue was deepest, and on a
 * shared account that is a whole organisation's collection quietly finishing
 * last every pass. The queue is an array and the winner is `shift()`, which is
 * the entire mechanism.
 */

/**
 * The endpoint prefixes that count against DataForSEO's 30-simultaneous ceiling.
 *
 * PHASES 7 AND 8 ADD ONE LINE EACH HERE. `backlinks/` and `on_page/` are listed
 * now, before either exists, deliberately: the list is the contract, and a
 * contract written after the fact is a contract somebody has to remember. A
 * prefix here that nothing calls yet costs nothing; a prefix missing the day
 * `backlinks/summary/live` ships costs a ceiling nobody notices is gone.
 *
 * `serp/` is deliberately ABSENT. The SERP family is queued, not DB-backed, and
 * its `task_get` polls are free and outside this ceiling — `POLL_CONCURRENCY`
 * bounds those, for politeness rather than for a limit. Putting them here would
 * make two hundred free polls compete for slots with the calls that cost money.
 */
const DB_BACKED_PREFIXES = [
  'dataforseo_labs/',
  'backlinks/',
  'on_page/',
  'content_analysis/',
  'domain_analytics/',
];

/**
 * Does this endpoint count against the shared ceiling?
 *
 * @param {string} endpoint
 * @returns {boolean}
 */
const isDbBackedEndpoint = (endpoint) => {
  const path = String(endpoint || '');
  return DB_BACKED_PREFIXES.some((prefix) => path.startsWith(prefix));
};

/**
 * The pool state. MODULE-LEVEL, and that is the point: one process, one
 * ceiling, whichever family asked.
 *
 * A class instance per caller would be three ceilings again wearing one type.
 */
const state = {
  limit: C.DB_BACKED_POOL_LIMIT,
  inFlight: 0,
  /** FIFO. `push` to join, `shift` to be served. See the header. */
  waiting: [],
  /** Diagnostics only — never a gate. */
  peakInFlight: 0,
  peakWaiting: 0,
  admitted: 0,
};

/** Hand the next waiter a slot, or give the slot back to the pool. */
const release = () => {
  const next = state.waiting.shift();
  if (next) {
    next();
    return;
  }
  state.inFlight -= 1;
};

/**
 * Take a slot, run `fn`, give the slot back — whatever `fn` does.
 *
 * The release is in a `finally`, which is the only arrangement that works: a
 * rejection is the COMMON case here (a `40209`, a timeout, a refused endpoint),
 * and a pool that leaked a slot per failure would wind itself down to zero over
 * a bad afternoon and then hang every subsequent call forever, with no error
 * anywhere to say why.
 *
 * Non-DB-backed endpoints pass through UNTOUCHED rather than being refused. This
 * is a throughput control, not an allowlist — `collect.js` owns the question of
 * what may be called at all, and a second file with an opinion about that is a
 * second place to keep in step.
 *
 * @template T
 * @param {string} endpoint
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
const withDbBackedSlot = async (endpoint, fn) => {
  if (!isDbBackedEndpoint(endpoint)) return fn();

  if (state.inFlight >= state.limit) {
    if (state.waiting.length + 1 > state.peakWaiting) {
      state.peakWaiting = state.waiting.length + 1;
    }
    await new Promise((resolve) => state.waiting.push(resolve));
  } else {
    state.inFlight += 1;
  }

  state.admitted += 1;
  if (state.inFlight > state.peakInFlight) state.peakInFlight = state.inFlight;

  try {
    return await fn();
  } finally {
    release();
  }
};

/**
 * What the pool is doing. Diagnostics, and the shape a test asserts against.
 *
 * `peakInFlight` is the number that matters: it is the highest simultaneity this
 * process ever reached, and if it ever exceeds `limit` the pool is broken.
 */
const poolStats = () => ({
  limit: state.limit,
  ceiling: C.DB_BACKED_SIMULTANEOUS_CEILING,
  inFlight: state.inFlight,
  waiting: state.waiting.length,
  peakInFlight: state.peakInFlight,
  peakWaiting: state.peakWaiting,
  admitted: state.admitted,
});

/**
 * Reset the counters. FOR TESTS, which need a known starting point and would
 * otherwise read whatever the previous test left behind.
 *
 * `limit` is settable so a test can prove the bound holds at 2 without queueing
 * twenty-six promises to do it.
 */
const resetPool = ({ limit = C.DB_BACKED_POOL_LIMIT } = {}) => {
  state.limit = limit;
  state.inFlight = 0;
  state.waiting = [];
  state.peakInFlight = 0;
  state.peakWaiting = 0;
  state.admitted = 0;
};

module.exports = {
  DB_BACKED_PREFIXES,
  isDbBackedEndpoint,
  withDbBackedSlot,
  poolStats,
  resetPool,
};

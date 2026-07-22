/**
 * Minimal in-memory sliding-window rate limiter for the PUBLIC portal endpoints
 * (passcode check + magic-link request). The app ships no rate-limit dependency;
 * this is a lightweight guard against passcode brute-force and email bombing
 * without adding one.
 *
 * Caveat: state is per-process and resets on restart, so it is a mitigation, not
 * a hard guarantee, on multi-instance deploys. For stronger guarantees, move the
 * counter into Mongo (per group) or add express-rate-limit later.
 */

// key → array of hit timestamps (ms). Pruned lazily on each check.
const hits = new Map();

// Bound the map so a flood of distinct keys can't grow it unboundedly.
const MAX_KEYS = 10000;

/**
 * Record an attempt for `key` and report whether it is allowed under the window.
 *
 * @param {string} key         caller identity (e.g. `${ip}:${portalToken}`)
 * @param {object} [opts]
 * @param {number} [opts.max=5]         max attempts allowed within the window
 * @param {number} [opts.windowMs=600000] window length in ms (default 10 min)
 * @returns {{ allowed: boolean, retryAfterSec: number }}
 */
const rateLimit = (key, { max = 5, windowMs = 10 * 60 * 1000 } = {}) => {
  const now = Date.now();
  const cutoff = now - windowMs;

  if (hits.size > MAX_KEYS) hits.clear();

  const arr = (hits.get(key) || []).filter((t) => t > cutoff);
  if (arr.length >= max) {
    const retryAfterSec = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
    hits.set(key, arr);
    return { allowed: false, retryAfterSec };
  }
  arr.push(now);
  hits.set(key, arr);
  return { allowed: true, retryAfterSec: 0 };
};

module.exports = { rateLimit };

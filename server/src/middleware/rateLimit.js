/**
 * Tiny dependency-free in-memory rate limiter.
 *
 * Deliberately not `express-rate-limit` — this project ships no such dependency,
 * and the Client Portal is the one public, unauthenticated surface that most
 * needs a brake (invite email spam, issue-create spam, thread flooding). A
 * fixed-window counter keyed per (route-bucket + client) is plenty for a
 * single-instance deploy. On a multi-instance deploy each process keeps its own
 * window — swap the Map for Redis if/when that day comes.
 *
 * Usage:
 *   const rateLimit = require('../middleware/rateLimit');
 *   router.post('/x', rateLimit({ windowMs: 60_000, max: 20 }), handler);
 */

// bucketName -> Map<key, { count, resetAt }>
const buckets = new Map();

const clientKey = (req) => {
  // Prefer the authenticated identity when we have one (portal contact / user),
  // else fall back to IP. `trust proxy` is not set, so req.ip is the socket peer.
  if (req.portal?.contactId) return `c:${req.portal.contactId}`;
  if (req.user?.userId) return `u:${req.user.userId}`;
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return `ip:${fwd || req.ip || req.socket?.remoteAddress || 'unknown'}`;
};

const rateLimit = ({
  windowMs = 60_000,
  max = 60,
  bucket = 'default',
  message = 'Too many requests. Please slow down and try again shortly.',
} = {}) => {
  if (!buckets.has(bucket)) buckets.set(bucket, new Map());
  const store = buckets.get(bucket);

  return (req, res, next) => {
    const key = clientKey(req);
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: message, retryAfter });
    }

    return next();
  };
};

// Opportunistic sweep so the Maps don't grow unbounded on a long-lived process.
const SWEEP_MS = 5 * 60_000;
const sweep = setInterval(() => {
  const now = Date.now();
  for (const store of buckets.values()) {
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }
}, SWEEP_MS);
// Never keep the event loop alive just for the sweep.
if (typeof sweep.unref === 'function') sweep.unref();

module.exports = rateLimit;

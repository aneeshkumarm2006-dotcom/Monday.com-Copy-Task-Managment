/**
 * `POST /api/connectors/dataforseo/pingback/:token` — RESERVED, AND INERT.
 *
 * ---- Webhooks: no. Shipped as code rather than left as an opinion -----------
 *
 * DataForSEO can call a URL when a task finishes. We do not want it to, in any
 * phase, and the reasons compound:
 *
 *   `task_get` IS FREE, so the economic case for a webhook is exactly zero.
 *     Everything a pingback saves is a call that costs nothing.
 *   THEY DO NOT SIGN IT. There is no HMAC, no shared secret, no signature
 *     header — the only offered control is a six-IP allowlist, behind a platform
 *     with no `trust proxy` set. So a trustworthy receiver has to treat the body
 *     as untrusted and call `task_get` anyway to find out what really happened,
 *     which means the honest design saves NO calls at all.
 *   THEY DO NOT RETRY IT. A dropped pingback is a task that is never collected
 *     unless something else notices — so the poller stays load-bearing whether
 *     or not this exists, and a second mechanism that cannot replace the first
 *     is a second mechanism to keep working.
 *   AN HOUR OF LATENCY ON A WEEKLY DATAPOINT IS NOISE — and phase 4's
 *     ten-minute collection cron took the median to ~5 minutes without a
 *     public route at all.
 *
 * What is reserved, and why reserving is worth doing:
 *
 *   THE PATH SHAPE. A token in the PATH rather than an HMAC over the BODY. That
 *     is the argument that keeps `app.js`'s body parsing untouched — a signature
 *     scheme would need the raw bytes, and `stashRawBody` would have to grow a
 *     third special case. Deciding this now is what makes adding a receiver
 *     later purely additive.
 *   THE MOUNT POSITION. Above `router.use(authMiddleware)`, beside the OAuth
 *     callback, because a third party has no session. Getting that wrong is a
 *     401 nobody can debug from the outside.
 *
 * The repair path DataForSEO documents for a dropped pingback is
 * `appendix/webhook_resend` (see `constants.ENDPOINT_WEBHOOK_RESEND`), and it is
 * deliberately never called: there is nothing to resend to. The poller's
 * equivalent is `READY_GRACE_HOURS` — results live thirty days, so a missed
 * announcement costs latency and never a re-purchase.
 *
 * ---- What this handler must NOT do ------------------------------------------
 *
 * It is a public, unauthenticated route on a service with real data behind it,
 * so it does the least possible: no database read, no token comparison, no
 * logging of the path (the token segment is attacker-controlled and would be
 * written into our logs verbatim), and no work whose cost scales with the
 * request. `501` says truthfully that the endpoint exists and is not
 * implemented, which is also the only answer that cannot be used to probe
 * whether a given token is real.
 */
const pingback = (req, res) => {
  res.status(501).json({
    error:
      'DataForSEO pingbacks are not accepted. Results are collected by polling, ' +
      'which is free, verified, and does not depend on an unsigned callback.',
  });
};

module.exports = { pingback };

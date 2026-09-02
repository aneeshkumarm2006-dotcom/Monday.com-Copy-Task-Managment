const express = require('express');
const cors = require('cors');
const passport = require('./config/passport');

const app = express();

// CORS — allow the frontend client
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

// Body parsing. `verify` stashes the raw bytes on req.rawBody so webhook routes
// (e.g. inbound email) can verify provider signatures over the exact payload.
const stashRawBody = (req, res, buf) => {
  req.rawBody = buf;
};

/**
 * Vault routes get a larger JSON limit than everything else.
 *
 * A vault item's whole payload — title, fields, a full TipTap document — is
 * AES-GCM sealed and then base64'd, which inflates it by a third before it ever
 * reaches the wire. At body-parser's 100kb default a Doc of any real length is
 * rejected with a 413 the user cannot act on, and there is no way to make it
 * smaller: encryption is not compressible and the payload cannot be split,
 * because it is one sealed unit by design.
 *
 * This runs BEFORE the global parser and body-parser marks a request once
 * parsed, so the parser below then skips it. That makes this an override for
 * these paths rather than a second parse, and leaves every other route on the
 * conservative default.
 */
const VAULT_BODY_PATH =
  /^\/api\/(boards\/[^/]+\/vault|orgs\/[^/]+\/vault-escrow|vault)(\/|$)/;
const vaultJson = express.json({ limit: '6mb', verify: stashRawBody });
app.use((req, res, next) =>
  VAULT_BODY_PATH.test(req.path) ? vaultJson(req, res, next) : next()
);

app.use(express.json({ verify: stashRawBody }));
app.use(express.urlencoded({ extended: true }));

// Passport (stateless — no session middleware)
app.use(passport.initialize());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'macan-api' });
});

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/api/orgs', require('./routes/orgs'));
app.use('/api/boards', require('./routes/boards'));
app.use('/api/dashboard', require('./routes/dashboard'));
// Client Portal — MUST be mounted before the bare `app.use('/api', ...)` routers
// below (groups/automations/updates/notes/activity). Each of those applies its
// own `router.use(authMiddleware)` to EVERY `/api/*` path, so if the portal
// router came after them, an unauthenticated public portal request
// (GET /api/portal/:token, /verify, request-link) or a portal-token request
// (/me/*) would be 401'd by the groups router before it ever reached here.
app.use('/api/portal', require('./routes/portal'));
// Inbound email webhooks (public, signature-verified) — before the blanket /api
// routers so their auth middleware never sees it.
app.use('/api/inbound', require('./routes/inbound'));
// Notifications sit ABOVE every bare-/api router for the same reason the
// connectors router does (see its comment below): the /stream endpoint is an
// EventSource, which cannot send an Authorization header — it authenticates
// via ?token= inside its own handler. Any bare-/api router's
// `router.use(authMiddleware)` matches EVERY /api/* path that flows past it,
// so with this mounted later, streams were 401'd before the route ever ran —
// SSE silently never worked and the polling fallback hid it.
app.use('/api/notifications', require('./routes/notifications'));
// Connectors — mounted bare at /api, and for the same ordering reason as the two
// above: it carries a PUBLIC OAuth callback (GET /api/connectors/callback) that
// a third party redirects a browser to with no session and no Authorization
// header. Any of the bare /api routers below would 401 it first.
app.use('/api', require('./routes/connectors'));
app.use('/api', require('./routes/groups'));
app.use('/api', require('./routes/automations'));
app.use('/api', require('./routes/trackers'));
app.use('/api', require('./routes/goals'));
app.use('/api', require('./routes/adsBudget'));
app.use('/api', require('./routes/scoreboard'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api', require('./routes/updates'));
app.use('/api', require('./routes/notes'));
app.use('/api', require('./routes/vault'));
app.use('/api', require('./routes/activity'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/productivity', require('./routes/productivity'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/search', require('./routes/search'));
app.use('/api/proxy', require('./routes/proxy'));

// Centralised error handler — surfaces the real cause in logs and, for the
// OAuth flow specifically, redirects the browser back to the login page with
// an error flag instead of dumping a raw Express 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);

  if (req.path.startsWith('/auth/google')) {
    return res.redirect(`${process.env.CLIENT_URL}/login?error=auth_failed`);
  }

  return res.status(500).json({ error: 'Server error' });
});

module.exports = app;

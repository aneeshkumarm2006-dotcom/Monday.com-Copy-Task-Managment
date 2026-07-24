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
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
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
app.use('/api', require('./routes/groups'));
app.use('/api', require('./routes/automations'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api', require('./routes/updates'));
app.use('/api', require('./routes/notes'));
app.use('/api', require('./routes/activity'));
app.use('/api/notifications', require('./routes/notifications'));
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

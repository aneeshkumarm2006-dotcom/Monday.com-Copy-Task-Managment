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

// Body parsing
app.use(express.json());
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

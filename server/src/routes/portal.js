const express = require('express');
const passport = require('../config/passport');
const authMiddleware = require('../middleware/auth');
const portalAuth = require('../middleware/portalAuth');
const rateLimit = require('../middleware/rateLimit');
const { updateUpload, handleUploadError } = require('../config/cloudinary');
const portal = require('../controllers/portalController');

// ---- Rate limiters ----------------------------------------------------------
// The portal is the only public, unauthenticated surface, so every write path
// gets a brake. Limits are per-client (contact when signed in, else IP).
const inviteLimit = rateLimit({ bucket: 'portal:invite', windowMs: 60_000, max: 5, message: 'Too many invites sent. Please wait a minute and try again.' });
const createLimit = rateLimit({ bucket: 'portal:create', windowMs: 60_000, max: 10, message: 'You are creating requests too quickly. Please wait a moment.' });
const threadLimit = rateLimit({ bucket: 'portal:thread', windowMs: 60_000, max: 30, message: 'You are sending messages too quickly. Please wait a moment.' });
const uploadLimit = rateLimit({ bucket: 'portal:upload', windowMs: 60_000, max: 20, message: 'Too many uploads. Please wait a moment.' });
const publicLimit = rateLimit({ bucket: 'portal:public', windowMs: 60_000, max: 60 });

/**
 * Client Portal router — mounted at /api/portal. Unlike every other /api router,
 * this one does NOT apply a single blanket auth. It mixes three planes, so auth
 * is applied PER ROUTE:
 *
 *   /groups/:groupId/*        → app user  (authMiddleware)  — team manages a link
 *   /me/*                     → client    (portalAuth)      — the client's data
 *   /auth/google*, /:token    → public                      — accept + sign in
 *
 * The literal `/groups/*`, `/me/*`, `/auth/*` routes are registered BEFORE the
 * `/:portalToken` param route so they aren't shadowed by it.
 */
const router = express.Router();

// ---- Team admin (authenticated app user) ----
router.get('/groups/:groupId/config', authMiddleware, portal.getPortalConfig);
router.put('/groups/:groupId/config', authMiddleware, portal.savePortalConfig);
router.post('/groups/:groupId/invite', authMiddleware, inviteLimit, portal.sendPortalInvite);

// ---- Portal-authenticated client ----
// rateLimit runs AFTER portalAuth so it keys on the signed-in contact, not IP.
router.get('/me/issues', portalAuth, portal.getMyIssues);
router.post('/me/issues', portalAuth, createLimit, portal.createMyIssue);
router.post(
  '/me/issues/:id/attachments',
  portalAuth,
  uploadLimit,
  updateUpload.single('file'),
  handleUploadError,
  portal.uploadIssueAttachment
);
router.get('/me/issues/:id/thread', portalAuth, portal.getIssueThread);
router.post('/me/issues/:id/thread', portalAuth, threadLimit, portal.postIssueThreadMessage);

// ---- Public Google sign-in (the "Accept invitation" → login flow) ----
// The group being joined is carried through Google in the OAuth `state` param as
// its portalToken; the callback reads it back from req.query.state.
router.get('/auth/google/callback',
  passport.authenticate('google-portal', {
    session: false,
    failureRedirect: `${process.env.CLIENT_URL || 'http://localhost:5173'}/portal/verify?error=1`,
  }),
  portal.portalGoogleCallback
);
router.get('/:portalToken/auth/google', publicLimit, (req, res, next) => {
  passport.authenticate('google-portal', {
    scope: ['profile', 'email'],
    session: false,
    state: req.params.portalToken,
  })(req, res, next);
});

// ---- Public branding for the landing page ----
router.get('/:portalToken', publicLimit, portal.getPortalMeta);

module.exports = router;

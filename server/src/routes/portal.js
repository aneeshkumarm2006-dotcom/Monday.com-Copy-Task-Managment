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
// Password sign-in is the one public surface where guessing pays, so it gets a
// tighter bucket than publicLimit. These key on IP (no contact/user exists yet),
// so they're only half the defence — portalController also locks an individual
// contact after 5 consecutive failures, which a distributed attempt can't dodge.
const loginLimit = rateLimit({ bucket: 'portal:login', windowMs: 60_000, max: 10, message: 'Too many sign-in attempts. Please wait a minute and try again.' });
const forgotLimit = rateLimit({ bucket: 'portal:forgot', windowMs: 60_000, max: 5, message: 'Too many requests. Please wait a minute and try again.' });
const setupLimit = rateLimit({ bucket: 'portal:setup', windowMs: 60_000, max: 10, message: 'Too many attempts. Please wait a minute and try again.' });

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
router.get('/groups/:groupId/contacts', authMiddleware, portal.listPortalContacts);
router.post('/groups/:groupId/contacts/:contactId/resend', authMiddleware, inviteLimit, portal.resendPortalInvite);

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
router.post('/me/issues/:id/reopen', portalAuth, threadLimit, portal.reopenIssue);
router.post('/me/issues/:id/rating', portalAuth, threadLimit, portal.rateIssue);

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

// ---- Public password sign-in (clients without a Google account) ----
// The email must have been invited on this group with authMethod 'password';
// anything else is refused with the same message as a wrong password. Both the
// login and the setup completion answer with a portal JWT as JSON — the page
// stores it and navigates, rather than round-tripping through /portal/verify the
// way the Google redirect has to.
router.post('/:portalToken/auth/password', loginLimit, portal.portalPasswordLogin);
router.post('/:portalToken/auth/password/forgot', forgotLimit, portal.portalRequestPasswordLink);
router.get('/:portalToken/auth/setup/:token', setupLimit, portal.portalCheckSetupToken);
router.post('/:portalToken/auth/setup/:token', setupLimit, portal.portalCompletePasswordSetup);

// ---- Public branding for the landing page ----
router.get('/:portalToken', publicLimit, portal.getPortalMeta);

module.exports = router;

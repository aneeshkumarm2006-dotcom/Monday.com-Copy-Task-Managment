const express = require('express');
const authMiddleware = require('../middleware/auth');
const portalAuth = require('../middleware/portalAuth');
const { updateUpload, handleUploadError } = require('../config/cloudinary');
const portal = require('../controllers/portalController');

/**
 * Client Portal router — mounted at /api/portal. Unlike every other /api router,
 * this one does NOT apply a single blanket auth. It mixes three planes, so auth
 * is applied PER ROUTE:
 *
 *   /groups/:groupId/config   → app user  (authMiddleware)  — team manages a link
 *   /me/*                     → client    (portalAuth)      — the client's data
 *   /:portalToken, /verify    → public                      — pre-sign-in flow
 *
 * The literal `/groups/*`, `/me/*` and `/verify` routes are registered BEFORE the
 * `/:portalToken` param route so they aren't shadowed by it.
 */
const router = express.Router();

// ---- Team admin (authenticated app user) ----
router.get('/groups/:groupId/config', authMiddleware, portal.getPortalConfig);
router.put('/groups/:groupId/config', authMiddleware, portal.savePortalConfig);

// ---- Portal-authenticated client ----
router.get('/me/issues', portalAuth, portal.getMyIssues);
router.post('/me/issues', portalAuth, portal.createMyIssue);
router.post(
  '/me/issues/:id/attachments',
  portalAuth,
  updateUpload.single('file'),
  handleUploadError,
  portal.uploadIssueAttachment
);
router.get('/me/issues/:id/thread', portalAuth, portal.getIssueThread);
router.post('/me/issues/:id/thread', portalAuth, portal.postIssueThreadMessage);

// ---- Public (pre-sign-in) ----
router.get('/verify', portal.verifyMagicLink);
router.post('/:portalToken/request-link', portal.requestMagicLink);
router.get('/:portalToken', portal.getPortalMeta);

module.exports = router;

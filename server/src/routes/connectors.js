const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  getCatalog,
  listOrgConnectors,
  startAuthorization,
  handleCallback,
  disconnectAccount,
  getBoardConnectors,
  setBoardConnector,
} = require('../controllers/connectorController');

/**
 * Mounted BARE at /api (see app.js), like routes/goals.js and routes/trackers.js,
 * because these paths live under three different prefixes: `/orgs/:orgId/...`
 * for the account pool, `/boards/:boardId/...` for per-board enablement, and
 * bare `/connectors/...` for the catalog and for a single account.
 *
 * MOUNT ORDER MATTERS. This router must come BEFORE the other bare `/api`
 * routers in app.js, because each of those applies its own
 * `router.use(authMiddleware)` to every `/api/*` path it sees. The OAuth
 * callback below is a browser redirect from a third party with no session and no
 * Authorization header — if routes/groups.js were reached first it would be
 * 401'd before it ever arrived here. Same reasoning as /api/portal and
 * /api/inbound.
 *
 * Capabilities, per handler:
 *   (none)                — the OAuth callback; authorised by a single-use,
 *                           server-minted `state`, not by a session
 *   org member            — listing the account pool (the board project picker
 *                           names these accounts, so hiding them breaks it)
 *   org.manage_settings   — connecting and disconnecting an ACCOUNT, because
 *                           that is workspace-wide credential handling
 *   connector.view        — reading what a board has switched on
 *   connector.manage      — switching it on, and (later) mapping and refreshing
 */
const router = express.Router();

/**
 * The OAuth callback. PUBLIC, and registered before the auth middleware for the
 * reason set out above.
 *
 * It is safe to leave unauthenticated because the `state` it requires was minted
 * by an org admin, stored server-side, and is deleted by the first request that
 * presents it — so it cannot be guessed, reused, or replayed.
 */
router.get('/connectors/callback', handleCallback);

// Everything below needs a Bearer token.
router.use(authMiddleware);

// --- The catalog ------------------------------------------------------------
// Static, and must precede `/connectors/:accountId` so "callback" and the
// catalog root are never parsed as an account id.
router.get('/connectors', getCatalog);

// --- The org account pool ---------------------------------------------------
router.get('/orgs/:orgId/connectors', listOrgConnectors);
router.post('/orgs/:orgId/connectors/:provider/authorize', startAuthorization);

// --- A single account -------------------------------------------------------
router.delete('/connectors/:accountId', disconnectAccount);

// --- Per-board enablement ---------------------------------------------------
router.get('/boards/:boardId/connectors', getBoardConnectors);
router.put('/boards/:boardId/connectors/:provider', setBoardConnector);

module.exports = router;

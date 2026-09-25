const express = require('express');
const authMiddleware = require('../middleware/auth');
const { getRates } = require('../controllers/fxController');

const router = express.Router();

router.use(authMiddleware);

/**
 * GET /api/fx/rates — every snapshot the browser needs to render money.
 *
 * Not org-scoped, because the rates are not the org's: `FxSnapshot` is global
 * on purpose (a rate is a public fact), so scoping this to a workspace would
 * imply a per-workspace answer that does not exist and would make the browser
 * re-fetch an identical table on every workspace switch.
 *
 * Any signed-in member may read it. Every screen in the product renders money,
 * so gating this on a capability would mean gating the ability to read a number
 * correctly.
 */
router.get('/rates', getRates);

module.exports = router;

const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  getRoster,
  getClient,
  getClientActivity,
  createRow,
  updateRow,
  deleteRow,
  reorderRows,
  setSettings,
} = require('../controllers/adsBudgetController');

/**
 * Ads budgets on a tracker board.
 *
 * Mounted bare at `/api` (see app.js) rather than under a prefix, for the same
 * reason trackers, goals and notes are: the paths straddle two shapes — the
 * board-scoped collection at `/boards/:boardId/ads-budget` and a single row at
 * `/ads-budget/:id`, which has no board in its URL because the row knows its own.
 *
 * Capabilities, per handler:
 *   adsBudget.view   — reading the roster, one client, and the ledger
 *   adsBudget.track  — a write touching ONLY `spent`
 *   adsBudget.manage — creating, deleting, reordering, changing anything that
 *                      is not `spent`, and the add-on's own switch
 *
 * The track/manage split is decided inside `updateRow` rather than here,
 * because it depends on the BODY: the same PATCH route is a spend report or a
 * budget change depending on which fields actually move. Gating the route on
 * one of the two would either lock contributors out of reporting spend or let
 * them rewrite an allocation.
 */
const router = express.Router();

router.use(authMiddleware);

// Board-scoped. The static `/reorder` is registered before `/:groupId`, or it
// would be parsed as a group id and 400 on every reorder.
router.get('/boards/:boardId/ads-budget', getRoster);
router.post('/boards/:boardId/ads-budget', createRow);
router.put('/boards/:boardId/ads-budget/reorder', reorderRows);
router.put('/boards/:boardId/ads-budget-settings', setSettings);
// Likewise `/activity` before the bare `/:groupId`, so the ledger is not read
// as a client whose id happens to be the word "activity".
router.get('/boards/:boardId/ads-budget/:groupId/activity', getClientActivity);
router.get('/boards/:boardId/ads-budget/:groupId', getClient);

// Row-scoped.
router.patch('/ads-budget/:id', updateRow);
router.delete('/ads-budget/:id', deleteRow);

module.exports = router;

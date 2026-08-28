const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  getGoalTypes,
  getGoals,
  createGoal,
  updateGoal,
  deleteGoal,
  getGoalActivity,
  reorderGoals,
  getGoalTrend,
} = require('../controllers/goalController');
const {
  listGoalColumns,
  addGoalColumn,
  updateGoalColumn,
  reorderGoalColumns,
  deleteGoalColumn,
} = require('../controllers/goalColumnController');

/**
 * Mounted BARE at /api (see app.js), like routes/trackers.js, because these
 * paths live under two different prefixes: `/boards/:boardId/goals...` for the
 * collection and `/goals/:id` for a single row.
 *
 * Capabilities, per handler:
 *   goal.view    — reading the tab and the trend
 *   goal.track   — a write touching ONLY the result fields
 *   goal.manage  — creating, deleting, or redefining a goal, AND the shared
 *                  column schema (see goalColumnController)
 */
const router = express.Router();

router.use(authMiddleware);

// The type catalog that generates the add-a-goal form. Static.
router.get('/goal-types', getGoalTypes);

// --- Goals on a board -------------------------------------------------------
// `trend` and `reorder` must precede nothing here (different prefix), but the
// order below still matters for readability.
router.get('/boards/:boardId/goals/trend', getGoalTrend);
router.get('/boards/:boardId/goals', getGoals);
router.post('/boards/:boardId/goals', createGoal);
router.put('/boards/:boardId/goals/reorder', reorderGoals);

// --- A single goal ----------------------------------------------------------
router.put('/goals/:id', updateGoal);
router.delete('/goals/:id', deleteGoal);
// Its history — `goal.view`, the same rung that shows the row in the first
// place. Rows live in the shared ActivityLog collection, keyed on `goal`.
router.get('/goals/:id/activity', getGoalActivity);

// --- The shared column schema (needs goal.manage) ---------------------------
// `reorder` before `/:cid` so it is not parsed as a column id.
router.get('/boards/:boardId/goal-columns', listGoalColumns);
router.post('/boards/:boardId/goal-columns', addGoalColumn);
router.patch('/boards/:boardId/goal-columns/reorder', reorderGoalColumns);
router.patch('/boards/:boardId/goal-columns/:cid', updateGoalColumn);
router.delete('/boards/:boardId/goal-columns/:cid', deleteGoalColumn);

module.exports = router;

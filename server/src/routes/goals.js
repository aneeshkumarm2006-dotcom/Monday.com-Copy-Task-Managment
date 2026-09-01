const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  getGoalTypes,
  getGoals,
  createGoal,
  carryForwardGoals,
  updateGoal,
  deleteGoal,
  getGoalActivity,
  reorderGoals,
  getGoalTrend,
  getGoalEvidence,
  getGoalTasks,
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
// Copy a month's promises into another month — `goal.manage`, because every row
// it writes is a new promise. MANUAL by design: there is no scheduled version of
// this and there must not be one. `dryRun: true` in the body returns the plan
// and writes nothing, which is what the confirmation modal shows.
router.post('/boards/:boardId/goals/carry-forward', carryForwardGoals);

// --- A single goal ----------------------------------------------------------
router.put('/goals/:id', updateGoal);
router.delete('/goals/:id', deleteGoal);
// Its history — `goal.view`, the same rung that shows the row in the first
// place. Rows live in the shared ActivityLog collection, keyed on `goal`.
router.get('/goals/:id/activity', getGoalActivity);

// --- Evidence: which done tasks counted towards which goal ------------------
// All three are `goal.view` — what work backs a goal is a fact about the board,
// the same as its score. The WRITE lives on routes/tasks.js, because it mutates
// a Task and nothing else.
router.get('/boards/:boardId/goals/evidence', getGoalEvidence);
router.get('/goals/:id/tasks', getGoalTasks);

// --- The shared column schema (needs goal.manage) ---------------------------
// `reorder` before `/:cid` so it is not parsed as a column id.
router.get('/boards/:boardId/goal-columns', listGoalColumns);
router.post('/boards/:boardId/goal-columns', addGoalColumn);
router.patch('/boards/:boardId/goal-columns/reorder', reorderGoalColumns);
router.patch('/boards/:boardId/goal-columns/:cid', updateGoalColumn);
router.delete('/boards/:boardId/goal-columns/:cid', deleteGoalColumn);

module.exports = router;

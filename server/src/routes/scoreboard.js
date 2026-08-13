const express = require('express');
const authMiddleware = require('../middleware/auth');
const { getScoreboard } = require('../controllers/scoreboardController');

/**
 * Mounted BARE at /api (see app.js), like routes/goals.js and routes/trackers.js.
 *
 * One route. The controller runs the gates: board access, `goal.view`, and the
 * tracker board type — then narrows to the caller's own row without
 * `productivity.view_others`, and drops the delivery half without `tracker.view`.
 */
const router = express.Router();

router.use(authMiddleware);

router.get('/boards/:boardId/scoreboard', getScoreboard);

module.exports = router;

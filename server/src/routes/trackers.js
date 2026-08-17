const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  listTrackers,
  createTracker,
  updateTracker,
  deleteTracker,
  setTrackerEntry,
  deleteTrackerEntry,
  setTrackerDayOff,
  deleteTrackerDayOff,
  getDelivery,
} = require('../controllers/trackerController');

const router = express.Router();

router.use(authMiddleware);

// Board-scoped. `/delivery` is the computed grid; `/trackers` is the config.
router.get('/boards/:boardId/delivery', getDelivery);
router.get('/boards/:boardId/trackers', listTrackers);
router.post('/boards/:boardId/trackers', createTracker);

// Tracker-scoped. `/entries` is registered before nothing else on :id, but keep
// the static segment first anyway — this router will grow.
router.put('/trackers/:id/entries', setTrackerEntry);
router.delete('/trackers/:id/entries', deleteTrackerEntry);
router.put('/trackers/:id/days-off', setTrackerDayOff);
router.delete('/trackers/:id/days-off', deleteTrackerDayOff);
router.put('/trackers/:id', updateTracker);
router.delete('/trackers/:id', deleteTracker);

module.exports = router;

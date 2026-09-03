const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  getNotifications,
  getUnreadCount,
  streamNotifications,
  markAsRead,
  markAsUnread,
  toggleBookmark,
  markAllAsRead,
  deleteNotification,
  clearRead,
  getPreferences,
  updatePreferences,
  getPushKey,
  subscribePush,
  unsubscribePush,
} = require('../controllers/notificationController');

const router = express.Router();

// SSE stream — authenticates via a ?token= query param (EventSource cannot set
// an Authorization header), so it must be registered BEFORE the bearer auth
// middleware below.
router.get('/stream', streamNotifications);

// All other notification routes require a Bearer token.
router.use(authMiddleware);

// Static paths must be registered before the parameterised `/:id` routes.
// GET    /api/notifications                 — list (filter, keyset pagination)
// GET    /api/notifications/unread-count     — lightweight unread count (poll target)
// PUT    /api/notifications/read-all         — mark all as read
// DELETE /api/notifications/clear-read       — delete all read notifications
// PUT    /api/notifications/:id/read         — mark a single notification as read
// PUT    /api/notifications/:id/unread       — mark a single notification as unread
// PUT    /api/notifications/:id/bookmark     — toggle bookmark on a notification
// DELETE /api/notifications/:id              — delete a single notification
router.get('/', getNotifications);
router.get('/unread-count', getUnreadCount);
router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);

// Web Push. Static paths, so above the `/:id` routes below.
router.get('/push/key', getPushKey);
router.post('/push/subscribe', subscribePush);
router.delete('/push/subscribe', unsubscribePush);
router.put('/read-all', markAllAsRead);
router.delete('/clear-read', clearRead);
router.put('/:id/read', markAsRead);
router.put('/:id/unread', markAsUnread);
router.put('/:id/bookmark', toggleBookmark);
router.delete('/:id', deleteNotification);

module.exports = router;

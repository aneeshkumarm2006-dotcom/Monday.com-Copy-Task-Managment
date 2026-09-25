const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  getGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
} = require('../controllers/groupController');

const { logoLimit, groupLogo } = require('../controllers/logoController');

const router = express.Router();

// All group routes require authentication
router.use(authMiddleware);

// Board-scoped
// GET    /api/boards/:boardId/groups — list groups for a board
// POST   /api/boards/:boardId/groups — create a group (admin-only)
router.get('/boards/:boardId/groups', getGroups);
router.post('/boards/:boardId/groups', createGroup);
// PUT    /api/boards/:boardId/groups/reorder — batch reorder groups
router.put('/boards/:boardId/groups/reorder', reorderGroups);

// Group-scoped
// PUT    /api/groups/:id  — update a group (admin-only)
// DELETE /api/groups/:id  — delete group + cascade (admin-only)
router.put('/groups/:id', updateGroup);
router.delete('/groups/:id', deleteGroup);

// Group logo — POST (multipart `logo`) / DELETE. `group.manage`.
router.post('/groups/:id/logo', logoLimit, groupLogo.upload);
router.delete('/groups/:id/logo', groupLogo.remove);

module.exports = router;

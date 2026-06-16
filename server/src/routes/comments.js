const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  getComments,
  addComment,
  editComment,
  setCommentMentionRead,
} = require('../controllers/commentController');

const router = express.Router();

// All comment routes require authentication
router.use(authMiddleware);

// GET   /api/tasks/:taskId/comments      — list comments for a task
// POST  /api/tasks/:taskId/comments      — add a comment to a task
// PATCH /api/tasks/:taskId/comments/:id  — edit a comment (author only)
router.get('/tasks/:taskId/comments', getComments);
router.post('/tasks/:taskId/comments', addComment);
router.patch('/tasks/:taskId/comments/:id', editComment);
// PATCH /api/tasks/:taskId/comments/:id/read — mentioned user toggles read
router.patch('/tasks/:taskId/comments/:id/read', setCommentMentionRead);

module.exports = router;

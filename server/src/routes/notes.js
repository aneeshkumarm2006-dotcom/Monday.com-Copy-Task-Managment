const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  getNotes,
  createNote,
  updateNote,
  deleteNote,
  getNoteCounts,
} = require('../controllers/noteController');

const router = express.Router();

router.use(authMiddleware);

// GET  /api/boards/:boardId/notes/counts — per-group note counts (badges)
router.get('/boards/:boardId/notes/counts', getNoteCounts);

// GET  /api/groups/:groupId/notes — list notes for a group
// POST /api/groups/:groupId/notes — create a note (editor only)
router.get('/groups/:groupId/notes', getNotes);
router.post('/groups/:groupId/notes', createNote);

// PATCH  /api/notes/:id — edit a note (editor only)
// DELETE /api/notes/:id — delete a note (editor only)
router.patch('/notes/:id', updateNote);
router.delete('/notes/:id', deleteNote);

module.exports = router;

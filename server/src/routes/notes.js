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

// GET  /api/groups/:groupId/notes — list notes for a group (board read access)
// POST /api/groups/:groupId/notes — create a note (requires `note.manage`)
router.get('/groups/:groupId/notes', getNotes);
router.post('/groups/:groupId/notes', createNote);

// PATCH  /api/notes/:id — edit a note (requires `note.manage`)
// DELETE /api/notes/:id — delete a note (requires `note.manage`)
router.patch('/notes/:id', updateNote);
router.delete('/notes/:id', deleteNote);

module.exports = router;

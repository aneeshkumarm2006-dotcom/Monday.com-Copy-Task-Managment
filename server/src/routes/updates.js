const express = require('express');
const authMiddleware = require('../middleware/auth');
const { updateUpload, handleUploadError } = require('../config/cloudinary');
const {
  getUpdates,
  addUpdate,
  editUpdate,
  deleteUpdate,
  uploadAttachment,
} = require('../controllers/updateController');

const router = express.Router();

router.use(authMiddleware);

// GET    /api/tasks/:taskId/updates                  — list updates
// POST   /api/tasks/:taskId/updates                  — create update
// PATCH  /api/tasks/:taskId/updates/:id              — edit update (author only)
// DELETE /api/tasks/:taskId/updates/:id              — delete update
router.get('/tasks/:taskId/updates', getUpdates);
router.post('/tasks/:taskId/updates', addUpdate);
router.patch('/tasks/:taskId/updates/:id', editUpdate);
router.delete('/tasks/:taskId/updates/:id', deleteUpdate);

// POST /api/tasks/:taskId/updates/attachments — upload file → Cloudinary
router.post(
  '/tasks/:taskId/updates/attachments',
  updateUpload.single('file'),
  handleUploadError,
  uploadAttachment
);

module.exports = router;

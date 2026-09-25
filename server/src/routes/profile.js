const express = require('express');
const authMiddleware = require('../middleware/auth');
const { avatarUpload } = require('../config/cloudinary');
const {
  updateProfile,
  updateTimezone,
  updateFeatures,
  updateDisplayCurrency,
  uploadAvatar,
  deletionPreview,
  deleteAccount,
} = require('../controllers/profileController');

const router = express.Router();

router.use(authMiddleware);

// PUT /api/profile — update display name
router.put('/', updateProfile);

// PUT /api/profile/timezone — silent browser-zone sync; feeds the 9am digest
router.put('/timezone', updateTimezone);

// PUT /api/profile/currency — which currency this person reads money in.
// Its own endpoint, like /timezone, so the write can never touch anything else.
router.put('/currency', updateDisplayCurrency);

// PUT /api/profile/features — toggle opt-in extras (activity export, …)
router.put('/features', updateFeatures);

// POST /api/profile/upload-avatar — multipart upload
router.post('/upload-avatar', avatarUpload.single('avatar'), uploadAvatar);

// GET /api/profile/deletion-preview — which workspaces block the delete, and
// which would be destroyed with it. The confirmation modal reads this so it
// never has to guess at the blast radius.
router.get('/deletion-preview', deletionPreview);

// DELETE /api/profile — permanently delete account and all associated data.
// 409s when a workspace you own still has other members; see the controller.
router.delete('/', deleteAccount);

module.exports = router;

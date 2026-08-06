const express = require('express');
const authMiddleware = require('../middleware/auth');
const { avatarUpload } = require('../config/cloudinary');
const {
  updateProfile,
  updateFeatures,
  uploadAvatar,
  deleteAccount,
} = require('../controllers/profileController');

const router = express.Router();

router.use(authMiddleware);

// PUT /api/profile — update display name
router.put('/', updateProfile);

// PUT /api/profile/features — toggle opt-in extras (activity export, …)
router.put('/features', updateFeatures);

// POST /api/profile/upload-avatar — multipart upload
router.post('/upload-avatar', avatarUpload.single('avatar'), uploadAvatar);

// DELETE /api/profile — permanently delete account and all associated data
router.delete('/', deleteAccount);

module.exports = router;

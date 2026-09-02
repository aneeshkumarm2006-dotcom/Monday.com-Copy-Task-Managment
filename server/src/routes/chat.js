const express = require('express');
const authMiddleware = require('../middleware/auth');
const { updateUpload, handleUploadError } = require('../config/cloudinary');
const {
  listChannels,
  createChannel,
  updateChannel,
  markChannelRead,
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  uploadChatAttachment,
} = require('../controllers/chatController');

const router = express.Router();

router.use(authMiddleware);

// GET    /api/chat/channels?org=<orgId>       — the sidebar (ensures auto channels)
// POST   /api/chat/channels                    — manual channel (workspace or board)
// PATCH  /api/chat/channels/:channelId         — rename / archive
// POST   /api/chat/channels/:channelId/read    — move the caller's read marker
router.get('/channels', listChannels);
router.post('/channels', createChannel);
router.patch('/channels/:channelId', updateChannel);
router.post('/channels/:channelId/read', markChannelRead);

// GET    /api/chat/channels/:channelId/messages              — page / thread
// POST   /api/chat/channels/:channelId/messages              — send
// PATCH  /api/chat/channels/:channelId/messages/:messageId   — author edit
// DELETE /api/chat/channels/:channelId/messages/:messageId   — author or manager
router.get('/channels/:channelId/messages', getMessages);
router.post('/channels/:channelId/messages', sendMessage);
router.patch('/channels/:channelId/messages/:messageId', editMessage);
router.delete('/channels/:channelId/messages/:messageId', deleteMessage);

// POST /api/chat/channels/:channelId/attachments — file → Cloudinary. Same
// multer pipeline as update attachments; the controller tears the asset back
// down when the gate refuses (the upload has already happened by then).
router.post(
  '/channels/:channelId/attachments',
  updateUpload.single('file'),
  handleUploadError,
  uploadChatAttachment
);

module.exports = router;

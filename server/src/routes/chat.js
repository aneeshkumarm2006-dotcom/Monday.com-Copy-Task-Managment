const express = require('express');
const authMiddleware = require('../middleware/auth');
const { updateUpload, handleUploadError } = require('../config/cloudinary');
const {
  listChannels,
  createChannel,
  openDm,
  updateChannel,
  markChannelRead,
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  makeTaskFromMessage,
  uploadChatAttachment,
  listBoardChannels,
  createGroupSurfaces,
  listThreads,
  createThread,
  markThreadRead,
} = require('../controllers/chatController');

const router = express.Router();

router.use(authMiddleware);

// GET    /api/chat/channels?org=<orgId>       — the sidebar (ensures auto channels)
// POST   /api/chat/channels                    — manual channel (workspace or board)
// PATCH  /api/chat/channels/:channelId         — rename / archive
// POST   /api/chat/channels/:channelId/read    — move the caller's read marker
router.get('/channels', listChannels);
router.post('/channels', createChannel);

// GET  /api/chat/boards/:boardId/channels — every surface on one board, grouped
//      by workstream. The board Chat tab. Client-board rooms appear ONLY here;
//      the sidebar above excludes them deliberately (see listChannels).
// POST /api/chat/boards/:boardId/groups/:groupId/surfaces — the setup picker's
//      write. Requires `group.manage`.
//
// Registered before `/channels/:channelId` below purely for readability — Express
// matches on the literal first segment, so `boards` and `channels` cannot collide.
router.get('/boards/:boardId/channels', listBoardChannels);
router.post('/boards/:boardId/groups/:groupId/surfaces', createGroupSurfaces);
// POST /api/chat/dms — find-or-create the DM with one other member
router.post('/dms', openDm);
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
// POST /api/chat/channels/:channelId/messages/:messageId/task — make-this-a-task
router.post('/channels/:channelId/messages/:messageId/task', makeTaskFromMessage);

// Mail surfaces. A thread IS a top-level message with a subject plus its
// existing one level of replies, so reading a thread still goes through
// `GET .../messages?thread=<id>`; these three add what a mailbox needs on top:
// a list sorted by last activity, a way to start a thread, and a PER-THREAD
// read marker (opening one thread must not mark the rest read).
router.get('/channels/:channelId/threads', listThreads);
router.post('/channels/:channelId/threads', createThread);
router.post('/channels/:channelId/threads/:threadId/read', markThreadRead);

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

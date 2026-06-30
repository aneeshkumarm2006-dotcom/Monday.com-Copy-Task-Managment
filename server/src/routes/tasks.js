const express = require('express');
const authMiddleware = require('../middleware/auth');
const { taskAttachmentUpload, handleUploadError } = require('../config/cloudinary');
const {
  getTasks,
  getMyTasks,
  getCalendarTasks,
  getSubitems,
  createTask,
  updateTask,
  deleteTask,
  reorderTasks,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  reorderChecklist,
  getTaskAttachments,
  uploadTaskAttachment,
  deleteTaskAttachment,
} = require('../controllers/taskController');
const {
  linkTask,
  unlinkTask,
  getMirror,
} = require('../controllers/linkController');
const {
  getFollowState,
  followTask,
  unfollowTask,
} = require('../controllers/followController');

const router = express.Router();

// All task routes require authentication
router.use(authMiddleware);

// GET /api/tasks/my — current user's assigned + personal tasks
router.get('/my', getMyTasks);

// GET /api/tasks/calendar?month=:m&year=:y&org=:orgId — tasks for the calendar
router.get('/calendar', getCalendarTasks);

// GET /api/tasks?board=:id&group=:id — list tasks for a board/group
router.get('/', getTasks);

// POST /api/tasks — create task (board task: admin only; personal: any user)
router.post('/', createTask);

// PUT /api/tasks/reorder — batch reorder tasks within a target group
// (handles cross-group moves too). Must come BEFORE /:id.
router.put('/reorder', reorderTasks);

// PUT /api/tasks/:id — update task (perms enforced in controller)
router.put('/:id', updateTask);

// DELETE /api/tasks/:id — delete task (admin only for board tasks)
router.delete('/:id', deleteTask);

// GET /api/tasks/:id/subitems — fetch direct children of a task
router.get('/:id/subitems', getSubitems);

// Follow / watch a task — opt into its activity notifications.
router.get('/:id/follow', getFollowState);
router.post('/:id/follow', followTask);
router.delete('/:id/follow', unfollowTask);

// --- Cross-board links + mirrors (F2) -------------------------------------
// Link / unlink rows on a connect_boards column; read a computed mirror value.
router.post('/:id/links/:columnId', linkTask);
router.delete('/:id/links/:columnId/:targetTaskId', unlinkTask);
router.get('/:id/mirror/:columnId', getMirror);

// Checklist routes — any task member can mutate
router.post('/:id/checklist', addChecklistItem);
router.put('/:id/checklist/reorder', reorderChecklist);
router.put('/:id/checklist/:itemId', updateChecklistItem);
router.delete('/:id/checklist/:itemId', deleteChecklistItem);

// Attachment routes — Files tab in the task detail panel.
router.get('/:id/attachments', getTaskAttachments);
router.post(
  '/:id/attachments',
  taskAttachmentUpload.single('file'),
  handleUploadError,
  uploadTaskAttachment
);
router.delete('/:id/attachments/:attachmentId', deleteTaskAttachment);

module.exports = router;

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
  setTaskPinned,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  reorderChecklist,
  getTaskAttachments,
  uploadTaskAttachment,
  deleteTaskAttachment,
  getClientRequest,
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

// POST /api/tasks — create task. Board task: requires `task.create` (the
// `contribute` rung and up). Naming assignees additionally requires
// `task.assign`. Personal task: any user, no board permissions consulted.
router.post('/', createTask);

// PUT /api/tasks/reorder — batch reorder tasks within a target group
// (handles cross-group moves too). Must come BEFORE /:id.
router.put('/reorder', reorderTasks);

// PUT /api/tasks/:id — update task (perms enforced in controller)
router.put('/:id', updateTask);

// DELETE /api/tasks/:id — delete task. Board task: requires `task.delete`
// (the `edit` rung). Personal task: its creator only.
router.delete('/:id', deleteTask);

// GET /api/tasks/:id/subitems — fetch direct children of a task
router.get('/:id/subitems', getSubitems);

// PUT /api/tasks/:id/pin — team pin/unpin. Floats the task to the top of its
// group for everyone on the board; never writes `order`, so an unpin returns
// the row to its real position. Requires `task.move` (same authority as
// reordering, since it changes where the row sits for other people).
router.put('/:id/pin', setTaskPinned);

// Follow / watch a task — opt into its activity notifications.
router.get('/:id/follow', getFollowState);
router.post('/:id/follow', followTask);
router.delete('/:id/follow', unfollowTask);

// --- Cross-board links + mirrors (F2) -------------------------------------
// Link / unlink rows on a connect_boards column; read a computed mirror value.
router.post('/:id/links/:columnId', linkTask);
router.delete('/:id/links/:columnId/:targetTaskId', unlinkTask);
router.get('/:id/mirror/:columnId', getMirror);

// Checklist routes — checklist items are task CONTENT, so they answer to the
// same rule as editing the task itself: `task.edit_any`, or `task.edit_assigned`
// on a task you are assigned to or created. Board read access alone is not
// enough (see `requireTaskEdit` in taskController).
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

// GET /api/tasks/:id/client-request — the Client Portal request behind this task
// (title, details, and the files the client attached when raising it), shown as
// the opening message of the Client thread.
router.get('/:id/client-request', getClientRequest);

module.exports = router;

import api from './api';

/**
 * GET /api/tasks?board=:id&group=:id&month=YYYY-MM
 *
 * List tasks for a board (optionally filtered by group, and by month on a
 * monthly board — where the server REQUIRES it, rather than silently returning
 * every task the board has ever had).
 */
export const getTasks = async (boardId, { group, month } = {}) => {
  const params = { board: boardId };
  if (group) params.group = group;
  if (month) params.month = month;
  const { data } = await api.get('/api/tasks', { params });
  return data.tasks;
};

/**
 * GET /api/tasks/my?org=:orgId — current user's assigned + personal tasks.
 *
 * Assigned board tasks are scoped to the given organisation; personal tasks
 * are always included (they have no organisation).
 */
export const getMyTasks = async (orgId) => {
  const params = {};
  if (orgId) params.org = orgId;
  const { data } = await api.get('/api/tasks/my', { params });
  return data.tasks;
};

/**
 * GET /api/tasks/calendar?month=:m&year=:y&org=:orgId
 *
 * Return tasks with a `dueDate` in the given month. `month` is 1-12.
 * Admins get all board tasks; regular users get only assigned tasks on
 * public boards. Personal tasks are always included for the current user.
 */
export const getCalendarTasks = async (month, year, orgId) => {
  const params = { month, year };
  if (orgId) params.org = orgId;
  const { data } = await api.get('/api/tasks/calendar', { params });
  return data.tasks;
};

/**
 * POST /api/tasks — create a task.
 *
 * For board tasks, payload requires: name, board, group, priority, status,
 * assignedTo (string[]), dueDate (optional ISO string), note (optional).
 * For personal tasks, pass `isPersonal: true` (no board/group).
 */
export const createTask = async (payload) => {
  const { data } = await api.post('/api/tasks', payload);
  // When a positioning automation ran, the server returns the settled group
  // order so the board can drop the task straight into its final spot. Attach
  // it to the returned task; callers that don't need it ignore the extra field.
  if (data.groupTasks) {
    return { ...data.task, groupTasks: data.groupTasks };
  }
  return data.task;
};

/**
 * PUT /api/tasks/:id — update a task. Partial update; only include the fields
 * to change.
 */
export const updateTask = async (id, payload) => {
  const { data } = await api.put(`/api/tasks/${id}`, payload);
  return data.task;
};

/**
 * PUT /api/tasks/:id/pin — team pin/unpin. `value` is explicit rather than a
 * toggle so a double-click can't race itself into the wrong state. Returns the
 * updated task.
 */
export const setTaskPinned = async (id, value) => {
  const { data } = await api.put(`/api/tasks/${id}/pin`, { value });
  return data.task;
};

/**
 * PUT /api/tasks/:id/portal-share — show this task in the client's portal, or
 * take it back out. Client Portal boards only. `value` is explicit for the same
 * reason as the pin: a double-click must not be able to land on "visible to the
 * client" by accident. Returns the updated task.
 */
export const setTaskPortalShared = async (id, value) => {
  const { data } = await api.put(`/api/tasks/${id}/portal-share`, { value });
  return data.task;
};

/**
 * DELETE /api/tasks/:id — delete a task.
 */
export const deleteTask = async (id) => {
  const { data } = await api.delete(`/api/tasks/${id}`);
  return data;
};

/**
 * GET /api/boards/:boardId/groups — list groups for a board.
 *
 * Groups are a task-adjacent concept and are used exclusively by the
 * board detail view, so we keep the API call alongside the task service.
 */
export const getGroups = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/groups`);
  return data.groups;
};

/**
 * POST /api/boards/:boardId/groups — create a new group (admin only).
 * Returns the full payload: { group, inviteSent } (inviteSent is only meaningful
 * on client boards where a clientEmail was supplied).
 */
export const createGroup = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/groups`, payload);
  return data;
};

/**
 * PUT /api/groups/:id — update a group's `name` and/or `order` (admin only).
 * Rejects a name that duplicates another group on the same board with a 409.
 * Never touches `portalClientName` — the client-facing label on a client board
 * is owned by the portal config screen, not by the group's internal name.
 */
export const updateGroup = async (groupId, payload) => {
  const { data } = await api.put(`/api/groups/${groupId}`, payload);
  return data.group;
};

/**
 * DELETE /api/groups/:id — delete a group and all its tasks (admin only).
 */
export const deleteGroup = async (groupId) => {
  const { data } = await api.delete(`/api/groups/${groupId}`);
  return data;
};

/**
 * PUT /api/boards/:boardId/groups/reorder — batch reorder groups on a board.
 */
export const reorderGroups = async (boardId, orderedIds) => {
  const { data } = await api.put(`/api/boards/${boardId}/groups/reorder`, {
    orderedIds,
  });
  return data.groups;
};

/**
 * PUT /api/tasks/reorder — reorder tasks within a target group, optionally
 * pulling in tasks from other groups on the same board. Server returns the
 * updated task list for the target group.
 */
export const reorderTasks = async (targetGroupId, orderedIds) => {
  const { data } = await api.put('/api/tasks/reorder', {
    targetGroupId,
    orderedIds,
  });
  return data;
};

/**
 * POST /api/tasks/:id/checklist — append a new checklist item.
 */
export const addChecklistItem = async (taskId, text) => {
  const { data } = await api.post(`/api/tasks/${taskId}/checklist`, { text });
  return data.task;
};

/**
 * PUT /api/tasks/:id/checklist/:itemId — toggle done and/or rename an item.
 * Pass any subset of { text, done }.
 */
export const updateChecklistItem = async (taskId, itemId, patch) => {
  const { data } = await api.put(`/api/tasks/${taskId}/checklist/${itemId}`, patch);
  return data.task;
};

/**
 * DELETE /api/tasks/:id/checklist/:itemId
 */
export const deleteChecklistItem = async (taskId, itemId) => {
  const { data } = await api.delete(`/api/tasks/${taskId}/checklist/${itemId}`);
  return data.task;
};

/**
 * PUT /api/tasks/:id/checklist/reorder — reorder the whole checklist.
 */
export const reorderChecklist = async (taskId, orderedIds) => {
  const { data } = await api.put(`/api/tasks/${taskId}/checklist/reorder`, {
    orderedIds,
  });
  return data.task;
};

/**
 * GET /api/tasks/:id/subitems — list direct children of a task.
 */
export const getSubitems = async (taskId) => {
  const { data } = await api.get(`/api/tasks/${taskId}/subitems`);
  return data.tasks;
};

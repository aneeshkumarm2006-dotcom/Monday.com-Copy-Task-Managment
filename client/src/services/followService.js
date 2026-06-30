import api from './api';

/**
 * GET /api/tasks/:id/follow — is the current user following (watching) this task?
 */
export const getFollowState = async (taskId) => {
  const { data } = await api.get(`/api/tasks/${taskId}/follow`);
  return data.following;
};

/**
 * POST /api/tasks/:id/follow — follow (watch) a task.
 */
export const followTask = async (taskId) => {
  const { data } = await api.post(`/api/tasks/${taskId}/follow`);
  return data.following;
};

/**
 * DELETE /api/tasks/:id/follow — unfollow a task.
 */
export const unfollowTask = async (taskId) => {
  const { data } = await api.delete(`/api/tasks/${taskId}/follow`);
  return data.following;
};

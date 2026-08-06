import api from './api';

export const updateProfile = async ({ name }) => {
  const { data } = await api.put('/api/profile', { name });
  return data.user;
};

/**
 * Toggle the current user's opt-in extras. Partial — send only what changed,
 * e.g. { activityExport: true }.
 */
export const updateFeatures = async (features) => {
  const { data } = await api.put('/api/profile/features', features);
  return data.user;
};

export const uploadAvatar = async (file) => {
  const formData = new FormData();
  formData.append('avatar', file);
  const { data } = await api.post('/api/profile/upload-avatar', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
};

export const deleteAccount = async () => {
  await api.delete('/api/profile');
};

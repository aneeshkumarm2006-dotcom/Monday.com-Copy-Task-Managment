import api from './api';

export const createOrg = async (name) => {
  const { data } = await api.post('/api/orgs', { name });
  return data.org;
};

/**
 * Returns `{ org, permissions }`. `permissions` is the server's RESOLVED answer
 * for the current user — `{ role, isOwner, capabilities[] }` — so the client never
 * re-derives "is this person an admin" from the raw org arrays again.
 */
export const getOrg = async (orgId) => {
  const { data } = await api.get(`/api/orgs/${orgId}`);
  return data; // { org, permissions }
};

export const joinOrg = async (inviteCode) => {
  const { data } = await api.post(`/api/orgs/join/${inviteCode}`);
  return data.org;
};

export const listMembers = async (orgId) => {
  const { data } = await api.get(`/api/orgs/${orgId}/members`);
  return data; // { members, adminId, adminIds, memberRoles, roles, permissions }
};

/**
 * Assign a role to a member. `roleId` is a role's _id — including custom roles.
 * (The old API could only toggle the strings 'admin' | 'member', which is what
 * made the whole model so coarse.)
 */
export const assignRole = async (orgId, userId, roleId) => {
  const { data } = await api.put(`/api/orgs/${orgId}/members/${userId}/role`, {
    roleId,
  });
  return data; // { message, role, adminIds }
};

// --- roles: the permissions matrix ------------------------------------------

/** `{ roles, catalog, assignments, canManage }` — the whole matrix in one call. */
export const listRoles = async (orgId) => {
  const { data } = await api.get(`/api/orgs/${orgId}/roles`);
  return data;
};

export const createRole = async (orgId, payload) => {
  const { data } = await api.post(`/api/orgs/${orgId}/roles`, payload);
  return data.role;
};

export const updateRole = async (orgId, roleId, payload) => {
  const { data } = await api.put(`/api/orgs/${orgId}/roles/${roleId}`, payload);
  return data.role;
};

export const deleteRole = async (orgId, roleId) => {
  const { data } = await api.delete(`/api/orgs/${orgId}/roles/${roleId}`);
  return data; // { message, reassigned }
};

export const removeMember = async (orgId, userId) => {
  const { data } = await api.delete(`/api/orgs/${orgId}/members/${userId}`);
  return data;
};

export const regenerateInvite = async (orgId) => {
  const { data } = await api.post(`/api/orgs/${orgId}/regenerate-invite`);
  return data.inviteCode;
};

export const sendInvite = async (orgId, email) => {
  const { data } = await api.post(`/api/orgs/${orgId}/send-invite`, { email });
  return data;
};

/**
 * POST /api/orgs/:id/transfer-ownership — make another member the workspace owner.
 *
 * Owner-only, and not a capability anyone can be granted. The outgoing owner is
 * left holding the `admin` role rather than demoted to Member. Returns
 * `{ message, org, permissions }`, where `permissions` is the CALLER's freshly
 * resolved set — after a transfer they are no longer the owner.
 */
export const transferOrgOwnership = async (orgId, userId) => {
  const { data } = await api.post(`/api/orgs/${orgId}/transfer-ownership`, {
    userId,
  });
  return data;
};

export const deleteOrg = async (orgId) => {
  const { data } = await api.delete(`/api/orgs/${orgId}`);
  return data;
};

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

// --- company holidays --------------------------------------------------------
//
// Reading is open to any member; writing needs `org.manage_settings`. Every
// write returns the WHOLE list, so the store replaces rather than merges and
// two tabs cannot drift.

/** `{ holidays }` — the whole calendar, or one year with `year`. */
export const listHolidays = async (orgId, year) => {
  const { data } = await api.get(`/api/orgs/${orgId}/holidays`, {
    params: year ? { year } : undefined,
  });
  return data.holidays;
};

/**
 * Replace ONE year's holidays. The server rejects any date outside `year`
 * rather than filing it, so a stale tab cannot smuggle a neighbouring year in
 * and have the next save of that year wipe it.
 */
export const saveHolidays = async (orgId, year, holidays) => {
  const { data } = await api.put(`/api/orgs/${orgId}/holidays`, { year, holidays });
  return data.holidays;
};

/**
 * Mark one day, or change part of one — the quick path from a calendar cell.
 *
 * PARTIAL on a day that already exists: pass only what you are changing and the
 * rest is left alone, so the name flush and an effect toggle cannot overwrite
 * each other when they overlap. On a NEW day an omitted `affects` means both,
 * which is what a holiday means unqualified.
 */
export const setHoliday = async (orgId, date, name, affects) => {
  const body = {};
  if (name !== undefined) body.name = name;
  if (affects !== undefined) body.affects = affects;
  const { data } = await api.put(`/api/orgs/${orgId}/holidays/${date}`, body);
  return data.holidays;
};

export const deleteHoliday = async (orgId, date) => {
  const { data } = await api.delete(`/api/orgs/${orgId}/holidays/${date}`);
  return data.holidays;
};

/**
 * GET /api/orgs/:id/service-catalog — the workspace's reusable service names,
 * behind the invite table's "catalog + free text" picker. Returns `services`,
 * best-used-first. Read-only: entries are minted by USING a service, never by a
 * form, so there is deliberately no create/update sibling here.
 */
export const getServiceCatalog = async (orgId) => {
  const { data } = await api.get(`/api/orgs/${orgId}/service-catalog`, { timeout: 20000 });
  return data;
};

// --- currency + exchange rates ----------------------------------------------
//
// Same split as the holidays above, and for the same reason: every screen in
// the product renders money, so reading is open to any member, while changing
// it needs `org.manage_settings`. Every write returns the WHOLE settings object
// so the store replaces rather than merges.

/** `{ baseCurrency, provider, cadence, hasApiKey, keyPreview, lastFetchAt, lastError }`. */
export const getCurrencySettings = async (orgId) => {
  const { data } = await api.get(`/api/orgs/${orgId}/currency`);
  return data.currency;
};

/**
 * Change part of the workspace's currency setup.
 *
 * PARTIAL: pass only what you are changing. The settings screen saves one
 * control at a time, and a whole-object write would mean changing the cadence
 * silently re-sent — or cleared — the API key.
 *
 * `apiKey: null` REMOVES the stored credential, which is deliberately different
 * from omitting the field. Without the distinction there is no way to
 * disconnect a key once one has been set.
 *
 * The key is never returned by anything, here or anywhere: the server replies
 * with a four-character preview so the screen can tell two keys apart.
 */
export const saveCurrencySettings = async (orgId, patch) => {
  const { data } = await api.put(`/api/orgs/${orgId}/currency`, patch);
  return data.currency;
};

// --- logo -------------------------------------------------------------------
// POST multipart (`logo`) replaces, DELETE removes. Both return `{ logo }` —
// the new URL, or '' — which is all the caller needs to patch its copy.
export const uploadOrgLogo = async (id, file) => {
  const form = new FormData();
  form.append('logo', file);
  const { data } = await api.post(`/api/orgs/${id}/logo`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data.logo || '';
};

export const removeOrgLogo = async (id) => {
  await api.delete(`/api/orgs/${id}/logo`);
  return '';
};

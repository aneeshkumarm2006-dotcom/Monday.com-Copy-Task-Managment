import axios from 'axios';

/**
 * A DEDICATED axios instance for the external Client Portal. It is deliberately
 * NOT the app's shared `api.js`: portal auth uses its own token key
 * (`macan_portal_token`), and a 401 here must not drop the app user's session or
 * bounce to /login — it just clears the portal token so the dashboard can show a
 * "session expired" state. Same origin/baseURL as the app, so no CORS change.
 */
const PORTAL_TOKEN_KEY = 'macan_portal_token';

export const getPortalToken = () => localStorage.getItem(PORTAL_TOKEN_KEY);
export const setPortalToken = (token) =>
  localStorage.setItem(PORTAL_TOKEN_KEY, token);
export const clearPortalToken = () =>
  localStorage.removeItem(PORTAL_TOKEN_KEY);

const portalApi = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  // Surface hangs as errors instead of an endless spinner.
  timeout: 20000,
});

portalApi.interceptors.request.use((config) => {
  const token = getPortalToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

portalApi.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Portal session expired/invalid — drop it; the dashboard reacts.
      clearPortalToken();
    }
    return Promise.reject(error);
  }
);

// ---- Public (pre-sign-in) ----
export const getPortalMeta = (portalToken) =>
  portalApi.get(`/api/portal/${portalToken}`).then((r) => r.data);

export const requestMagicLink = (portalToken, { email, passcode }) =>
  portalApi
    .post(`/api/portal/${portalToken}/request-link`, { email, passcode })
    .then((r) => r.data);

export const verifyMagicLink = (token) =>
  portalApi.get(`/api/portal/verify`, { params: { token } }).then((r) => r.data);

// ---- Client dashboard (portal-authenticated) ----
export const getMyIssues = () =>
  portalApi.get('/api/portal/me/issues').then((r) => r.data);

export const createMyIssue = (payload) =>
  portalApi.post('/api/portal/me/issues', payload).then((r) => r.data);

export const uploadIssueAttachment = (issueId, file) => {
  const form = new FormData();
  form.append('file', file);
  return portalApi
    .post(`/api/portal/me/issues/${issueId}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data);
};

export const getIssueThread = (issueId) =>
  portalApi.get(`/api/portal/me/issues/${issueId}/thread`).then((r) => r.data);

export const postThreadMessage = (issueId, payload) =>
  portalApi
    .post(`/api/portal/me/issues/${issueId}/thread`, payload)
    .then((r) => r.data);

export default portalApi;

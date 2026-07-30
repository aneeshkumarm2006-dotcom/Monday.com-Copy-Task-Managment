import axios from 'axios';

/**
 * A DEDICATED axios instance for the external Client Portal. It is deliberately
 * NOT the app's shared `api.js`: portal auth uses its own token key
 * (`macan_portal_token`), and a 401 here must not drop the app user's session or
 * bounce to /login — it just clears the portal token so the dashboard can show a
 * "session expired" state. Same origin/baseURL as the app, so no CORS change.
 */
const PORTAL_TOKEN_KEY = 'macan_portal_token';
// The last group link this browser opened. Kept SEPARATELY from the session
// token and deliberately NOT cleared on 401: it's a public link id, not a
// credential, and remembering it is what lets the expired-session screen offer a
// way back in instead of telling the client to go dig out their email.
const PORTAL_LINK_KEY = 'macan_portal_link';

export const getPortalToken = () => localStorage.getItem(PORTAL_TOKEN_KEY);
export const setPortalToken = (token) =>
  localStorage.setItem(PORTAL_TOKEN_KEY, token);
export const clearPortalToken = () =>
  localStorage.removeItem(PORTAL_TOKEN_KEY);

export const getLastPortalLink = () => localStorage.getItem(PORTAL_LINK_KEY);
export const rememberPortalLink = (portalToken) => {
  if (portalToken) localStorage.setItem(PORTAL_LINK_KEY, portalToken);
};

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

/**
 * The full URL that starts the "Accept invitation" → Google sign-in flow. It's a
 * full-page navigation (not an XHR): the browser goes to the API, which redirects
 * to Google and back to `/portal/verify?ptoken=...`. The API base has no trailing
 * slash in practice, but guard against one just in case.
 */
export const portalGoogleSignInUrl = (portalToken) => {
  const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
  return `${base}/api/portal/${portalToken}/auth/google`;
};

/**
 * Sign in a client who uses a password instead of Google. Unlike the Google
 * flow (a full-page redirect that lands on /portal/verify), this is a plain XHR
 * that answers with the portal JWT — the caller stores it and navigates.
 *
 * A 403 with `code: 'NEEDS_SETUP'` means the address was invited but hasn't
 * chosen a password yet; the UI should point at requestPortalPasswordLink.
 */
export const portalPasswordLogin = (portalToken, email, password) =>
  portalApi
    .post(`/api/portal/${portalToken}/auth/password`, { email, password })
    .then((r) => r.data);

/**
 * Ask for a one-time link to set or reset a password. Always resolves with the
 * same message whether or not the address has access — don't try to infer
 * anything from it.
 */
export const requestPortalPasswordLink = (portalToken, email) =>
  portalApi
    .post(`/api/portal/${portalToken}/auth/password/forgot`, { email })
    .then((r) => r.data);

/** Validate a one-time link before rendering the form → { email, purpose, … }. */
export const checkPortalSetupToken = (portalToken, token) =>
  portalApi
    .get(`/api/portal/${portalToken}/auth/setup/${encodeURIComponent(token)}`)
    .then((r) => r.data);

/** Consume a one-time link: store the password and sign in → { token }. */
export const completePortalPasswordSetup = (portalToken, token, password) =>
  portalApi
    .post(`/api/portal/${portalToken}/auth/setup/${encodeURIComponent(token)}`, { password })
    .then((r) => r.data);

// ---- Client dashboard (portal-authenticated) ----
export const getMyIssues = () =>
  portalApi.get('/api/portal/me/issues').then((r) => r.data);

export const createMyIssue = (payload) =>
  portalApi.post('/api/portal/me/issues', payload).then((r) => r.data);

/**
 * Upload one attachment onto an issue.
 *
 * `onProgress` receives 0-100 so the UI can show a real progress bar — clients
 * on slow connections otherwise stare at a spinner with no idea whether their
 * screenshot is going anywhere. The 20s default timeout is far too tight for a
 * 25MB file (the server's per-file limit), so uploads get their own.
 *
 * `context` says which composer sent the file — 'request' for the intake form,
 * 'thread' for a message. Both end up in the same place on the task, so this is
 * what keeps the request's own screenshots distinguishable from everything
 * attached afterwards, on both this side and the team's.
 */
export const uploadIssueAttachment = (issueId, file, onProgress, context = 'thread') => {
  const form = new FormData();
  form.append('file', file);
  form.append('context', context);
  return portalApi
    .post(`/api/portal/me/issues/${issueId}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 180000,
      onUploadProgress: (e) => {
        if (!onProgress) return;
        // Cap at 99 until the response lands — 100% should mean "stored", not
        // "finished sending bytes".
        const pct = e.total ? Math.min(99, Math.round((e.loaded * 100) / e.total)) : 0;
        onProgress(pct);
      },
    })
    .then((r) => r.data);
};

export const getIssueThread = (issueId) =>
  portalApi.get(`/api/portal/me/issues/${issueId}/thread`).then((r) => r.data);

export const postThreadMessage = (issueId, payload) =>
  portalApi
    .post(`/api/portal/me/issues/${issueId}/thread`, payload)
    .then((r) => r.data);

export const reopenIssue = (issueId, note) =>
  portalApi
    .post(`/api/portal/me/issues/${issueId}/reopen`, { note })
    .then((r) => r.data);

export const rateIssue = (issueId, rating) =>
  portalApi
    .post(`/api/portal/me/issues/${issueId}/rating`, { rating })
    .then((r) => r.data);

export default portalApi;

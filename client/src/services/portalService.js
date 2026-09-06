import axios from 'axios';

/**
 * A DEDICATED axios instance for the external Client Portal. It is deliberately
 * NOT the app's shared `api.js`: portal auth uses its own token key
 * (`macan_portal_token`), and a 401 here must not drop the app user's session or
 * bounce to /login — it just clears the portal token so the dashboard can show a
 * "session expired" state. Same origin/baseURL as the app, so no CORS change.
 * The one exception is the public sign-in endpoints, whose 401 means "wrong
 * password", not "your session died" — see PUBLIC_AUTH_PATH below.
 */
const PORTAL_TOKEN_KEY = 'macan_portal_token';
// The last group link this browser opened. Kept SEPARATELY from the session
// token and deliberately NOT cleared on 401: it's a public link id, not a
// credential, and remembering it is what lets the expired-session screen offer a
// way back in instead of telling the client to go dig out their email.
const PORTAL_LINK_KEY = 'macan_portal_link';

/**
 * Fired on `window` whenever the portal token changes IN THIS TAB. The `storage`
 * event only reaches OTHER tabs, so without this a hook watching the token would
 * never learn about the sign-in or the expiry that happened right here — see
 * usePortalStream, which keeps a live EventSource keyed on it.
 */
export const PORTAL_TOKEN_EVENT = 'macan:portal-token';
const announceToken = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PORTAL_TOKEN_EVENT));
  }
};

export const getPortalToken = () => localStorage.getItem(PORTAL_TOKEN_KEY);
export const setPortalToken = (token) => {
  localStorage.setItem(PORTAL_TOKEN_KEY, token);
  announceToken();
};
export const clearPortalToken = () => {
  localStorage.removeItem(PORTAL_TOKEN_KEY);
  announceToken();
};

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

// The PUBLIC, pre-sign-in endpoints. They answer a wrong password (and a
// spent/none-of-your-business setup token) with a 401 that says nothing about
// the session the browser may already hold — the emailed /portal/<token> link is
// the client's bookmark, so a signed-in client fumbling a password here used to
// log themselves out of the session they arrived with.
const PUBLIC_AUTH_PATH = /\/auth\/(password|setup)(\/|$)/;

portalApi.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || '';
    if (error.response?.status === 401 && !PUBLIC_AUTH_PATH.test(url)) {
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
/**
 * GET /api/portal/me/home — the SERVICE TABLE's single read.
 *
 * Returns the client, the signed-in contact (including a contact id, which no
 * other portal payload carries), and one row per service with its request
 * counts, chat and mail unread, and last activity.
 *
 * Deliberately NOT assembled from getMyIssues + getPortalChannels: the channel
 * list drops a service that has no rooms yet, which would make a service the
 * client is paying for vanish from their own home screen.
 */
export const getPortalHome = () =>
  portalApi.get('/api/portal/me/home').then((r) => r.data);

/**
 * `service` narrows the list to one service, which is what makes the home
 * table's counts clickable. The server validates the id against the board in
 * the token before it trusts it.
 */
export const getMyIssues = (service = null) =>
  portalApi
    .get('/api/portal/me/issues', service ? { params: { service } } : undefined)
    .then((r) => r.data);

/** The client's own "email me about new messages" switch. */
export const getPortalPreferences = () =>
  portalApi.get('/api/portal/me/preferences').then((r) => r.data);

export const updatePortalPreferences = (patch) =>
  portalApi.patch('/api/portal/me/preferences', patch).then((r) => r.data);

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

/* ---- Client chat & mail (portal-authenticated) ----------------------------
 * The CLIENT plane of the messaging feature. Every one of these lives under
 * `/api/portal/me/chat` and is answered with the portal's own message shape —
 * deliberately not the team's, which carries colleagues' email addresses. They
 * all 403 unless the board is a client board on the `advanced` tier, so a basic
 * portal simply never renders the tabs.
 * -------------------------------------------------------------------------- */
const CHAT = '/api/portal/me/chat';

/** Every client surface this contact can see, grouped by workstream. */
export const getPortalChannels = () =>
  portalApi.get(`${CHAT}/channels`).then((r) => r.data);

/**
 * A page of messages. Default: NEWEST FIRST plus a `nextBefore` cursor — pass
 * it back as `{ before }` for the previous page. `{ thread: id }` switches the
 * response to a single thread (`{ parent, replies }`, replies oldest-first).
 */
export const getPortalMessages = (channelId, params) =>
  portalApi
    .get(`${CHAT}/channels/${channelId}/messages`, { params })
    .then((r) => r.data);

export const sendPortalMessage = (channelId, payload) =>
  portalApi
    .post(`${CHAT}/channels/${channelId}/messages`, payload)
    .then((r) => r.data);

/**
 * Upload one attachment for a chat/mail message. Same deal as
 * `uploadIssueAttachment`: its own long timeout (the 20s default cannot carry a
 * 25MB file) and real 0-100 progress, because a client on hotel wifi otherwise
 * stares at a spinner with no idea whether their file is moving.
 */
export const uploadPortalChatFile = (channelId, file, onProgress) => {
  const form = new FormData();
  form.append('file', file);
  return portalApi
    .post(`${CHAT}/channels/${channelId}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 180000,
      onUploadProgress: (e) => {
        if (!onProgress) return;
        // Capped at 99 until the response lands — 100% must mean "stored".
        const pct = e.total ? Math.min(99, Math.round((e.loaded * 100) / e.total)) : 0;
        onProgress(pct);
      },
    })
    .then((r) => r.data);
};

/** `at` is optional — omit it and the server reads up to "now". */
export const markPortalChannelRead = (channelId, at) =>
  portalApi
    .post(`${CHAT}/channels/${channelId}/read`, at ? { at } : {})
    .then((r) => r.data);

/** Mail thread list, already sorted by last activity. Never re-sort it. */
export const getPortalThreads = (channelId, params) =>
  portalApi
    .get(`${CHAT}/channels/${channelId}/threads`, { params })
    .then((r) => r.data);

/** Starting a mail thread is the one thing a client may create here. */
export const createPortalThread = (channelId, payload) =>
  portalApi
    .post(`${CHAT}/channels/${channelId}/threads`, payload)
    .then((r) => r.data);

/** Reading ONE thread. Deliberately not channel-wide — the rest stay unread. */
export const markPortalThreadRead = (threadId) =>
  portalApi.post(`${CHAT}/threads/${threadId}/read`).then((r) => r.data);

/**
 * Team members this contact may @mention — names only, no addresses.
 *
 * NOTHING CALLS THIS YET. The route, the handler and the write-path validation
 * for `mentions` are all built, but PortalComposer is a plain textarea with no
 * mention affordance, so a client cannot produce one. Kept (rather than deleted
 * with its route) because the missing half is the composer, not this: wire the
 * autocomplete and the whole path works. Don't delete one end without the other.
 */
export const getPortalMentions = () =>
  portalApi.get(`${CHAT}/mentions`).then((r) => r.data);

/**
 * The SSE endpoint, as an absolute URL with the portal token in the query
 * string — `EventSource` cannot send an Authorization header, so the token has
 * to travel this way. Built off the same base as `portalGoogleSignInUrl`.
 * Returns '' when there is no session, so callers can skip connecting.
 */
export const portalStreamUrl = () => {
  const token = getPortalToken();
  if (!token) return '';
  const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
  return `${base}/api/portal/me/stream?token=${encodeURIComponent(token)}`;
};

export default portalApi;

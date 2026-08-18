import axios from 'axios';
import useToastStore from '../store/toastStore';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('macan_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * A 401 that is NOT about the app session.
 *
 * The board vault has a second, short-lived token of its own, and its routes
 * answer 401 in two entirely routine situations: someone typed the wrong vault
 * password, and a 15-minute unlock lapsed. Both are the vault saying "locked",
 * not the server saying "who are you".
 *
 * Without this distinction the handler below would delete `macan_token` and
 * sign the user out of the whole application because they fat-fingered a vault
 * password — or, worse, silently every quarter-hour that a vault sat open.
 *
 * The vault marks those responses with a `code`, so they are identifiable
 * rather than guessed at. Anything without one is still treated as a dead
 * session, which keeps the default fail-safe.
 */
const VAULT_401_CODES = new Set(['VAULT_DENIED', 'VAULT_LOCKED', 'VAULT_LOCKED_OUT']);

api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Callers can opt out of the global toast by setting
    // `config.suppressErrorToast = true` on their request.
    const suppress = error.config?.suppressErrorToast;

    if (error.response) {
      const status = error.response.status;
      const scopedLock = VAULT_401_CODES.has(error.response.data?.code);
      if (status === 401 && !scopedLock) {
        // Token invalid/expired — drop it so the app redirects to /login
        localStorage.removeItem('macan_token');
      } else if (!suppress && status >= 500) {
        useToastStore
          .getState()
          .error('Something went wrong on our end. Please try again.');
      }
    } else if (error.request && !suppress) {
      // No response at all — network error
      useToastStore
        .getState()
        .error('Network error. Check your connection and try again.');
    }
    return Promise.reject(error);
  }
);

export default api;

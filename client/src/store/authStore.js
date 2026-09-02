import { create } from 'zustand';
import * as authService from '../services/authService';
import useOrgStore from './orgStore';
import useVaultStore from './vaultStore';

const TOKEN_KEY = 'macan_token';

/**
 * Tell the server what timezone this browser resolves to, if it differs from
 * what the account has stored. Fire-and-forget on purpose: the 9am due-task
 * digest is the only consumer, nothing on this screen depends on the answer,
 * and a failed sync must never surface as an error on app load — the digest
 * simply keeps using the previous zone until the next visit.
 */
const syncTimezone = (user) => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || user?.timezone === zone) return;
    import('../services/api').then(({ default: api }) =>
      api.put('/api/profile/timezone', { timezone: zone }, { suppressErrorToast: true })
    ).catch(() => {});
  } catch {
    /* Intl unavailable — nothing to sync */
  }
};

const useAuthStore = create((set, get) => ({
  user: null,
  token: localStorage.getItem(TOKEN_KEY) || null,
  isAuthenticated: !!localStorage.getItem(TOKEN_KEY),
  loading: false,

  login: (token) => {
    localStorage.setItem(TOKEN_KEY, token);
    set({ token, isAuthenticated: true });
  },

  logout: async () => {
    await authService.logout();
    localStorage.removeItem(TOKEN_KEY);
    useOrgStore.getState().clearOrgs();
    // Drop any unlocked vault key with the session. The vault store is never
    // persisted, so a reload would clear it anyway — but signing out on a shared
    // machine must not leave the key sitting in the tab the next person uses.
    useVaultStore.getState().lock();
    set({ user: null, token: null, isAuthenticated: false });
  },

  fetchCurrentUser: async () => {
    const token = get().token;
    if (!token) return null;

    set({ loading: true });
    try {
      const user = await authService.getCurrentUser();
      set({ user, isAuthenticated: true, loading: false });
      syncTimezone(user);
      return user;
    } catch (err) {
      // Token is bad — clear state
      localStorage.removeItem(TOKEN_KEY);
      set({ user: null, token: null, isAuthenticated: false, loading: false });
      return null;
    }
  },
}));

export default useAuthStore;

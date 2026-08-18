import { create } from 'zustand';
import * as authService from '../services/authService';
import useOrgStore from './orgStore';
import useVaultStore from './vaultStore';

const TOKEN_KEY = 'macan_token';

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

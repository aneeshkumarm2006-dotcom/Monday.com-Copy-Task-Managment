import { create } from 'zustand';
import * as authService from '../services/authService';
import useOrgStore from './orgStore';
import useVaultStore from './vaultStore';
import { clearAllDrafts } from '../utils/updateDrafts';

const TOKEN_KEY = 'macan_token';

/**
 * The reader's chosen display currency, mirrored locally.
 *
 * `user` hydrates asynchronously on every cold load, so without this a reload
 * paints every figure in the currency it is stored in and then visibly
 * re-renders into the chosen one. For a number somebody reads aloud on a call,
 * a value that changes after first paint is a distinct hazard from a spinner.
 *
 * The `macan_*` family, like `macan_token` and `macan_current_org`, because
 * this is session state rather than a per-board view preference (those use
 * `<scope>:<thing>:<id>` — see `utils/deliveryPrefs.js`).
 *
 * The SERVER is still the source of truth. This is a first-paint guess that the
 * profile fetch overwrites moments later, and it is cleared on logout: unlike a
 * draft it holds nobody's work, so there is no reason to let it seed the next
 * person's first paint on a shared browser.
 */
export const DISPLAY_CURRENCY_KEY = 'macan_display_currency';

/** The mirrored choice, or null. Fails soft — a private window throws on read. */
export const readStoredCurrency = () => {
  try {
    return localStorage.getItem(DISPLAY_CURRENCY_KEY) || null;
  } catch {
    return null;
  }
};

const writeStoredCurrency = (code) => {
  try {
    if (code) localStorage.setItem(DISPLAY_CURRENCY_KEY, code);
    else localStorage.removeItem(DISPLAY_CURRENCY_KEY);
  } catch {
    // Storage disabled. The choice still works for this session; it just will
    // not survive a reload without a flash.
  }
};

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

  /**
   * `purgeLocal` is for the one-way door: ACCOUNT DELETION, not an ordinary
   * sign-out.
   *
   * A draft is kept in localStorage precisely so it survives a reload, and
   * signing out and back in on your own machine is the everyday case where
   * somebody expects their half-written comment to still be there. Wiping on
   * every logout would fix a leak by introducing routine data loss, so the
   * default is to leave them; the deletion path, where there is no coming back
   * and the residue would be permanent (the only other sweeper is a 30-day age
   * check that runs inside an Updates composer nobody will ever open again),
   * passes true.
   */
  /**
   * Change which currency this person reads money in.
   *
   * Writes the mirror FIRST so a reload during the request still paints the new
   * choice, then patches `user` locally rather than re-fetching the whole
   * profile — the server returns only the one field, and a full refetch would
   * make a currency toggle cost a profile round trip.
   */
  setDisplayCurrency: async (code) => {
    const next = code || null;
    writeStoredCurrency(next);
    set((s) => (s.user ? { user: { ...s.user, displayCurrency: next } } : {}));
    const { default: api } = await import('../services/api');
    await api.put('/api/profile/currency', { displayCurrency: next });
    return next;
  },

  logout: async ({ purgeLocal = false } = {}) => {
    // Read the id BEFORE the state is cleared — the draft sweep is scoped to
    // this person's keys, and after `set()` there is nobody left to scope it to.
    const userId = get().user?._id || null;
    await authService.logout();
    localStorage.removeItem(TOKEN_KEY);
    // Holds nobody's work, so unlike the drafts below it goes on every logout.
    writeStoredCurrency(null);
    useOrgStore.getState().clearOrgs();
    // Drop any unlocked vault key with the session. The vault store is never
    // persisted, so a reload would clear it anyway — but signing out on a shared
    // machine must not leave the key sitting in the tab the next person uses.
    useVaultStore.getState().lock();
    // Unsent Updates prose — deletion only, see `purgeLocal` above. Scoped to
    // this user's keys (plus the `anon:` bucket, which belongs to no session) so
    // two people sharing a browser cannot wipe each other's half-written notes.
    if (purgeLocal) clearAllDrafts(userId);
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
      // Keep the first-paint mirror honest. The server just told us what this
      // person actually chose, which may differ from what this browser cached
      // (they changed it elsewhere, or somebody else used this browser).
      writeStoredCurrency(user?.displayCurrency || null);
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

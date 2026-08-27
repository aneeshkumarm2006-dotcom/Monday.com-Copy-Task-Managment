import { create } from 'zustand';
import * as orgService from '../services/orgService';
import * as authService from '../services/authService';
import usePermissionStore from './permissionStore';

const CURRENT_ORG_KEY = 'macan_current_org';

const useOrgStore = create((set, get) => ({
  currentOrg: null,
  orgs: [],
  members: [],
  adminId: null,
  adminIds: [],
  /** userId -> { id, key, name, color } — each member's resolved role. */
  memberRoles: {},
  /** The org's role list, for the assignment dropdown. */
  roles: [],
  loading: false,
  // --- company holidays ------------------------------------------------------
  //
  // The workspace holiday calendar, cached here beside `currentOrg` because that
  // is its scope. Loaded once per org and refreshed only by a write: it changes
  // a few times a year, and every date-aware screen in the app reads it, so
  // re-fetching per screen would be a lot of requests for a list that is almost
  // always identical.
  //
  // Every mutator REPLACES the list from the server's response rather than
  // patching locally — the same no-optimistic-update rule the board chips
  // follow, and for the same reason: the server is the one that de-duplicates,
  // sorts and caps.

  /** [{ date: 'YYYY-MM-DD', name }] — the whole calendar, every year. */
  holidays: [],
  /** The org id `holidays` was loaded for; null means "not loaded yet". */
  holidaysLoadedFor: null,

  fetchHolidays: async (orgId) => {
    const id = orgId || get().currentOrg?._id;
    if (!id) return [];
    try {
      const holidays = await orgService.listHolidays(id);
      set({ holidays, holidaysLoadedFor: id });
      return holidays;
    } catch (err) {
      // A member without the org loaded yet, or an offline blip. Holidays are
      // decoration on every screen except Settings, so failing to load them
      // must never break the screen that asked.
      console.error('fetchHolidays failed:', err);
      return get().holidays;
    }
  },

  /** Load once per org. Safe to call from every screen that paints a day. */
  ensureHolidays: async (orgId) => {
    const id = orgId || get().currentOrg?._id;
    if (!id || get().holidaysLoadedFor === id) return get().holidays;
    return get().fetchHolidays(id);
  },

  /** Replace one year wholesale — the Settings year grid's save. */
  saveHolidays: async (orgId, year, holidays) => {
    const next = await orgService.saveHolidays(orgId, year, holidays);
    set({ holidays: next, holidaysLoadedFor: orgId });
    return next;
  },

  /** Mark one day — the quick path from a calendar cell. */
  setHoliday: async (orgId, date, name = '') => {
    const next = await orgService.setHoliday(orgId, date, name);
    set({ holidays: next, holidaysLoadedFor: orgId });
    return next;
  },

  deleteHoliday: async (orgId, date) => {
    const next = await orgService.deleteHoliday(orgId, date);
    set({ holidays: next, holidaysLoadedFor: orgId });
    return next;
  },


  /**
   * Hydrate orgs list from a user object (usually from authStore).
   * Also restores the last-selected currentOrg from localStorage, or defaults
   * to the first org.
   */
  setOrgsFromUser: (user) => {
    const orgs = Array.isArray(user?.organisations) ? user.organisations : [];
    const savedId = localStorage.getItem(CURRENT_ORG_KEY);
    const current =
      orgs.find((o) => o._id === savedId) || orgs[0] || null;

    if (current) {
      localStorage.setItem(CURRENT_ORG_KEY, current._id);
    }
    set({ orgs, currentOrg: current });
    usePermissionStore.getState().fetchPermissions(current?._id || null);
  },

  /**
   * Re-fetch the list of organisations the current user belongs to.
   * Uses /auth/me since there is no dedicated "my orgs" endpoint.
   */
  fetchOrgs: async () => {
    set({ loading: true });
    try {
      const user = await authService.getCurrentUser();
      const orgs = Array.isArray(user?.organisations) ? user.organisations : [];
      const savedId = localStorage.getItem(CURRENT_ORG_KEY);
      const current =
        orgs.find((o) => o._id === savedId) || orgs[0] || null;
      if (current) {
        localStorage.setItem(CURRENT_ORG_KEY, current._id);
      }
      set({ orgs, currentOrg: current, loading: false });
      usePermissionStore.getState().fetchPermissions(current?._id || null);
      return orgs;
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  setCurrentOrg: (orgId) => {
    const org = get().orgs.find((o) => o._id === orgId);
    if (org) {
      localStorage.setItem(CURRENT_ORG_KEY, org._id);
      // Capabilities are per-org. Switching workspaces must re-resolve them, or
      // the UI keeps rendering affordances earned by the PREVIOUS org's role.
      // Holidays are per-org too, and a stale calendar would shade the wrong
      // days rather than merely showing too much.
      set({
        currentOrg: org,
        members: [],
        memberRoles: {},
        roles: [],
        holidays: [],
        holidaysLoadedFor: null,
      });
      usePermissionStore.getState().fetchPermissions(org._id);
    }
  },

  createOrg: async (name) => {
    const org = await orgService.createOrg(name);
    const orgs = [...get().orgs, org];
    localStorage.setItem(CURRENT_ORG_KEY, org._id);
    set({ orgs, currentOrg: org });
    await usePermissionStore.getState().fetchPermissions(org._id);
    return org;
  },

  joinOrg: async (inviteCode) => {
    const org = await orgService.joinOrg(inviteCode);
    const orgs = get().orgs.some((o) => o._id === org._id)
      ? get().orgs
      : [...get().orgs, org];
    localStorage.setItem(CURRENT_ORG_KEY, org._id);
    set({ orgs, currentOrg: org });
    await usePermissionStore.getState().fetchPermissions(org._id);
    return org;
  },

  /**
   * Members, plus each one's RESOLVED role and the org's role list.
   *
   * `memberRoles` is keyed by user id — the server resolves it (owner → explicit
   * assignment → legacy admins[] → default), so the client never re-implements
   * that order. `adminId` / `adminIds` are still carried for the handful of
   * places that have not been migrated off them yet.
   */
  fetchMembers: async (orgId) => {
    set({ loading: true });
    try {
      const data = await orgService.listMembers(orgId);
      set({
        members: data.members,
        adminId: data.adminId,
        adminIds: data.adminIds || [],
        memberRoles: data.memberRoles || {},
        roles: data.roles || [],
        loading: false,
      });
      // The server ships the caller's own permissions alongside; adopt them so a
      // role change is reflected without a second round trip.
      if (data.permissions) {
        usePermissionStore.getState().setPermissions(data.permissions, orgId);
      }
      return data;
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  /**
   * Hand the workspace to another member. Owner-only on the server.
   *
   * Two things have to be refreshed afterwards, not one: the members table (whose
   * Owner chip and role chips both moved) and the CALLER's own capabilities — the
   * outgoing owner just stopped being the owner, and every owner-only affordance
   * in the app is rendered from `permissionStore`. `fetchMembers` does both,
   * because listMembers ships the caller's resolved permissions alongside.
   *
   * `currentOrg.admin` is patched locally too. It is only a fallback for
   * `adminId` in the members table, but a fallback that disagrees with the server
   * is worse than no fallback at all.
   */
  transferOwnership: async (orgId, userId) => {
    const data = await orgService.transferOrgOwnership(orgId, userId);
    const patch = (o) => (o && o._id === orgId ? { ...o, admin: userId } : o);
    set((s) => ({
      orgs: s.orgs.map(patch),
      currentOrg: patch(s.currentOrg),
    }));
    await get().fetchMembers(orgId);
    return data;
  },

  clearOrgs: () => {
    localStorage.removeItem(CURRENT_ORG_KEY);
    usePermissionStore.getState().clear();
    set({
      currentOrg: null,
      orgs: [],
      members: [],
      adminId: null,
      adminIds: [],
      memberRoles: {},
      roles: [],
    });
  },

  /**
   * Permanently delete an organisation. Owner-only on the server.
   * Drops the org from local state and re-points currentOrg at the next
   * available org (or null if this was the last one). Returns the new
   * currentOrg so callers can route appropriately.
   */
  deleteOrg: async (orgId) => {
    await orgService.deleteOrg(orgId);
    const orgs = get().orgs.filter((o) => o._id !== orgId);
    const nextCurrent =
      get().currentOrg?._id === orgId ? orgs[0] || null : get().currentOrg;
    if (nextCurrent) {
      localStorage.setItem(CURRENT_ORG_KEY, nextCurrent._id);
    } else {
      localStorage.removeItem(CURRENT_ORG_KEY);
    }
    set({
      orgs,
      currentOrg: nextCurrent,
      members: [],
      adminId: null,
      adminIds: [],
      memberRoles: {},
      roles: [],
      holidays: [],
      holidaysLoadedFor: null,
    });
    usePermissionStore.getState().fetchPermissions(nextCurrent?._id || null);
    return nextCurrent;
  },
}));

export default useOrgStore;

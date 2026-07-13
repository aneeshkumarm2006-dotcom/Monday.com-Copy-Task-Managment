import { create } from 'zustand';
import * as orgService from '../services/orgService';

/**
 * The client's copy of what the SERVER says this user may do.
 *
 * The client used to re-derive `isAdmin` itself — an identical
 * `isMainAdmin || isExtraAdmin` block over `org.admin` + `org.admins[]`, copy-pasted
 * into eight places (App.jsx, BoardDetailPage, AnalyticsPage, MyBoardsPage,
 * ProductivityPage, …). Eight chances for a UI gate to drift from what the server
 * actually enforces, and no way to express anything finer than "admin or not".
 *
 * Now the server resolves permission once and ships the answer. The client only
 * reads it. `can()` here and `can()` on the server are the same question with the
 * same answer — the UI can hide what the API would reject, and nothing else.
 *
 * This is a CONVENIENCE, never a security boundary. Every capability is enforced
 * server-side regardless of what the UI chooses to render.
 */
const usePermissionStore = create((set, get) => ({
  /** Capability keys the current user holds ORG-wide. */
  capabilities: [],
  /** { id, key, name, color } — the role they hold. */
  role: null,
  isOwner: false,
  loading: false,
  loadedForOrg: null,

  /**
   * Pull the caller's resolved permissions for `orgId`. Called on org switch and
   * after any role change.
   */
  fetchPermissions: async (orgId) => {
    if (!orgId) {
      set({ capabilities: [], role: null, isOwner: false, loadedForOrg: null });
      return null;
    }
    set({ loading: true });
    try {
      const { permissions } = await orgService.getOrg(orgId);
      set({
        capabilities: permissions?.capabilities || [],
        role: permissions?.role || null,
        isOwner: !!permissions?.isOwner,
        loading: false,
        loadedForOrg: orgId,
      });
      return permissions;
    } catch {
      // Fail CLOSED. A failed permission fetch must not leave stale capabilities
      // from a previous org in place — that would render affordances the user no
      // longer has.
      set({
        capabilities: [],
        role: null,
        isOwner: false,
        loading: false,
        loadedForOrg: orgId,
      });
      return null;
    }
  },

  /**
   * Adopt a permission payload the server already sent alongside something else
   * (listMembers, for instance), so a role change reflects immediately without a
   * second round trip.
   */
  setPermissions: (permissions, orgId) => {
    if (!permissions) return;
    set({
      capabilities: permissions.capabilities || [],
      role: permissions.role || null,
      isOwner: !!permissions.isOwner,
      loadedForOrg: orgId || get().loadedForOrg,
    });
  },

  clear: () =>
    set({ capabilities: [], role: null, isOwner: false, loadedForOrg: null }),
}));

export default usePermissionStore;

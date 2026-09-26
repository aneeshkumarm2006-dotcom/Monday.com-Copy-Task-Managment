import { create } from 'zustand';
import * as orgService from '../services/orgService';
import * as authService from '../services/authService';
import usePermissionStore from './permissionStore';
import useExecutiveViewStore from './executiveViewStore';
import useBoardStore from './boardStore';

const CURRENT_ORG_KEY = 'macan_current_org';

/**
 * The workspace-currency request in flight, and the retry after a failed one.
 *
 * Module-level for the same reason `boardStore` keeps its roster promises out
 * of state: they are plumbing, nothing renders from them, and a set() per
 * request would re-render every money cell on the page for no change.
 *
 * The retry exists because the only caller that loads the currency (App.jsx)
 * runs once per user+org. One dropped request used to leave `currency` null
 * for the rest of the session — survivable now that `useMoney` falls back to
 * `currentOrg.baseCurrency`, but that copy is only as fresh as `/auth/me`, and
 * the Settings tab would sit on an empty form. A few spaced retries recover
 * from a blip without turning an outage into a request storm.
 */
const inFlightCurrency = new Map(); // orgId -> { seq, promise }
/**
 * The newest request started per org, so an OLDER answer can never overwrite a
 * newer one. Needed because `fetchCurrency(id, { force: true })` deliberately
 * starts a second request beside one already in flight — and the first may
 * well land second.
 */
const latestCurrencySeq = new Map(); // orgId -> seq
let currencySeq = 0;
const CURRENCY_RETRY_DELAYS_MS = [5000, 30000, 120000];
let currencyRetry = { orgId: null, attempt: 0, timer: null };

/**
 * When each org's currency was last RE-checked on suspicion (`recheckCurrency`),
 * so a board that really is out of step with the workspace asks the server at
 * most once per window instead of on every render that notices it.
 */
const lastCurrencyRecheck = new Map(); // orgId -> ms
const CURRENCY_RECHECK_MS = 30000;

const clearCurrencyRetry = () => {
  if (currencyRetry.timer) clearTimeout(currencyRetry.timer);
  currencyRetry = { orgId: null, attempt: 0, timer: null };
};

/**
 * Patch `baseCurrency` onto every copy of one org the store holds.
 *
 * `useMoney` reads `currentOrg.baseCurrency` as its first-paint fallback, so a
 * copy that disagrees with the fetched settings would label figures with the
 * workspace's OLD currency the next time `currency` is cleared (an org switch
 * and back) — until a reload re-ran `/auth/me`.
 */
const withBaseCurrency = (orgId, baseCurrency) => (s) => {
  if (!orgId || !baseCurrency) return {};
  const patch = (o) =>
    o && o._id === orgId && o.baseCurrency !== baseCurrency ? { ...o, baseCurrency } : o;
  return { orgs: s.orgs.map(patch), currentOrg: patch(s.currentOrg) };
};

/** What a workspace change resets: settings loaded for the PREVIOUS workspace. */
const freshOrgSettings = () => ({
  holidays: [],
  holidaysLoadedFor: null,
  currency: null,
  currencyLoadedFor: null,
});

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

  /** Mark one day, or change part of one. Omitted fields are left alone. */
  setHoliday: async (orgId, date, name, affects) => {
    const next = await orgService.setHoliday(orgId, date, name, affects);
    set({ holidays: next, holidaysLoadedFor: orgId });
    return next;
  },

  deleteHoliday: async (orgId, date) => {
    const next = await orgService.deleteHoliday(orgId, date);
    set({ holidays: next, holidaysLoadedFor: orgId });
    return next;
  },

  // --- currency ---------------------------------------------------------------
  //
  // The workspace's currency setup, cached beside `holidays` because it has
  // exactly the same shape of life: one small object per org, read by screens
  // all over the product, changed a handful of times ever.
  //
  // `baseCurrency` is the load-bearing field for everyone. The rest — provider,
  // cadence, whether a key is installed — is only ever read by the Currency
  // settings tab, but it arrives in the same request because splitting one
  // small object across two endpoints buys nothing.

  /** `{ baseCurrency, provider, cadence, hasApiKey, keyPreview, ... }` or null. */
  currency: null,
  /** The org id `currency` was loaded for; null means "not loaded yet". */
  currencyLoadedFor: null,

  /**
   * Read the workspace's currency setup from the server.
   *
   * `force: true` skips joining a request already in flight. Sharing is right
   * for the loaders — App.jsx and the Settings tab ask on the same render — but
   * wrong straight after a WRITE the caller knows about: the Settings tab's
   * "Fetch rates now" re-reads to show the new `lastFetchAt` / `lastError`, and
   * joining a request that left before the refresh finished would hand it the
   * state from before the refresh, with nothing to say it was stale.
   */
  fetchCurrency: async (orgId, { force = false } = {}) => {
    const id = orgId || get().currentOrg?._id;
    if (!id) return null;

    // Concurrent callers share one request — App.jsx and the Settings tab both
    // ask on the same render when Settings is the page being opened.
    const existing = inFlightCurrency.get(id);
    if (existing && !force) return existing.promise;

    const seq = ++currencySeq;
    latestCurrencySeq.set(id, seq);
    /**
     * Has a newer request for this org started since this one? Then its answer
     * is the one to keep: this one hands its caller the newer promise (or the
     * store's copy, once that has landed) and writes nothing — neither the
     * settings nor, on failure, a retry the newer request may not need.
     */
    const superseded = () => latestCurrencySeq.get(id) !== seq;
    const newest = () => inFlightCurrency.get(id)?.promise ?? get().currency;

    const request = (async () => {
      try {
        const currency = await orgService.getCurrencySettings(id);
        if (superseded()) return newest();
        if (currencyRetry.orgId === id) clearCurrencyRetry();
        set((s) => {
          // A response for a workspace the user has since switched away from
          // must not land in `currency` — `useMoney` reads that slot without
          // checking whose it is, so it would label the new workspace's
          // figures with the old one's unit. The org record is still patched.
          const stillCurrent = !s.currentOrg || s.currentOrg._id === id;
          return {
            ...(stillCurrent ? { currency, currencyLoadedFor: id } : {}),
            ...withBaseCurrency(id, currency?.baseCurrency)(s),
          };
        });
        return currency;
      } catch (err) {
        // Money still renders without this — `useMoney` falls back to
        // `currentOrg.baseCurrency`, and a column with its own code never needed
        // it. Failing to load a preference must never break the screen that
        // asked for it.
        //
        // `currencyLoadedFor` is deliberately left unset, so the next
        // `ensureCurrency` asks again, and a retry is scheduled because nothing
        // else would call it: App.jsx loads once per user+org.
        console.error('fetchCurrency failed:', err);
        if (superseded()) return newest();
        const attempt = currencyRetry.orgId === id ? currencyRetry.attempt : 0;
        if (attempt < CURRENCY_RETRY_DELAYS_MS.length) {
          clearCurrencyRetry();
          currencyRetry = {
            orgId: id,
            attempt: attempt + 1,
            timer: setTimeout(() => {
              currencyRetry.timer = null;
              // Only if this is still the workspace on screen and nobody has
              // loaded it in the meantime — a retry for an org the user has
              // since left would overwrite the new one's currency.
              if (get().currentOrg?._id === id && get().currencyLoadedFor !== id) {
                get().fetchCurrency(id);
              }
            }, CURRENCY_RETRY_DELAYS_MS[attempt]),
          };
        }
        return get().currency;
      } finally {
        // Only this request's own entry — a forced one may have replaced it.
        if (inFlightCurrency.get(id)?.seq === seq) inFlightCurrency.delete(id);
      }
    })();

    inFlightCurrency.set(id, { seq, promise: request });
    return request;
  },

  /** Load once per org. Safe to call from anywhere that renders money. */
  ensureCurrency: async (orgId) => {
    const id = orgId || get().currentOrg?._id;
    if (!id || get().currencyLoadedFor === id) return get().currency;
    return get().fetchCurrency(id);
  },

  /**
   * Re-read the workspace currency because something on screen suggests it
   * moved — a board that FOLLOWS the workspace arrived with its money in a
   * unit other than the cached base.
   *
   * That is exactly what everyone else sees after an admin changes the
   * workspace currency: the server relabels the following boards and pings
   * them (`board.changed`), each open board refetches itself, and the fresh
   * columns say CAD while this tab's cached base still says INR — so the board
   * chip would call a board that is perfectly in step "not relabelled yet".
   * Asking again settles it: a real change lands and the warning goes; a board
   * that really is behind keeps it. Throttled per org, so a board that stays
   * behind costs one request per window rather than one per render.
   */
  recheckCurrency: async (orgId) => {
    const id = orgId || get().currentOrg?._id;
    if (!id) return get().currency;
    const now = Date.now();
    if (now - (lastCurrencyRecheck.get(id) || 0) < CURRENCY_RECHECK_MS) return get().currency;
    lastCurrencyRecheck.set(id, now);
    return get().fetchCurrency(id, { force: true });
  },

  /**
   * Change part of the setup. Partial — pass only what changed.
   *
   * Replaces from the server's response rather than patching locally, the same
   * no-optimistic-update rule the holidays follow: the server is the one that
   * validates the code, seals the key and derives the preview.
   *
   * The org records are patched with the new `baseCurrency` too. `currentOrg`
   * is what `useMoney` falls back to while `currency` is unloaded, so leaving
   * it on the old code would bring the old currency back after the next org
   * switch. Both land in the same set(), so every `useMoney` fallback reads the
   * new code from the next render — no refetch in between.
   *
   * A new `baseCurrency` also RELABELS every board that follows the workspace
   * (server side, in the same request). The reply names them; they are marked
   * stale in the board store so opening one refetches it rather than showing
   * the cached copy's old unit. The board open in another tab refreshes itself
   * off the `board.changed` ping the server sends per relabelled board.
   *
   * Returns `{ currency, relabelled }` — `relabelled` is `{ count, boardIds }`,
   * or null when the save did not move the base currency.
   */
  saveCurrency: async (orgId, patch) => {
    const { currency: next, relabelled } = await orgService.saveCurrencySettings(orgId, patch);
    set((s) => ({
      currency: next,
      currencyLoadedFor: orgId,
      ...withBaseCurrency(orgId, next?.baseCurrency)(s),
    }));
    if (relabelled?.boardIds?.length) {
      useBoardStore.getState().markBoardsStale(relabelled.boardIds);
    }
    return { currency: next, relabelled };
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
        // Same reasoning as the calendar above, and money makes it sharper: a
        // stale base currency would label the new workspace's figures with the
        // previous one's unit.
        currency: null,
        currencyLoadedFor: null,
      });
      usePermissionStore.getState().fetchPermissions(org._id);
    }
  },

  createOrg: async (name) => {
    const org = await orgService.createOrg(name);
    const orgs = [...get().orgs, org];
    localStorage.setItem(CURRENT_ORG_KEY, org._id);
    // The previous workspace's calendar and currency are not this one's —
    // the same reset `setCurrentOrg` does, or code-less money in the new
    // workspace reads in the old one's unit until the refetch lands.
    set({ orgs, currentOrg: org, ...freshOrgSettings() });
    await usePermissionStore.getState().fetchPermissions(org._id);
    return org;
  },

  joinOrg: async (inviteCode) => {
    const org = await orgService.joinOrg(inviteCode);
    const orgs = get().orgs.some((o) => o._id === org._id)
      ? get().orgs
      : [...get().orgs, org];
    localStorage.setItem(CURRENT_ORG_KEY, org._id);
    // See createOrg.
    set({ orgs, currentOrg: org, ...freshOrgSettings() });
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

  /**
   * Set (a File) or clear (null) a workspace's logo, then patch every copy the
   * store holds — `orgs` feeds the switcher menu, `currentOrg` the rail tile.
   */
  setOrgLogo: async (orgId, file) => {
    const logo = file
      ? await orgService.uploadOrgLogo(orgId, file)
      : await orgService.removeOrgLogo(orgId);
    const patch = (o) => (o && o._id === orgId ? { ...o, logo } : o);
    set((s) => ({ orgs: s.orgs.map(patch), currentOrg: patch(s.currentOrg) }));
    return logo;
  },

  clearOrgs: () => {
    localStorage.removeItem(CURRENT_ORG_KEY);
    usePermissionStore.getState().clear();
    // The executive view is per (org, user) like the capabilities above, and it
    // decides which page /dashboard is — so a profile left standing after the
    // workspace went away would put the next session on a home page composed for
    // somebody who is no longer signed in. Cleared, never re-fetched from here:
    // one effect in App.jsx owns loading it, keyed on the user and the selected
    // org, so a second caller here would only race it.
    useExecutiveViewStore.getState().clear();
    // The workspace currency is per org like everything above; a copy left
    // behind would label the next session's figures until its own fetch landed.
    clearCurrencyRetry();
    inFlightCurrency.clear();
    lastCurrencyRecheck.clear();
    // Forgetting the newest-request marks makes every request still in flight
    // count as superseded, so one that lands after sign-out writes nothing.
    latestCurrencySeq.clear();
    set({
      currentOrg: null,
      orgs: [],
      members: [],
      adminId: null,
      adminIds: [],
      memberRoles: {},
      roles: [],
      currency: null,
      currencyLoadedFor: null,
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
      currency: null,
      currencyLoadedFor: null,
    });
    usePermissionStore.getState().fetchPermissions(nextCurrent?._id || null);
    return nextCurrent;
  },
}));

/**
 * The workspace's base currency, as every money reader should ask for it.
 *
 * The fetched settings count only once they belong to the workspace IN VIEW
 * (`currencyLoadedFor`): switching, creating or joining a workspace changes
 * `currentOrg` before the new settings land, and reading `currency` blindly
 * labelled the new workspace's figures with the previous one's unit for that
 * window. Then `currentOrg.baseCurrency` (it arrives with `/auth/me`, so it
 * answers from the first paint), else null — a plain number, which is honest.
 */
export const selectBaseCurrency = (s) =>
  (s.currencyLoadedFor && s.currencyLoadedFor === s.currentOrg?._id
    ? s.currency?.baseCurrency
    : null) ||
  s.currentOrg?.baseCurrency ||
  null;

export default useOrgStore;

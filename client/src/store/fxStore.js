import { create } from 'zustand';
import * as fxService from '../services/fxService';

/**
 * THE RATE TABLES, CACHED FOR THE SESSION.
 *
 * Its own store rather than a slice of `orgStore`, because what it holds is not
 * the org's. `FxSnapshot` is global — a rate is a public fact — so this survives
 * a workspace switch untouched, where `holidays` and `currency` are deliberately
 * cleared. Putting it in `orgStore` would mean either wrongly clearing it or
 * carving an exception into that store's reset.
 *
 * ---- Why the whole list, and not one current rate --------------------------
 *
 * Conversion is per RECORD, not per page: a ledger holds invoices from
 * different months and each converts at its own month's rate. One "current"
 * table would be wrong for most rows. The whole set is small — one object of
 * ~171 numbers per period, twelve a year for a monthly workspace — so holding
 * it is cheaper than being clever about it.
 *
 * ---- Once per session, and then kept fresh ---------------------------------
 *
 * The app loads the table once, at sign-in (`ensureRates`). That alone left two
 * holes, both of which read as "the currency toggle does nothing":
 *
 *   - a table that came back EMPTY — the first sign-in after a workspace set up
 *     its rate provider, before the runner's first fetch — stayed empty for the
 *     rest of the session, so every figure stayed unconverted until a reload;
 *   - a tab left open all day never learned about the day's new snapshot, so
 *     today's invoices (dated after the newest rate it held) stayed in their
 *     own currency while yesterday's converted.
 *
 * `ensureFresh` closes both: it refetches when the table is empty or was
 * FETCHED more than `MAX_AGE_MS` ago, and is otherwise free. Age is measured
 * from when WE fetched, never from `asOf`: the newest snapshot is legitimately
 * days old over a weekend (the provider publishes on business days), and
 * judging by it would refetch on every board open until Monday.
 *
 * Concurrent callers share one request, and a failed or empty answer is not
 * retried sooner than `RETRY_MS` — a board page that mounts ten times a minute
 * must not become ten rate requests a minute against a server with no rates.
 */

/** How old a fetched table may get before `ensureFresh` asks again. */
export const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** The shortest gap between two attempts that did not produce a usable table. */
export const RETRY_MS = 60 * 1000;

/** The request in flight, shared by every caller. Not state: nothing renders from it. */
let inFlight = null;

/**
 * Does the table need fetching again? Pure, so the rule is testable on its own
 * and the store's action stays a one-liner.
 *
 * @param {{ loaded, snapshots, fetchedAt, attemptedAt }} s  the store's state
 * @param {number} now  epoch millis
 */
export const ratesNeedRefresh = (s, now = Date.now()) => {
  if (!s?.loaded) return true;
  const recentlyTried = typeof s.attemptedAt === 'number' && now - s.attemptedAt < RETRY_MS;
  if (recentlyTried) return false;
  const empty = !Array.isArray(s.snapshots) || s.snapshots.length === 0;
  if (empty) return true;
  return typeof s.fetchedAt !== 'number' || now - s.fetchedAt >= MAX_AGE_MS;
};

const useFxStore = create((set, get) => ({
  /** `[{ dayKey, rates }]`, newest first. */
  snapshots: [],
  /** The newest day we hold, or null. */
  asOf: null,
  /** Whether a load has finished — distinct from "there are no snapshots". */
  loaded: false,
  /** When the table in hand was fetched (epoch ms), or null. Only a SUCCESS sets it. */
  fetchedAt: null,
  /** When a fetch was last started (epoch ms), success or not — the retry throttle. */
  attemptedAt: null,

  fetchRates: async () => {
    if (inFlight) return inFlight;
    set({ attemptedAt: Date.now() });
    const request = (async () => {
      try {
        const data = await fxService.listRates();
        const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
        set({
          snapshots,
          asOf: data?.asOf || null,
          loaded: true,
          fetchedAt: Date.now(),
        });
        return snapshots;
      } catch (err) {
        /**
         * Money still renders without this. Every figure falls back to the
         * currency it is stored in — which is exactly what the product did
         * before any of this existed — so a failed rate load must never break
         * the screen that asked for it.
         *
         * `loaded` is still set: the screens gate a skeleton on it, and leaving
         * it false would spin forever rather than showing honest, unconverted
         * money. The table already in hand is KEPT — a dropped refresh is not a
         * reason to un-convert a page that was converting a minute ago — and
         * `fetchedAt` is left alone, so the next `ensureFresh` after the retry
         * gap tries again.
         */
        console.error('fetchRates failed:', err);
        set({ loaded: true });
        return get().snapshots;
      } finally {
        inFlight = null;
      }
    })();
    inFlight = request;
    return request;
  },

  /** Load once per session. Safe to call from anywhere that renders money. */
  ensureRates: async () => {
    if (get().loaded) return get().snapshots;
    return get().fetchRates();
  },

  /**
   * Refetch when the table is empty or older than `MAX_AGE_MS`; otherwise a
   * no-op that resolves to the table in hand. For a surface where stale rates
   * are visible — the board page calls it on mount — and cheap enough to call
   * on every mount (see the header for the throttle).
   */
  ensureFresh: async () => {
    if (!ratesNeedRefresh(get())) return get().snapshots;
    return get().fetchRates();
  },

  /**
   * After a manual refresh in Settings, so the new day is visible at once.
   * Waits out a request already in flight rather than sharing it: that one
   * left before the refresh landed, so its answer is the table being replaced.
   */
  reload: async () => {
    if (inFlight) await inFlight;
    return get().fetchRates();
  },
}));

export default useFxStore;

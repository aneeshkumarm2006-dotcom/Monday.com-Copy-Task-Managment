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
 */
const useFxStore = create((set, get) => ({
  /** `[{ dayKey, rates }]`, newest first. */
  snapshots: [],
  /** The newest day we hold, or null. */
  asOf: null,
  /** Whether a load has finished — distinct from "there are no snapshots". */
  loaded: false,

  fetchRates: async () => {
    try {
      const data = await fxService.listRates();
      set({
        snapshots: Array.isArray(data.snapshots) ? data.snapshots : [],
        asOf: data.asOf || null,
        loaded: true,
      });
      return data.snapshots;
    } catch (err) {
      /**
       * Money still renders without this. Every figure falls back to the
       * currency it is stored in — which is exactly what the product did before
       * any of this existed — so a failed rate load must never break the screen
       * that asked for it.
       *
       * `loaded` is still set: the screens gate a skeleton on it, and leaving it
       * false would spin forever rather than showing honest, unconverted money.
       */
      console.error('fetchRates failed:', err);
      set({ loaded: true });
      return get().snapshots;
    }
  },

  /** Load once per session. Safe to call from anywhere that renders money. */
  ensureRates: async () => {
    if (get().loaded) return get().snapshots;
    return get().fetchRates();
  },

  /** After a manual refresh in Settings, so the new day is visible at once. */
  reload: async () => get().fetchRates(),
}));

export default useFxStore;

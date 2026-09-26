import { useMemo } from 'react';

import useAuthStore, { readStoredCurrency } from '../store/authStore';
import useOrgStore, { selectBaseCurrency } from '../store/orgStore';
import useFxStore from '../store/fxStore';
import { canonicalCurrency, makeMoneyFormatter, isDisplayCurrency } from '../utils/money';
import { formatColumnValue } from '../utils/numberFormat';

/**
 * THE HOOK EVERY MONEY RENDER GOES THROUGH.
 *
 * Wraps `utils/money.js`'s formatter in the three things a component would
 * otherwise have to fetch for itself: who is reading, what they chose, and
 * which rate tables we hold.
 *
 * ---- Why a hook and not a third argument to `formatNumber` -----------------
 *
 * Because the alternative is a prop chain. There are roughly a dozen call sites
 * for `formatNumber(value, settings)` and another forty for `formatMoney`, most
 * of them several components deep — `LedgerView` → `InvoiceTile` → `Figure`,
 * `DataGrid` → `NumberCell`. Threading a display currency and a rate table
 * through all of that is a lot of plumbing to arrive at one fact that is the
 * same everywhere.
 *
 * So the formatters keep their exact signatures and stay pure, and this closes
 * over the reader's choice instead. A call site changes by one identifier:
 *
 *     formatNumber(value, column.settings)        // before
 *     money.column(value, column.settings, date)  // after
 *
 * Modelled on `usePermissions` — a hook wrapping stores with a memoized API,
 * which is this codebase's existing read-side convention and the reason there
 * are no React contexts anywhere in it.
 *
 * ---- Why it is safe to call from anywhere ----------------------------------
 *
 * Every dependency fails soft. No chosen currency, no rates, an unknown code, a
 * record older than every snapshot — each of those independently means "render
 * this in the currency it is stored in", which is what the product did before
 * any of this existed. There is no state in which calling this makes a figure
 * WRONG; the worst case is that it does not convert.
 */
const useMoney = () => {
  const hydrated = useAuthStore((s) => !!s.user);
  const stored = useAuthStore((s) => s.user?.displayCurrency);
  /**
   * Before the profile arrives, fall back to the locally mirrored choice.
   *
   * `user` hydrates asynchronously on every cold load, so without this a board
   * paints in the source currency and then re-renders into the reader's choice
   * a moment later. Read once per render rather than held in state: it is a
   * synchronous localStorage read of one short string, and keeping a copy in
   * state would mean a second source of truth to keep in step.
   */
  const chosen = hydrated ? stored : readStoredCurrency();
  /**
   * The workspace currency, from whichever copy has arrived.
   *
   * `currency` is fetched per org after sign-in and is null until that round
   * trip lands — and forever, if it fails. `currentOrg` came with `/auth/me`
   * and already carries `baseCurrency`, so it answers from the first paint.
   * Null when neither knows: that prints a plain number, which is honest. The
   * literal 'INR' this used to end on painted ₹ across a CAD workspace for
   * exactly that window.
   */
  const baseCurrency = useOrgStore(selectBaseCurrency);
  const snapshots = useFxStore((s) => s.snapshots);
  const ratesLoaded = useFxStore((s) => s.loaded);

  return useMemo(() => {
    /**
     * A stale or hand-edited value is ignored rather than trusted. The choice
     * is mirrored into localStorage to avoid a first-paint flash, and that
     * mirror can outlive a change to what we offer.
     */
    const display = isDisplayCurrency(chosen) ? chosen : null;
    const fmt = makeMoneyFormatter({ display, snapshots });

    return {
      /** What the reader chose, or null when they read amounts as entered. */
      display,
      /** True only when a toggle is actually in effect. Cheap guard for callers. */
      active: fmt.active,
      /** Whether rates have finished loading — for gating a skeleton, not a value. */
      ready: ratesLoaded,
      /**
       * True when a figure would convert but the rates have not arrived yet.
       *
       * The one case worth a skeleton: a number that paints in rupees and then
       * changes to dollars a moment later is worse than a brief placeholder,
       * because somebody reads the first one aloud. Anyone viewing in the
       * source currency waits for nothing.
       */
      pending: fmt.active && !ratesLoaded,
      /** The workspace currency, or null while nobody knows it yet. */
      baseCurrency,

      /**
       * A column's cell, group total or footer.
       *
       * Format-aware: only a `format: 'currency'` column is money. Plain,
       * percent, rating and goal numbers render through `formatNumber` with no
       * symbol and no conversion — see `formatColumnValue` for the regression
       * that rule closes.
       *
       * A currency column's unit is its own `settings.currency`, else
       * `fallbackCurrency` (pass the board's currency), else the workspace's.
       *
       * Takes the column's `settings` so an UNCONVERTED figure keeps the
       * decimals its author chose. A converted one deliberately ignores them —
       * `decimals: 0` is a fact about the rupee scale, and carrying it across a
       * ÷96 conversion renders a ₹500 line as "$5".
       */
      column: (value, settings, on = null, fallbackCurrency = null) =>
        formatColumnValue(fmt, value, settings, {
          on,
          fallbackCurrency: fallbackCurrency || baseCurrency,
        }),

      /**
       * A figure whose currency is known directly rather than from a column —
       * an Ads Budget row (the board's currency), a goal (USD), a connector
       * figure (USD).
       */
      in: (value, from, on = null) => fmt.format(value, { from, on }),

      /**
       * The converted NUMBER rather than a string.
       *
       * What the totals use. `ledgerTotals` has to convert every row and add
       * the results at full precision — handing it a formatted string would
       * mean parsing money back out of prose, and rounding each row before
       * adding drifts a total away from the rows it is made of.
       */
      value: (value, from, on = null) => fmt.resolve(value, { from, on }).value,

      /** The whole resolution — value, currency, whether it converted, at what rate. */
      resolve: (value, from, on = null) => fmt.resolve(value, { from, on }),

      /**
       * One line saying the figures on this surface were converted, or null.
       *
       * Said ONCE per surface rather than with a marker on every cell — this
       * codebase's own rule, from `adsBudgetExport.js`: "the subtitle and the
       * Currency column say which one, once, instead of on every figure". It
       * also keeps tabular-nums columns scanning cleanly.
       */
      note: (from, on = null) => {
        if (!fmt.active) return null;
        const r = fmt.resolve(1, { from, on });
        if (!r.converted) return null;
        return `Converted from ${canonicalCurrency(from)} at ${r.asOf} rates`;
      },

      /**
       * The once-per-surface line for a Table footer, a Stages header, an Ads
       * Budget screen — anywhere figures render in bulk.
       *
       * Unlike `note`, it also speaks when a conversion was ASKED FOR and could
       * not happen. That silence was half of "the board is CAD but the symbol is
       * rupee": a reader who chose CAD and got ₹ figures, because no snapshot
       * existed yet, had nothing on screen saying the toggle had not applied.
       *
       *   converted                      → "Shown in CAD · entered in INR · rates of 2026-09-01"
       *   asked for, no rate, different  → "Shown as entered (INR) — no exchange rate available yet"
       *   as entered, or already in it   → null
       *
       * Says and compares the CANONICAL code, never the raw `from`. Stored
       * codes are not all canonical — a column written before codes were
       * normalised can say 'cad' — and `resolve` canonicalises to find the rate
       * but this compared the raw string, so a CAD reader on a 'cad' column was
       * told "Shown as entered (cad) — no exchange rate available yet" about
       * figures that needed no rate at all.
       */
      surfaceNote: (from, on = null) => {
        const source = canonicalCurrency(from);
        if (!fmt.active || !source) return null;
        const r = fmt.resolve(1, { from, on });
        if (r.converted) {
          return `Shown in ${display} · entered in ${source} · rates of ${r.asOf}`;
        }
        if (source !== display) {
          return `Shown as entered (${source}) — no exchange rate available yet`;
        }
        return null;
      },
    };
  }, [chosen, baseCurrency, snapshots, ratesLoaded]);
};

export default useMoney;

/**
 * How a number column renders.
 *
 * A number column stores a plain number and always will — the format is a
 * DISPLAY fact, not a storage one. Storing "₹1,80,000" as a string would mean
 * the sum, the filter and the formula all have to parse it back, and every one
 * of them has to agree on the same grammar. So the value stays 180000 and this
 * decides what it looks like.
 *
 * ---- What changed, and what this file still owns ---------------------------
 *
 * The currency CATALOG and everything to do with converting between currencies
 * now live in `utils/money.js`, which is the single contract for "what unit is
 * this number in". This file kept the part that is genuinely about a COLUMN:
 * turning a column's `settings` — `format`, `decimals`, `currency` — into a
 * string. `formatNumber`'s signature is unchanged, so every existing call site
 * still compiles and still renders an unconverted figure.
 *
 * A reader's chosen display currency is NOT threaded through `formatNumber`. It
 * arrives via the `useMoney()` hook instead, which hands a component a formatter
 * that already closes over the choice and the rates. That keeps this function
 * pure and keeps conversion out of ~10 call sites that do not care about it.
 * `formatColumnValue` below is the one place the two meet — it takes that
 * formatter as an argument, so the rule "only a currency column is money" is
 * plain code a `node --test` can reach, not something buried in a hook.
 *
 * The server copy of this file is gone. Its header claimed "the group totals and
 * exports render there" and nothing outside a test ever imported it — the totals
 * are computed in `columnSummary.js` and every export is built with jsPDF in the
 * browser. See `server/src/utils/money.js`.
 */

import { CURRENCIES, currencyByCode, formatIn } from './money.js';

/** The formats a number column may take. `plain` is the default and the old behaviour. */
export const NUMBER_FORMATS = ['plain', 'currency', 'percent'];

/**
 * Re-exported so the pickers and cells that already import the catalog from
 * here keep working. `utils/money.js` is where it is defined and where the
 * reasoning lives; there is exactly one list.
 */
export { CURRENCIES, currencyByCode };

/**
 * Format `value` per a column's settings.
 *
 * Returns '' for a missing value rather than '0' or '—': an empty cell and a
 * cell holding zero are different facts, and on a budget board the difference
 * between "not set yet" and "nothing left" matters.
 *
 * @param {number|string|null} value
 * @param {Object} [settings] the column's `settings` object
 * @returns {string}
 */
export const formatNumber = (value, settings = {}) => {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || Number.isNaN(n)) return '';

  const s = settings || {};
  const format = NUMBER_FORMATS.includes(s.format) ? s.format : 'plain';
  // `decimals` is honoured for every format when the column states one.
  const decimals =
    typeof s.decimals === 'number' && Number.isInteger(s.decimals) && s.decimals >= 0 && s.decimals <= 4
      ? s.decimals
      : undefined;

  if (format === 'currency') {
    // Delegated so there is one Intl call for money in the whole client, and so
    // an unrecognised code renders as "JPY 1,234" rather than borrowing the
    // first symbol in the catalog. The version this replaced fell back to
    // `CURRENCIES[0]`, which is how a column holding dollars could print a ₹.
    //
    // No stated precision means 'auto' — whole figures stay whole, a typed
    // ₹1,234.50 keeps its paise — rather than the 0 this used to force, which
    // rounded real amounts to figures nobody entered.
    return formatIn(n, s.currency, { decimals: decimals === undefined ? 'auto' : decimals });
  }

  if (format === 'percent') {
    // The stored value IS the percentage — 85 means 85%, not 8500%. Storing a
    // fraction would make every formula referencing it read wrong.
    const d = decimals === undefined ? 0 : decimals;
    return `${n.toLocaleString(undefined, {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    })}%`;
  }

  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals === undefined ? 2 : decimals,
  });
};

/**
 * A column's figure for a reader — the pure half of `useMoney().column`.
 *
 * ---- Only a CURRENCY column is money ---------------------------------------
 *
 * Everything else — a plain count, a percent, a rating average, a goal number —
 * goes through `formatNumber` untouched: no symbol and, critically, no
 * conversion. The version this replaced sent every number through the money
 * formatter with the workspace currency as its source, so "Hours: 12" read
 * "₹12.00", a percent column read "₹85.00", and a reader who chose USD saw a
 * plain count of 1,200 "converted" to $12.52 as if it were rupees.
 *
 * It is the FORMAT that decides, not whether a `currency` is set: a column
 * switched from Currency to Percent keeps its old `settings.currency`, and
 * testing for the code would keep charging it in rupees.
 *
 * ---- Where a currency column's unit comes from -----------------------------
 *
 * Its own `settings.currency`, else `fallbackCurrency` — the caller's board
 * currency, then the workspace's — else nothing, which prints a plain number.
 * Never a literal: a hardcoded 'INR' at the end of this chain is how a CAD
 * workspace painted ₹ on every figure while its currency was still loading.
 *
 * @param {Object|null} fmt  a `makeMoneyFormatter` result, or null for as-entered
 * @param {*} value          the stored cell value (numeric strings accepted)
 * @param {Object} settings  the column's settings
 * @param {Object} [opts]
 * @param {string|Date|null} [opts.on]              the record's day, for the rate
 * @param {string|null} [opts.fallbackCurrency]     unit for a column with no code
 */
export const formatColumnValue = (fmt, value, settings, { on = null, fallbackCurrency = null } = {}) => {
  const s = settings || {};
  if (s.format !== 'currency') return formatNumber(value, s);

  // A typed cell can arrive as a string. The money formatter only takes
  // numbers, and returning '' for "1500" would show an amount as blank.
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';

  const from = s.currency || fallbackCurrency || null;
  if (!fmt) return formatIn(n, from, { decimals: s.decimals ?? 'auto' });
  return fmt.format(n, { from, on, decimals: s.decimals });
};

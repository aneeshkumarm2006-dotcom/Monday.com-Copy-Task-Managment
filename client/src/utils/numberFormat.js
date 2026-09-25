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
 * A reader's chosen display currency is NOT threaded through here. It arrives
 * via the `useMoney()` hook instead, which hands a component a formatter that
 * already closes over the choice and the rates. That keeps this function pure
 * and keeps conversion out of ~10 call sites that do not care about it.
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

  const format = NUMBER_FORMATS.includes(settings.format) ? settings.format : 'plain';
  // `decimals` is honoured for every format. Money is usually shown whole in an
  // agency's own boards — ₹1,80,000 rather than ₹1,80,000.00 — so currency
  // defaults to 0 rather than to the currency's own minor units.
  const decimals =
    typeof settings.decimals === 'number' && settings.decimals >= 0 && settings.decimals <= 4
      ? settings.decimals
      : format === 'currency'
        ? 0
        : undefined;

  if (format === 'currency') {
    // Delegated so there is one Intl call for money in the whole client, and so
    // an unrecognised code renders as "JPY 1,234" rather than borrowing the
    // first symbol in the catalog. The version this replaced fell back to
    // `CURRENCIES[0]`, which is how a column holding dollars could print a ₹.
    return formatIn(n, settings.currency, { decimals: decimals === undefined ? 0 : decimals });
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

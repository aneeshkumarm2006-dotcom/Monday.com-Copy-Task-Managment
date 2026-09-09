/**
 * How a number column renders.
 *
 * A number column stores a plain number and always will — the format is a
 * DISPLAY fact, not a storage one. Storing "₹1,80,000" as a string would mean
 * the sum, the filter and the formula all have to parse it back, and every one
 * of them has to agree on the same grammar. So the value stays 180000 and this
 * decides what it looks like.
 *
 * Duplicated on the server as `server/src/utils/numberFormat.js` — the cell
 * renders here and the group totals and exports render there, and they have to
 * agree. The server's `numberFormat.test.js` is the tripwire that says so.
 */

/** The formats a number column may take. `plain` is the default and the old behaviour. */
export const NUMBER_FORMATS = ['plain', 'currency', 'percent'];

/**
 * Currencies offered in the column settings.
 *
 * A closed list rather than free text: the symbol and the GROUPING differ, and
 * Indian grouping is not "every three digits" — 1,80,000 is lakhs, not
 * 180,000. `Intl` knows that from the locale, which is why each entry carries
 * one rather than just a symbol.
 */
export const CURRENCIES = [
  { code: 'INR', symbol: '₹', locale: 'en-IN' },
  { code: 'USD', symbol: '$', locale: 'en-US' },
  { code: 'EUR', symbol: '€', locale: 'de-DE' },
  { code: 'GBP', symbol: '£', locale: 'en-GB' },
  { code: 'AED', symbol: 'AED', locale: 'en-AE' },
];

export const currencyByCode = (code) =>
  CURRENCIES.find((c) => c.code === code) || CURRENCIES[0];

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
    const cur = currencyByCode(settings.currency);
    try {
      return new Intl.NumberFormat(cur.locale, {
        style: 'currency',
        currency: cur.code,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(n);
    } catch {
      // An environment without full ICU still has to render something a person
      // can read — the symbol and a grouped number, rather than a throw.
      return `${cur.symbol}${n.toLocaleString(cur.locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}`;
    }
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

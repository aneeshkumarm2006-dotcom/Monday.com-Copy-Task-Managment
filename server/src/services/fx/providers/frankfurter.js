const { FxError } = require('../errors');

/**
 * FRANKFURTER — the default rate provider, and the keyless one.
 *
 * https://frankfurter.dev — rates published by central banks, no account, no
 * quota, no credential. That is why it is the default: a workspace that never
 * opens the Currency settings screen still gets live rates, so this feature has
 * no setup step.
 *
 * ---- The response shape is an ARRAY, not a rates map -----------------------
 *
 * This is the whole reason each provider gets its own module rather than a
 * shared parser with a few options. Frankfurter answers:
 *
 *   [ { "date":"2026-09-21", "base":"USD", "quote":"INR", "rate":95.82 },
 *     { "date":"2026-09-21", "base":"USD", "quote":"CAD", "rate":1.3991 }, ... ]
 *
 * one row per pair, where ExchangeRate-API answers a single object with a
 * `conversion_rates` map. Folding the array into that map is this file's job.
 *
 * ---- Why no `quotes` parameter ---------------------------------------------
 *
 * Asking for everything is deliberate. `Board.adsBudget.currency` accepts any
 * ISO 4217 code and validates only the length, so a board can already be
 * denominated in JPY or BRL; a request narrowed to the codes our pickers offer
 * would silently fail to convert one. Omitting `quotes` returns ~171
 * currencies for the same single request, so the narrow version would cost the
 * same and do less.
 */

const BASE_URL = 'https://api.frankfurter.dev/v2/rates';

/** Frankfurter needs no credential. Stated as data so the registry can ask. */
const needsKey = false;

const label = 'Frankfurter';

/**
 * @param {Object} opts
 * @param {string} opts.base   the unit to quote everything against
 * @param {string} [opts.dayKey] 'YYYY-MM-DD' for a historical fetch; omit for latest
 * @returns {Promise<{ dayKey: string, base: string, rates: Object }>}
 */
const fetchRates = async ({ base, dayKey } = {}) => {
  const params = new URLSearchParams({ base });
  // Historical rates are on the SAME keyless endpoint, which is what makes
  // backfilling a year of invoices possible without an account.
  if (dayKey) params.set('date', dayKey);

  const url = `${BASE_URL}?${params.toString()}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    // A DNS failure or a dropped connection is not the same as a refusal, and
    // the runner retries the one and not the other.
    throw new FxError(`Could not reach ${label}.`, {
      provider: 'frankfurter',
      cause: err.message,
      retryable: true,
    });
  }

  if (!res.ok) {
    throw new FxError(`${label} refused the request (HTTP ${res.status}).`, {
      provider: 'frankfurter',
      httpStatus: res.status,
      // 5xx is theirs and worth retrying; 4xx means we asked wrongly and
      // retrying would ask wrongly again.
      retryable: res.status >= 500,
    });
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new FxError(`${label} returned something that is not JSON.`, {
      provider: 'frankfurter',
      cause: err.message,
      retryable: true,
    });
  }

  if (!Array.isArray(body) || body.length === 0) {
    throw new FxError(`${label} returned no rates.`, {
      provider: 'frankfurter',
      retryable: true,
    });
  }

  const rates = {};
  let observedDay = null;
  for (const row of body) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.quote === 'string' && typeof row.rate === 'number') {
      rates[row.quote.toUpperCase()] = row.rate;
    }
    // Every row carries the same date. Read it from the RESPONSE rather than
    // echoing what we asked for: request a Sunday and the provider answers with
    // Friday's rates, and filing those under Sunday would claim a publication
    // that never happened.
    if (!observedDay && typeof row.date === 'string') observedDay = row.date;
  }

  if (Object.keys(rates).length === 0) {
    throw new FxError(`${label} returned rows with no usable rates.`, {
      provider: 'frankfurter',
      retryable: true,
    });
  }

  return {
    dayKey: observedDay || dayKey || null,
    base: (body[0] && body[0].base) || base,
    rates,
  };
};

module.exports = { key: 'frankfurter', label, needsKey, fetchRates };

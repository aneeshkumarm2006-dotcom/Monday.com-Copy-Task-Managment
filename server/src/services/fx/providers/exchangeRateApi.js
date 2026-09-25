const { FxError } = require('../errors');

/**
 * EXCHANGERATE-API — the keyed alternative.
 *
 * https://www.exchangerate-api.com. Exists for a workspace that already pays
 * for an account and would rather rates came from it, and — just as usefully —
 * so the provider seam is proven by two implementations rather than asserted by
 * one. A registry with a single entry is a registry nobody has tested.
 *
 * ---- How it differs from Frankfurter ---------------------------------------
 *
 * Response shape: a single object with a `conversion_rates` map, where
 * Frankfurter returns an array of one row per pair. Folding the two into the
 * same `{ dayKey, base, rates }` is why each provider parses its own body.
 *
 * Failures: reported in an `error-type` FIELD on a 200-ish response rather than
 * only as an HTTP status, so a response can be "successful" and still be a
 * refusal. Those are mapped to `needsConfig` where a retry cannot help.
 *
 * ---- The key never appears in an error -------------------------------------
 *
 * The credential goes in the URL PATH, which is this provider's design and not
 * ours. So nothing here ever puts the URL into an error, a log line or a
 * message — `FxError` carries the endpoint's name, never its address.
 */

const label = 'ExchangeRate-API';

/** This one will not run without a credential. The registry asks before calling. */
const needsKey = true;

/**
 * Their documented `error-type` values, and what each one means for a retry.
 *
 * `quota-reached` is retryable in the sense that it fixes itself next month —
 * but not on the runner's timescale, so it is treated as configuration: the
 * settings screen says the plan is exhausted rather than the runner spinning.
 */
const ERROR_COPY = {
  'invalid-key': 'That API key was rejected.',
  'inactive-account': 'That account has not been confirmed yet.',
  'quota-reached': 'That account has used up its plan for this period.',
  'unsupported-code': 'The provider does not support that currency.',
  'malformed-request': 'The provider rejected the request.',
};

const fetchRates = async ({ base, dayKey, apiKey } = {}) => {
  if (!apiKey) {
    throw new FxError(`${label} needs an API key. Add one in Settings → Currency.`, {
      provider: 'exchangerate-api',
      needsConfig: true,
    });
  }

  /**
   * Historical rates are a PAID feature here, and the endpoint differs in
   * shape: /history/<base>/<y>/<m>/<d> rather than /latest/<base>. Both are
   * attempted, and a plan without history simply reports `quota-reached` or a
   * 403, which surfaces on the settings screen rather than silently writing a
   * today-rate under a historical date.
   */
  const path = dayKey
    ? `history/${base}/${dayKey.slice(0, 4)}/${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))}`
    : `latest/${base}`;

  const url = `https://v6.exchangerate-api.com/v6/${apiKey}/${path}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new FxError(`Could not reach ${label}.`, {
      provider: 'exchangerate-api',
      // NOT err.message — a fetch failure can echo the URL, and the URL
      // contains the key.
      retryable: true,
    });
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  // The error field is authoritative even on a 200 — this provider reports
  // refusals in the payload, not only in the status line.
  const errorType = body && typeof body['error-type'] === 'string' ? body['error-type'] : null;
  if (errorType) {
    const known = ERROR_COPY[errorType];
    throw new FxError(known || `${label} refused the request (${errorType}).`, {
      provider: 'exchangerate-api',
      httpStatus: res.status,
      // Every documented error-type is a configuration problem: a different key,
      // a confirmed account, a bigger plan, a supported currency. None of them
      // is fixed by asking again in an hour.
      needsConfig: true,
    });
  }

  if (!res.ok) {
    throw new FxError(`${label} refused the request (HTTP ${res.status}).`, {
      provider: 'exchangerate-api',
      httpStatus: res.status,
      retryable: res.status >= 500,
    });
  }

  const table = body && (body.conversion_rates || body.rates);
  if (!table || typeof table !== 'object') {
    throw new FxError(`${label} returned no rates.`, {
      provider: 'exchangerate-api',
      retryable: true,
    });
  }

  const rates = {};
  for (const [code, value] of Object.entries(table)) {
    if (typeof value === 'number') rates[code.toUpperCase()] = value;
  }

  if (Object.keys(rates).length === 0) {
    throw new FxError(`${label} returned an empty rate table.`, {
      provider: 'exchangerate-api',
      retryable: true,
    });
  }

  return {
    // This provider reports the day it fetched rather than the day they are
    // for, so an explicit historical request is filed under the day we asked
    // for. `time_last_update_utc` is the fallback for a latest fetch.
    dayKey: dayKey || dayKeyFromUpdate(body) || null,
    base: (body && body.base_code) || base,
    rates,
  };
};

/** `time_last_update_utc` as a day key, or null. */
const dayKeyFromUpdate = (body) => {
  const raw = body && body.time_last_update_utc;
  if (typeof raw !== 'string') return null;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
};

module.exports = { key: 'exchangerate-api', label, needsKey, fetchRates };

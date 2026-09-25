/**
 * THE CURRENCY CATALOG, server side — what codes exist and what we accept.
 *
 * ---- Why this does not format anything -------------------------------------
 *
 * It replaces `utils/numberFormat.js`, which was a byte-for-byte copy of the
 * client file and whose own header claimed "the group totals and exports render
 * here". They do not. Nothing outside a test ever imported it: the group totals
 * are computed in `client/src/utils/columnSummary.js` and every export is built
 * with jsPDF in the browser. A duplicated formatter that renders nothing is two
 * places to fix and one of them untested, so the formatter is gone and the half
 * that was actually load-bearing — the list of codes, and the rules for what may
 * be stored — is here.
 *
 * Money is rendered in exactly one place now: `client/src/utils/money.js`. The
 * server's job is to make sure a currency code that reaches the database is one
 * we can render and convert, which is what the validators below are for.
 *
 * ---- The one live server-side money renderer -------------------------------
 *
 * `services/activityFormat.js` prefixes a logged value with the goal's stored
 * `unitLabel`, and it deliberately does NOT use this file. An activity row is a
 * record of what somebody wrote at the time; converting it — or restating its
 * unit — would falsify the log.
 */

/** The formats a number column may take. `plain` is the default and the old behaviour. */
const NUMBER_FORMATS = ['plain', 'currency', 'percent'];

/**
 * Every currency a stored amount may be denominated in.
 *
 * MUST stay in step with `client/src/utils/money.js`'s `CURRENCIES` — that file
 * is where the reasoning for the list lives (it is the union of two lists that
 * used to disagree, and each entry carries a locale because Indian grouping is
 * lakhs, not thousands). `money.test.js` pins the codes so the two cannot drift
 * silently; the client keeps the symbols and locales because only the client
 * renders.
 */
const CURRENCY_CODES = ['INR', 'USD', 'CAD', 'EUR', 'GBP', 'AED', 'AUD', 'SGD'];

/** What a person may choose to READ the product in. A promise, not a list. */
const DISPLAY_CURRENCIES = ['INR', 'USD', 'CAD'];

/** The unit every stored FX rate is quoted against. See the client's `FX_BASE`. */
const FX_BASE = 'USD';

/** How often a workspace asks the provider for a new snapshot. */
const FX_CADENCES = ['daily', 'monthly'];

/**
 * The rate providers a workspace may choose between.
 *
 * `frankfurter` is first because it is the default AND the keyless one: an org
 * that never opens the Currency settings screen still gets live rates. The
 * second exists so a workspace that would rather use its own paid account can,
 * and so the seam is proven by two implementations rather than asserted by one.
 *
 * Mirrors `services/fx/providers/`. A code here with no module there is a
 * provider that cannot be asked anything.
 */
const FX_PROVIDERS = ['frankfurter', 'exchangerate-api'];

/** Which providers will refuse to run without a credential. */
const FX_PROVIDERS_NEEDING_KEY = ['exchangerate-api'];

const providerNeedsKey = (provider) => FX_PROVIDERS_NEEDING_KEY.includes(provider);

const isCurrencyCode = (code) => CURRENCY_CODES.includes(code);

const isDisplayCurrency = (code) => DISPLAY_CURRENCIES.includes(code);

/**
 * A code as it should be stored, or `null` if we will not store it.
 *
 * Upper-cased and trimmed first, because a picker and an API client will send
 * 'inr' and ' INR ' respectively and both mean the same currency. Anything not
 * in the catalog is refused rather than coerced — see `sanitizeColumnCurrency`.
 */
const normaliseCurrencyCode = (raw) => {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return isCurrencyCode(code) ? code : null;
};

/**
 * The currency for a number column's `settings`, validated.
 *
 * ---- Why this is refused rather than defaulted -----------------------------
 *
 * `column.settings` is `Mixed` and `columnController` validates only the
 * `connect_boards` and `mirror` shapes, so until now any string at all could be
 * stored as a currency. On the client, `currencyByCode` ended `||
 * CURRENCIES[0]`, so every unrecognised code rendered as rupees.
 *
 * That was cosmetic for as long as the code only chose a symbol. It stops being
 * cosmetic the moment a RATE is looked up by the same code: a column actually
 * holding dollars, stored as something we do not recognise, would be treated as
 * rupees and multiplied by ~96 for a reader in USD. So an unknown code is a 400
 * on the way in, and the renderer prints the bare code rather than guessing.
 *
 * @returns {{ ok: true, code: string }|{ ok: false, error: string }}
 */
const sanitizeColumnCurrency = (raw) => {
  const code = normaliseCurrencyCode(raw);
  if (code) return { ok: true, code };
  return {
    ok: false,
    error: `Currency must be one of ${CURRENCY_CODES.join(', ')}.`,
  };
};

/**
 * One snapshot's rate table, cleaned for storage.
 *
 * Drops anything that is not a usable positive finite number — a zero or
 * negative rate is worse than a missing one, because a missing rate leaves a
 * figure honestly unconverted while a zero turns it into 0.
 *
 * Always asserts `FX_BASE: 1`. The provider quotes every OTHER currency against
 * the base and omits the base itself, but `crossRate` divides by
 * `rates[from]` — so without this, converting FROM USD would divide by
 * undefined and every dollar figure would refuse to convert.
 */
const sanitizeRates = (raw) => {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [code, value] of Object.entries(raw)) {
      const key = typeof code === 'string' ? code.trim().toUpperCase() : '';
      if (!/^[A-Z]{3}$/.test(key)) continue;
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      out[key] = n;
    }
  }
  out[FX_BASE] = 1;
  return out;
};

/** 'YYYY-MM-DD', the only shape a snapshot is keyed by. */
const DAY_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const isDayKey = (value) => typeof value === 'string' && DAY_KEY_RE.test(value);

/**
 * The last four characters of a key, for the settings screen.
 *
 * Short enough to be useless to anybody who intercepts it and long enough to
 * tell two keys apart, which is the only job it has.
 */
const keyPreviewOf = (key) =>
  typeof key === 'string' && key.length >= 4 ? `…${key.slice(-4)}` : '';

/**
 * A partial FX settings patch, cleaned.
 *
 * PARTIAL by design — the settings screen saves one control at a time, and a
 * whole-object write would mean a cadence change silently re-sending (or
 * clearing) the API key. Fields absent from `body` are left alone, which is the
 * same contract `setHoliday` follows.
 *
 * The API key is deliberately NOT handled here: it has to be sealed, which
 * needs the org id as AAD and can fail on a deployment with no encryption key
 * configured. That belongs in the controller where both are in scope.
 *
 * @returns {{ ok: true, patch: Object }|{ ok: false, error: string }}
 */
const sanitizeFxSettings = (body) => {
  const patch = {};
  if (!body || typeof body !== 'object') return { ok: true, patch };

  if (body.baseCurrency !== undefined) {
    const code = normaliseCurrencyCode(body.baseCurrency);
    if (!code) {
      return { ok: false, error: `Currency must be one of ${CURRENCY_CODES.join(', ')}.` };
    }
    patch.baseCurrency = code;
  }

  if (body.provider !== undefined) {
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    if (!FX_PROVIDERS.includes(provider)) {
      return { ok: false, error: `Provider must be one of ${FX_PROVIDERS.join(', ')}.` };
    }
    patch['fx.provider'] = provider;
  }

  if (body.cadence !== undefined) {
    const cadence = typeof body.cadence === 'string' ? body.cadence.trim() : '';
    if (!FX_CADENCES.includes(cadence)) {
      return { ok: false, error: `Cadence must be one of ${FX_CADENCES.join(', ')}.` };
    }
    patch['fx.cadence'] = cadence;
  }

  return { ok: true, patch };
};

module.exports = {
  NUMBER_FORMATS,
  CURRENCY_CODES,
  DISPLAY_CURRENCIES,
  FX_BASE,
  FX_CADENCES,
  FX_PROVIDERS,
  FX_PROVIDERS_NEEDING_KEY,
  providerNeedsKey,
  sanitizeFxSettings,
  keyPreviewOf,
  isCurrencyCode,
  isDisplayCurrency,
  normaliseCurrencyCode,
  sanitizeColumnCurrency,
  sanitizeRates,
  isDayKey,
  DAY_KEY_RE,
};

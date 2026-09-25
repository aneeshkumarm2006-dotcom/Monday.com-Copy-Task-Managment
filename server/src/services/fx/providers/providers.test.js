const { test } = require('node:test');
const assert = require('node:assert');

const frankfurter = require('./frankfurter');
const exchangeRateApi = require('./exchangeRateApi');
const { checkRegistry, getProvider, PROVIDERS } = require('../index');
const { FxError } = require('../errors');

/**
 * Two providers that agree about nothing except their return shape.
 *
 * That disagreement is the point: one answers with an ARRAY of one row per
 * pair, the other with a single object carrying a `conversion_rates` map; one
 * reports failure in an HTTP status, the other in an `error-type` field on an
 * otherwise successful response; one needs a credential and the other does not.
 * A seam that survives both is genuinely provider-agnostic rather than shaped
 * around whichever one was written first.
 *
 * The payloads below are REAL — captured from live calls to both APIs while
 * this was being built — because a parser tested against a body somebody
 * imagined is a parser tested against nothing.
 */

/** `fetch`, replaced for one call. Node's global, so no injection seam needed. */
const withFetch = async (impl, fn) => {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
};

const okJson = (body) => async () => ({
  ok: true,
  status: 200,
  json: async () => body,
});

// --- the registry ----------------------------------------------------------

test('every offered provider has a module, and vice versa', () => {
  // A code in the catalog with no module here is a setting the Currency screen
  // will happily let somebody select and that can then never be asked anything.
  assert.strictEqual(checkRegistry(), true);
});

test('an unknown provider falls back to the keyless default', () => {
  // A workspace whose stored provider was removed in a deploy must keep getting
  // rates, not stop dead.
  assert.strictEqual(getProvider('something-we-deleted').key, 'frankfurter');
  assert.strictEqual(getProvider(undefined).key, 'frankfurter');
});

test('the default provider is the one that needs no key', () => {
  // This is what makes the whole feature work with no setup step.
  assert.strictEqual(PROVIDERS.frankfurter.needsKey, false);
});

// --- Frankfurter: an array of pairs ----------------------------------------

const FRANKFURTER_BODY = [
  { date: '2026-09-21', base: 'USD', quote: 'AED', rate: 3.6725 },
  { date: '2026-09-21', base: 'USD', quote: 'CAD', rate: 1.3991 },
  { date: '2026-09-21', base: 'USD', quote: 'EUR', rate: 0.87069 },
  { date: '2026-09-21', base: 'USD', quote: 'GBP', rate: 0.74674 },
  { date: '2026-09-21', base: 'USD', quote: 'INR', rate: 95.82 },
];

test('Frankfurter folds its array of pairs into one rate table', async () => {
  const out = await withFetch(okJson(FRANKFURTER_BODY), () =>
    frankfurter.fetchRates({ base: 'USD' })
  );
  assert.strictEqual(out.base, 'USD');
  assert.strictEqual(out.dayKey, '2026-09-21');
  assert.strictEqual(out.rates.INR, 95.82);
  assert.strictEqual(out.rates.CAD, 1.3991);
  assert.strictEqual(Object.keys(out.rates).length, 5);
});

test('Frankfurter files rates under the day the PROVIDER published, not the day we asked', async () => {
  /**
   * Ask for a Sunday and you are answered with Friday's rates. Filing those
   * under Sunday would claim a publication that never happened — and the
   * "newest snapshot at or before this day" rule already resolves a Sunday
   * invoice to Friday without anybody inventing a row.
   */
  const out = await withFetch(okJson(FRANKFURTER_BODY), () =>
    frankfurter.fetchRates({ base: 'USD', dayKey: '2026-09-20' })
  );
  assert.strictEqual(out.dayKey, '2026-09-21');
});

test('Frankfurter asks for every currency, not just the ones we offer', async () => {
  /**
   * `Board.adsBudget.currency` takes any ISO code and validates only the
   * length, so a board can be denominated in JPY. A request narrowed to our
   * pickers' eight codes would silently fail to convert it — and the wide
   * request is the same single call.
   */
  let seen = '';
  await withFetch(
    async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => FRANKFURTER_BODY };
    },
    () => frankfurter.fetchRates({ base: 'USD' })
  );
  assert.ok(!seen.includes('quotes='), `should not narrow the request: ${seen}`);
  assert.ok(seen.includes('base=USD'));
});

test('Frankfurter passes a historical date through', async () => {
  let seen = '';
  await withFetch(
    async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => FRANKFURTER_BODY };
    },
    () => frankfurter.fetchRates({ base: 'USD', dayKey: '2026-03-15' })
  );
  // Historical is the SAME keyless endpoint, which is what makes backfilling a
  // year of invoices possible with no account.
  assert.ok(seen.includes('date=2026-03-15'), seen);
});

test('Frankfurter reports a server fault as retryable and a refusal as not', async () => {
  const fails = (status) => async () => ({ ok: false, status, json: async () => ({}) });

  await assert.rejects(
    () => withFetch(fails(503), () => frankfurter.fetchRates({ base: 'USD' })),
    (err) => err instanceof FxError && err.retryable === true
  );
  await assert.rejects(
    () => withFetch(fails(400), () => frankfurter.fetchRates({ base: 'USD' })),
    (err) => err instanceof FxError && err.retryable === false
  );
});

test('Frankfurter refuses an empty or unusable body rather than storing nothing', async () => {
  // A snapshot with no rates is worse than no snapshot: it satisfies the
  // "already have this period" check and blocks the next real fetch.
  for (const body of [[], [{ nonsense: true }]]) {
    await assert.rejects(
      () => withFetch(okJson(body), () => frankfurter.fetchRates({ base: 'USD' })),
      (err) => err instanceof FxError
    );
  }
});

// --- ExchangeRate-API: a conversion_rates map ------------------------------

const ERA_BODY = {
  result: 'success',
  base_code: 'USD',
  time_last_update_utc: 'Mon, 21 Sep 2026 00:00:01 +0000',
  conversion_rates: { USD: 1, INR: 95.8, CAD: 1.399, EUR: 0.8707 },
};

test('ExchangeRate-API reads its conversion_rates map', async () => {
  const out = await withFetch(okJson(ERA_BODY), () =>
    exchangeRateApi.fetchRates({ base: 'USD', apiKey: 'k'.repeat(24) })
  );
  assert.strictEqual(out.base, 'USD');
  assert.strictEqual(out.dayKey, '2026-09-21');
  assert.strictEqual(out.rates.INR, 95.8);
});

test('ExchangeRate-API refuses to call at all without a key', async () => {
  // Asking a keyed provider without a credential spends a request to be told
  // something we already knew.
  await assert.rejects(
    () => exchangeRateApi.fetchRates({ base: 'USD' }),
    (err) => err instanceof FxError && err.needsConfig === true
  );
});

test('every documented error-type is surfaced as a configuration problem', async () => {
  /**
   * This provider reports refusals in the BODY, so a 200 can still be a
   * failure. None of these is fixed by asking again in an hour — a different
   * key, a confirmed account, a bigger plan — so the runner must stop rather
   * than spin.
   */
  for (const type of [
    'invalid-key',
    'inactive-account',
    'quota-reached',
    'unsupported-code',
    'malformed-request',
  ]) {
    await assert.rejects(
      () =>
        withFetch(okJson({ result: 'error', 'error-type': type }), () =>
          exchangeRateApi.fetchRates({ base: 'USD', apiKey: 'k'.repeat(24) })
        ),
      (err) => {
        assert.ok(err instanceof FxError, `${type} should be an FxError`);
        assert.strictEqual(err.needsConfig, true, `${type} should not be retried`);
        return true;
      }
    );
  }
});

test('an API key never appears in an error a person can see', async () => {
  /**
   * This provider puts the credential in the URL PATH — their design, not ours
   * — so any error that echoes a URL leaks the key into a settings screen, a
   * log line and `Organisation.fx.lastError`.
   */
  const KEY = 'supersecretkey12345678';
  const boom = async () => {
    throw new Error(`request to https://v6.exchangerate-api.com/v6/${KEY}/latest/USD failed`);
  };
  await assert.rejects(
    () => withFetch(boom, () => exchangeRateApi.fetchRates({ base: 'USD', apiKey: KEY })),
    (err) => {
      assert.ok(!err.message.includes(KEY), 'the key leaked into the message');
      assert.ok(!String(err.cause || '').includes(KEY), 'the key leaked into the cause');
      assert.ok(!err.toDisplay().includes(KEY), 'the key leaked into the display text');
      return true;
    }
  );
});

test('toDisplay never carries the cause, which can carry a URL', () => {
  const err = new FxError('Could not reach it.', {
    provider: 'exchangerate-api',
    cause: 'https://v6.exchangerate-api.com/v6/SECRET/latest/USD',
  });
  assert.strictEqual(err.toDisplay(), 'Could not reach it.');
  assert.ok(!err.toDisplay().includes('SECRET'));
});

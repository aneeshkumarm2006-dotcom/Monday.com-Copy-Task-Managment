const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  CURRENCY_CODES,
  DISPLAY_CURRENCIES,
  FX_BASE,
  FX_CADENCES,
  isCurrencyCode,
  isDisplayCurrency,
  normaliseCurrencyCode,
  sanitizeColumnCurrency,
  sanitizeRates,
  isDayKey,
} = require('./money');

/**
 * The server does not render money — it decides what may be STORED as money.
 * Everything here is about refusing a value that would later be rendered or
 * converted wrongly, because by then it is somebody's invoice.
 */

test('the display list is a subset of the storable list', () => {
  for (const code of DISPLAY_CURRENCIES) {
    assert.ok(isCurrencyCode(code), `${code} is offered for display but not storable`);
  }
});

test('the base currency is storable', () => {
  // `crossRate` divides by `rates[from]`; a base outside the catalog would mean
  // amounts in it could never convert.
  assert.ok(isCurrencyCode(FX_BASE));
});

test('the catalog matches the client, code for code', () => {
  /**
   * The tripwire the old `numberFormat.js` pair only CLAIMED to have — its
   * header named a `numberFormat.test.js` that never existed, which is how the
   * two copies were free to drift for as long as they did.
   *
   * Only the codes are compared. The client additionally carries a symbol and a
   * locale per entry because only the client renders; duplicating those here
   * would recreate exactly the dead weight this file was written to delete.
   */
  const clientSource = fs.readFileSync(
    path.join(__dirname, '../../../client/src/utils/money.js'),
    'utf8'
  );
  const block = clientSource.match(/export const CURRENCIES = \[([\s\S]*?)\];/);
  assert.ok(block, 'could not find CURRENCIES in the client money contract');

  const clientCodes = [...block[1].matchAll(/code:\s*'([A-Z]{3})'/g)].map((m) => m[1]);
  assert.deepEqual(
    clientCodes,
    CURRENCY_CODES,
    'client and server currency catalogs have drifted'
  );

  const displayBlock = clientSource.match(/export const DISPLAY_CURRENCIES = \[([^\]]*)\]/);
  assert.ok(displayBlock, 'could not find DISPLAY_CURRENCIES in the client money contract');
  const clientDisplay = [...displayBlock[1].matchAll(/'([A-Z]{3})'/g)].map((m) => m[1]);
  assert.deepEqual(clientDisplay, DISPLAY_CURRENCIES, 'display currency lists have drifted');
});

test('CAD is storable and offered', () => {
  // It existed only inside the Ads Budget card's private list before this.
  assert.ok(isCurrencyCode('CAD'));
  assert.ok(isDisplayCurrency('CAD'));
});

test('the union kept the codes only the Ads Budget card knew', () => {
  /**
   * The one way this change could break existing data. `Board.adsBudget.currency`
   * accepts any ISO code and that card offered AUD and SGD, so narrowing the
   * catalog to the codes the OTHER picker knew would make such a board
   * unrepresentable in its own select — and the next save would silently
   * rewrite its currency.
   */
  for (const code of ['AUD', 'SGD', 'EUR', 'GBP', 'AED']) {
    assert.ok(isCurrencyCode(code), `${code} must survive the catalog union`);
  }
});

test('a code is normalised before it is judged', () => {
  // A picker sends 'INR', an API client sends ' inr '. Both mean rupees.
  assert.equal(normaliseCurrencyCode(' inr '), 'INR');
  assert.equal(normaliseCurrencyCode('Usd'), 'USD');
  assert.equal(normaliseCurrencyCode('ZZZ'), null);
  assert.equal(normaliseCurrencyCode(42), null);
  assert.equal(normaliseCurrencyCode(null), null);
});

test('an unknown column currency is refused, not defaulted', () => {
  /**
   * THE reason this validator exists. `column.settings` is Mixed and
   * `columnController` validated only the connect_boards and mirror shapes, so
   * any string could be stored. The client then resolved an unknown code to the
   * first catalog entry — rupees — which was cosmetic right up until a RATE got
   * looked up by the same code and multiplied a dollar column by ~96.
   */
  assert.deepEqual(sanitizeColumnCurrency('inr'), { ok: true, code: 'INR' });

  const bad = sanitizeColumnCurrency('DOLLARS');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /INR/);
  assert.equal(bad.code, undefined, 'a refusal must not hand back a guess');

  for (const v of [null, undefined, '', 123, {}]) {
    assert.equal(sanitizeColumnCurrency(v).ok, false);
  }
});

test('the rate table always asserts the base at 1', () => {
  // The provider quotes every OTHER currency against the base and omits the
  // base itself. Without this, converting FROM USD divides by undefined and
  // every dollar figure silently refuses to convert.
  const rates = sanitizeRates({ INR: 95.82, CAD: 1.3991 });
  assert.equal(rates[FX_BASE], 1);
  assert.equal(rates.INR, 95.82);
});

test('unusable rates are dropped rather than stored', () => {
  // A zero is worse than a missing rate: missing leaves a figure honestly
  // unconverted, zero turns it into 0.
  const rates = sanitizeRates({
    INR: 95.82,
    AAA: 0,
    BBB: -3,
    CCC: 'not a number',
    DDD: null,
    toolong: 5,
    EUR: '0.87069',
  });
  assert.equal(rates.INR, 95.82);
  assert.equal(rates.EUR, 0.87069, 'a numeric string is still a number');
  for (const k of ['AAA', 'BBB', 'CCC', 'DDD', 'TOOLONG']) {
    assert.ok(!(k in rates), `${k} should have been dropped`);
  }
});

test('sanitizeRates survives junk without throwing', () => {
  for (const v of [null, undefined, 'nope', 42, []]) {
    assert.equal(sanitizeRates(v)[FX_BASE], 1);
  }
});

test('cadences are the two the settings tab offers', () => {
  assert.deepEqual(FX_CADENCES, ['daily', 'monthly']);
});

test('a day key is a real calendar day', () => {
  assert.ok(isDayKey('2026-03-15'));
  assert.ok(isDayKey('2026-12-31'));
  assert.ok(!isDayKey('2026-13-01'), 'month 13');
  assert.ok(!isDayKey('2026-03-32'), 'day 32');
  assert.ok(!isDayKey('2026-03'), 'a month key is not a day key');
  assert.ok(!isDayKey('2026-3-1'), 'unpadded');
  assert.ok(!isDayKey(null));
});

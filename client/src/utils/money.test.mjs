import test from 'node:test';
import assert from 'node:assert';

import {
  CURRENCIES,
  DISPLAY_CURRENCIES,
  FX_BASE,
  currencyByCode,
  isCurrencyCode,
  formatIn,
  crossRate,
  convert,
  snapshotFor,
  dayKeyOfMonthKey,
  toDayKey,
  makeMoneyFormatter,
} from './money.js';
import { formatNumber } from './numberFormat.js';

/**
 * Money is the one thing in this product where being wrong is expensive and
 * silent. Every test here pins a decision that looks like a detail and is not.
 */

// --- the catalog -----------------------------------------------------------

test('the display list is a subset of the storable list', () => {
  // The two are different kinds of thing: CURRENCIES is "what a number might be
  // stored as", DISPLAY_CURRENCIES is "what the toggle promises to render". A
  // display currency we cannot represent at all would be a toggle that breaks.
  for (const code of DISPLAY_CURRENCIES) {
    assert.ok(isCurrencyCode(code), `${code} is offered for display but not storable`);
  }
});

test('the catalog carries CAD, and the base is in it', () => {
  // CAD existed only in the Ads Budget card's private list before this.
  assert.ok(isCurrencyCode('CAD'));
  assert.ok(isCurrencyCode(FX_BASE));
});

test('every entry carries a locale, not just a symbol', () => {
  // Indian grouping is lakhs, not thousands, and Intl only knows that from the
  // locale. An entry with a symbol and no locale renders ₹180,000.
  for (const c of CURRENCIES) {
    assert.match(c.code, /^[A-Z]{3}$/);
    assert.ok(c.symbol, `${c.code} has no symbol`);
    assert.ok(c.locale, `${c.code} has no locale`);
  }
});

test('an unknown code resolves to null, never to the first entry', () => {
  // THE regression this file exists for. The version replaced here ended
  // `|| CURRENCIES[0]`, so a column holding dollars under an unrecognised code
  // rendered as rupees — and would have been multiplied by ~96 once rates
  // arrived.
  assert.equal(currencyByCode('ZZZ'), null);
  assert.equal(currencyByCode(undefined), null);
  assert.equal(currencyByCode(''), null);
});

// --- rendering -------------------------------------------------------------

test('rupees render the Indian way', () => {
  // 1,80,000 — lakhs, not 180,000. Moved here from boardTemplates.test.js when
  // the server's duplicate formatter was deleted.
  const out = formatIn(180000, 'INR', { decimals: 0 });
  assert.match(out, /1,80,000/);
  assert.match(out, /₹/);
});

test('an unrecognised code prints the code, not a borrowed symbol', () => {
  const out = formatIn(1234, 'JPY', { decimals: 0 });
  assert.match(out, /JPY/);
  assert.ok(!out.includes('₹'), `should not claim rupees: ${out}`);
});

test('decimals follow the magnitude when not told otherwise', () => {
  // Below 100 the pennies are the whole number; above it they are noise.
  assert.match(formatIn(1.25, 'USD'), /1\.25/);
  assert.ok(!formatIn(8000, 'USD').includes('.'), 'a four-figure sum should read round');
});

test('an empty cell formats as empty, not zero', () => {
  // On a budget board "not set yet" and "nothing left" are different facts.
  for (const v of [null, undefined, '']) {
    assert.equal(formatNumber(v, { format: 'currency', currency: 'INR' }), '');
  }
  assert.notEqual(formatNumber(0, { format: 'currency', currency: 'INR' }), '');
});

test('percent stores the percentage, not the fraction', () => {
  assert.equal(formatNumber(85, { format: 'percent' }), '85%');
});

// --- rates -----------------------------------------------------------------

const RATES = { USD: 1, INR: 95.82, CAD: 1.3991, EUR: 0.87069 };

test('a currency converts to itself at exactly 1, with no table', () => {
  assert.equal(crossRate(null, 'INR', 'INR'), 1);
});

test('cross rates go through the base in one division', () => {
  const r = crossRate(RATES, 'INR', 'CAD');
  assert.ok(Math.abs(r - RATES.CAD / RATES.INR) < 1e-12);
  // And the pair is reciprocal, which is what basing on USD buys us.
  const back = crossRate(RATES, 'CAD', 'INR');
  assert.ok(Math.abs(r * back - 1) < 1e-9, 'INR->CAD->INR should return you home');
});

test('a missing leg returns null rather than 1', () => {
  // A silent 1 would quietly claim two different currencies were equal.
  assert.equal(crossRate(RATES, 'INR', 'JPY'), null);
  assert.equal(crossRate(RATES, 'JPY', 'INR'), null);
  assert.equal(crossRate(undefined, 'INR', 'USD'), null);
});

test('a zero or negative rate is refused on BOTH legs', () => {
  // Checking only the divisor leaves a negative target turning a positive
  // amount negative.
  assert.equal(crossRate({ ...RATES, INR: 0 }, 'INR', 'USD'), null);
  assert.equal(crossRate({ ...RATES, CAD: -1 }, 'INR', 'CAD'), null);
});

test('convert does not round', () => {
  // Rounding here and then adding drifts a total away from its rows.
  const out = convert(100, 'USD', 'INR', RATES);
  assert.equal(out, 9582);
  const third = convert(1, 'USD', 'EUR', RATES);
  assert.ok(String(third).length > 4, 'full precision should survive');
});

// --- dated snapshots -------------------------------------------------------

const SNAPS = [
  { dayKey: '2026-01-01', rates: { USD: 1, INR: 90 } },
  { dayKey: '2026-03-01', rates: { USD: 1, INR: 92 } },
  { dayKey: '2026-09-01', rates: { USD: 1, INR: 95.82 } },
];

test('a record resolves to the newest snapshot at or before its day', () => {
  assert.equal(snapshotFor(SNAPS, '2026-03-15').dayKey, '2026-03-01');
  assert.equal(snapshotFor(SNAPS, '2026-03-01').dayKey, '2026-03-01');
});

test('a weekend or holiday falls back to the last published day', () => {
  // The provider publishes on business days only. The "newest at or before"
  // rule absorbs that with no special case — do not "fix" this into an
  // exact-match lookup.
  assert.equal(snapshotFor(SNAPS, '2026-08-30').dayKey, '2026-03-01');
});

test('a record older than every snapshot refuses, and never reaches forward', () => {
  // THE dangerous failure. Falling back to the OLDEST snapshot would value a
  // 2025 invoice at a 2026 rate while looking exactly as authoritative as a
  // correct one.
  assert.equal(snapshotFor(SNAPS, '2025-06-01'), null);
});

test('no day at all means the newest we hold', () => {
  assert.equal(snapshotFor(SNAPS, null).dayKey, '2026-09-01');
});

test('a month key reads its rate from the first of the month', () => {
  assert.equal(dayKeyOfMonthKey('2026-03'), '2026-03-01');
  assert.equal(dayKeyOfMonthKey('2026-13'), null);
  assert.equal(dayKeyOfMonthKey('nonsense'), null);
});

test('toDayKey accepts the three shapes callers actually hold', () => {
  assert.equal(toDayKey('2026-03-15'), '2026-03-15');
  assert.equal(toDayKey('2026-03-15T09:30:00.000Z'), '2026-03-15');
  assert.equal(toDayKey(new Date('2026-03-15T09:30:00.000Z')), '2026-03-15');
  assert.equal(toDayKey(null), null);
  assert.equal(toDayKey('not a date'), null);
});

// --- the bound formatter ---------------------------------------------------

test('no display currency means the product renders exactly as before', () => {
  // The default for everyone until they choose. A default that converted would
  // have restated every figure in the product on the day this shipped.
  const m = makeMoneyFormatter({ display: null, snapshots: SNAPS });
  assert.equal(m.active, false);
  const r = m.resolve(180000, { from: 'INR', on: '2026-09-10' });
  assert.equal(r.converted, false);
  assert.equal(r.value, 180000);
  assert.equal(r.currency, 'INR');
});

test('a figure converts at ITS OWN day, not today', () => {
  const m = makeMoneyFormatter({ display: 'USD', snapshots: SNAPS });
  const march = m.resolve(9200, { from: 'INR', on: '2026-03-15' });
  const sept = m.resolve(9200, { from: 'INR', on: '2026-09-10' });
  assert.equal(march.asOf, '2026-03-01');
  assert.equal(sept.asOf, '2026-09-01');
  assert.equal(march.value, 100); // 9200 / 92
  assert.notEqual(march.value, sept.value);
});

test('a figure with no usable rate is left in its own currency, unmarked', () => {
  const m = makeMoneyFormatter({ display: 'USD', snapshots: SNAPS });
  const old = m.resolve(1000, { from: 'INR', on: '2020-01-01' });
  assert.equal(old.converted, false);
  assert.equal(old.currency, 'INR');
  assert.equal(old.value, 1000);
  // And it renders as rupees rather than as dollars-at-a-guess.
  assert.match(m.format(1000, { from: 'INR', on: '2020-01-01' }), /₹/);
});

test('converted figures ignore the source column decimals', () => {
  /**
   * The bug this prevents: RUPEES pins `decimals: 0` because ₹1,80,000 should
   * not read ₹1,80,000.00. Carry that across a ÷96 conversion and a ₹500 line
   * renders "$5" — the column author chose zero decimals for the RUPEE scale.
   */
  const m = makeMoneyFormatter({ display: 'USD', snapshots: SNAPS });
  const out = m.format(500, { from: 'INR', on: '2026-09-10', decimals: 0 });
  assert.match(out, /5\.2/, `expected cents on a small converted figure, got ${out}`);
});

test('unconverted figures still honour the column decimals', () => {
  const m = makeMoneyFormatter({ display: null, snapshots: SNAPS });
  const out = m.format(180000, { from: 'INR', decimals: 0 });
  assert.match(out, /1,80,000/);
  assert.ok(!out.includes('.'), `column asked for whole rupees, got ${out}`);
});

test('the ledger strip still reconciles after conversion', () => {
  /**
   * `ledger.js` computes `outstanding = billed - paid` precisely so the three
   * always agree. Converting and rounding each of them INDEPENDENTLY breaks
   * that. The rule this pins: convert every row, add at full precision, then
   * derive outstanding from the CONVERTED sums.
   */
  const m = makeMoneyFormatter({ display: 'USD', snapshots: SNAPS });
  const rows = [
    { amount: 9200, on: '2026-03-15' },
    { amount: 9582, on: '2026-09-10' },
    { amount: 4600, on: '2026-03-20' },
  ];
  const conv = (r) => m.resolve(r.amount, { from: 'INR', on: r.on }).value;

  const billed = rows.reduce((a, r) => a + conv(r), 0);
  const paid = conv(rows[0]);
  const outstanding = billed - paid;

  assert.ok(Math.abs(billed - (100 + 100 + 50)) < 1e-9);
  assert.ok(Math.abs(outstanding - (billed - paid)) < 1e-9);
  // Each row used its own rate — two different ones — and they still add up.
  assert.notEqual(
    m.resolve(9200, { from: 'INR', on: '2026-03-15' }).rate,
    m.resolve(9200, { from: 'INR', on: '2026-09-10' }).rate
  );
});

test('a display currency outside the offered three is ignored', () => {
  // Defence against a stale localStorage value or a hand-edited profile.
  const m = makeMoneyFormatter({ display: 'EUR', snapshots: SNAPS });
  assert.equal(m.active, false);
  assert.equal(m.resolve(100, { from: 'INR', on: '2026-09-10' }).converted, false);
});

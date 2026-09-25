/**
 * THE MONEY CONTRACT — what currency a number is in, and what to show it as.
 *
 * Every money figure in the product is a plain `Number` stored in whatever
 * currency it was entered in. That does not change here and should not: storing
 * "₹1,80,000" as a string would mean the sum, the filter and the formula all
 * have to parse it back, and every one of them has to agree on the same grammar.
 *
 * What this file adds is the second half of the sentence. A number on its own is
 * not money — money is a number AND a unit — and until now the unit lived in
 * five unrelated places (a column's `settings.currency`, a board's
 * `adsBudget.currency`, a hardcoded `$` in the goals code, and two USD
 * assumptions inside the connector). This is the one place that knows:
 *
 *   1. what currency a stored number is ALREADY in          (the caller says)
 *   2. what currency the person reading it wants             (`display`)
 *   3. the rate between them ON THAT RECORD'S OWN DATE       (`snapshots`)
 *
 * ---- Why the rate is dated, and not simply "today's" -----------------------
 *
 * An invoice raised in March is a fact about March. If it converted at today's
 * rate its dollar value would drift every day, which means the Ledger's "Billed"
 * total moves on its own — and that is a number people reconcile against their
 * books. So a record converts at the rate in force on ITS OWN day, and a March
 * invoice reads the same in September as it did in March.
 *
 * The consequence to keep in mind: two rows in one group can carry DIFFERENT
 * rates, so a total has to convert each row and then add. Summing first and
 * converting the total is wrong, and `ledger.js`'s four figures would stop
 * reconciling with the rows above them.
 *
 * ---- What this file will NOT do --------------------------------------------
 *
 * It never guesses a unit. An unrecognised currency code renders as the bare
 * code ("JPY 1,234") rather than borrowing a symbol, and a code with no rate is
 * left unconverted in its own currency. A figure whose unit is uncertain is
 * shown as what it actually is; the one unacceptable outcome is a confident
 * number in the wrong unit.
 *
 * Mirrored on the server as `server/src/utils/money.js` — but only the CATALOG
 * and the validators are mirrored. Formatting lives here alone, because the
 * server does not render money (see that file's header).
 */

/**
 * Every currency a stored amount may be denominated in.
 *
 * This is the UNION of the two lists that used to disagree —
 * `numberFormat.js`'s five (INR/USD/EUR/GBP/AED) and the Ads Budget card's
 * eight (which added AUD, CAD, SGD and was the only place CAD existed at all).
 * Unioning rather than intersecting is deliberate and load-bearing: a board
 * already set to AUD must still be able to render and re-save itself. Narrowing
 * this list to the three we offer as DISPLAY currencies would make such a board
 * unrepresentable in its own picker, and the next save would silently rewrite
 * its currency.
 *
 * Each entry carries a LOCALE, not just a symbol, because the grouping differs
 * and Indian grouping is not "every three digits" — 1,80,000 is lakhs, not
 * 180,000. `Intl` knows that from the locale.
 *
 * INR is first because this workspace bills in rupees and it reads better at
 * the top of a picker. Nothing depends on the order any more: the old
 * `currencyByCode` fell back to `CURRENCIES[0]` for an unknown code, which is
 * how a column holding dollars could render with a rupee symbol.
 */
export const CURRENCIES = [
  { code: 'INR', symbol: '₹', locale: 'en-IN', name: 'Indian rupee' },
  { code: 'USD', symbol: '$', locale: 'en-US', name: 'US dollar' },
  { code: 'CAD', symbol: 'CA$', locale: 'en-CA', name: 'Canadian dollar' },
  { code: 'EUR', symbol: '€', locale: 'de-DE', name: 'Euro' },
  { code: 'GBP', symbol: '£', locale: 'en-GB', name: 'Pound sterling' },
  { code: 'AED', symbol: 'AED', locale: 'en-AE', name: 'UAE dirham' },
  { code: 'AUD', symbol: 'A$', locale: 'en-AU', name: 'Australian dollar' },
  { code: 'SGD', symbol: 'S$', locale: 'en-SG', name: 'Singapore dollar' },
];

/** `[{ value, label }]` for a `<SelectField>`, e.g. "USD — US dollar". */
export const currencyOptions = () =>
  CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }));

/**
 * The currencies a PERSON may choose to read the product in.
 *
 * Deliberately a much shorter list than `CURRENCIES`, and the two are not the
 * same kind of thing. `CURRENCIES` is "what a number might be stored as" and
 * grows whenever a board is denominated in something new. This is "what the
 * toggle offers", and every entry here is a promise that we can convert
 * anything into it and render it correctly.
 */
export const DISPLAY_CURRENCIES = ['INR', 'USD', 'CAD'];

/**
 * The unit every stored rate is quoted against.
 *
 * A PRECISION decision, not an arbitrary one. The provider returns five decimal
 * places, so the base decides how many SIGNIFICANT figures we get: quoted
 * against USD, INR is 95.82 (five); quoted against INR, USD is 0.01044 (three).
 * Cross-rates derived from three-figure quotes carry ~0.05% error and are not
 * even reciprocal. Basing on the high-value unit and dividing keeps every pair
 * accurate.
 */
export const FX_BASE = 'USD';

/**
 * The catalog entry for a code, or `null` when we do not know the code.
 *
 * `null` rather than a default is the whole point. The version this replaces
 * ended `|| CURRENCIES[0]`, so every unrecognised code — and the field is
 * unvalidated `Mixed` on the server, so there are plenty — silently rendered as
 * rupees. Cosmetic while a symbol was all that hung off it; an ~96x error once
 * a rate is looked up by the same code.
 */
export const currencyByCode = (code) =>
  CURRENCIES.find((c) => c.code === code) || null;

export const isCurrencyCode = (code) => currencyByCode(code) !== null;

export const isDisplayCurrency = (code) => DISPLAY_CURRENCIES.includes(code);

/**
 * How many decimals a figure of this size deserves.
 *
 * Lifted from `connectorFormat.js`'s `formatMoney`, which worked this out first:
 * a budget table full of "$8,000.00" is harder to scan than one full of
 * "$8,000", and the pennies on a four-figure number are noise — but below 100
 * they are the whole number.
 *
 * Judged on the magnitude being SHOWN, not the one it came from. Readability is
 * a property of the number on screen; ₹500 and the $5 it converts to do not
 * want the same treatment.
 */
const decimalsForMagnitude = (n) => (Math.abs(n) < 100 ? 2 : 0);

/**
 * `value` rendered in `code`, with no conversion and no opinion about where the
 * number came from.
 *
 * `decimals` defaults to the magnitude rule above. Pass it explicitly to honour
 * a column's own `settings.decimals` — which is right for an UNCONVERTED figure
 * (the column author chose it) and wrong for a converted one (they chose it for
 * a different currency's scale).
 */
export const formatIn = (value, code, { decimals } = {}) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';

  const d = typeof decimals === 'number' ? decimals : decimalsForMagnitude(value);
  const cur = currencyByCode(code);

  // A code we do not carry. Render the number plainly and SAY the code, rather
  // than borrowing a symbol from the top of the list and asserting something
  // false. "JPY 1,234" is honest and readable; "₹1,234" is a lie.
  if (!cur) {
    const plain = value.toLocaleString(undefined, {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
    const label = typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : '';
    return label ? `${label} ${plain}` : plain;
  }

  try {
    return new Intl.NumberFormat(cur.locale, {
      style: 'currency',
      currency: cur.code,
      // `minimumFractionDigits: 0` is load-bearing, not tidying. `style:
      // 'currency'` otherwise defaults the minimum to the currency's own digits
      // — two for USD — so every whole amount under $100 renders as "$57.00" in
      // a column of "$346" and "$1,020".
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    }).format(value);
  } catch {
    // An environment without full ICU still has to render something a person
    // can read, rather than taking out every cell on the page with a throw.
    return `${cur.symbol}${value.toLocaleString(cur.locale, {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    })}`;
  }
};

/**
 * The rate to multiply a `from` amount by to get a `to` amount.
 *
 * `rates` is one snapshot's table: how many of each currency one unit of
 * `FX_BASE` buys. So `from -> base` is a division and `base -> to` a
 * multiplication, and the pair collapses to `rates[to] / rates[from]`.
 *
 * Returns `null` — never 1, and never a guess — when either leg is missing or
 * unusable. A missing rate must leave the caller showing the source currency,
 * and a silent 1 would quietly claim two different currencies were equal.
 *
 * Both legs are checked for `<= 0`, not just one: a zero or negative rate that
 * survived sanitisation would otherwise produce a zero or negative amount out
 * of a positive one.
 */
export const crossRate = (rates, from, to) => {
  if (!from || !to) return null;
  if (from === to) return 1;
  if (!rates) return null;

  const f = rates[from];
  const t = rates[to];
  if (!Number.isFinite(f) || !Number.isFinite(t)) return null;
  if (f <= 0 || t <= 0) return null;

  return t / f;
};

/**
 * `value` in `to`, at full float precision, or `null` if it cannot be converted.
 *
 * Deliberately does NOT round. Rounding here and then adding would drift a
 * total away from the rows it is made of; rounding belongs at the point of
 * display, once, which is `formatIn`.
 */
export const convert = (value, from, to, rates) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rate = crossRate(rates, from, to);
  if (rate === null) return null;
  return value * rate;
};

/**
 * The snapshot in force on `dayKey` — the newest one dated at or before it.
 *
 * ---- Why it never reaches forward ------------------------------------------
 *
 * A record older than every snapshot we hold returns `null`, and the caller
 * shows the source currency. The tempting alternative — fall back to the
 * OLDEST snapshot, or the nearest one either side — is the single failure mode
 * that produces a confidently wrong historical figure, because it values a 2024
 * invoice at a 2026 rate while looking exactly as authoritative as a correct
 * one.
 *
 * ---- Why there is no staleness check ---------------------------------------
 *
 * There is deliberately no "refuse a rate older than N days" rule anywhere in
 * this file, and adding one would break the feature rather than harden it.
 * Under dated snapshots a March invoice's rate IS six months old, and that is
 * exactly correct. The only failure condition is "no snapshot at or before this
 * record's day". A wedged refresh job therefore shows up as NEW records falling
 * back to their source currency — never as historical invoices silently
 * un-converting themselves.
 *
 * `dayKey` omitted means "the newest we have", which is what an undated figure
 * gets.
 */
export const snapshotFor = (snapshots, dayKey) => {
  let best = null;
  for (const s of Array.isArray(snapshots) ? snapshots : []) {
    if (!s || typeof s.dayKey !== 'string') continue;
    // ISO day keys sort lexicographically, which is the whole reason the wire
    // format is a string and not a Date.
    if (dayKey && s.dayKey > dayKey) continue;
    if (!best || s.dayKey > best.dayKey) best = s;
  }
  return best;
};

/** A `monthKey` ('2026-03') as the day its rate is read from. */
export const dayKeyOfMonthKey = (monthKey) =>
  typeof monthKey === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)
    ? `${monthKey}-01`
    : null;

/** Whatever a caller has — a Date, an ISO string, a day key — as a day key. */
export const toDayKey = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    // Already a day key, or an ISO timestamp whose first ten characters are one.
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  return null;
};

/**
 * A formatter bound to one reader's choice and one set of rates.
 *
 * This is what `useMoney()` hands components, and it is the reason no call site
 * grows a prop chain: the display currency and the rate tables are closed over
 * here, so a cell that used to call `formatNumber(v, settings)` calls
 * `money(v, { from })` and is otherwise unchanged.
 *
 * `display` falsy — which is the default for everyone until they choose —
 * means AS ENTERED. Nothing converts, and the product renders exactly as it
 * did before this file existed. A default that converted would have restated
 * every figure in the product on the day it shipped.
 *
 * @param {Object} opts
 * @param {string|null} opts.display  the reader's currency, or null for as-entered
 * @param {Array}  opts.snapshots     [{ dayKey, rates }], any order
 */
export const makeMoneyFormatter = ({ display = null, snapshots = [] } = {}) => {
  const target = isDisplayCurrency(display) ? display : null;

  /**
   * What `value` becomes for this reader, as data rather than as a string.
   *
   * Separate from `format` because the totals need it: `ledgerTotals` has to
   * convert every row and add the results at full precision, and handing it a
   * formatted string would mean parsing money back out of prose.
   */
  const resolve = (value, { from, on } = {}) => {
    const source = from || null;
    const miss = { value, currency: source, converted: false, rate: null, asOf: null };

    if (typeof value !== 'number' || !Number.isFinite(value)) return miss;
    if (!target || !source || source === target) return miss;

    const snap = snapshotFor(snapshots, on ? toDayKey(on) : null);
    if (!snap) return miss;

    const rate = crossRate(snap.rates, source, target);
    if (rate === null) return miss;

    return {
      value: value * rate,
      currency: target,
      converted: true,
      rate,
      asOf: snap.dayKey,
    };
  };

  /**
   * `value` as a string.
   *
   * `decimals` is honoured only when the figure is NOT converted. A column's
   * `decimals: 0` is a fact about the rupee scale — carry it across a ÷96
   * conversion and a ₹500 line renders "$5".
   */
  const format = (value, { from, on, decimals } = {}) => {
    const r = resolve(value, { from, on });
    if (r.value === null || r.value === undefined || r.value === '') return '';
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return '';
    return formatIn(r.value, r.currency, r.converted ? {} : { decimals });
  };

  return {
    /** The reader's currency, or null when they read amounts as entered. */
    display: target,
    /** True when a toggle is actually in effect — cheap guard for callers. */
    active: target !== null,
    resolve,
    format,
  };
};

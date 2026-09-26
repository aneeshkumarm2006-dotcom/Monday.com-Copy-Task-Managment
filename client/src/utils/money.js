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
 *
 * Case- and whitespace-tolerant, because stored codes have not always been
 * normalised: a column saved as 'cad' rendered "CAD 1,234" with no symbol and
 * never converted, since the rate table is keyed 'CAD'. Tolerance is not
 * guessing — 'cad' can only mean one currency.
 */
export const currencyByCode = (code) => {
  if (typeof code !== 'string') return null;
  const up = code.trim().toUpperCase();
  return CURRENCIES.find((c) => c.code === up) || null;
};

export const isCurrencyCode = (code) => currencyByCode(code) !== null;

/**
 * A stored code as it should be COMPARED and SHOWN: the catalog's code, else
 * the raw string trimmed and uppercased, else null for nothing at all.
 *
 * The comparison half is the point. Two places compared a raw stored code
 * against a canonical one — the board-currency label calling a 'cad' column
 * "different" from a CAD board, and the surface note telling a CAD reader
 * "Shown as entered (cad) — no exchange rate available yet". An unknown code
 * is kept (uppercased) rather than dropped, because it renders as itself (see
 * `formatIn`) and so really is a different unit from the board's.
 */
export const canonicalCurrency = (code) => {
  const known = currencyByCode(code);
  if (known) return known.code;
  if (typeof code !== 'string') return null;
  const up = code.trim().toUpperCase();
  return up || null;
};

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
 *
 * This is the rule for CONVERTED figures, whose pennies are an artefact of the
 * rate. A figure somebody TYPED gets `decimalsAuto` instead — see below.
 */
const decimalsForMagnitude = (n) => (Math.abs(n) < 100 ? 2 : 0);

/**
 * Decimals for a figure shown exactly as it was entered: none when it is whole,
 * two when it is not.
 *
 * The magnitude rule above is wrong for these, in both directions. It rounded a
 * typed ₹1,234.50 to "₹1,235" — a figure nobody entered, on an invoice somebody
 * reconciles to the paisa — and it padded a typed $57 out to "$57.00". The
 * templates used to paper over the first half by pinning `decimals: 0` on every
 * money column, which only moved the rounding somewhere harder to see. A typed
 * figure already says how precise it is; the renderer's job is to not lose that.
 */
const decimalsAuto = (n) => (Number.isInteger(n) ? 0 : 2);

/**
 * `decimals` as `Intl` will accept it, or the fallback rule.
 *
 * A column's `settings.decimals` is unvalidated on the way in, and `Intl`
 * throws a RangeError for a negative or fractional digit count — as does the
 * `toLocaleString` in `formatIn`'s own catch, so one bad setting would take out
 * every cell in the column rather than just rendering with default precision.
 */
const resolveDecimals = (decimals, value) => {
  if (decimals === 'auto') return decimalsAuto(value);
  if (typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 20) {
    return decimals;
  }
  return decimalsForMagnitude(value);
};

/**
 * `value` rendered in `code`, with no conversion and no opinion about where the
 * number came from.
 *
 * `decimals` defaults to the magnitude rule above. Pass it explicitly to honour
 * a column's own `settings.decimals` — which is right for an UNCONVERTED figure
 * (the column author chose it) and wrong for a converted one (they chose it for
 * a different currency's scale). Pass `'auto'` for an unconverted figure whose
 * column states no precision: whole stays whole, anything else gets two.
 *
 * ---- Why the symbol is swapped in after Intl has run -----------------------
 *
 * Each catalog entry pairs a currency with its HOME locale, because that is
 * where the grouping comes from (1,80,000 for rupees). But Intl prints a
 * currency's home symbol unqualified in its home locale: en-CA gives "$" for
 * CAD, en-AU "$" for AUD, en-SG "$" for SGD. So a CAD column, a USD column and
 * a reader toggling between the two all read a bare "$", while the picker, the
 * edit prefix and the Navbar all say "CA$". The number was right and the unit
 * was ambiguous, which for money is the same thing as wrong.
 *
 * Replacing only the `currency` part keeps everything the locale gets right —
 * the grouping, the minus sign, and which side of the number the symbol sits
 * on (€ trails in de-DE) — and makes the unit the catalog's, the same string
 * every other surface shows. The catch below already used `cur.symbol`, so an
 * environment without full ICU now agrees with one that has it.
 */
export const formatIn = (value, code, { decimals } = {}) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';

  const d = resolveDecimals(decimals, value);
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
    })
      .formatToParts(value)
      .map((part) => (part.type === 'currency' ? cur.symbol : part.value))
      .join('');
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

/** A Date as the LOCAL calendar day it falls on. */
const localDayKey = (d) => {
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/**
 * Whatever a caller has — a Date, an ISO string, a day key — as a day key.
 *
 * ---- Why a timestamp is read in LOCAL time, never sliced ------------------
 *
 * A date cell stores the local midnight of the day somebody picked, serialised
 * as UTC. In India that is the PREVIOUS day at 18:30Z: an invoice issued on
 * 15 March is stored as "2026-03-14T18:30:00.000Z". Slicing the first ten
 * characters — what this used to do — dated every IST record one day early,
 * which is invisible until the day in question is the first of a month and
 * the invoice converts at the wrong month's rate.
 *
 * So a full timestamp is parsed and read back in local parts: the day the
 * person picked. A bare 'YYYY-MM-DD' carries no time and no zone, so it IS the
 * day and is returned untouched — parsing it would read it as UTC midnight and
 * shift it the other way west of Greenwich.
 */
export const toDayKey = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return localDayKey(new Date(value));
  }
  if (value instanceof Date) return localDayKey(value);
  return null;
};

/**
 * Is `col` money that belongs to THIS board — a currency-format column that is
 * not a mirror?
 *
 * `settings.format === 'currency'` is the one test for "is this money" (the
 * server's `isMoneyColumn` says the same; a payments column has the format
 * pinned, so it passes). A MIRROR column is the exception that matters when the
 * question is "what unit is this board in": its figure is another board's cell,
 * shown as-is, so its code is a fact about the SOURCE board. Letting it vote
 * made a CAD board that mirrors a rupee budget resolve to INR — and a relabel of
 * this board would have stamped CAD onto a column that still showed rupees.
 *
 * Mirrored by `isOwnMoneyColumn` in `server/src/utils/money.js`; the two must
 * agree, or the chip and the server that stamps new columns name different
 * units for the same board.
 */
export const isOwnMoneyColumn = (col) =>
  !!col &&
  typeof col.settings === 'object' &&
  col.settings !== null &&
  col.settings.format === 'currency' &&
  col.type !== 'mirror';

/**
 * The currency a board's money is in, or null when nothing says.
 *
 *   1. `board.currency` — the board-level unit, set by the "Change" control;
 *   2. else the first of the board's OWN money columns (`isOwnMoneyColumn` —
 *      never a mirror) that carries a valid code, in array order — the same
 *      column `ledgerColumns().amount` finds, so the grid, the Ledger and this
 *      label agree on a board older than (1);
 *   3. else the workspace's base currency.
 *
 * Mirrored on the server (the board-currency endpoints resolve the same
 * order). Each step is validated rather than trusted, because every one of
 * them is a stored string and an unknown code must fall through to the next
 * rather than be rendered as if it meant something.
 */
export const boardCurrencyOf = (board, orgBase = null) => {
  const valid = (code) => {
    if (typeof code !== 'string') return null;
    const up = code.trim().toUpperCase();
    return isCurrencyCode(up) ? up : null;
  };

  const own = valid(board?.currency);
  if (own) return own;

  const columns = Array.isArray(board?.columns) ? board.columns : [];
  for (const c of columns) {
    if (!isOwnMoneyColumn(c)) continue;
    const code = valid(c.settings.currency);
    if (code) return code;
  }

  return valid(orgBase);
};

/**
 * Does any money column on `board` show a unit other than `code` — the board's
 * resolved currency (`boardCurrencyOf`)?
 *
 * Measured against the RESOLVED code, not among the columns themselves. A
 * board whose `currency` says CAD and whose only money column still says INR
 * has one distinct column code — "the columns agree" — and yet every figure
 * in that column renders ₹ under a label reading CA$. That is the most mixed a
 * board can be, and comparing the columns only with each other called it
 * clean.
 *
 * A column with no code of its own is not a disagreement: it renders in the
 * board's unit. Codes compare canonically (`canonicalCurrency`), so a legacy
 * 'cad' beside CAD is not a mix — but a code outside the catalog is, because
 * it renders as itself rather than as the board's.
 *
 * A MIRROR is never a disagreement either (`isOwnMoneyColumn`): it shows the
 * source board's figure in the source board's unit, and relabelling THIS board
 * cannot change that — so flagging it would offer a fix that fixes nothing.
 */
export const boardCurrencyMixed = (board, code) => {
  const target = canonicalCurrency(code);
  if (!target) return false;
  const columns = Array.isArray(board?.columns) ? board.columns : [];
  return columns.some((c) => {
    if (!isOwnMoneyColumn(c)) return false;
    const own = canonicalCurrency(c.settings.currency);
    return own !== null && own !== target;
  });
};

/**
 * Does this board FOLLOW the workspace currency?
 *
 * `Board.currency` null means exactly that: the board has no unit of its own,
 * and its money moves with `Organisation.baseCurrency` — the server relabels
 * every following board's money columns when the workspace currency changes.
 * A catalog code is an explicit per-board override, which a workspace change
 * leaves alone.
 *
 * Tested with the catalog rather than `== null` so a stored string the catalog
 * does not know (the field is enum-validated, but a cached board is whatever
 * the last response said) is read the way `boardCurrencyOf` reads it: as
 * nothing, so the workspace is what speaks.
 */
export const boardFollowsWorkspace = (board) => !currencyByCode(board?.currency);

/**
 * Everything a board-currency control needs to say about one board, in one
 * place, so the toolbar chip, the Edit Board dialog and the Settings list
 * cannot come to different conclusions about the same board.
 *
 *   following  `boardFollowsWorkspace`
 *   code       the unit the figures are IN — `boardCurrencyOf`, deliberately
 *              not the workspace's: on a following board the columns carry the
 *              workspace code once the server has relabelled them, and until
 *              then (an open board whose refresh has not landed, or a board
 *              the relabel could not reach) the label must name what the cells
 *              actually print, not what they are about to
 *   workspace  the workspace's code, canonical, or null while it is unknown
 *   stored     the board's own override code, or null when following
 *   mixed      `boardCurrencyMixed` against `code`
 *   outOfStep  a FOLLOWING board whose own money is not in the workspace's
 *              unit — the relabel a workspace change owes it has not reached
 *              it yet. Picking "Workspace currency" again is what fixes it, so
 *              the control must not treat that pick as a no-op
 */
export const boardCurrencyState = (board, orgBase = null) => {
  const following = boardFollowsWorkspace(board);
  const workspace = currencyByCode(orgBase)?.code || null;
  const stored = following ? null : currencyByCode(board?.currency).code;
  const code = boardCurrencyOf(board, orgBase);
  const mixed = boardCurrencyMixed(board, code);
  const outOfStep = following && !!workspace && !!code && code !== workspace;
  return { following, code, workspace, stored, mixed, outOfStep };
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
    // The canonical code where we know it, so a stored 'cad' finds the 'CAD'
    // rate; an unknown code passes through to be rendered as itself.
    const source = currencyByCode(from)?.code || from || null;
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
   * conversion and a ₹500 line renders "$5". An unconverted figure with no
   * `decimals` shows the precision it was typed with (`'auto'`); a converted
   * one follows the magnitude rule, because its pennies came from the rate.
   */
  const format = (value, { from, on, decimals } = {}) => {
    const r = resolve(value, { from, on });
    if (r.value === null || r.value === undefined || r.value === '') return '';
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return '';
    if (r.converted) return formatIn(r.value, r.currency, {});
    return formatIn(r.value, r.currency, { decimals: decimals ?? 'auto' });
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

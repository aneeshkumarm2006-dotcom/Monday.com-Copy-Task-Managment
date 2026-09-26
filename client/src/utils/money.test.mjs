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
  boardCurrencyOf,
  boardCurrencyMixed,
  boardCurrencyState,
  boardFollowsWorkspace,
  isOwnMoneyColumn,
  canonicalCurrency,
  makeMoneyFormatter,
} from './money.js';
import { formatNumber, formatColumnValue } from './numberFormat.js';

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

test('a stored code in the wrong case still resolves, renders and converts', () => {
  // Columns saved as 'cad' rendered "CAD 1,234" and never found the 'CAD' rate.
  assert.equal(currencyByCode(' cad ')?.code, 'CAD');
  assert.equal(formatIn(1234, 'cad'), 'CA$1,234');
  const m = makeMoneyFormatter({ display: 'USD', snapshots: [{ dayKey: '2026-09-01', rates: { USD: 1, CAD: 1.25 } }] });
  const r = m.resolve(125, { from: 'cad' });
  assert.equal(r.converted, true);
  assert.equal(r.value, 100);
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

test('every dollar says WHICH dollar — the catalog symbol, not the home locale bare "$"', () => {
  /**
   * en-CA prints CAD as a bare "$", as en-AU does AUD and en-SG SGD, so a CAD
   * column, a USD column and a reader toggling between them all read "$". The
   * picker and the edit prefix said "CA$" the whole time.
   */
  assert.equal(formatIn(1234, 'CAD'), 'CA$1,234');
  assert.equal(formatIn(1234, 'AUD'), 'A$1,234');
  assert.equal(formatIn(1234, 'SGD'), 'S$1,234');
  assert.equal(formatIn(1234, 'USD'), '$1,234');
  assert.notEqual(formatIn(1000, 'CAD'), formatIn(1000, 'USD'));
});

test('the symbol swap keeps the locale grouping and the symbol position', () => {
  // Lakhs survive — the whole reason the catalog pairs a code with a locale.
  assert.equal(formatIn(180000, 'INR', { decimals: 0 }), '₹1,80,000');
  // The euro still trails in de-DE, with de-DE's grouping.
  const eur = formatIn(1234, 'EUR');
  assert.match(eur, /^1\.234\s€$/, `expected the euro after the number, got ${eur}`);
  // A negative keeps its sign in front of the swapped symbol.
  assert.equal(formatIn(-1234, 'CAD'), '-CA$1,234');
});

test('an unusable decimals setting falls back instead of throwing', () => {
  // `settings.decimals` is unvalidated; Intl throws a RangeError for these,
  // which would take out every cell in the column.
  assert.equal(formatIn(1234, 'USD', { decimals: -1 }), '$1,234');
  assert.equal(formatIn(1234, 'USD', { decimals: 2.5 }), '$1,234');
});

test("'auto' decimals keep a typed figure's own precision", () => {
  assert.equal(formatIn(1234, 'USD', { decimals: 'auto' }), '$1,234');
  assert.equal(formatIn(57, 'USD', { decimals: 'auto' }), '$57', 'a whole $57 is not $57.00');
  assert.equal(formatIn(1234.5, 'USD', { decimals: 'auto' }), '$1,234.50', 'real cents are not rounded away');
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

test('a currency column with no stated decimals shows what was typed', () => {
  // Templates used to pin `decimals: 0`, which rounded ₹1,234.50 to ₹1,235.
  assert.equal(formatNumber(1234.5, { format: 'currency', currency: 'INR' }), '₹1,234.50');
  assert.equal(formatNumber(180000, { format: 'currency', currency: 'INR' }), '₹1,80,000');
  // A stated precision still wins.
  assert.equal(formatNumber(1234.5, { format: 'currency', currency: 'INR', decimals: 0 }), '₹1,235');
});

// --- a column's figure: only a CURRENCY column is money --------------------

/**
 * The critical regression from the commit that introduced `useMoney`: every
 * number went through the money formatter with the workspace currency as its
 * source, so "Hours: 12" read "₹12.00" and a percent column read "₹85.00".
 * `formatColumnValue` is the pure half of `useMoney().column`.
 */
const AS_ENTERED = makeMoneyFormatter({ display: null, snapshots: [] });
const SNAPS_FOR_COLUMN = [{ dayKey: '2026-09-01', rates: { USD: 1, INR: 95.82 } }];

test('a plain number column shows no symbol', () => {
  assert.equal(formatColumnValue(AS_ENTERED, 12, {}, { fallbackCurrency: 'INR' }), '12');
  assert.equal(formatColumnValue(AS_ENTERED, 12, null, { fallbackCurrency: 'INR' }), '12');
  assert.equal(formatColumnValue(AS_ENTERED, 1200, { format: 'plain' }, { fallbackCurrency: 'CAD' }), '1,200');
});

test('a percent column reads as a percent, even one that used to be currency', () => {
  // Switching Currency → Percent keeps the old `currency` in settings; the
  // FORMAT decides, not whether a code is present.
  assert.equal(formatColumnValue(AS_ENTERED, 85, { format: 'percent' }, { fallbackCurrency: 'INR' }), '85%');
  assert.equal(
    formatColumnValue(AS_ENTERED, 85, { format: 'percent', currency: 'INR' }, { fallbackCurrency: 'INR' }),
    '85%'
  );
});

test('a rating average is a number, not money', () => {
  assert.equal(formatColumnValue(AS_ENTERED, 4.2, { max: 5, summary: 'avg' }, { fallbackCurrency: 'INR' }), '4.2');
});

test('a reader who chose a display currency does not convert a plain column', () => {
  // The USD reader's "1,200 hours" used to become $12.52, as if it were rupees.
  const usd = makeMoneyFormatter({ display: 'USD', snapshots: SNAPS_FOR_COLUMN });
  assert.equal(formatColumnValue(usd, 1200, {}, { fallbackCurrency: 'INR' }), '1,200');
  // …while a currency column on the same page does convert.
  assert.equal(
    formatColumnValue(usd, 9582, { format: 'currency', currency: 'INR' }, { fallbackCurrency: 'INR' }),
    '$100'
  );
});

test("a currency column's unit: its own code, then the fallback, never a literal", () => {
  const cad = { format: 'currency', currency: 'CAD' };
  const bare = { format: 'currency' };
  assert.equal(formatColumnValue(AS_ENTERED, 1234, cad, { fallbackCurrency: 'INR' }), 'CA$1,234');
  assert.equal(formatColumnValue(AS_ENTERED, 1234, bare, { fallbackCurrency: 'CAD' }), 'CA$1,234');
  // Nobody knows the unit yet (the org currency has not loaded): a plain
  // number, honestly — not "₹1,234".
  const unknown = formatColumnValue(AS_ENTERED, 1234, bare, {});
  assert.equal(unknown, '1,234');
});

test('a currency cell typed as a string still renders', () => {
  assert.equal(formatColumnValue(AS_ENTERED, '1500', { format: 'currency', currency: 'USD' }), '$1,500');
  assert.equal(formatColumnValue(AS_ENTERED, '', { format: 'currency', currency: 'USD' }), '');
  assert.equal(formatColumnValue(null, 1500.25, { format: 'currency', currency: 'USD' }), '$1,500.25');
});

// --- the board's currency --------------------------------------------------

test('a board currency resolves board → first coded money column → workspace', () => {
  const cadCol = { type: 'number', settings: { format: 'currency', currency: 'CAD' } };
  const bareCol = { type: 'number', settings: { format: 'currency' } };
  const plainCol = { type: 'number', settings: { currency: 'USD' } };

  assert.equal(boardCurrencyOf({ currency: 'aud', columns: [cadCol] }, 'INR'), 'AUD');
  // A code-less money column is skipped, not taken as "no currency".
  assert.equal(boardCurrencyOf({ columns: [bareCol, cadCol] }, 'INR'), 'CAD');
  // A plain column's leftover code is not the board's unit.
  assert.equal(boardCurrencyOf({ columns: [plainCol] }, 'INR'), 'INR');
  // An unknown stored code falls through rather than being trusted.
  assert.equal(boardCurrencyOf({ currency: 'ZZZ', columns: [] }, 'USD'), 'USD');
  assert.equal(boardCurrencyOf(null, null), null);
  assert.equal(boardCurrencyOf({ columns: [] }, 'nonsense'), null);
});

test('canonicalCurrency: catalog code, else the stored code uppercased, else null', () => {
  assert.equal(canonicalCurrency('cad'), 'CAD');
  assert.equal(canonicalCurrency(' CAD '), 'CAD');
  // Not in the catalog — kept, because it renders as itself (formatIn).
  assert.equal(canonicalCurrency('zzz'), 'ZZZ');
  assert.equal(canonicalCurrency(''), null);
  assert.equal(canonicalCurrency('   '), null);
  assert.equal(canonicalCurrency(null), null);
  assert.equal(canonicalCurrency(42), null);
});

test('a board is mixed when any money column differs from its RESOLVED unit', () => {
  const money = (currency) => ({ type: 'number', settings: { format: 'currency', currency } });
  // The worst case, and the one that was missed: one column, so the columns
  // "agree" among themselves — but it is INR under a CAD label.
  const onlyInr = { currency: 'CAD', columns: [money('INR')] };
  assert.equal(boardCurrencyMixed(onlyInr, boardCurrencyOf(onlyInr)), true);
  // Two columns that differ from each other.
  const two = { columns: [money('CAD'), money('INR')] };
  assert.equal(boardCurrencyMixed(two, boardCurrencyOf(two)), true);
  // A legacy lower-case code is the same unit, not a mix.
  const legacy = { currency: 'CAD', columns: [money('cad'), money('CAD')] };
  assert.equal(boardCurrencyMixed(legacy, boardCurrencyOf(legacy)), false);
  // A code-less money column renders in the board's unit; a plain column's
  // leftover code is not money at all.
  const bare = {
    currency: 'CAD',
    columns: [money(undefined), money(''), { type: 'number', settings: { format: 'plain', currency: 'INR' } }],
  };
  assert.equal(boardCurrencyMixed(bare, boardCurrencyOf(bare)), false);
  // An unknown code renders as itself, so it IS different from the board's.
  const odd = { currency: 'CAD', columns: [money('ZZZ')] };
  assert.equal(boardCurrencyMixed(odd, boardCurrencyOf(odd)), true);
  // Nothing resolved means nothing to disagree with.
  assert.equal(boardCurrencyMixed({ columns: [money('ZZZ')] }, null), false);
  assert.equal(boardCurrencyMixed(null, 'CAD'), false);
});

// --- following the workspace -----------------------------------------------

test('a board with no currency of its own FOLLOWS the workspace; a code is an override', () => {
  assert.equal(boardFollowsWorkspace({ currency: null }), true);
  assert.equal(boardFollowsWorkspace({}), true);
  assert.equal(boardFollowsWorkspace(null), true);
  assert.equal(boardFollowsWorkspace({ currency: '' }), true);
  // An override, whatever its case.
  assert.equal(boardFollowsWorkspace({ currency: 'USD' }), false);
  assert.equal(boardFollowsWorkspace({ currency: 'usd' }), false);
  // A code the catalog does not know is read as nothing — the same as
  // `boardCurrencyOf`, which falls through it to the workspace.
  assert.equal(boardFollowsWorkspace({ currency: 'ZZZ' }), true);
});

test('boardCurrencyState: a following board in step with the workspace', () => {
  const money = (currency) => ({ type: 'number', settings: { format: 'currency', currency } });
  const s = boardCurrencyState({ currency: null, columns: [money('CAD'), money('CAD')] }, 'cad');
  assert.deepEqual(s, {
    following: true,
    code: 'CAD',
    workspace: 'CAD',
    stored: null,
    mixed: false,
    outOfStep: false,
  });
  // No money at all: it reads in the workspace's unit, and is in step.
  const empty = boardCurrencyState({ currency: null, columns: [] }, 'CAD');
  assert.equal(empty.code, 'CAD');
  assert.equal(empty.outOfStep, false);
});

test('boardCurrencyState: a following board the workspace relabel has not reached yet', () => {
  const money = (currency) => ({ type: 'number', settings: { format: 'currency', currency } });
  // The workspace moved to CAD; this board's columns still say INR. The label
  // names what the cells PRINT (INR), and says the board is out of step.
  const s = boardCurrencyState({ currency: null, columns: [money('INR')] }, 'CAD');
  assert.equal(s.following, true);
  assert.equal(s.code, 'INR');
  assert.equal(s.workspace, 'CAD');
  assert.equal(s.mixed, false);
  assert.equal(s.outOfStep, true);
  // A mirror is the source board's unit and is never "out of step" here.
  const mirror = { type: 'mirror', settings: { format: 'currency', currency: 'INR' } };
  const m = boardCurrencyState({ currency: null, columns: [mirror] }, 'CAD');
  assert.equal(m.code, 'CAD');
  assert.equal(m.outOfStep, false);
  // The workspace unknown (not loaded yet): nothing to be out of step WITH.
  assert.equal(boardCurrencyState({ columns: [money('INR')] }, null).outOfStep, false);
});

test('boardCurrencyState: an override keeps its own unit whatever the workspace says', () => {
  const money = (currency) => ({ type: 'number', settings: { format: 'currency', currency } });
  const s = boardCurrencyState({ currency: 'usd', columns: [money('USD')] }, 'CAD');
  assert.equal(s.following, false);
  assert.equal(s.stored, 'USD');
  assert.equal(s.code, 'USD');
  assert.equal(s.workspace, 'CAD');
  // Differing from the workspace is the POINT of an override, not a fault.
  assert.equal(s.outOfStep, false);
  assert.equal(s.mixed, false);
  // …but a column left behind in another unit is still a mix.
  const left = boardCurrencyState({ currency: 'USD', columns: [money('INR')] }, 'CAD');
  assert.equal(left.mixed, true);
});

// --- a mirror's unit is its SOURCE board's ---------------------------------

test('isOwnMoneyColumn: currency-format columns of this board, never a mirror', () => {
  assert.equal(isOwnMoneyColumn({ type: 'number', settings: { format: 'currency', currency: 'CAD' } }), true);
  assert.equal(isOwnMoneyColumn({ type: 'formula', settings: { format: 'currency' } }), true);
  // Payments has its format pinned by the server, so it is money like any other.
  assert.equal(isOwnMoneyColumn({ type: 'payments', settings: { format: 'currency', currency: 'INR' } }), true);
  // The one exclusion: a mirror shows ANOTHER board's figure in that board's unit.
  assert.equal(isOwnMoneyColumn({ type: 'mirror', settings: { format: 'currency', currency: 'INR' } }), false);
  // Not money at all.
  assert.equal(isOwnMoneyColumn({ type: 'number', settings: { format: 'percent', currency: 'INR' } }), false);
  assert.equal(isOwnMoneyColumn({ type: 'number' }), false);
  assert.equal(isOwnMoneyColumn({ type: 'number', settings: null }), false);
  assert.equal(isOwnMoneyColumn(null), false);
  assert.equal(isOwnMoneyColumn(undefined), false);
});

test("a mirror never votes on the board's currency", () => {
  /**
   * The bug this pins: a CAD board that mirrors a rupee budget from another
   * board resolved to INR, because the mirror came first in the array — so the
   * chip said ₹ and a relabel would have stamped CAD onto figures that are
   * still rupees on their own board.
   */
  const mirror = { type: 'mirror', settings: { format: 'currency', currency: 'INR' } };
  const amount = { type: 'number', settings: { format: 'currency', currency: 'CAD' } };
  assert.equal(boardCurrencyOf({ columns: [mirror, amount] }, 'USD'), 'CAD', 'the own column wins');
  assert.equal(boardCurrencyOf({ columns: [mirror] }, 'USD'), 'USD', 'a mirror alone falls to the workspace');
  assert.equal(boardCurrencyOf({ columns: [mirror] }, null), null);
});

test('a mirror in another unit does not make a board mixed', () => {
  const mirror = { type: 'mirror', settings: { format: 'currency', currency: 'INR' } };
  const amount = { type: 'number', settings: { format: 'currency', currency: 'CAD' } };
  const board = { currency: 'CAD', columns: [amount, mirror] };
  assert.equal(boardCurrencyMixed(board, boardCurrencyOf(board)), false);
  // …while an own column in that unit still does.
  const own = { currency: 'CAD', columns: [amount, { ...mirror, type: 'number' }] };
  assert.equal(boardCurrencyMixed(own, boardCurrencyOf(own)), true);
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
  // Built from LOCAL parts so the test means the same thing in every zone.
  const morning = new Date(2026, 2, 15, 9, 30);
  assert.equal(toDayKey('2026-03-15'), '2026-03-15');
  assert.equal(toDayKey(morning.toISOString()), '2026-03-15');
  assert.equal(toDayKey(morning), '2026-03-15');
  assert.equal(toDayKey(null), null);
  assert.equal(toDayKey('not a date'), null);
});

test('toDayKey reads a stored date cell as the day that was picked', () => {
  /**
   * A date cell stores LOCAL midnight as UTC. In India that is the previous
   * day at 18:30Z — slicing the string dated every IST invoice a day early,
   * and one issued on the 1st converted at the previous month's rate.
   */
  const picked = new Date(2026, 8, 1); // local midnight, 1 September
  assert.equal(toDayKey(picked.toISOString()), '2026-09-01');
  assert.equal(toDayKey(picked), '2026-09-01');
  // A bare day key carries no zone and is never re-parsed.
  assert.equal(toDayKey('2026-09-01'), '2026-09-01');
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

test('an unconverted figure with no decimals shows the precision it was typed with', () => {
  const m = makeMoneyFormatter({ display: null, snapshots: SNAPS });
  assert.equal(m.format(1234, { from: 'CAD' }), 'CA$1,234');
  assert.equal(m.format(57, { from: 'USD' }), '$57');
  assert.equal(m.format(1234.5, { from: 'INR' }), '₹1,234.50');
});

test('a converted figure keeps the magnitude rule', () => {
  // Its pennies come from the rate, so they are shown only where they matter.
  const m = makeMoneyFormatter({ display: 'USD', snapshots: SNAPS });
  assert.equal(m.format(95820, { from: 'INR', on: '2026-09-10' }), '$1,000');
  assert.equal(m.format(958.2, { from: 'INR', on: '2026-09-10' }), '$10.00');
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

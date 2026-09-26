import { formatColumnValue } from './numberFormat.js';
import { columnValue, columnValuesOf, numericValue } from './columnValues.js';
import { boardCurrencyOf } from './money.js';
import { paymentsOf } from './payments.js';

/**
 * Group column summaries — the number under a column, per group.
 *
 * A billing board is a list of rows that happen to have amounts on them until
 * something adds them up. Four of the six templates want exactly this, which is
 * why it is one mechanism with a per-column setting rather than four bespoke
 * footers.
 *
 * Computed on the CLIENT from rows already loaded, deliberately. The server
 * alternative is an aggregation per group per column on every board read, to
 * produce a number the client is holding every input to. The one case that
 * would need the server is a group paginated beyond what is loaded — and the
 * board loads a group whole, so it does not arise.
 */

/** What a column can summarise to. `none` means the footer cell stays empty. */
export const SUMMARIES = [
  { key: 'none', label: 'None' },
  { key: 'sum', label: 'Sum' },
  { key: 'avg', label: 'Average' },
  { key: 'min', label: 'Lowest' },
  { key: 'max', label: 'Highest' },
  { key: 'filled', label: 'Filled' },
  { key: 'empty', label: 'Empty' },
  { key: 'checked', label: 'Checked' },
];

/** Which summaries make sense for which column type. */
const NUMERIC_TYPES = new Set(['number', 'formula', 'rating', 'mirror', 'payments']);

export const summariesFor = (type) => {
  if (NUMERIC_TYPES.has(type)) {
    return SUMMARIES.filter((s) => s.key !== 'checked');
  }
  if (type === 'checkbox') {
    return SUMMARIES.filter((s) => ['none', 'checked', 'filled', 'empty'].includes(s.key));
  }
  return SUMMARIES.filter((s) => ['none', 'filled', 'empty'].includes(s.key));
};

/**
 * Is a stored cell empty?
 *
 * An empty LIST is empty too: a file column whose only file was removed, or a
 * payments column with no receipts, holds `[]` — and counting that as "filled"
 * would report a claim with no receipt as having one.
 */
const isBlank = (v) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Compute one column's summary over a group's rows.
 *
 * Returns `{ value, count }` or null when there is nothing to show. `count` is
 * how many rows CONTRIBUTED, which is what makes an average honest: an average
 * over three filled cells in a group of ten is not the group's average, and the
 * footer says so rather than implying otherwise.
 *
 * Empty cells are EXCLUDED from sum and average rather than counted as zero.
 * A budget line with no amount typed yet is not a line worth ₹0, and averaging
 * it in would drag every total toward a number nobody entered.
 *
 * The numbers come from `numericValue`, not the stored cell, because two of the
 * numeric types store no number: a formula stores nothing (so a "Remaining"
 * column totalled ₹0 however much was left) and a payments column stores a
 * list of receipts. `columns` — the board's — is what a formula needs to find
 * its inputs; without it a formula column has no values to add.
 */
export const computeSummary = (rows, column, columns = null) => {
  const kind = column?.settings?.summary;
  if (!kind || kind === 'none') return null;
  const list = Array.isArray(rows) ? rows : [];

  // Keyed by the column's `_id`, and a Map on a hydrated document — see
  // `columnValues.js`. This read used `column.key` against a plain object,
  // which is `undefined` on every row of every board, so every total on
  // every template board was 0 or empty regardless of the data.
  const raw = columnValuesOf(list, column);

  switch (kind) {
    case 'filled':
    case 'empty': {
      // A formula stores nothing, so whether it is "filled" is whether it
      // COMPUTES — otherwise every formula column would count as all-empty.
      const filled =
        column?.type === 'formula'
          ? list.filter((r) => numericValue(r, column, columns) !== null).length
          : raw.filter((v) => !isBlank(v)).length;
      return {
        value: kind === 'filled' ? filled : list.length - filled,
        count: list.length,
        raw: true,
      };
    }
    case 'checked':
      return { value: raw.filter(Boolean).length, count: list.length, raw: true };
    default:
      break;
  }

  /**
   * A payments cell with no receipts is BLANK for an average, a lowest and a
   * highest — the same rule as an empty number cell above.
   *
   * `numericValue` reads it as 0, deliberately: a formula like "Outstanding =
   * Amount − Paid" has to see the full amount on an invoice nobody has paid
   * (see `paymentsTotal`). But "Lowest paid" over ten invoices, eight of them
   * unpaid, is not ₹0, and "Average paid" is not the two real receipts divided
   * by ten. So those three look only at rows that have a receipt, and the label
   * says "Average of 2". A SUM is untouched: adding the zeros changes nothing.
   */
  const contributing =
    column?.type === 'payments' && kind !== 'sum'
      ? list.filter((r) => paymentsOf(columnValue(r, column)).length > 0)
      : list;

  const nums = contributing
    .map((r) => numericValue(r, column, columns))
    .filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (nums.length === 0) {
    /**
     * An EMPTY group still has a total, and it is zero.
     *
     * Returning null here meant a freshly-seeded Billing board showed twelve
     * months with no totals anywhere — so the one thing the template promised
     * (this board adds your invoices up) was invisible until somebody typed an
     * invoice in. A sum over nothing is 0; say so.
     *
     * Min and max are the exception: the smallest of no numbers is not zero,
     * it does not exist, and printing ₹0 would be a claim rather than a blank.
     */
    if (kind === 'sum') return { value: 0, count: 0 };
    return null;
  }

  switch (kind) {
    case 'sum':
      return { value: nums.reduce((a, b) => a + b, 0), count: nums.length };
    case 'avg':
      return { value: nums.reduce((a, b) => a + b, 0) / nums.length, count: nums.length };
    case 'min':
      return { value: Math.min(...nums), count: nums.length };
    case 'max':
      return { value: Math.max(...nums), count: nums.length };
    default:
      return null;
  }
};

/** The label shown above the number, e.g. "Sum" or "Average of 3". */
export const summaryLabel = (rows, column, columns = null) => {
  const kind = column?.settings?.summary;
  const entry = SUMMARIES.find((s) => s.key === kind);
  if (!entry || kind === 'none') return '';
  const result = computeSummary(rows, column, columns);
  // "Average of 3" when only some rows contributed, so a partial average never
  // reads as the whole group's.
  if (kind === 'avg' && result && result.count < (Array.isArray(rows) ? rows.length : 0)) {
    return `Average of ${result.count}`;
  }
  return entry.label;
};

/**
 * Every summarised column's total for one group, ready to render.
 *
 * Shared by the group header and the table footer so the two can never show
 * different numbers for the same column — which they would the moment one of
 * them grew its own idea of how to format a count.
 *
 * Returns `[]` for a board with no flexible columns, which is every board that
 * existed before templates: the header slot renders nothing at all rather than
 * an empty row of labels.
 *
 * `fallbackCurrency` is the unit for a currency column that carries no code of
 * its own. It defaults to the BOARD's currency (`boardCurrencyOf`), not the
 * workspace's, so a CAD billing board's code-less Remaining column totals in
 * CA$ beside its Amount column rather than in whatever the workspace bills in.
 */
export const groupSummaries = (board, rows, money = null, fallbackCurrency = boardCurrencyOf(board)) => {
  if (!board?.useFlexibleColumns || !Array.isArray(board.columns)) return [];
  const out = [];
  for (const col of board.columns) {
    const kind = col.settings?.summary;
    if (!kind || kind === 'none') continue;
    const result = computeSummary(rows, col, board.columns);
    if (!result) continue;
    out.push({
      key: col._id || col.key,
      name: col.name,
      label: summaryLabel(rows, col, board.columns),
      // A count of ROWS is not a value in the column's own unit — running
      // "3 receipts missing" through the currency formatter would print "₹3".
      display: result.raw
        ? result.value.toLocaleString()
        : /**
           * Through the reader's formatter when one is supplied, so a group
           * total agrees with the cells above it; without one, as entered.
           * Either way only a CURRENCY column gets a symbol — a plain Sum of
           * hours is "36", not "₹36.00" (see `formatColumnValue`).
           *
           * NO DATE is passed: a group's rows can span months, and dating the
           * SUM at any one of them would be a claim about the wrong day. So a
           * total converts at the latest rate we hold, while a cell converts at
           * its own day only when the grid hands it one. On a board whose rows
           * span months and whose reader has chosen a display currency, the
           * header can therefore differ slightly from the converted cells
           * under it. The Ledger, where that difference is the whole point,
           * converts row by row in `ledgerTotals`.
           */
          money
          ? money.column(result.value, col.settings, null, fallbackCurrency)
          : formatColumnValue(null, result.value, col.settings, { fallbackCurrency }),
    });
  }
  return out;
};

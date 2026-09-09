import { formatNumber } from './numberFormat';

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
const NUMERIC_TYPES = new Set(['number', 'formula', 'rating', 'mirror']);

export const summariesFor = (type) => {
  if (NUMERIC_TYPES.has(type)) {
    return SUMMARIES.filter((s) => s.key !== 'checked');
  }
  if (type === 'checkbox') {
    return SUMMARIES.filter((s) => ['none', 'checked', 'filled', 'empty'].includes(s.key));
  }
  return SUMMARIES.filter((s) => ['none', 'filled', 'empty'].includes(s.key));
};

const numbersIn = (values) =>
  values
    .map((v) => (typeof v === 'string' ? Number(v) : v))
    .filter((n) => typeof n === 'number' && !Number.isNaN(n));

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
 */
export const computeSummary = (rows, column) => {
  const kind = column?.settings?.summary;
  if (!kind || kind === 'none') return null;

  const raw = rows.map((r) => r?.columnValues?.[column.key]);
  const present = raw.filter((v) => v !== null && v !== undefined && v !== '');

  switch (kind) {
    case 'filled':
      return { value: present.length, count: rows.length, raw: true };
    case 'empty':
      return { value: rows.length - present.length, count: rows.length, raw: true };
    case 'checked':
      return { value: raw.filter(Boolean).length, count: rows.length, raw: true };
    default:
      break;
  }

  const nums = numbersIn(present);
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
export const summaryLabel = (rows, column) => {
  const kind = column?.settings?.summary;
  const entry = SUMMARIES.find((s) => s.key === kind);
  if (!entry || kind === 'none') return '';
  const result = computeSummary(rows, column);
  // "Average of 3" when only some rows contributed, so a partial average never
  // reads as the whole group's.
  if (kind === 'avg' && result && result.count < rows.length) {
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
 */
export const groupSummaries = (board, rows) => {
  if (!board?.useFlexibleColumns || !Array.isArray(board.columns)) return [];
  const out = [];
  for (const col of board.columns) {
    const kind = col.settings?.summary;
    if (!kind || kind === 'none') continue;
    const result = computeSummary(rows, col);
    if (!result) continue;
    out.push({
      key: col._id || col.key,
      name: col.name,
      label: summaryLabel(rows, col),
      // A count of ROWS is not a value in the column's own unit — running
      // "3 receipts missing" through the currency formatter would print "₹3".
      display: result.raw
        ? result.value.toLocaleString()
        : formatNumber(result.value, col.settings),
    });
  }
  return out;
};

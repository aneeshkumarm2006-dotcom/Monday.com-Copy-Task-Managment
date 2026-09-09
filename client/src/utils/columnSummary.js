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
  if (nums.length === 0) return null;

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

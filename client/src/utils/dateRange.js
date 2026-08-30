/**
 * Date-range presets, as data.
 *
 * ---- Why the dates are UTC DAY KEYS and stay that way -----------------------
 *
 * `YYYY-MM-DD`, which is what the connector data endpoint's `from`/`to` parse
 * and what a snapshot's `periodKey` IS. A `Date` here would put a timezone
 * between the browser and a period key that has none, and the symptom would be a
 * chart quietly missing its first or last column for everybody west of
 * Greenwich — the kind of bug that is invisible to whoever built it in London.
 *
 * The shape is `ExportActivityModal`'s `PRESETS`, reused rather than reinvented:
 * a key, a label, and a `range()` answering `[start, end]`, with `custom`
 * carrying a null `range` as the sentinel meaning "the two inputs decide". That
 * file solved this inline and could not share it; lifting it out is what let the
 * SEO dashboard have the same control.
 *
 * `to` is deliberately NOT clamped to today — the same decision the server's
 * `resolveRange` records. A board looking at a month that has not finished still
 * wants the whole month, and clamping would make the right edge of a chart move
 * under the reader as the month went on.
 */

/** `YYYY-MM-DD` from a Date, in UTC. */
export const toDayKey = (date) => date.toISOString().slice(0, 10);

const daysAgo = (n, from = new Date()) => {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};

export const RANGE_PRESETS = [
  { key: '30d', label: 'Last 30 days', range: () => [daysAgo(29), new Date()] },
  { key: '90d', label: 'Last 90 days', range: () => [daysAgo(89), new Date()] },
  { key: '6m', label: 'Last 6 months', range: () => [daysAgo(181), new Date()] },
  { key: '12m', label: 'Last 12 months', range: () => [daysAgo(364), new Date()] },
  {
    key: 'thisMonth',
    label: 'This month',
    range: () => {
      const now = new Date();
      return [new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), now];
    },
  },
  {
    key: 'lastMonth',
    label: 'Last month',
    range: () => {
      const now = new Date();
      return [
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
        // Day 0 of this month is the last day of the previous one.
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)),
      ];
    },
  },
  { key: 'custom', label: 'Custom range', range: null },
];

/**
 * Resolve a preset key into `{from, to}` day keys.
 *
 * The `custom` sentinel returns whatever the caller is already holding, so the
 * two typed inputs are the source of truth for that one key and nothing else has
 * to branch on it.
 *
 * @param {string} presetKey
 * @param {{from: string, to: string}} custom
 * @returns {{from: string, to: string}}
 */
export const resolveRangePreset = (presetKey, custom) => {
  const preset = RANGE_PRESETS.find((p) => p.key === presetKey);
  if (!preset || !preset.range) return custom;
  const [start, end] = preset.range();
  return { from: toDayKey(start), to: toDayKey(end) };
};

/**
 * True when a range cannot return anything.
 *
 * Named rather than silently applied, because a reversed range returns an empty
 * chart, and an empty chart is indistinguishable from a connector that stopped
 * working.
 */
export const isRangeInvalid = (value) =>
  !value?.from || !value?.to || value.from > value.to;

/** "1 Sep 2026" from a `YYYY-MM-DD`. Blank rather than "Invalid Date". */
export const prettyDay = (key) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return '';
  const d = new Date(`${key}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
};

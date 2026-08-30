import { BLANK, sortRowsBy } from './rankRows.js';
import { isKindCollected } from './labsRows.js';

/**
 * The AI Visibility screen's rows, out of the rank snapshot.
 *
 * ---- Nothing here fetches, and nothing here computes a metric --------------
 *
 * Both halves matter. `ai_overview` rides inside the SERP payload the rank
 * tracker already buys, so this screen's marginal API cost is zero — and the
 * counting was done ON THE SERVER, at collection time, by
 * `dataforseo/normalise.js`, because that is the only place the full
 * hundred-result payload ever exists. What this file does is arrange stored
 * numbers into rows and format them.
 *
 * ---- CITED AND MENTIONED ARE TWO METRICS AND ARE NEVER ONE -----------------
 *
 * CITED means our domain is in the reference list Google attached to its own
 * summary. It is exact, it is a link, and it is the half that sends traffic.
 *
 * MENTIONED means our brand word appears in the summary's prose. It is
 * visibility with no click behind it, and it is inferred from text rather than
 * read from a field.
 *
 * They overlap and neither contains the other. A blended "AI visibility"
 * percentage would move for either reason and tell a reader to do neither —
 * citations are earned with links, mentions with entity coverage. So they are
 * two tiles, two columns, two goal fields, and there is deliberately no function
 * in this file that adds them together.
 *
 * ---- The denominators, which are the other easy mistake --------------------
 *
 * PRESENCE is over every tracked keyword: how much of this set Google now
 * answers itself. CITED and MENTIONED are over the keywords that HAVE an
 * overview, because we cannot be cited in one that does not exist. Taken over
 * the whole set instead, both rates fall whenever Google shows fewer overviews —
 * which draws as our visibility collapsing in a week we did nothing.
 *
 * Every rate here is a 0-1 fraction and the screen renders the FRACTION beside
 * the percentage, because "0 of 0" and "0 of 40" are different findings and a
 * bare 0% cannot tell them apart.
 */

const numberOr = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export { isKindCollected };

/**
 * The headline numbers, or null when nothing has been collected.
 *
 * @param {Object|null} snapshot - the `positions` (or `movement`) snapshot
 * @returns {Object|null}
 */
export const aiSummaryFrom = (snapshot) => {
  const ai = snapshot?.data?.aiVisibility || null;
  if (!ai) return null;
  return {
    tracked: numberOr(ai.tracked) ?? 0,
    withOverview: numberOr(ai.withOverview) ?? 0,
    presenceRate: numberOr(ai.presenceRate),
    cited: numberOr(ai.cited) ?? 0,
    citedRate: numberOr(ai.citedRate),
    mentioned: numberOr(ai.mentioned) ?? 0,
    mentionedRate: numberOr(ai.mentionedRate),
    citedNotMentioned: numberOr(ai.citedNotMentioned) ?? 0,
    mentionedNotCited: numberOr(ai.mentionedNotCited) ?? 0,
    averageCitationRank: numberOr(ai.averageCitationRank),
    /** The depth the reading was bought to, for the caption. */
    depth: numberOr(snapshot?.data?.depth),
  };
};

/**
 * "3 of 40", never a bare percentage.
 *
 * A rate with no fraction beside it cannot distinguish "we are cited in none of
 * the forty overviews on this keyword set" from "there are no overviews at all",
 * and those are opposite findings with opposite actions.
 */
export const fractionLabel = (part, whole) => {
  if (typeof part !== 'number' || typeof whole !== 'number') return '—';
  return `${part} of ${whole}`;
};

/** A 0-1 fraction as a whole percentage, or an em dash. Never `0%` for null. */
export const percentLabel = (rate) =>
  typeof rate === 'number' && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '—';

/**
 * The four states a keyword can be in, as data.
 *
 * Kept as four rather than collapsed into "visible / not", because the action
 * behind each one is different: `both` is fine, `cited` needs the brand in the
 * answer, `mentioned` needs the link, `neither` needs the page to be worth
 * citing at all, and `none` is not about us.
 */
export const AI_STATES = [
  { key: 'both', label: 'Cited and named', tone: 'positive' },
  { key: 'cited', label: 'Cited, not named', tone: 'neutral' },
  { key: 'mentioned', label: 'Named, not cited', tone: 'neutral' },
  { key: 'neither', label: 'Overview, neither', tone: 'negative' },
  { key: 'none', label: 'No AI Overview', tone: 'muted' },
];

const AI_STATE_BY_KEY = new Map(AI_STATES.map((s) => [s.key, s]));

/** Which of the five a keyword row is in. */
export const aiStateOf = (row) => {
  if (!row?.aiOverview?.present) return 'none';
  if (row.aiOverview.cited && row.aiOverview.mentioned) return 'both';
  if (row.aiOverview.cited) return 'cited';
  if (row.aiOverview.mentioned) return 'mentioned';
  return 'neither';
};

export const aiStateLabel = (key) => AI_STATE_BY_KEY.get(key)?.label || key;

/**
 * One row per tracked keyword.
 *
 * @param {Object|null} snapshot
 * @returns {Array<Object>}
 */
export const aiRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.keywords) ? snapshot.data.keywords : [];
  return rows.map((row) => {
    const ai = row.aiOverview || {};
    return {
      keyword: String(row.keyword || ''),
      rank: numberOr(row.rank),
      ranked: !!row.ranked,
      present: !!ai.present,
      cited: !!ai.cited,
      mentioned: !!ai.mentioned,
      /**
       * WHERE in Google's citation list we appear, 1-based.
       *
       * Deliberately never routed through `connectorFormat.formatRank`. That
       * function owns the SERP three-way rule and turns a null into "Not in top
       * 100" — a sentence about search results, on a column about a citation
       * list of eight, that is never true.
       */
      citationRank: numberOr(ai.citationRank),
      citationCount: numberOr(ai.citationCount),
      references: Array.isArray(ai.references) ? ai.references : [],
      state: aiStateOf(row),
    };
  });
};

/** Render a citation position. Its own function, for the reason above. */
export const formatCitationRank = (value, present) => {
  if (typeof value === 'number') return `#${value}`;
  if (present) return 'Not cited';
  return '—';
};

export const AI_BUCKETS = AI_STATES.map((state) => ({
  key: state.key,
  label: state.label,
  match: (row) => row.state === state.key,
}));

export const filterAiRows = (rows, { query = '', buckets = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const wanted = AI_BUCKETS.filter((b) => buckets.includes(b.key));
  return rows.filter((row) => {
    if (needle && !row.keyword.toLowerCase().includes(needle)) return false;
    if (wanted.length && !wanted.some((b) => b.match(row))) return false;
    return true;
  });
};

const aiValueOf = (row, key) => {
  switch (key) {
    case 'keyword':
      return row.keyword.toLowerCase();
    case 'rank':
      return row.rank === null ? BLANK : row.rank;
    case 'citationRank':
      return row.citationRank === null ? BLANK : row.citationRank;
    case 'citationCount':
      return row.citationCount === null ? BLANK : row.citationCount;
    case 'state':
      return row.state;
    default:
      return BLANK;
  }
};

export const sortAiRows = (rows, sort) => sortRowsBy(rows, sort, aiValueOf);

/**
 * Who Google cites for this keyword set, ours included.
 *
 * Ours is KEPT rather than filtered out — it is the row a reader looks for
 * first, and removing it makes the shares impossible to read against. `ours` is
 * a flag so the screen can mark it rather than a reason to drop it.
 *
 * @param {Object|null} snapshot
 * @returns {Array<Object>}
 */
export const citationSourcesFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.aiVisibility?.sources)
    ? snapshot.data.aiVisibility.sources
    : [];
  return rows.map((row) => ({
    domain: String(row.domain || ''),
    keywords: numberOr(row.keywords) ?? 0,
    share: numberOr(row.share),
    ours: !!row.ours,
  }));
};

/**
 * The AI Overview presence trend, from the stored series.
 *
 * `connectorDataController` compacts `trend` down to `totals` and
 * `averagePositions` and drops `keywords[]` — so the presence rate is NOT in
 * that series and cannot be drawn from it. Rather than widen a shared
 * controller for one panel, this screen shows the CURRENT reading against the
 * PREVIOUS one, which is the same one-step delta every other phase-7 and
 * phase-8 panel draws.
 *
 * @param {Object|null} current
 * @param {Object|null} previous
 * @param {(rate: Object) => number|null} pick
 * @returns {number|null}
 */
export const aiDeltaOf = (current, previous, pick) => {
  const now = current ? pick(current) : null;
  const then = previous ? pick(previous) : null;
  if (typeof now !== 'number' || typeof then !== 'number') return null;
  return Math.round((now - then) * 1000) / 1000;
};

/**
 * May two AI readings be compared at all?
 *
 * The DEPTH guard, restated for this screen. The `ai_overview` block sits above
 * the organic results and arrives at either depth, so the AI numbers themselves
 * are comparable across depths — but the screen draws them beside the rank
 * column, and a rank bought to ten and a rank bought to a hundred are different
 * measurements. Rather than let one panel be comparable and its neighbour not,
 * the whole screen refuses when the depths disagree, and says why.
 *
 * Same `{ok, reason}` shape as `backlinkRows.comparability` and
 * `auditRows.comparability`; its server counterpart is
 * `dataforseo/comparability.js`'s `rankComparability`.
 */
export const comparability = (current, previous) => {
  if (!current || !previous) return { ok: false, reason: '' };
  const now = numberOr(current.depth);
  const then = numberOr(previous.depth);
  if (now !== null && then !== null && now !== then) {
    return {
      ok: false,
      reason:
        `These two readings were bought to different depths (${then} results, then ` +
        `${now}), so the ranks beside these counts are not measuring the same thing.`,
    };
  }
  return { ok: true, reason: '' };
};

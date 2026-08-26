/**
 * The mappable field catalog — every value Ubersuggest can produce that a
 * person may bind to somewhere on a goal.
 *
 * ---- Why this file is the seam that keeps the feature configurable ---------
 *
 * The alternative — and the thing this exists to prevent — is a writeback
 * service that says `goal.actual = positions.keywords[i].position` and
 * `columnValues[volume] = metrics.volume`. That would work exactly once, on one
 * board, for one trade. The three SEO boards already disagree with each other:
 * they use disjoint column ObjectIds, and the difficulty column is spelled
 * `keyword_difficultly` on DAVNOOT SEO and `keyword_difficulty` on the other
 * two. A hardcoded writeback would fill one of them and silently skip the rest.
 *
 * So the binding is DATA — a `ConnectorFieldMapping` row per (board, provider,
 * sourceField) naming a goal column by `_id` — and this catalog is the list of
 * left-hand sides it can name. Adding a mappable field is ONE entry here. No
 * controller branch, no model change, no UI change; the panel renders whatever
 * the server sends and the phase-5 writeback reads whatever the mapping names.
 *
 * Connector #2 ships its own catalog in its own directory and both work.
 *
 * ---- What an entry has to declare, and why each part earns its place -------
 *
 *   `type`   is what the value IS, and it is the whole basis of the
 *            compatibility check in `../fieldMapping.js`. A mapping is refused
 *            at CONFIGURATION time — with a sentence — rather than silently at
 *            3am when the runner discovers it cannot put "informational" in a
 *            number column.
 *
 *   `kind`   is which snapshot carries it. The panel groups by this, and the
 *            writeback uses it to know which snapshot to open. A field whose
 *            kind the board has switched off can be mapped but will not fill,
 *            and the UI says so rather than leaving a mystery.
 *
 *   `scope`  is 'keyword' or 'project', and it is the one that is easy to get
 *            wrong. A rank is a fact about a KEYWORD; organic traffic is a fact
 *            about the whole project. Phase 5 binds a goal to a tracked keyword,
 *            so a keyword-scoped field needs that link before it can resolve and
 *            a project-scoped one does not. Collapsing the two would mean
 *            offering "Search volume" on a goal with no keyword and filling it
 *            with whichever row happened to be first.
 *
 *   `read`   is the extraction, and it is PURE: snapshot data in, value out. It
 *            lives here rather than in the writeback for the same reason
 *            `normalise.js` is separate from `fetchers.js` — it is the part a
 *            shape change lands on, and the part worth testing hard. Every one
 *            returns null rather than throwing, and a null MEANS something (see
 *            `nullMeans`) rather than being an error in disguise.
 *
 * ---- The null that is an answer --------------------------------------------
 *
 * `rank` returns null for a keyword the domain does not rank for in the top 100.
 * That is a FINAL answer from the provider, not a missing reading, and
 * `nullMeans` carries the sentence so every consumer says the same thing. A
 * connector field whose null is just "we could not find it" leaves `nullMeans`
 * unset. Nothing may collapse the two: one is data, the other is a gap.
 */

/** A finite number, or null. Never NaN, never a coerced empty string. */
const numOrNull = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** A non-empty string, or null. */
const strOrNull = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * The row for one keyword inside a `positions` or `keyword_metrics` snapshot.
 *
 * Matched case-insensitively, because the phrase arrives from the provider on
 * one side and is typed by a person on the other. Returns null when the
 * snapshot has no row for it — a keyword added to a project after the last
 * collection is the normal case, not a fault.
 */
const rowFor = (data, keyword) => {
  const needle = strOrNull(keyword);
  if (!needle) return null;
  const rows = Array.isArray(data?.keywords) ? data.keywords : [];
  const lower = needle.toLowerCase();
  return rows.find((r) => strOrNull(r?.keyword)?.toLowerCase() === lower) || null;
};

/** The latest point of the project-average series. */
const latestAverage = (data) => {
  const series = Array.isArray(data?.averagePositions) ? data.averagePositions : [];
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = numOrNull(series[i]?.value);
    if (value !== null) return value;
  }
  return null;
};

/** `YYYY-MM-DD` from anything date-shaped, or null. Same rule as normalise.js. */
const dayKeyOf = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const NOT_IN_TOP_100 = 'Not in the top 100 — a final answer from the provider, not a missing reading.';

/**
 * @typedef {Object} ConnectorField
 * @property {string} key       - stored on the mapping row; renaming one is a migration
 * @property {string} label     - what the panel calls it
 * @property {string} blurb     - one line under the label
 * @property {'number'|'text'|'date'|'link'} type - decides what it may be mapped to
 * @property {string} kind      - the snapshot kind that carries it
 * @property {'keyword'|'project'} scope - what the value is a fact ABOUT
 * @property {boolean} [derived] - computed from other fields rather than read
 * @property {string} [nullMeans] - when null is an ANSWER, the sentence for it
 * @property {(data: any, ctx: {keyword?: string}) => any} read - pure extraction
 */

/** @type {ConnectorField[]} */
const FIELDS = [
  // ---- positions, per keyword ---------------------------------------------
  {
    key: 'rank',
    label: 'Current rank',
    blurb: 'Where this keyword ranks today, 1–100.',
    type: 'number',
    kind: 'positions',
    scope: 'keyword',
    nullMeans: NOT_IN_TOP_100,
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.position),
  },
  {
    key: 'rank_previous',
    label: 'Previous rank',
    blurb: 'Where it ranked at the provider’s previous collection.',
    type: 'number',
    kind: 'positions',
    scope: 'keyword',
    nullMeans: NOT_IN_TOP_100,
    read: (data, { keyword } = {}) =>
      numOrNull(rowFor(data, keyword)?.previousPosition),
  },
  {
    key: 'rank_change',
    label: 'Rank movement',
    blurb:
      'Positions gained since the previous collection. Positive is an ' +
      'improvement, because rank is inverted — 3 is better than 8.',
    type: 'number',
    kind: 'positions',
    scope: 'keyword',
    derived: true,
    // Null here is NOT "not in the top 100" — it is a keyword that entered or
    // left the top 100, where there is no pair of ranks to subtract. See
    // `movementOf` in normalise.js, which keeps that distinction deliberately.
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.change),
  },
  {
    key: 'ranking_url',
    label: 'Ranking page',
    blurb: 'The URL that ranks for this keyword.',
    type: 'link',
    kind: 'positions',
    scope: 'keyword',
    read: (data, { keyword } = {}) => strOrNull(rowFor(data, keyword)?.url),
  },

  // ---- positions, per project ---------------------------------------------
  {
    key: 'average_position',
    label: 'Project average position',
    blurb:
      'The provider’s own project-wide mean. It counts a keyword outside the ' +
      'top 100 as 100, so it is NOT the average of the ranks above it.',
    type: 'number',
    kind: 'positions',
    scope: 'project',
    read: (data) => latestAverage(data),
  },
  {
    key: 'keywords_tracked',
    label: 'Keywords tracked',
    blurb: 'How many keywords this project follows.',
    type: 'number',
    kind: 'positions',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.tracked),
  },
  {
    key: 'keywords_ranking',
    label: 'Keywords ranking',
    blurb: 'How many of them place inside the top 100.',
    type: 'number',
    kind: 'positions',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.ranking),
  },
  {
    key: 'keywords_improved',
    label: 'Keywords improved',
    blurb: 'How many moved up since the previous collection.',
    type: 'number',
    kind: 'positions',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.improved),
  },
  {
    key: 'keywords_declined',
    label: 'Keywords declined',
    blurb: 'How many moved down since the previous collection.',
    type: 'number',
    kind: 'positions',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.declined),
  },
  {
    key: 'collected_on',
    label: 'Rankings collected on',
    blurb:
      'The day the provider read the SERP. Ubersuggest collects once a week ' +
      'on every plan, so this is usually a few days behind today.',
    type: 'date',
    kind: 'positions',
    scope: 'project',
    read: (data) => dayKeyOf(data?.updatedAt),
  },

  // ---- keyword_metrics, per keyword ---------------------------------------
  {
    key: 'volume',
    label: 'Search volume',
    blurb: 'Estimated monthly searches.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.volume),
  },
  {
    key: 'seo_difficulty',
    label: 'Keyword difficulty',
    blurb: 'How hard it is to rank organically, 0–100. The provider calls it SD.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.difficulty),
  },
  {
    key: 'paid_difficulty',
    label: 'Paid difficulty',
    blurb:
      'How contested the keyword is in ads. A DIFFERENT number from keyword ' +
      'difficulty — the provider calls it PD, and the two are easy to confuse.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) =>
      numOrNull(rowFor(data, keyword)?.paidDifficulty),
  },
  {
    key: 'cpc',
    label: 'Cost per click',
    blurb: 'What advertisers pay for this keyword.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.cpc),
  },
  {
    key: 'competition',
    label: 'Paid competition',
    blurb: 'Advertiser competition, 0–1.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.competition),
  },
  {
    key: 'search_intent',
    label: 'Search intent',
    blurb: 'What the searcher is trying to do — informational, commercial, and so on.',
    type: 'text',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => strOrNull(rowFor(data, keyword)?.intent),
  },

  // ---- domain_overview, per project ---------------------------------------
  {
    key: 'organic_traffic',
    label: 'Organic traffic',
    blurb: 'Estimated monthly visits from search.',
    type: 'number',
    kind: 'domain_overview',
    scope: 'project',
    read: (data) => numOrNull(data?.organicTraffic),
  },
  {
    key: 'organic_keywords',
    label: 'Organic keywords',
    blurb: 'How many keywords the domain ranks for at all.',
    type: 'number',
    kind: 'domain_overview',
    scope: 'project',
    read: (data) => numOrNull(data?.organicKeywords),
  },
  {
    key: 'domain_authority',
    label: 'Domain authority',
    blurb: 'The provider’s 0–100 authority score for the domain.',
    type: 'number',
    kind: 'domain_overview',
    scope: 'project',
    read: (data) => numOrNull(data?.domainAuthority),
  },
  {
    key: 'traffic_value',
    label: 'Traffic value',
    blurb: 'What that organic traffic would cost to buy.',
    type: 'number',
    kind: 'domain_overview',
    scope: 'project',
    read: (data) => numOrNull(data?.trafficValue),
  },

  // ---- backlinks, per project ---------------------------------------------
  {
    key: 'backlinks_total',
    label: 'Total backlinks',
    blurb: 'Every inbound link the provider knows about.',
    type: 'number',
    kind: 'backlinks',
    scope: 'project',
    read: (data) => numOrNull(data?.backlinks),
  },
  {
    key: 'referring_domains',
    label: 'Referring domains',
    blurb: 'How many distinct sites link to this one.',
    type: 'number',
    kind: 'backlinks',
    scope: 'project',
    read: (data) => numOrNull(data?.referringDomains),
  },

  // ---- site_audit, per project --------------------------------------------
  {
    key: 'health_score',
    label: 'Site health score',
    blurb: 'The headline score from the last completed crawl.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.healthScore),
  },
  {
    key: 'audit_errors',
    label: 'Audit errors',
    blurb: 'Pages affected by error-level issues in the last crawl.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.errors),
  },
  {
    key: 'audit_warnings',
    label: 'Audit warnings',
    blurb: 'Pages affected by warning-level issues in the last crawl.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.warnings),
  },
  {
    key: 'pages_crawled',
    label: 'Pages crawled',
    blurb: 'How many pages the last audit reached.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.crawled),
  },
];

const FIELD_KEYS = FIELDS.map((f) => f.key);
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** @param {string} key @returns {ConnectorField|null} */
const getField = (key) => BY_KEY.get(key) || null;

/** @param {string} key @returns {boolean} */
const isField = (key) => BY_KEY.has(key);

/**
 * Read one field out of a snapshot's normalised body.
 *
 * The only entry point the writeback needs, and the reason `read` can stay a
 * private detail of each entry: a caller names a field key and hands over the
 * data, and never reaches into the catalog itself.
 *
 * Returns null for an unknown key rather than throwing. A mapping row can
 * outlive the field it names — someone removes an entry from this file while a
 * board still has it bound — and a weekly run that crashed on that would take
 * every other field down with it.
 *
 * @param {string} key
 * @param {any} data - the `data` body of a ConnectorSnapshot of the field's kind
 * @param {{keyword?: string}} [ctx]
 * @returns {number|string|null}
 */
const readField = (key, data, ctx = {}) => {
  const field = getField(key);
  if (!field) return null;
  try {
    const value = field.read(data, ctx);
    return value === undefined ? null : value;
  } catch {
    // A shape we did not anticipate is a null, not a failed sync. Same rule as
    // every normaliser next door.
    return null;
  }
};

module.exports = { FIELDS, FIELD_KEYS, getField, isField, readField };

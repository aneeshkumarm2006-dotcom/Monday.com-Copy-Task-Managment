/**
 * The Ads-board descriptor — A SKETCH, deliberately not registered.
 *
 * ---- What this file is, and what it is emphatically not ---------------------
 *
 * This is phase 6 of the connector work: "no new provider is built; confirm the
 * registry seam holds by sketching the Ads-board descriptor and its own field
 * catalog." It is the second tenant of the tracker+goals machinery, written out
 * far enough to be RUN by the generic engines — the registry validator, the
 * snapshot planner, the compatibility check and the goal writeback — without
 * being connectable by anybody.
 *
 * It is absent from `utils/connectorProviders.js` and from the REGISTRY in
 * `../index.js`, which is what keeps it out of the Settings catalog, out of the
 * Add-ons tab and out of every route. Nothing in `src/` imports it. Its one
 * consumer is `../registrySeam.test.js`.
 *
 * If a real Ads connector is ever built, this becomes
 * `services/connectors/metaAds/` with the same shape, `metaAds` is added to the
 * provider enum, one line is added to the REGISTRY, and the OAuth half is
 * filled in for real. Nothing else in the codebase changes — and the point of
 * the test beside this file is that that claim is checked rather than believed.
 *
 * ---- Why ADS is the right thing to sketch against ---------------------------
 *
 * Because it is the tenant most likely to break an SEO-shaped abstraction:
 *
 *   - Its subject is an AD ACCOUNT, not a domain. `kind.requires` therefore
 *     names a different field, and a project with no ad account id must be
 *     skipped by the same generic branch that skips a domainless project today.
 *   - Its cadence is DAILY, not weekly. `syncIntervalHours` is 24 here against
 *     Ubersuggest's 168, so "the interval belongs to the descriptor" is a fact
 *     rather than a comment.
 *   - Its variants fan out over PLACEMENTS, not over (device, locale). The
 *     variant axis had better be opaque to the planner, and this is what proves
 *     it is.
 *   - Its goals are not about keywords. An ads goal is "Meta — Q3 retargeting",
 *     a task description, so a good half of this catalog is `scope: 'project'`
 *     and a link with NO keyword has to fill real cells. That is the case phase
 *     5 declared `scope` for, and this is the first thing that exercises it end
 *     to end.
 *   - Its natural rollup is a RATIO — cost per result, CTR — where SEO's are
 *     ranks and counts. Rounding and null handling get a second opinion.
 *
 * ---- The one place the seam is tight, recorded honestly --------------------
 *
 * `ConnectorProject`'s mirrored description is SEO-shaped: `domain`,
 * `keywordCount`, `competitorCount`, `locations`, `hasBrand`. An ad account has
 * none of those and has placements, a currency and a spend cap instead. The
 * escape hatch is `raw`, which holds the provider payload verbatim and is
 * handed to `variantsFor` along with the rest of the row — so `placementsFor`
 * below reads `project.raw.placements`, and the seam does hold today with no
 * schema change.
 *
 * The cost of that is real and worth stating rather than discovering: values in
 * `raw` cannot be indexed, cannot be queried, and are not normalised on the way
 * in. A real Ads provider would want either a generic `attributes` bag on
 * `ConnectorProject` or its own mirrored fields beside the SEO ones. That is a
 * one-field schema change and it is deliberately NOT made here, because no
 * provider is being built and a speculative column is how a schema rots.
 */

// ---------------------------------------------------------------------------
// Kinds — what this provider can collect
// ---------------------------------------------------------------------------

/**
 * Three kinds, chosen to exercise the three branches the planner has: an
 * unconditional one that fans out, a DEPENDENT one, and one gated on a field
 * the project may not carry.
 */
const KINDS = [
  {
    key: 'campaign_performance',
    label: 'Campaigns',
    blurb: 'Spend, impressions, clicks, results and cost per result per campaign.',
    subject: 'account',
    tools: ['insights'],
    requires: null,
    dependsOn: [],
    manualOnly: false,
  },
  {
    key: 'creative_performance',
    label: 'Creatives',
    blurb: 'The same measures per ad creative, for the campaigns already read.',
    subject: 'account',
    tools: ['insights'],
    // The campaign list is not separately retrievable without spending another
    // call, and `campaign_performance` has just returned it. Same shape as
    // Ubersuggest's keyword_metrics → positions dependency, which is the point:
    // `resolveKinds` orders these and the runner passes `previous` through
    // without knowing what either kind means.
    dependsOn: ['campaign_performance'],
    manualOnly: false,
  },
  {
    key: 'account_overview',
    label: 'Account',
    blurb: 'Account-level spend, reach and frequency for the period.',
    subject: 'account',
    tools: ['account_insights'],
    // The ads analogue of Ubersuggest's `requires: 'domain'`. A mirrored
    // project with no external account id cannot serve it, and the planner must
    // skip it BEFORE spending a call — through the same generic branch.
    requires: 'externalId',
    dependsOn: [],
    manualOnly: false,
  },
];

const KIND_KEYS = KINDS.map((k) => k.key);
const BY_KEY = new Map(KINDS.map((k) => [k.key, k]));

/** @param {string} key */
const getKind = (key) => BY_KEY.get(key) || null;

/** @param {string} key */
const isKind = (key) => BY_KEY.has(key);

/**
 * A board's selection → the kinds to run, in dependency order.
 *
 * This is a CONTRACT, not a convenience, and it is the same one Ubersuggest's
 * `resolveKinds` implements — the runner calls it through the descriptor and
 * relies on all four of these:
 *
 *   1. An empty selection means EVERYTHING. `BoardConnector.kinds` defaults to
 *      `[]` and a board that just switched the connector on has expressed no
 *      opinion; reading that as "fetch nothing" leaves the tab blank with no
 *      error to explain it.
 *   2. Dependencies are PULLED IN, not assumed present. A board narrowed to
 *      `['creative_performance']` still needs the campaign list fetched, and
 *      silently returning nothing there is indistinguishable from a provider
 *      failure.
 *   3. A selection of nothing but unknown keys falls back to the full set — a
 *      misconfiguration is not a request for silence.
 *   4. The output is ordered so a dependency always precedes its dependant,
 *      which is what lets the runner walk the list once and pass results
 *      forward.
 *
 * Writing this by hand for the second provider and getting point 2 wrong is
 * exactly the sort of divergence the seam test beside this file exists to
 * catch; it did catch it.
 *
 * @param {string[]} [selected]
 * @param {{includeManualOnly?: boolean}} [opts]
 */
const resolveKinds = (selected, { includeManualOnly = false } = {}) => {
  const wanted = new Set(
    Array.isArray(selected) && selected.length ? selected.filter(isKind) : KIND_KEYS
  );

  if (wanted.size === 0) KIND_KEYS.forEach((k) => wanted.add(k));

  for (const key of [...wanted]) {
    for (const dep of getKind(key).dependsOn) wanted.add(dep);
  }

  return KINDS.filter(
    (k) => wanted.has(k.key) && (includeManualOnly || !k.manualOnly)
  );
};

// ---------------------------------------------------------------------------
// Variants — the fan-out axis, which is NOT the SEO one
// ---------------------------------------------------------------------------

const DEFAULT_VARIANT = { key: 'all', placement: null };

/** Read the mirrored placements out of `raw`. See the header for why `raw`. */
const placementsFor = (project) => {
  const raw = project?.raw;
  const list = Array.isArray(raw?.placements) ? raw.placements : [];
  return list.filter((p) => typeof p === 'string' && p.trim() !== '');
};

/**
 * Campaign performance splits by placement; nothing else does.
 *
 * The planner asks rather than assuming, so an axis it has never heard of costs
 * it nothing. `key` is readable for the same reason Ubersuggest's is — "why did
 * this account's history split into two series" is a question somebody asks
 * with a shell open.
 */
const MAX_PLACEMENTS = 4;

const variantsFor = (kindKey, project) => {
  if (kindKey !== 'campaign_performance') {
    return { variants: [DEFAULT_VARIANT], skipped: 0 };
  }

  const placements = placementsFor(project);
  if (!placements.length) return { variants: [DEFAULT_VARIANT], skipped: 0 };

  const variants = placements.slice(0, MAX_PLACEMENTS).map((p) => ({
    key: `placement|${p}`,
    placement: p,
  }));
  return { variants, skipped: Math.max(0, placements.length - variants.length) };
};

// ---------------------------------------------------------------------------
// The field catalog
// ---------------------------------------------------------------------------

const numOrNull = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const strOrNull = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * The row for one campaign inside a snapshot.
 *
 * The ads analogue of `rowFor(data, keyword)`: matched case-insensitively
 * because the name arrives from the provider on one side and is chosen by a
 * person on the other. Note which slot carries it — the link's `keyword` field,
 * which the generic writeback calls that because Ubersuggest was first and
 * which means "the sub-subject this goal is about". Renaming it would be a
 * migration for cosmetics; a real Ads provider inherits the name.
 */
const rowFor = (data, name) => {
  const needle = strOrNull(name);
  if (!needle) return null;
  const rows = Array.isArray(data?.campaigns) ? data.campaigns : [];
  const lower = needle.toLowerCase();
  return rows.find((r) => strOrNull(r?.name)?.toLowerCase() === lower) || null;
};

/** A ratio that must not divide by zero and must not round a real 0 away. */
const ratio = (numerator, denominator, dp = 2) => {
  const n = numOrNull(numerator);
  const d = numOrNull(denominator);
  if (n === null || d === null || d === 0) return null;
  return Number((n / d).toFixed(dp));
};

const NO_RESULTS_YET =
  'No results attributed yet — a final answer for the period, not a missing reading.';

/** @type {Array<Object>} */
const FIELDS = [
  // ---- campaign_performance, per campaign ---------------------------------
  {
    key: 'spend',
    label: 'Spend',
    blurb: 'What this campaign cost in the period, in the account currency.',
    type: 'number',
    kind: 'campaign_performance',
    scope: 'keyword',
    read: (data, ctx) => numOrNull(rowFor(data, ctx?.keyword)?.spend),
  },
  {
    key: 'results',
    label: 'Results',
    blurb: 'Conversions attributed to this campaign.',
    type: 'number',
    kind: 'campaign_performance',
    scope: 'keyword',
    read: (data, ctx) => numOrNull(rowFor(data, ctx?.keyword)?.results),
  },
  {
    key: 'cost_per_result',
    label: 'Cost per result',
    blurb: 'Spend divided by results. Blank until something converts.',
    type: 'number',
    kind: 'campaign_performance',
    scope: 'keyword',
    derived: true,
    nullMeans: NO_RESULTS_YET,
    read: (data, ctx) => {
      const row = rowFor(data, ctx?.keyword);
      return row ? ratio(row.spend, row.results) : null;
    },
  },
  {
    key: 'ctr',
    label: 'Click-through rate',
    blurb: 'Clicks per impression, as a percentage.',
    type: 'number',
    kind: 'campaign_performance',
    scope: 'keyword',
    derived: true,
    read: (data, ctx) => {
      const row = rowFor(data, ctx?.keyword);
      if (!row) return null;
      const r = ratio(row.clicks, row.impressions, 4);
      return r === null ? null : Number((r * 100).toFixed(2));
    },
  },
  {
    key: 'campaign_status',
    label: 'Campaign status',
    blurb: 'Active, paused or completed, as the provider reports it.',
    type: 'text',
    kind: 'campaign_performance',
    scope: 'keyword',
    read: (data, ctx) => strOrNull(rowFor(data, ctx?.keyword)?.status),
  },

  // ---- creative_performance, per campaign ---------------------------------
  {
    key: 'top_creative',
    label: 'Best creative',
    blurb: 'The creative with the lowest cost per result in the period.',
    type: 'text',
    kind: 'creative_performance',
    scope: 'keyword',
    read: (data, ctx) => {
      const needle = strOrNull(ctx?.keyword);
      if (!needle) return null;
      const rows = (Array.isArray(data?.creatives) ? data.creatives : []).filter(
        (c) => strOrNull(c?.campaign)?.toLowerCase() === needle.toLowerCase()
      );
      let best = null;
      for (const c of rows) {
        const cpr = ratio(c.spend, c.results);
        if (cpr === null) continue;
        if (!best || cpr < best.cpr) best = { cpr, name: strOrNull(c.name) };
      }
      return best ? best.name : null;
    },
  },
  {
    key: 'creative_preview',
    label: 'Creative preview',
    blurb: 'A link to the best creative in the ad manager.',
    type: 'link',
    kind: 'creative_performance',
    scope: 'keyword',
    read: (data, ctx) => {
      const needle = strOrNull(ctx?.keyword);
      if (!needle) return null;
      const rows = Array.isArray(data?.creatives) ? data.creatives : [];
      const row = rows.find(
        (c) => strOrNull(c?.campaign)?.toLowerCase() === needle.toLowerCase()
      );
      return strOrNull(row ? row.previewUrl : null);
    },
  },

  // ---- account_overview, per project --------------------------------------
  // The half that fills a goal with NO sub-subject at all. An ads goal named
  // "Meta — Q3 retargeting" is a task description, not a campaign name, and a
  // link with no `keyword` must still fill these.
  {
    key: 'account_spend',
    label: 'Account spend',
    blurb: 'Total spend across the whole ad account for the period.',
    type: 'number',
    kind: 'account_overview',
    scope: 'project',
    read: (data) => numOrNull(data ? data.spend : null),
  },
  {
    key: 'account_reach',
    label: 'Reach',
    blurb: 'People who saw at least one ad from this account.',
    type: 'number',
    kind: 'account_overview',
    scope: 'project',
    read: (data) => numOrNull(data ? data.reach : null),
  },
  {
    key: 'frequency',
    label: 'Frequency',
    blurb: 'Average impressions per person reached.',
    type: 'number',
    kind: 'account_overview',
    scope: 'project',
    read: (data) => ratio(data ? data.impressions : null, data ? data.reach : null),
  },
  {
    key: 'last_reported_on',
    label: 'Last reported on',
    blurb: 'The day the provider last closed the books on this account.',
    type: 'date',
    kind: 'account_overview',
    scope: 'project',
    read: (data) => {
      const value = data ? data.reportedOn : null;
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
        return value.slice(0, 10);
      }
      return null;
    },
  },
];

const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** Pull one field out of a snapshot body. Pure, and never throws. */
const readField = (key, data, ctx = {}) => {
  const field = FIELD_BY_KEY.get(key);
  if (!field) return null;
  try {
    const value = field.read(data, ctx);
    return value === undefined ? null : value;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

const descriptor = {
  name: 'ads',
  label: 'Meta Ads',
  blurb:
    'Pull spend, results and creative performance from your ad accounts. ' +
    'Ad reporting settles over about 72 hours, so recent days still move.',

  scopes: ['ads_read'],

  /** No client_credentials here either — the same browser step, for the same reason. */
  requiresBrowserConsent: true,

  /**
   * DAILY, against Ubersuggest's weekly 168. Nothing generic reads a constant
   * for this; the planner takes it off the descriptor.
   */
  syncIntervalHours: 24,

  /**
   * The sketch stops here. A real provider fills these in against a real
   * authorization server; what matters for the seam is the SHAPE, and that
   * `validateDescriptor` insists on `buildAuthorizeUrl` being callable.
   */
  oauth: {
    buildAuthorizeUrl: () => {
      throw new Error('ads is a sketch — see the header');
    },
    exchangeCode: () => {
      throw new Error('ads is a sketch — see the header');
    },
    refreshTokens: () => {
      throw new Error('ads is a sketch — see the header');
    },
  },

  kinds: KINDS,
  resolveKinds,
  variantsFor,
  fields: FIELDS,
  readField,

  /**
   * `listProjects`, `describeAccount`, `fetch`, `createClient` and `actions`
   * are the parts that need a real API behind them, and a sketch cannot have
   * one. They are omitted rather than stubbed — `validateDescriptor` does not
   * require them, `listConnectors` tolerates their absence (`availableKinds`
   * and `availableFields` already fall back to `[]` for a provider that stopped
   * at an earlier phase), and a stub returning plausible fixtures would be the
   * exact thing that makes a seam LOOK proven while proving nothing.
   */
};

module.exports = {
  descriptor,
  KINDS,
  FIELDS,
  resolveKinds,
  variantsFor,
  readField,
  getKind,
};

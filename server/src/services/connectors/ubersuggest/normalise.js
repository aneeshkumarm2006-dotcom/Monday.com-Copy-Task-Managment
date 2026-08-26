/**
 * Provider payload → snapshot shape.
 *
 * ---- Why this is separate from fetchers.js ---------------------------------
 *
 * Everything here is pure. Given a JSON blob it returns our shape, with no HTTP,
 * no session and no clock — which is what makes it the part worth testing hard,
 * and the part a future contributor can safely change when the provider moves a
 * field. `fetchers.js` next door does the talking; this does the reading.
 *
 * ---- The rule every function here follows ----------------------------------
 *
 * NOTHING THROWS ON A SHAPE IT DOES NOT RECOGNISE. `llms.md` documents response
 * fields for `project_position_info` and the audit tools and for nothing else —
 * the domain, backlinks and keyword reports are all "the raw Ubersuggest API
 * payload (fields defined by the backend)". So a missing field is the normal
 * case, not a fault, and a normaliser that threw would turn one renamed key
 * into a failed weekly sync for every account.
 *
 * The snapshot keeps the raw payload alongside the normalised fields for the
 * same reason `ConnectorProject.raw` exists: a field we failed to anticipate is
 * then a change in this file rather than a week of history nobody collected.
 *
 * ---- The one semantic that must not be smoothed away -----------------------
 *
 * A position of `null` with `status: 'ok'` means THE DOMAIN DOES NOT RANK IN THE
 * TOP 100. It is a final answer. `llms.md` is explicit that this is "NOT a
 * 'still loading' state". Every normaliser below preserves the difference
 * between that null and an absent field, because collapsing them is how a
 * failed sync becomes indistinguishable from an honest "not ranking" — and the
 * tab would render both as an empty cell.
 */

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

/**
 * First present value among several candidate keys.
 *
 * The same defensive spelling list as `projects.js`, and for the same reason:
 * the documented tools use snake_case, the undocumented passthrough payloads
 * have been seen using both, and picking one would be a coin flip.
 *
 * Note `null` is SKIPPED here but is meaningful elsewhere — see `numOrNull`,
 * which is what the position readers use.
 */
const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

/** A finite number, or null. Strings are parsed — this API quotes numbers. */
const num = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    // Thousands separators and a currency symbol both appear in this payload.
    const parsed = Number(value.replace(/[,$\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** `pick`, then `num`. */
const pickNum = (obj, keys) => num(pick(obj, keys));

/**
 * A rank, preserving the difference between "not in the top 100" and "the field
 * was not there".
 *
 * @param {any} container - e.g. `keywords[i].new_position`
 * @returns {{ value: number|null, present: boolean }}
 */
const positionOf = (container) => {
  if (container === undefined) return { value: null, present: false };
  // The documented shape is `{ position: number|null }`, but a bare number in
  // that slot is the obvious future simplification and costs nothing to accept.
  if (typeof container === 'number' || typeof container === 'string') {
    return { value: num(container), present: true };
  }
  if (container === null) return { value: null, present: true };
  if (typeof container !== 'object') return { value: null, present: false };
  if (!('position' in container) && !('pos' in container) && !('rank' in container)) {
    return { value: null, present: false };
  }
  const raw = container.position ?? container.pos ?? container.rank ?? null;
  return { value: num(raw), present: true };
};

/**
 * Pull the first array out of an envelope, trying the shapes this backend uses.
 * A bare array is returned as-is.
 */
const unwrapArray = (payload, keys = []) => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of [...keys, 'data', 'results', 'items', 'rows', 'list']) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      for (const inner of [...keys, 'data', 'results', 'items', 'rows']) {
        if (Array.isArray(value[inner])) return value[inner];
      }
    }
  }
  return [];
};

/**
 * Unwrap `{ result: … }`.
 *
 * The audit tools document their fields as `result.done`, `result.report` and so
 * on, but the MCP layer sometimes hands back the inner object already unwrapped
 * depending on whether the tool declared an output schema. Accepting both is two
 * lines; guessing wrong is an empty audit section with no error.
 */
const unwrapResult = (payload) => {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.result && typeof payload.result === 'object') return payload.result;
  }
  return payload;
};

/** An ISO day (`YYYY-MM-DD`) from anything date-shaped, or null. */
const dayKeyOf = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** A Date from anything date-shaped, or null. */
const dateOf = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ---------------------------------------------------------------------------
// positions — project_position_info
// ---------------------------------------------------------------------------

/**
 * Which way a keyword moved.
 *
 * Rank is inverted — 3 is better than 8 — so `change` is `previous - current`
 * and a POSITIVE number is an improvement. That sign convention is stated here
 * once and relied on by the tab; flipping it silently would turn every green
 * arrow red.
 *
 * The two asymmetric cases are the ones worth naming rather than folding into a
 * number: a keyword that entered the top 100 has no previous rank to subtract
 * from, and one that fell out of it has no current rank. Both are movement, and
 * both would be `null` if this only returned a difference.
 */
const movementOf = (current, previous) => {
  const hasCurrent = typeof current === 'number';
  const hasPrevious = typeof previous === 'number';

  if (hasCurrent && hasPrevious) {
    const change = previous - current;
    return { change, movement: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' };
  }
  if (hasCurrent && !hasPrevious) return { change: null, movement: 'entered' };
  if (!hasCurrent && hasPrevious) return { change: null, movement: 'lost' };
  // Neither point ranks. Not a gap — a keyword this domain has never charted for.
  return { change: null, movement: 'none' };
};

/** One tracked keyword's row. */
const normalisePositionRow = (raw) => {
  if (!raw || typeof raw !== 'object') return null;

  // The phrase key is NOT documented — the response table stops at `status` and
  // the two position objects. Every plausible spelling is accepted, and a row
  // with none of them is still kept: an unnamed rank is useless in the table but
  // it still counts toward the totals, and dropping it would make the counts
  // disagree with the provider's own `binned`.
  const keyword = pick(raw, [
    'keyword', 'kw', 'phrase', 'term', 'query', 'keyword_name', 'name', 'text',
  ]);

  const current = positionOf(pick(raw, ['new_position', 'newPosition']) ?? raw.new_position);
  const previous = positionOf(pick(raw, ['old_position', 'oldPosition']) ?? raw.old_position);

  const status = String(pick(raw, ['status']) || 'ok');

  return {
    keyword: keyword ? String(keyword) : null,
    // 'ok' | 'pending'. `pending` only ever appears on a brand-new project whose
    // first SERP collection has not run — it is the ONE case where a null rank
    // really does mean "not yet", and the tab must say so differently.
    status,
    position: current.value,
    previousPosition: previous.value,
    // Kept so a row where the provider omitted the object entirely is
    // distinguishable from one where it sent an explicit null. The first is a
    // shape we did not anticipate; the second is "not in the top 100".
    ranked: current.present,
    url: (() => {
      const u = pick(raw, ['url', 'ranking_url', 'landing_page', 'page']);
      return u ? String(u) : null;
    })(),
    ...movementOf(current.value, previous.value),
  };
};

/**
 * The project-aggregate average-position series.
 *
 * Label discipline matters here: Ubersuggest counts a keyword outside the top
 * 100 as +100 in this mean, so it is NOT the average of the ranks we store and
 * must never be recomputed from them. It is passed through, labelled as the
 * provider's own number, and the tab says "project average" on it.
 */
const normaliseAverageSeries = (raw) => {
  const list = unwrapArray(raw, ['positions', 'series', 'points']);
  const out = [];
  for (const entry of list) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'number' || typeof entry === 'string') {
      const value = num(entry);
      if (value !== null) out.push({ date: null, value });
      continue;
    }
    if (typeof entry !== 'object') continue;
    const date = dayKeyOf(pick(entry, ['date', 'day', 'period', 'at', 'x', 'timestamp']));
    const value = pickNum(entry, ['position', 'value', 'avg', 'average', 'y', 'pos']);
    if (date === null && value === null) continue;
    out.push({ date, value });
  }
  // Oldest first, so a chart can render it without re-sorting. Undated points
  // keep their arrival order at the end rather than being dropped.
  return out.sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
};

/**
 * `project_position_info` → our positions snapshot.
 *
 * @param {any} payload
 * @returns {Object}
 */
const normalisePositions = (payload) => {
  const root = unwrapResult(payload) || {};

  const keywords = unwrapArray(pick(root, ['keywords']) ?? root.keywords, ['keywords'])
    .map(normalisePositionRow)
    .filter(Boolean);

  const binned = (root.binned && typeof root.binned === 'object') ? root.binned : {};

  // Counted from the rows rather than trusted from `binned`, EXCEPT
  // `notRanking` — the provider's own bucket is authoritative there and can
  // legitimately disagree with ours when it sent rows we could not name.
  let improved = 0;
  let declined = 0;
  let unchanged = 0;
  let ranking = 0;
  let pending = 0;
  for (const k of keywords) {
    if (k.status === 'pending') pending += 1;
    if (typeof k.position === 'number') ranking += 1;
    if (k.movement === 'up' || k.movement === 'entered') improved += 1;
    else if (k.movement === 'down' || k.movement === 'lost') declined += 1;
    else if (k.movement === 'flat') unchanged += 1;
  }

  const providerNotRanking = pickNum(binned, ['not_ranking', 'notRanking']);

  return {
    // `done: true` means FINAL. The tab must not offer a retry on a finished
    // report that simply says the domain does not rank.
    done: root.done === true || root.done === 'true',
    updatedAt: dateOf(pick(root, ['updated_at', 'updatedAt', 'collected_at'])),
    keywords,
    averagePositions: normaliseAverageSeries(
      pick(root, ['average_positions', 'averagePositions'])
    ),
    totals: {
      tracked: keywords.length,
      ranking,
      notRanking: providerNotRanking !== null
        ? providerNotRanking
        : keywords.length - ranking - pending,
      pending,
      improved,
      declined,
      unchanged,
    },
    binned,
  };
};

// ---------------------------------------------------------------------------
// keyword_metrics — match_keywords
// ---------------------------------------------------------------------------

/**
 * One keyword's metrics.
 *
 * The response table for `match_keywords` is the one documented table among the
 * keyword tools, so these spellings are the primary ones and the alternates are
 * defensive rather than speculative. `sd` is SEO difficulty and `pd` is paid
 * difficulty — the two are trivially confusable and mapping them the wrong way
 * round would put a paid number in a column labelled KD, which is exactly the
 * class of silent error phase 5 exists to remove.
 */
const normaliseKeywordMetric = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const keyword = pick(raw, ['keyword', 'kw', 'phrase', 'term']);
  if (!keyword) return null;

  return {
    keyword: String(keyword),
    volume: pickNum(raw, ['volume', 'search_volume', 'searchVolume']),
    cpc: pickNum(raw, ['cpc']),
    difficulty: pickNum(raw, ['sd', 'seo_difficulty', 'seoDifficulty', 'difficulty']),
    paidDifficulty: pickNum(raw, ['pd', 'paid_difficulty', 'paidDifficulty']),
    competition: pickNum(raw, ['competition']),
    intent: (() => {
      const v = pick(raw, ['search_intent', 'searchIntent', 'intent']);
      return v ? String(v) : null;
    })(),
  };
};

/**
 * `match_keywords` → our keyword_metrics snapshot.
 *
 * ONLY `searched_keywords` is read. `suggestions` is the expansion half of the
 * tool — keywords Ubersuggest thinks are related — and it is often an order of
 * magnitude larger than the seed list. Storing it would bloat every snapshot
 * with data no section renders, in a collection whose entire purpose is to be
 * kept forever.
 *
 * @param {any} payload
 * @returns {Array<Object>}
 */
const normaliseKeywordMetrics = (payload) => {
  const root = unwrapResult(payload) || {};
  const rows = unwrapArray(
    pick(root, ['searched_keywords', 'searchedKeywords']) ?? root.searched_keywords,
    ['searched_keywords']
  );
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const metric = normaliseKeywordMetric(row);
    if (!metric) continue;
    const key = metric.keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(metric);
  }
  return out;
};

// ---------------------------------------------------------------------------
// site_audit — site_audit / site_audit_status
// ---------------------------------------------------------------------------

/** One issue row inside a category. */
const normaliseAuditIssue = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  // Issue ids are NOT enumerated anywhere in the documentation and must be
  // discovered from the response — they are also the argument
  // `site_audit_results` takes to list affected URLs, so an issue with no id is
  // one nobody can drill into.
  const id = pick(raw, ['id', 'issue', 'key', 'code']);
  const name = pick(raw, ['name', 'title', 'label', 'description']);
  if (id === null && name === null) return null;
  return {
    id: id === null ? null : String(id),
    name: name ? String(name) : String(id),
    count: pickNum(raw, ['count', 'total', 'pages', 'affected', 'value']) ?? 0,
  };
};

const AUDIT_CATEGORIES = ['errors', 'warnings', 'recommendations'];

/**
 * `site_audit` / `site_audit_status` → our site_audit snapshot.
 *
 * Both tools are documented as returning the same shape, which is why one
 * normaliser serves the scheduled read and the explicit "Run audit" button.
 *
 * @param {any} payload
 * @returns {Object}
 */
const normaliseSiteAudit = (payload) => {
  const root = unwrapResult(payload) || {};
  const report = (root.report && typeof root.report === 'object') ? root.report : {};
  const overview = (report.overview && typeof report.overview === 'object')
    ? report.overview
    : {};
  const perCategory = (() => {
    const v = pick(report, ['issues_per_category', 'issuesPerCategory']);
    return v && typeof v === 'object' ? v : {};
  })();

  const categories = {};
  const totals = {};
  for (const name of AUDIT_CATEGORIES) {
    const issues = unwrapArray(perCategory[name], [name])
      .map(normaliseAuditIssue)
      .filter(Boolean)
      .sort((a, b) => b.count - a.count);
    categories[name] = issues;
    // The category total is the sum of its issues rather than a headline field,
    // because the headline fields in `overview` are not documented and have been
    // seen counting pages rather than issues.
    totals[name] = issues.reduce((sum, i) => sum + (i.count || 0), 0);
  }

  return {
    // False means the crawl is still running. The tab shows progress and the
    // snapshot is stored `partial` — a half-finished crawl is real information
    // ("47 of 150 pages, 12 errors so far") and throwing it away would leave the
    // section blank for the minutes a crawl takes.
    done: root.done === true || root.done === 'true',
    crawled: pickNum(root, ['crawl_count', 'crawlCount']),
    crawlMaxPages: pickNum(root, ['crawl_max_pages', 'crawlMaxPages']),
    // 'no_errors' on success; anything else means the crawl itself failed, which
    // is different from a crawl that succeeded and found errors on the site.
    extendedStatus: (() => {
      const v = pick(root, ['extended_status', 'extendedStatus']);
      return v ? String(v) : null;
    })(),
    healthScore: pickNum(overview, [
      'health_score', 'healthScore', 'score', 'site_health', 'health',
    ]),
    categories,
    totals,
    overview,
  };
};

// ---------------------------------------------------------------------------
// domain_overview — domain_overview + traffic_value
// ---------------------------------------------------------------------------

/**
 * `domain_overview` (+ the separate `traffic_value` call) → our snapshot.
 *
 * Wholly undocumented fields — `llms.md` says only "Traffic, organic keyword
 * count, domain authority and backlinks summary for the domain". So every
 * reader below is a candidate list, the raw payload is kept, and a null here
 * means "we could not find it", not "it is zero". The tab renders those as an
 * em dash rather than a 0, because a 0 traffic estimate and a field we failed to
 * locate look identical on a number line and mean opposite things.
 *
 * @param {any} overviewPayload
 * @param {any} [trafficValuePayload]
 * @returns {Object}
 */
const normaliseDomainOverview = (overviewPayload, trafficValuePayload) => {
  const root = unwrapResult(overviewPayload) || {};
  // The payload has been seen both flat and wrapped in a per-domain object.
  const body = (() => {
    if (root && typeof root === 'object' && !Array.isArray(root)) {
      const nested = pick(root, ['domain', 'overview', 'summary']);
      if (nested && typeof nested === 'object') return { ...nested, ...root };
    }
    return root && typeof root === 'object' ? root : {};
  })();

  const tv = unwrapResult(trafficValuePayload) || {};

  return {
    organicTraffic: pickNum(body, [
      'organic_traffic', 'organicTraffic', 'traffic', 'monthly_traffic', 'visits',
    ]),
    organicKeywords: pickNum(body, [
      'organic_keywords', 'organicKeywords', 'keywords', 'keyword_count', 'keywords_count',
    ]),
    domainAuthority: pickNum(body, [
      'domain_authority', 'domainAuthority', 'da', 'authority', 'domain_score',
    ]),
    backlinks: pickNum(body, ['backlinks', 'total_backlinks', 'backlinks_count']),
    referringDomains: pickNum(body, [
      'referring_domains', 'referringDomains', 'refdomains', 'ref_domains',
    ]),
    trafficValue: pickNum(tv, [
      'traffic_value', 'trafficValue', 'value', 'cost', 'estimated_value',
    ]) ?? pickNum(body, ['traffic_value', 'trafficValue']),
    overview: body,
  };
};

// ---------------------------------------------------------------------------
// backlinks — backlinks_overview + anchor_texts
// ---------------------------------------------------------------------------

/** One anchor-text row. */
const normaliseAnchor = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const anchor = pick(raw, ['anchor', 'anchor_text', 'anchorText', 'text', 'title']);
  if (anchor === null) return null;
  return {
    anchor: String(anchor),
    backlinks: pickNum(raw, ['backlinks', 'total', 'count', 'links']),
    domains: pickNum(raw, [
      'domains', 'referring_domains', 'refdomains', 'domains_count',
    ]),
  };
};

/**
 * `backlinks_overview` (+ `anchor_texts`) → our snapshot.
 *
 * @param {any} overviewPayload
 * @param {any} [anchorsPayload]
 * @returns {Object}
 */
const normaliseBacklinks = (overviewPayload, anchorsPayload) => {
  const root = unwrapResult(overviewPayload) || {};
  const body = root && typeof root === 'object' ? root : {};

  const anchors = unwrapArray(
    unwrapResult(anchorsPayload),
    ['anchors', 'anchor_texts', 'anchorTexts']
  )
    .map(normaliseAnchor)
    .filter(Boolean)
    .sort((a, b) => (b.backlinks || 0) - (a.backlinks || 0));

  return {
    backlinks: pickNum(body, [
      'backlinks', 'total_backlinks', 'totalBacklinks', 'backlinks_count', 'total',
    ]),
    referringDomains: pickNum(body, [
      'referring_domains', 'referringDomains', 'refdomains', 'ref_domains',
      'domains', 'referring_domains_count',
    ]),
    domainAuthority: pickNum(body, [
      'domain_authority', 'domainAuthority', 'da', 'authority', 'domain_score',
    ]),
    nofollow: pickNum(body, ['nofollow', 'nofollow_backlinks', 'no_follow']),
    dofollow: pickNum(body, ['dofollow', 'dofollow_backlinks', 'do_follow']),
    anchors,
    overview: body,
  };
};

module.exports = {
  // The readers, exported because they are what a shape change lands on.
  pick,
  num,
  pickNum,
  positionOf,
  unwrapArray,
  unwrapResult,
  dayKeyOf,
  dateOf,
  movementOf,
  // Per-kind normalisers.
  normalisePositionRow,
  normaliseAverageSeries,
  normalisePositions,
  normaliseKeywordMetric,
  normaliseKeywordMetrics,
  normaliseAuditIssue,
  normaliseSiteAudit,
  normaliseDomainOverview,
  normaliseBacklinks,
  AUDIT_CATEGORIES,
};

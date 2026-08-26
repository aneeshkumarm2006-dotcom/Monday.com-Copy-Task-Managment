const { createMcpClient } = require('./mcpClient');
const { getKind } = require('./kinds');
const N = require('./normalise');

/**
 * One fetcher per snapshot kind.
 *
 * ---- What a fetcher owes its caller ----------------------------------------
 *
 * A fetcher makes the provider calls for one kind, for one project, and hands
 * back a SNAPSHOT BODY — never a database row. Persistence, dedupe, quota
 * accounting and the per-account stop conditions all live in the generic
 * `../snapshotService.js`, which names no provider. That split is what makes the
 * Ads-board connector a sibling directory rather than a rewrite of the runner.
 *
 * ---- What it must never do -------------------------------------------------
 *
 * SWALLOW A QUOTA ERROR. `mcpClient.callTool` throws an `McpCallError` carrying
 * `.quotaExhausted`, `.retryable` and `.needsReauth`, and those flags are the
 * runner's stop conditions — a fetcher that caught everything and returned an
 * empty result would turn "this account is out of quota, stop for today" into
 * "every project returned nothing", and the next run would do it all again.
 *
 * So the rule below is narrow and deliberate: a fetcher catches a failure ONLY
 * on a SECONDARY call whose absence degrades the snapshot rather than emptying
 * it (anchor texts next to a backlink total, traffic value next to a traffic
 * estimate). The primary call's error always propagates.
 *
 * ---- Quota, and why the kinds are batched per project ----------------------
 *
 * "Each distinct report subject counts one report per day … repeated calls for
 * the same subject on the same day do not consume extra reports." The three
 * domain-subject kinds all name the SAME domain, so run together they cost one
 * report between them; run on three different days they cost three. That is the
 * reason the runner walks kinds inside a project rather than projects inside a
 * kind, and the reason a same-day re-run is free rather than merely idempotent.
 */

// ---------------------------------------------------------------------------
// Tool names, spelled once
// ---------------------------------------------------------------------------

const TOOL_POSITIONS = 'project_position_info';
const TOOL_MATCH_KEYWORDS = 'match_keywords';
const TOOL_SITE_AUDIT = 'site_audit';
const TOOL_SITE_AUDIT_STATUS = 'site_audit_status';
const TOOL_DOMAIN_OVERVIEW = 'domain_overview';
const TOOL_TRAFFIC_VALUE = 'traffic_value';
const TOOL_BACKLINKS_OVERVIEW = 'backlinks_overview';
const TOOL_ANCHOR_TEXTS = 'anchor_texts';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * How many tracked keywords we ask `match_keywords` about per project, per run.
 *
 * This is a REAL cap with a real cost, and it is capped rather than unbounded
 * because a keyword is its own report subject: 300 tracked keywords on 15
 * projects would be 4,500 report subjects against a 900/day ceiling, and the
 * run would die a third of the way through the first project having spent the
 * whole workspace's day. At 100 the same fleet costs 1,500 across two days,
 * which is survivable and degrades predictably.
 *
 * The snapshot records `truncated` and the real tracked total so the tab says
 * "metrics for 100 of 240 tracked keywords" rather than quietly showing 100 and
 * letting somebody conclude the other 140 stopped being tracked.
 */
const KEYWORD_METRICS_MAX = 100;

/** `match_keywords` takes an array but documents no ceiling. Chunked to be safe. */
const KEYWORD_BATCH_SIZE = 25;

/** Upstream caps `anchor_texts` at 25 regardless of what we ask for. */
const ANCHOR_LIMIT = 25;

/**
 * How far back the rank report is asked to look.
 *
 * `startDate`/`endDate` are REQUIRED on `project_position_info`, and the window
 * only affects `average_positions.positions` — the per-keyword half is always
 * two points, previous and current. Thirty days is what the tool's own
 * documentation suggests as the default and gives the aggregate chart four
 * weekly collections to draw.
 */
const POSITIONS_WINDOW_DAYS = 30;

/**
 * How many (location, language) combinations of one project we will poll.
 *
 * Each is a separate report. A project tracking eight locales would otherwise
 * cost eight reports a week on its own; the runner logs what it skipped rather
 * than silently truncating.
 */
const MAX_POSITION_VARIANTS = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD`, UTC. The provider's date arguments are plain ISO days. */
const isoDay = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * The date window a fetch should ask for, defaulted rather than required.
 *
 * @param {{from?: string|Date, to?: string|Date}} [range]
 * @param {Date} [now]
 */
const resolveRange = (range = {}, now = new Date()) => {
  const to = range.to ? isoDay(range.to) : isoDay(now);
  if (range.from) return { from: isoDay(range.from), to };
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - POSITIONS_WINDOW_DAYS);
  return { from: isoDay(from), to };
};

/** Split an array into fixed-size chunks. */
const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * A stable, READABLE key for one variant of a kind.
 *
 * The design plan called this `requestHash`. A hash and a readable key give the
 * same guarantee — two different request shapes never collide on one snapshot
 * row — but only one of them can be read off a document in a shell six months
 * from now, and "why is this project's history split in two" is exactly the
 * question somebody will be asking. So: readable.
 *
 * `default` for every kind that takes only a subject, which is all of them
 * except positions.
 */
const variantKey = ({ device, lang, locId } = {}) => {
  const parts = [device || 'desktop', lang || 'any', locId ? String(locId) : 'any'];
  return parts.join('|');
};

const DEFAULT_VARIANT = { key: 'default' };

/**
 * Which variants of a kind exist for this project.
 *
 * Only `positions` fans out: it is the sole device-aware tool in the manifest
 * and the only one that filters by a (locId, language) pair — and that pair MUST
 * be one the project actually tracks, which is why `ConnectorProject.locations`
 * is mirrored. Everything else takes one subject and has exactly one variant.
 *
 * Mobile is deliberately absent. It is off by default per project at the
 * provider, costs its own report, and we have no way to tell from `list_projects`
 * whether a project tracks it — polling it blind would spend a report per
 * project per week to receive an error.
 *
 * @param {string} kindKey
 * @param {Object} project - a ConnectorProject row
 * @returns {{ variants: Array<Object>, skipped: number }}
 */
const variantsFor = (kindKey, project) => {
  if (kindKey !== 'positions') return { variants: [DEFAULT_VARIANT], skipped: 0 };

  const locations = Array.isArray(project?.locations) ? project.locations : [];
  const usable = locations.filter((l) => l && (l.locId || l.lang));

  if (!usable.length) {
    // No mirrored locales. The filters are optional, so one unfiltered call is
    // a valid ask and returns whatever the project's default combination is.
    return { variants: [{ ...DEFAULT_VARIANT, key: variantKey({}) }], skipped: 0 };
  }

  const variants = usable.slice(0, MAX_POSITION_VARIANTS).map((l) => ({
    key: variantKey({ device: 'desktop', lang: l.lang, locId: l.locId }),
    device: 'desktop',
    lang: l.lang || null,
    locId: l.locId || null,
    label: l.label || null,
  }));

  return { variants, skipped: Math.max(0, usable.length - variants.length) };
};

// ---------------------------------------------------------------------------
// The fetchers
// ---------------------------------------------------------------------------

/**
 * Rank tracking.
 *
 * `done: false` is stored as a PARTIAL snapshot rather than discarded. The
 * report is asynchronous and the tool already polls internally, so a false here
 * means it ran out of patience — but the rows it did return are real, and
 * throwing them away would leave the section blank for a week rather than
 * showing last week's plus whatever arrived.
 */
const fetchPositions = async (client, { project, range, variant }) => {
  const { from, to } = resolveRange(range);

  const args = {
    project_id: String(project.externalId),
    startDate: from,
    endDate: to,
  };
  if (variant?.locId) args.locId = Number(variant.locId);
  if (variant?.lang) args.language = String(variant.lang);
  if (variant?.device) args.device = variant.device;

  const { data } = await client.callTool(TOOL_POSITIONS, args);
  const normalised = N.normalisePositions(data);

  return {
    data: normalised,
    raw: data,
    status: normalised.done ? 'ok' : 'partial',
    note: normalised.done
      ? ''
      : 'Ubersuggest was still computing this report. The rows below are what it had.',
    // The provider's own SERP-collection time is the authoritative period, not
    // our clock. Two polls in one week resolve to one snapshot because of this
    // line — see snapshotService's periodKey.
    collectedAt: normalised.updatedAt || null,
    range: { from, to },
  };
};

/**
 * Volume, difficulty, CPC and intent for the tracked keywords.
 *
 * Reads its keyword list out of the `positions` result taken moments earlier in
 * the same run. The alternative — `get_project` — is a second report for a list
 * we already hold, and there is no third way to enumerate tracked keywords.
 */
const fetchKeywordMetrics = async (client, { project, variant, previous }) => {
  const positions = previous?.positions;
  const tracked = (positions?.keywords || [])
    .map((k) => k.keyword)
    .filter((k) => typeof k === 'string' && k.trim() !== '');

  if (!tracked.length) {
    // Not a failure. A project with no tracked keywords, or one whose position
    // report has not run yet, has nothing to look up — and an empty snapshot
    // records that we asked, which is what stops the runner retrying it hourly.
    return {
      data: { keywords: [], trackedTotal: 0, truncated: false },
      raw: null,
      status: 'ok',
      note: positions
        ? 'This project has no tracked keywords yet.'
        : 'Rank tracking did not run, so there was no keyword list to price.',
      collectedAt: null,
    };
  }

  const unique = [...new Set(tracked.map((k) => k.trim()))];
  const asked = unique.slice(0, KEYWORD_METRICS_MAX);

  // Locale is taken from the same variant the positions report used, so the
  // volume next to a rank is the volume for the market that rank was measured
  // in. Mixing them would put US volume beside a UK rank on the same row.
  const locale = {};
  if (variant?.lang) locale.language = String(variant.lang);
  if (variant?.locId) locale.locId = Number(variant.locId);

  const rows = [];
  for (const batch of chunk(asked, KEYWORD_BATCH_SIZE)) {
    // Sequential. These share one account's quota and firing them in parallel
    // turns "we ran out partway through" into "several calls raced past the
    // limit and we cannot say which of them landed".
    // eslint-disable-next-line no-await-in-loop
    const { data } = await client.callTool(TOOL_MATCH_KEYWORDS, {
      keywords: batch,
      // The seed metrics are what we want; suggestions are the expensive half
      // and nothing renders them. 1 is the smallest ask the parameter allows.
      limit: 1,
      ...locale,
    });
    rows.push(...N.normaliseKeywordMetrics(data));
  }

  const byKeyword = new Map(rows.map((r) => [r.keyword.toLowerCase(), r]));

  return {
    data: {
      // Ordered by the tracked list, not by the provider's response order, so
      // the Keywords table and the Positions table read down in the same order.
      keywords: asked.map(
        (k) => byKeyword.get(k.toLowerCase()) || {
          keyword: k,
          volume: null,
          cpc: null,
          difficulty: null,
          paidDifficulty: null,
          competition: null,
          intent: null,
        }
      ),
      trackedTotal: unique.length,
      truncated: unique.length > asked.length,
      cap: KEYWORD_METRICS_MAX,
    },
    raw: null, // Several batched payloads; the normalised rows are the record.
    status: 'ok',
    note: unique.length > asked.length
      ? `Metrics fetched for the first ${asked.length} of ${unique.length} tracked keywords.`
      : '',
    collectedAt: null,
  };
};

/**
 * The last completed site audit.
 *
 * READS, NEVER STARTS. `site_audit` is documented as "starts (or re-starts) a
 * site audit crawl" — minutes of somebody else's compute, capped by plan — so
 * an unattended weekly job that started one for every domain in the workspace
 * is exactly the behaviour that gets an integration switched off at the other
 * end. Starting a crawl is the explicit "Run audit" button below.
 *
 * The consequence is that a domain nobody has ever audited returns a fatal
 * "Task has not been set" from `site_audit_status`. That is recorded as an empty
 * snapshot with an actionable sentence, not as a failure — there is nothing
 * broken, somebody just has to press the button once.
 */
const fetchSiteAudit = async (client, { project }) => {
  const domain = String(project.domain || '').trim();

  let data;
  try {
    ({ data } = await client.callTool(TOOL_SITE_AUDIT_STATUS, { domain }));
  } catch (err) {
    // Quota and dead grants are the runner's business, not ours.
    if (err.quotaExhausted || err.needsReauth || err.retryable) throw err;
    if (/task has not been set|no.*audit|not found/i.test(err.message || '')) {
      return {
        data: null,
        raw: null,
        status: 'partial',
        note: 'No site audit has been run for this domain yet. Use “Run audit” to start one.',
        collectedAt: null,
      };
    }
    throw err;
  }

  const normalised = N.normaliseSiteAudit(data);

  return {
    data: normalised,
    raw: data,
    status: normalised.done ? 'ok' : 'partial',
    note: normalised.done
      ? ''
      : `Crawl in progress — ${normalised.crawled ?? 0} of ${normalised.crawlMaxPages ?? '?'} pages.`,
    collectedAt: null,
  };
};

/**
 * Traffic, authority and traffic value.
 *
 * Two tools, one subject, therefore one report between them on the same day.
 * `traffic_value` is SECONDARY: it is a single number beside a whole overview,
 * so its failure degrades the card rather than emptying it and is caught here.
 * The overview's failure is not caught — see this file's header.
 */
const fetchDomainOverview = async (client, { project }) => {
  const domain = String(project.domain || '').trim();

  const { data: overview } = await client.callTool(TOOL_DOMAIN_OVERVIEW, { domain });

  let trafficValue = null;
  let note = '';
  try {
    ({ data: trafficValue } = await client.callTool(TOOL_TRAFFIC_VALUE, { domain }));
  } catch (err) {
    if (err.quotaExhausted || err.needsReauth) throw err;
    note = 'Traffic value was unavailable on this run.';
  }

  return {
    data: N.normaliseDomainOverview(overview, trafficValue),
    raw: { overview, trafficValue },
    status: 'ok',
    note,
    collectedAt: null,
  };
};

/**
 * Backlink totals and the anchor-text mix.
 *
 * Same shape as the domain overview: the totals are primary, the anchor list is
 * secondary and its failure is survivable.
 */
const fetchBacklinks = async (client, { project }) => {
  const domain = String(project.domain || '').trim();

  const { data: overview } = await client.callTool(TOOL_BACKLINKS_OVERVIEW, { domain });

  let anchors = null;
  let note = '';
  try {
    ({ data: anchors } = await client.callTool(TOOL_ANCHOR_TEXTS, {
      domain,
      limit: ANCHOR_LIMIT,
    }));
  } catch (err) {
    if (err.quotaExhausted || err.needsReauth) throw err;
    note = 'Anchor texts were unavailable on this run.';
  }

  return {
    data: N.normaliseBacklinks(overview, anchors),
    raw: { overview, anchors },
    status: 'ok',
    note,
    collectedAt: null,
  };
};

const FETCHERS = {
  positions: fetchPositions,
  keyword_metrics: fetchKeywordMetrics,
  site_audit: fetchSiteAudit,
  domain_overview: fetchDomainOverview,
  backlinks: fetchBacklinks,
};

/**
 * Fetch one kind, for one project, for one variant.
 *
 * This is the descriptor's `fetch`. The generic snapshot service calls it and
 * knows nothing about which tools it spends.
 *
 * @param {string} kindKey
 * @param {Object} ctx
 * @param {Object} ctx.session   - services/connectors/session.js
 * @param {Object} ctx.project   - a ConnectorProject row
 * @param {Object} [ctx.range]   - { from, to }
 * @param {Object} [ctx.variant] - from `variantsFor`
 * @param {Object} [ctx.previous] - kind key → normalised data already fetched
 *   in THIS run, for the kinds that declare a dependency
 * @param {Function} [ctx.clientFactory] - injected by the tests
 * @returns {Promise<{data: any, raw: any, status: string, note: string,
 *   collectedAt: Date|null}>}
 */
const fetchKind = async (kindKey, ctx) => {
  const kind = getKind(kindKey);
  if (!kind) throw new Error(`Unknown Ubersuggest snapshot kind "${kindKey}"`);

  const fetcher = FETCHERS[kindKey];
  if (!fetcher) throw new Error(`No fetcher for Ubersuggest kind "${kindKey}"`);

  const { session, clientFactory = createMcpClient } = ctx;
  const client = ctx.client || clientFactory(session);

  return fetcher(client, ctx);
};

// ---------------------------------------------------------------------------
// Actions — the things a person presses, not the things a schedule does
// ---------------------------------------------------------------------------

/**
 * Start a fresh crawl of a project's domain.
 *
 * Separate from `fetchSiteAudit` on purpose. A crawl is expensive at the other
 * end and its results are not instant — `site_audit` answers with the initial
 * status, and the finished report arrives on a later poll, which for us means
 * the next scheduled `site_audit` fetch or the next manual refresh. So this
 * returns a STATUS, and the caller's job is to say "started" rather than to
 * pretend it has an audit.
 *
 * `recrawl: true` is the whole point of the button — without it the tool may
 * answer from cache, which is what the scheduled read already does.
 */
const runAudit = async ({ session, project, clientFactory = createMcpClient, client }) => {
  const domain = String(project?.domain || '').trim();
  if (!domain) {
    const err = new Error('This project has no domain, so there is nothing to audit.');
    err.status = 400;
    throw err;
  }

  const mcp = client || clientFactory(session);
  const { data } = await mcp.callTool(TOOL_SITE_AUDIT, { domain, recrawl: true });
  const normalised = N.normaliseSiteAudit(data);

  return {
    data: normalised,
    raw: data,
    // A crawl that came back already finished is a real audit and is stored as
    // one; the usual case is `done: false` and a snapshot that says so.
    status: normalised.done ? 'ok' : 'partial',
    note: normalised.done
      ? ''
      : 'Crawl started. It usually takes a few minutes — refresh to see the result.',
    collectedAt: null,
  };
};

/**
 * The provider's user-triggered actions, keyed by name.
 *
 * A map rather than a hardcoded endpoint so the controller stays generic: it
 * looks the action up on the descriptor, checks `requires` against the project,
 * and runs it. The Ads connector will declare its own without touching a route.
 */
const ACTIONS = {
  audit: {
    key: 'audit',
    label: 'Run audit',
    /** The snapshot kind this action writes, so its result is stored like any other. */
    kind: 'site_audit',
    /** A field the project must carry. Checked before a call is made. */
    requires: 'domain',
    run: runAudit,
  },
};

module.exports = {
  fetchKind,
  variantsFor,
  variantKey,
  resolveRange,
  runAudit,
  ACTIONS,
  // Exported for the tests, which exercise the fetchers against a stub client
  // rather than through HTTP.
  fetchPositions,
  fetchKeywordMetrics,
  fetchSiteAudit,
  fetchDomainOverview,
  fetchBacklinks,
  chunk,
  KEYWORD_METRICS_MAX,
  KEYWORD_BATCH_SIZE,
  MAX_POSITION_VARIANTS,
  POSITIONS_WINDOW_DAYS,
  TOOL_POSITIONS,
  TOOL_MATCH_KEYWORDS,
  TOOL_SITE_AUDIT,
  TOOL_SITE_AUDIT_STATUS,
  TOOL_DOMAIN_OVERVIEW,
  TOOL_TRAFFIC_VALUE,
  TOOL_BACKLINKS_OVERVIEW,
  TOOL_ANCHOR_TEXTS,
};

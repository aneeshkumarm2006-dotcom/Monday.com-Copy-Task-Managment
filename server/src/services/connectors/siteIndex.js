const ConnectorSnapshot = require('../../models/ConnectorSnapshot');

/**
 * THE SITE INDEX — one row per site, for the table that opens the SEO tab.
 *
 * ---- Why this exists at all ------------------------------------------------
 *
 * The dashboard answers "how is THIS site doing". It has always opened straight
 * into one, chosen by a dropdown, which means the question an agency actually
 * opens the tab with — "how are my twenty sites doing" — could only be answered
 * by picking each one in turn and remembering the numbers. That is not a
 * reporting tool, it is a filing cabinet.
 *
 * So the tab now opens on a TABLE of every site, and this file is what fills a
 * row. Drilling into one is the second click, not the first.
 *
 * ---- Why the arithmetic lives on the server --------------------------------
 *
 * Because the alternative is twenty `/data` requests, each of which loads every
 * keyword of every snapshot to compute five numbers off the top of them. A
 * hundred-keyword site's `positions` payload is tens of kilobytes; twenty of
 * those is a table that takes a second to paint and a megabyte to deliver, for
 * ten numbers per row.
 *
 * It is also the same rule the rest of this feature follows, and the reason
 * `goalTypes.js` and `adsBudgetPacing.js` are each the ONLY scorer of their
 * thing: a metric computed in two places is a metric that will eventually
 * disagree with itself, and the disagreement is invisible in a screenshot.
 *
 * ---- What it does NOT do ---------------------------------------------------
 *
 * It contacts no provider and spends nothing. Every number here came out of
 * `ConnectorSnapshot`, which is why the handler that calls it sits on
 * `connector.view` and is safe on every render. That is the rule the whole data
 * plane is built on — see `connectorDataController`'s header.
 */

/**
 * The kinds a row is built from. Ordered by how much of the row each one fills.
 *
 * Deliberately a SHORT list rather than every kind. A table column has to be
 * comparable across twenty sites at a glance, and most kinds produce a list
 * (competitors, anchors, top pages) with no single honest number to put in a
 * cell. Those stay one click away, on the screen built for them.
 */
const INDEX_KINDS = ['positions', 'backlinks_summary', 'site_audit'];

/**
 * How many readings of each kind to load per site.
 *
 * TWO, because every delta in this table is "against the previous collection"
 * and the provider stores no history of its own — the same rule the Overview
 * screen states at length. One reading gives numbers with no arrows; three
 * would be a bigger query for a column nobody asked for.
 */
const DEPTH_PER_KIND = 2;

/**
 * A click-through curve, used ONLY to turn a set of ranks into one number.
 *
 * ---- Why a visibility score is computed here rather than fetched -----------
 *
 * Because nobody sells us one. DataForSEO answers "where does this rank" and
 * nothing else, so the single number that lets twenty sites be compared in one
 * column has to be ours. Being ours, it is documented rather than presented as
 * a measurement: it is a WEIGHTED COUNT OF RANKS, not a traffic estimate, and
 * it must never be labelled as traffic on a client report.
 *
 * The weights are an ordinary organic CTR curve rounded to three places. The
 * exact numbers matter far less than that they are FIXED — a score whose curve
 * changes between releases is a score whose history is not comparable with
 * itself, which is the one failure that would make the column worse than no
 * column at all.
 *
 * Index is position - 1. Anything past the end of the array scores zero: a rank
 * of 47 is real and is worth reporting on the rank table, but it is not
 * visibility.
 */
const CTR_CURVE = [
  0.28, 0.15, 0.11, 0.08, 0.06, 0.05, 0.04, 0.03, 0.028, 0.025,
  0.02, 0.018, 0.016, 0.014, 0.013, 0.012, 0.011, 0.01, 0.009, 0.008,
];

/** The most one keyword can contribute, so the score lands on 0-100. */
const CTR_MAX = CTR_CURVE[0];

/** A finite number, or null. Never a coerced zero — see `connectorFormat`. */
const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * A 0-100 visibility score over one collection's keyword rows.
 *
 * Divided by the TRACKED count rather than by the ranked one, deliberately: a
 * site with one keyword at #1 and ninety-nine nowhere is not a visible site, and
 * dividing by the ranked count would score it 100. The denominator is what makes
 * the column mean "how much of what we track is working".
 *
 * Null for a site with nothing tracked, which renders as an em dash. A zero
 * would say "we looked and found nothing", and we did not look.
 *
 * @param {Array<Object>} keywords - normalised rows carrying `rank`
 * @returns {number|null}
 */
const visibilityOf = (keywords) => {
  const rows = Array.isArray(keywords) ? keywords : [];
  if (!rows.length) return null;
  const earned = rows.reduce((sum, row) => {
    const rank = num(row && row.rank) ?? num(row && row.position);
    if (rank === null || rank < 1) return sum;
    return sum + (CTR_CURVE[Math.round(rank) - 1] || 0);
  }, 0);
  return Math.round((earned / (rows.length * CTR_MAX)) * 1000) / 10;
};

/**
 * The rank half of a row, from one `positions` snapshot.
 *
 * Reads the stored `totals` rather than recounting `keywords[]` where it can:
 * the aggregate was computed by `normalise.aggregatePositions` at collection
 * time, and recounting it here would be the second implementation this file
 * exists to avoid. `visibility` is the exception — it needs the individual
 * ranks, and it did not exist when those totals were written.
 */
const rankMetricsOf = (snapshot) => {
  const data = (snapshot && snapshot.data) || null;
  if (!data) return null;
  const totals = data.totals || {};
  const ai = data.aiVisibility || null;
  return {
    tracked: num(totals.tracked),
    ranking: num(totals.ranked),
    top3: num(totals.top3),
    top10: num(totals.top10),
    averageRank: num(totals.averageRank),
    visibility: visibilityOf(data.keywords),
    /**
     * The AI Overview column, from the block that already rides inside the SERP
     * payload. Free — it is counted out of a reading the rank table already
     * paid for — which is why it earns a column while the paid extras do not.
     */
    aiPresenceRate: ai ? num(ai.presenceRate) : null,
    aiCited: ai ? num(ai.cited) : null,
  };
};

/** The link half, from one `backlinks_summary` snapshot. */
const linkMetricsOf = (snapshot) => {
  const data = (snapshot && snapshot.data) || null;
  if (!data) return null;
  const profile = data.profile || {};
  const self = (data.authority || []).find((row) => row.isSelf) || null;
  return {
    backlinks: num(profile.backlinks),
    referringDomains: num(profile.referringDomains),
    /**
     * DataForSEO's own 0-1000 rank for our domain, and NEVER domain authority —
     * the distinction `backlinksNormalise.js` opens with. Carried with its scale
     * so the client can say which one it is rather than implying DA.
     */
    authorityRank: self ? num(self.authorityRank) : null,
  };
};

/** The crawl half, from one `site_audit` snapshot. */
const auditMetricsOf = (snapshot) => {
  const data = (snapshot && snapshot.data) || null;
  if (!data) return null;
  const totals = data.totals || {};
  return {
    /**
     * Carried verbatim. `onpageNormalise.js` opens by refusing to recompute it,
     * and a table that rescaled it into a friendlier percentage would be exactly
     * the recomputation it refused.
     */
    siteHealth: num(totals.onpageScore),
    pagesCrawled: num(totals.pagesCrawled) ?? num(data.pagesCrawled),
  };
};

/**
 * Every numeric field, minus the same field one collection ago.
 *
 * Only over keys that are numbers on BOTH sides. A delta against a missing
 * reading is not zero and is not the value itself — it is unknown, and an absent
 * key is how this says so. Rank is not inverted here; the client knows which
 * columns are better-when-smaller and renders the arrow, exactly as
 * `connectorFormat` already does for a single rank.
 */
const deltaBetween = (now, before) => {
  if (!now || !before) return {};
  const out = {};
  Object.keys(now).forEach((key) => {
    const a = num(now[key]);
    const b = num(before[key]);
    if (a === null || b === null) return;
    out[key] = Math.round((a - b) * 100) / 100;
  });
  return out;
};

/**
 * The newest two readings of each index kind, for a set of projects, in ONE
 * query.
 *
 * `{project, kind, collectedAt: -1}` is an index this collection already
 * carries, so this is a walk rather than a scan. `data` is the bulky field and
 * it is selected because the visibility score needs the ranks — but `raw` never
 * is, which is what keeps a twenty-site table off the provider's verbatim
 * payloads.
 *
 * @param {Array} projectIds
 * @returns {Promise<Map<string, Map<string, Object[]>>>} projectId → kind → [newest, previous]
 */
const loadIndexSnapshots = async (projectIds) => {
  const byProject = new Map();
  if (!projectIds.length) return byProject;

  const rows = await ConnectorSnapshot.find({
    project: { $in: projectIds },
    kind: { $in: INDEX_KINDS },
    status: 'ok',
  })
    .select('project kind variant collectedAt fetchedAt data')
    .sort({ project: 1, kind: 1, collectedAt: -1, fetchedAt: -1 })
    .lean();

  rows.forEach((row) => {
    const pid = String(row.project);
    if (!byProject.has(pid)) byProject.set(pid, new Map());
    const byKind = byProject.get(pid);
    const kept = byKind.get(row.kind) || [];
    /**
     * ONE VARIANT PER SITE, and it is the newest one's.
     *
     * A site collected in two markets has two `positions` rows per collection,
     * and they are two different facts — a US rank and a UK rank for the same
     * keyword. Averaging them would invent a market that does not exist, so the
     * table shows the newest market's and the row says which. The other one is
     * a click away, on the dashboard's own market picker.
     */
    if (kept.length && kept[0].variant !== row.variant) return;
    if (kept.length >= DEPTH_PER_KIND) return;
    kept.push(row);
    byKind.set(row.kind, kept);
  });

  return byProject;
};

/**
 * One row of numbers per site: where it stands, and what moved.
 *
 * Drafts are skipped rather than queried for. A draft has never been collected
 * for — that is enforced twice server-side, see `ConnectorProject.status` — so
 * its row is a row of em dashes either way, and including it would put an empty
 * `$in` term in the query for every unfinished site in the workspace.
 *
 * @param {Object[]} projects - lean `ConnectorProject` rows, already scoped
 * @returns {Promise<Map<string, Object>>} projectId → {metrics, deltas, variant, collectedAt}
 */
const buildSiteIndex = async (projects = []) => {
  const live = projects.filter((p) => p && p.status !== 'draft');
  const snapshots = await loadIndexSnapshots(live.map((p) => p._id));

  const out = new Map();
  projects.forEach((project) => {
    const byKind = snapshots.get(String(project._id)) || new Map();
    const at = (kind, i) => (byKind.get(kind) || [])[i] || null;

    const positions = at('positions', 0);
    const links = at('backlinks_summary', 0);
    const audit = at('site_audit', 0);

    const now = {
      ...(rankMetricsOf(positions) || {}),
      ...(linkMetricsOf(links) || {}),
      ...(auditMetricsOf(audit) || {}),
    };
    const before = {
      ...(rankMetricsOf(at('positions', 1)) || {}),
      ...(linkMetricsOf(at('backlinks_summary', 1)) || {}),
      ...(auditMetricsOf(at('site_audit', 1)) || {}),
    };

    out.set(String(project._id), {
      /**
       * Which market the rank numbers are from, and when they were read. Both
       * are on the ROW rather than only in a tooltip: a rank with no market and
       * no date beside it is a number that cannot be checked, which is the same
       * argument the project bar already makes for the single-site view.
       */
      variant: (positions && positions.variant) || null,
      collectedAt:
        (positions && (positions.collectedAt || positions.fetchedAt)) || null,
      metrics: Object.keys(now).length ? now : null,
      deltas: deltaBetween(now, before),
      /** Which of the three readings this row actually has. Drives the em dash. */
      has: {
        positions: !!positions,
        backlinks: !!links,
        audit: !!audit,
      },
    });
  });

  return out;
};

module.exports = {
  buildSiteIndex,
  // Pure, and exported because they are what the tests assert on.
  visibilityOf,
  deltaBetween,
  INDEX_KINDS,
  CTR_CURVE,
};

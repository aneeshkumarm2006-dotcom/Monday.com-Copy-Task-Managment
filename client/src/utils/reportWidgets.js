import { comparability as backlinkComparability, deltaOf as backlinkDelta } from './backlinkRows.js';
import { comparability as auditComparability, deltaOf as auditDelta } from './auditRows.js';
import { comparability as rankComparability } from './aiRows.js';

/**
 * The Client Report — five widget primitives, and not one more.
 *
 * ---- Why five ---------------------------------------------------------------
 *
 * A KPI tile, a table, a line, a bar and a donut. Semrush's entire reporting
 * product runs on five chart types, and the temptation on a builder like this is
 * always twenty. What twenty buys is a report nobody can read twice: a client
 * learns to read a shape, and a page where every section is a different shape is
 * a page they read once and then skim.
 *
 * The constraint is enforced by `WIDGETS` being a closed table and
 * `isWidgetType` being the only door into it, so a sixth type is a deliberate
 * edit rather than an object literal somebody adds inline.
 *
 * ---- Zero API cost, and that is a load-bearing claim -----------------------
 *
 * Every number on this page came out of a snapshot some other screen already
 * paid for. This module takes the payload the tab already has and rearranges it.
 * It makes no request of any kind — the connector data tab's whole doctrine is
 * that a page load must never reach a provider, and on this provider a page load
 * that did would BUY SERPS, per viewer, per render.
 *
 * ---- Freshness is per WIDGET, and that is the phase-6 rule kept -------------
 *
 * Labs data may never be called live; the backlink index may; a crawl is neither
 * and carries a size. A report mixes all three on one page, so a single caption
 * at the top would have to be wrong about two of them. Every widget therefore
 * names the `kind` it came from and carries a `freshness` token, and the renderer
 * stamps each one individually.
 *
 * ---- And the summary at the top -------------------------------------------
 *
 * The plan asked for an AI narrative. THERE IS NO MODEL SEAM IN THIS
 * APPLICATION — no server-side LLM client, no key, no budget line — and adding a
 * live external call to a phase whose whole premise is that a page load contacts
 * nothing would be the wrong trade twice over: an outbound dependency on a
 * render path, and a per-view cost on a screen built to have none.
 *
 * So the summary is GENERATED FROM THE SAME GUARDED NUMBERS THE WIDGETS DRAW,
 * deterministically, in this file. The consequence worth having: it cannot say
 * anything the panels below it contradict, and it cannot state a delta that
 * `comparability` refused — because it asks the same functions. A model writing
 * prose over an unguarded subtraction is exactly how "your backlinks grew 12%"
 * ends up under a panel that declined to draw the same number.
 */

const numberOr = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * THE FIVE. A closed table, deliberately.
 *
 * `format` says how the renderer should read a raw value; it is data rather than
 * a function so the same descriptor survives being serialised into a saved
 * report layout later.
 */
export const WIDGETS = [
  { type: 'number', label: 'Number', blurb: 'One figure, with its change when the two readings are comparable.' },
  { type: 'table', label: 'Table', blurb: 'Rows and columns, capped so a page stays a page.' },
  { type: 'line', label: 'Line', blurb: 'A series over time. Rank axes are inverted; nothing else is.' },
  { type: 'bar', label: 'Bar', blurb: 'A handful of labelled magnitudes.' },
  { type: 'donut', label: 'Donut', blurb: 'Parts of one whole, six slices and a remainder.' },
];

const WIDGET_TYPES = new Set(WIDGETS.map((w) => w.type));

export const isWidgetType = (type) => WIDGET_TYPES.has(type);

/** How many rows a report table may carry before it stops being a report. */
export const TABLE_ROW_CAP = 10;

/** How many slices a donut may carry before the rest becomes "Other". */
export const DONUT_SLICE_CAP = 6;

/**
 * The freshness token a widget carries, by the kind it came from.
 *
 * Three values, matching `labsExport`'s registry exactly: `index` for the Labs
 * database (which may never be called live), `live` for the backlink index
 * (which may), and `crawl` for a measurement we ordered at a size. `serp` is the
 * fourth, and it is the only one that is a reading of a page on a day.
 */
export const FRESHNESS_BY_KIND = {
  positions: 'serp',
  movement: 'serp',
  keyword_metrics: 'index',
  competitors: 'index',
  keyword_gap: 'index',
  top_pages: 'index',
  backlinks_summary: 'live',
  backlinks_timeseries: 'live',
  referring_domains: 'live',
  referring_networks: 'live',
  anchors: 'live',
  site_audit: 'crawl',
  business_profile: 'live',
};

export const FRESHNESS_CAPTIONS = {
  serp: 'read from the live search results on the day shown',
  index: 'from a competitive index, not a live reading',
  live: 'from a continuously rebuilt link index',
  crawl: 'from a crawl of the site at the size shown',
};

/**
 * Build one widget, refusing an unknown type rather than rendering nothing.
 *
 * Exported as `buildWidget` so a test can assert the refusal directly. That
 * refusal is the only thing keeping the five from becoming twenty: without it, a
 * sixth type is an object literal somebody adds inline in a screen and nobody
 * reviews as a decision.
 */
export const buildWidget = (type, spec) => {
  if (!isWidgetType(type)) {
    throw new Error(`"${type}" is not one of the five report widgets`);
  }
  return {
    type,
    freshness: FRESHNESS_BY_KIND[spec.kind] || null,
    ...spec,
  };
};

/**
 * A KPI tile whose delta is asked of the right guard, or is absent.
 *
 * ---- The whole point of routing every delta through a named guard ----------
 *
 * A client report is the one surface where a wrong number is both most likely to
 * be believed and least likely to be checked. `backlinks_status_type` recomputes
 * every aggregate rather than filtering rows; `onpage_score` is a share of the
 * pages crawled; a rank bought to depth 10 reports everything past ten as
 * unranked. Two readings taken differently produce a delta that is a change of
 * settings wearing the clothes of a result.
 *
 * So `delta` is null and `deltaReason` carries the sentence, which the renderer
 * prints in place of an arrow. A missing number with an explanation beats a
 * present number with none.
 */
const guardFor = (kind) => {
  if (kind === 'site_audit') return { check: auditComparability, delta: auditDelta };
  if (kind === 'positions' || kind === 'movement') {
    return {
      check: rankComparability,
      delta: (a, b, pick) => {
        if (!rankComparability(a, b).ok) return null;
        const now = pick(a);
        const then = pick(b);
        return typeof now === 'number' && typeof then === 'number' ? now - then : null;
      },
    };
  }
  return { check: backlinkComparability, delta: backlinkDelta };
};

export const numberWidget = ({ title, sub, kind, current, previous, pick, format = 'number' }) => {
  const guard = guardFor(kind);
  const ok = current && previous ? guard.check(current, previous) : { ok: false, reason: '' };
  return buildWidget('number', {
    title,
    sub,
    kind,
    format,
    value: pick(current || {}) ?? null,
    delta: current && previous ? guard.delta(current, previous, pick) : null,
    deltaReason: ok.ok ? '' : ok.reason,
  });
};

export const tableWidget = ({ title, sub, kind, columns, rows }) =>
  buildWidget('table', {
    title,
    sub,
    kind,
    columns,
    rows: (Array.isArray(rows) ? rows : []).slice(0, TABLE_ROW_CAP),
    /** Said out loud, because a truncated table that does not say so lies. */
    truncated: Array.isArray(rows) && rows.length > TABLE_ROW_CAP,
    totalRows: Array.isArray(rows) ? rows.length : 0,
  });

export const lineWidget = ({ title, sub, kind, points, yLabel, invertY = false }) =>
  buildWidget('line', {
    title,
    sub,
    kind,
    yLabel,
    /**
     * INVERTED FOR RANK ONLY. Rank 1 belongs at the top or improvement draws as
     * a cliff-fall; a backlink count inverted the same way renders two years of
     * link building as a collapse, which is the plausible copy-paste phase 7
     * named.
     */
    invertY,
    points: (Array.isArray(points) ? points : []).map((p) => ({
      x: p.x,
      /** Null stays null. A week with no reading is a GAP, not a zero. */
      y: numberOr(p.y),
    })),
  });

export const barWidget = ({ title, sub, kind, bars }) =>
  buildWidget('bar', {
    title,
    sub,
    kind,
    bars: (Array.isArray(bars) ? bars : []).map((b) => ({
      label: String(b.label),
      value: numberOr(b.value),
      tone: b.tone || null,
    })),
  });

export const donutWidget = ({ title, sub, kind, slices }) => {
  const all = (Array.isArray(slices) ? slices : [])
    .map((s) => ({ label: String(s.label), value: numberOr(s.value) ?? 0 }))
    .sort((a, b) => b.value - a.value);

  const kept = all.slice(0, DONUT_SLICE_CAP);
  const rest = all.slice(DONUT_SLICE_CAP).reduce((sum, s) => sum + s.value, 0);
  if (rest > 0) kept.push({ label: 'Other', value: rest, other: true });

  return buildWidget('donut', {
    title,
    sub,
    kind,
    slices: kept,
    total: all.reduce((sum, s) => sum + s.value, 0),
  });
};

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The written summary, from the same guarded numbers the widgets draw.
 *
 * ---- The rules it is written under -----------------------------------------
 *
 * IT NEVER STATES A DELTA THE PANELS REFUSED. Every change it mentions comes
 * from a `numberWidget` that already asked its guard, so a sentence about growth
 * cannot appear above a tile that declined to draw it.
 *
 * IT SAYS NOTHING RATHER THAN SOMETHING BLAND. A summary that always produces
 * three sentences produces three sentences nobody reads. With no comparable
 * readings it returns one honest line about that and stops.
 *
 * IT NAMES NO PROVIDER AND MAKES NO PROMISE. "Rankings improved" is a claim
 * about the world; "twelve tracked keywords moved into the top ten since the
 * last reading" is a description of two numbers.
 *
 * @param {Array<Object>} widgets - the number widgets, already guarded
 * @param {Object} meta
 * @returns {{lines: string[], caveats: string[]}}
 */
export const narrativeFrom = (widgets, meta = {}) => {
  const tiles = widgets.filter((w) => w.type === 'number');
  const lines = [];
  const caveats = [];

  const byTitle = (title) => tiles.find((t) => t.title === title) || null;

  const opening = [
    meta.siteName || 'This site',
    meta.periodLabel ? `— reading of ${meta.periodLabel}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  if (opening) lines.push(`${opening}.`);

  const top10 = byTitle('Keywords on page one');
  if (top10 && typeof top10.value === 'number') {
    const move =
      typeof top10.delta === 'number' && top10.delta !== 0
        ? `, ${top10.delta > 0 ? 'up' : 'down'} ${Math.abs(top10.delta)} since the last reading`
        : '';
    lines.push(`${plural(top10.value, 'tracked keyword ranks', 'tracked keywords rank')} on page one${move}.`);
  }

  const links = byTitle('Referring domains');
  if (links && typeof links.value === 'number') {
    const move =
      typeof links.delta === 'number' && links.delta !== 0
        ? ` (${links.delta > 0 ? '+' : ''}${links.delta} since the last reading)`
        : '';
    lines.push(`${links.value.toLocaleString()} domains link to it${move}.`);
  }

  const health = byTitle('Site health score');
  if (health && typeof health.value === 'number') {
    lines.push(
      `The last crawl scored the site ${health.value} out of 100` +
        (typeof health.delta === 'number' && health.delta !== 0
          ? `, ${health.delta > 0 ? 'up' : 'down'} ${Math.abs(health.delta)}.`
          : '.')
    );
  }

  const ai = byTitle('Keywords with an AI Overview');
  if (ai && typeof ai.value === 'number' && ai.value > 0) {
    const cited = byTitle('Cited in the AI Overview');
    lines.push(
      `Google now shows an AI Overview for ${ai.value} of the tracked keywords` +
        (cited && typeof cited.value === 'number'
          ? `, and cites this site in ${cited.value} of them.`
          : '.')
    );
  }

  /**
   * THE CAVEATS, which are the half a generated summary usually leaves out. Any
   * tile whose guard refused contributes its own sentence, so the reader is told
   * which comparisons were declined and why rather than noticing an arrow is
   * missing.
   */
  for (const tile of tiles) {
    if (tile.deltaReason) caveats.push(`${tile.title}: ${tile.deltaReason}`);
  }

  if (lines.length <= 1 && !caveats.length) {
    return {
      lines: [
        `${meta.siteName || 'This site'} has one reading so far, so there is nothing to compare it with yet.`,
      ],
      caveats,
    };
  }

  return { lines, caveats };
};

/**
 * Assemble the whole report from the connector data payload.
 *
 * Sections are built ONLY from the kinds that actually have a reading — a
 * heading over an empty panel reads as a fault, and a client report is the last
 * place to explain our own collection settings.
 *
 * @param {Object} data - the connector data payload
 * @returns {{meta: Object, sections: Array<Object>, narrative: Object}}
 */
export const buildReport = (data) => {
  const snap = data?.snapshots || {};
  const prev = data?.previousSnapshots || {};
  const sections = [];
  const tiles = [];

  const rank = snap.positions || snap.movement || null;
  const rankPrev = snap.positions ? prev.positions : prev.movement;
  const rankKind = snap.positions ? 'positions' : 'movement';

  if (rank) {
    const headline = [
      numberWidget({
        title: 'Keywords tracked',
        kind: rankKind,
        current: rank.data,
        previous: rankPrev?.data,
        pick: (d) => numberOr(d?.totals?.tracked),
      }),
      numberWidget({
        title: 'Keywords on page one',
        sub: 'position 10 or better',
        kind: rankKind,
        current: rank.data,
        previous: rankPrev?.data,
        pick: (d) => numberOr(d?.totals?.top10),
      }),
      numberWidget({
        title: 'Keywords in the top 3',
        kind: rankKind,
        current: rank.data,
        previous: rankPrev?.data,
        pick: (d) => numberOr(d?.totals?.top3),
      }),
      numberWidget({
        title: 'Average position',
        sub: 'over the keywords that ranked',
        kind: rankKind,
        current: rank.data,
        previous: rankPrev?.data,
        pick: (d) => numberOr(d?.totals?.averageRank),
      }),
    ];
    tiles.push(...headline);

    const trend = Array.isArray(data?.trend) ? data.trend : [];
    sections.push({
      key: 'rankings',
      title: 'Search rankings',
      widgets: [
        ...headline,
        lineWidget({
          title: 'Average position over time',
          kind: rankKind,
          yLabel: 'Position',
          /** THE ONLY inverted axis in this report. See `lineWidget`. */
          invertY: true,
          points: trend.map((p) => ({ x: p.periodKey, y: p.totals?.averageRank ?? null })),
        }),
        barWidget({
          title: 'Where the keywords sit',
          kind: rankKind,
          bars: [
            { label: 'Top 3', value: rank.data?.totals?.top3, tone: 'positive' },
            { label: 'Top 10', value: rank.data?.totals?.top10, tone: 'positive' },
            { label: 'Top 100', value: rank.data?.totals?.top100, tone: 'neutral' },
            {
              label: 'Unranked',
              value:
                numberOr(rank.data?.totals?.tracked) !== null &&
                numberOr(rank.data?.totals?.ranked) !== null
                  ? rank.data.totals.tracked - rank.data.totals.ranked
                  : null,
              tone: 'negative',
            },
          ],
        }),
      ],
    });

    const ai = rank.data?.aiVisibility || null;
    if (ai && numberOr(ai.withOverview)) {
      const aiTiles = [
        numberWidget({
          title: 'Keywords with an AI Overview',
          sub: `of ${ai.tracked} tracked`,
          kind: rankKind,
          current: rank.data,
          previous: rankPrev?.data,
          pick: (d) => numberOr(d?.aiVisibility?.withOverview),
        }),
        numberWidget({
          title: 'Cited in the AI Overview',
          sub: 'our domain is in Google’s reference list',
          kind: rankKind,
          current: rank.data,
          previous: rankPrev?.data,
          pick: (d) => numberOr(d?.aiVisibility?.cited),
        }),
        numberWidget({
          /**
           * A SEPARATE TILE, never added to the one above it. Cited is a link;
           * mentioned is prose. They are fixed by different work.
           */
          title: 'Named without a citation',
          sub: 'the brand appears in the text, with no link',
          kind: rankKind,
          current: rank.data,
          previous: rankPrev?.data,
          pick: (d) => numberOr(d?.aiVisibility?.mentionedNotCited),
        }),
      ];
      tiles.push(...aiTiles);
      sections.push({
        key: 'ai',
        title: 'AI Overviews',
        widgets: [
          ...aiTiles,
          donutWidget({
            title: 'Who Google cites for these keywords',
            kind: rankKind,
            slices: (ai.sources || []).map((s) => ({ label: s.domain, value: s.keywords })),
          }),
        ],
      });
    }
  }

  if (snap.backlinks_summary) {
    const links = [
      numberWidget({
        title: 'Referring domains',
        kind: 'backlinks_summary',
        current: snap.backlinks_summary.data,
        previous: prev.backlinks_summary?.data,
        pick: (d) => numberOr(d?.profile?.referringDomains),
      }),
      numberWidget({
        title: 'Backlinks',
        kind: 'backlinks_summary',
        current: snap.backlinks_summary.data,
        previous: prev.backlinks_summary?.data,
        pick: (d) => numberOr(d?.profile?.backlinks),
      }),
      numberWidget({
        /** 0-1000, DataForSEO's own metric. Never labelled DA or DR. */
        title: 'Link strength (0–1000)',
        sub: 'DataForSEO’s own rank — not comparable to any other tool’s',
        kind: 'backlinks_summary',
        current: snap.backlinks_summary.data,
        previous: prev.backlinks_summary?.data,
        pick: (d) => numberOr(d?.profile?.rank),
      }),
    ];
    tiles.push(...links);
    sections.push({ key: 'backlinks', title: 'Backlinks', widgets: links });
  }

  if (snap.site_audit) {
    const audit = [
      numberWidget({
        title: 'Site health score',
        sub: 'a share of the pages crawled',
        kind: 'site_audit',
        current: snap.site_audit.data,
        previous: prev.site_audit?.data,
        pick: (d) => numberOr(d?.totals?.onpageScore),
      }),
      numberWidget({
        title: 'Pages crawled',
        kind: 'site_audit',
        current: snap.site_audit.data,
        previous: prev.site_audit?.data,
        pick: (d) => numberOr(d?.crawl?.pagesCrawled),
      }),
    ];
    tiles.push(...audit);
    sections.push({
      key: 'audit',
      title: 'Technical health',
      widgets: [
        ...audit,
        tableWidget({
          title: 'The biggest issues',
          kind: 'site_audit',
          columns: [
            { key: 'label', label: 'Issue', align: 'left' },
            { key: 'severity', label: 'Severity', align: 'left' },
            { key: 'pages', label: 'Pages affected', align: 'right', format: 'number' },
          ],
          rows: (snap.site_audit.data?.issues || [])
            .filter((i) => numberOr(i.pages))
            .sort((a, b) => (b.pages || 0) - (a.pages || 0))
            .map((i) => ({ label: i.label, severity: i.severity, pages: i.pages })),
        }),
      ],
    });
  }

  const meta = {
    siteName: data?.project?.name || data?.project?.domain || 'This site',
    domain: data?.project?.domain || '',
    periodLabel: rank?.periodKey || snap.backlinks_summary?.periodKey || '',
    variant: data?.variant || '',
  };

  return { meta, sections, narrative: narrativeFrom(tiles, meta) };
};

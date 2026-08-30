import { Database, Download, Filter, Radio, Scan, Search, X } from 'lucide-react';

import Button from '../../../ui/Button';
import { FilterPopover, MiniChip, OptionList, OptionRow } from '../../../ui/FilterControls';
import { formatDay, formatNumber, staleness } from '../../../../utils/connectorFormat';
import { POSITION_BUCKETS } from '../../../../utils/labsRows';

/**
 * The pieces all three Labs screens share.
 *
 * ---- The one that is not decoration ----------------------------------------
 *
 * `IndexStamp`. Every panel on these three screens is drawn from DataForSEO
 * Labs, which is a DATABASE and not a crawl — and DataForSEO's own
 * documentation cannot agree with itself about how old that database is. The
 * Labs overview page says it is rebuilt WEEKLY and offers a free `/status`
 * endpoint as the oracle; their general database article says the SERP and
 * keyword databases underneath refresh every 30-60 days for top-tier locations
 * and 60-90 for mid-tier. Both cannot be true.
 *
 * There is no way to settle that from outside, so the product does not pretend
 * to have settled it. Every panel says "competitive index, updated weekly" and
 * carries the date THEY report, and the word "live" is reserved for the SERP
 * tracker and (in phase 7) backlinks, which really are read fresh.
 *
 * The stamp shows TWO dates because they answer two different questions:
 *
 *   INDEX UPDATED — when DataForSEO last rebuilt the database. What decides
 *                   whether a number is worth acting on.
 *   COLLECTED     — when we last asked it. What decides whether the number on
 *                   screen is the newest one we own.
 *
 * A panel showing only the second would inherit the rank tracker's "collected 2
 * hours ago" and make a freshness claim about somebody else's index that we have
 * no basis for.
 */

export const IndexStamp = ({ freshness, label = 'DataForSEO' }) => (
  <div
    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
    style={{
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-subtle)',
      color: 'var(--color-text-secondary)',
    }}
  >
    <Database size={14} className="shrink-0" aria-hidden="true" />
    <span className="font-body" style={{ fontSize: 12.5 }}>
      Competitive index, updated weekly
    </span>
    <span
      className="font-body"
      style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
    >
      {freshness.indexUpdatedAt
        ? `${label} last rebuilt this index ${formatDay(freshness.indexUpdatedAt)}`
        : `${label} did not report when this index was last rebuilt`}
    </span>
    <span aria-hidden="true" style={{ color: 'var(--color-text-muted)' }}>
      ·
    </span>
    <span
      className="font-body"
      style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
    >
      {freshness.collectedAt
        ? `we collected it ${staleness(freshness.collectedAt)}`
        : 'never collected'}
    </span>
  </div>
);

/**
 * `IndexStamp`'s counterpart for the one family that IS live.
 *
 * ---- Why this is a second component and not a prop on the first ------------
 *
 * Because they make opposite claims and the difference is the point. `IndexStamp`
 * exists to REFUSE the word live: Labs is a database whose age DataForSEO's own
 * documentation puts at both "weekly" and "30-90 days", so those panels say
 * "competitive index" and show the rebuild date they report.
 *
 * The backlink index is rebuilt continuously — ~8.7 billion pages crawled every
 * 24 hours — and DataForSEO lists Backlinks among its live-only families, so
 * this one is allowed the word. Folded into one component behind a flag, the
 * next person editing the caption edits both, and the sentence that has to stay
 * false for Labs is one keystroke from being true.
 *
 * It carries THREE facts and each answers a different question:
 *
 *   WHICH LINK SET — `backlinks_status_type` recomputes every aggregate rather
 *                    than filtering rows, so which corpus a number came from is
 *                    part of the number.
 *   COLLECTED      — when we last asked. Live is about their index, not ours.
 *   INDEX SIZE     — the free footnote, and the caveat that goes with it: the
 *                    per-domain recrawl interval is undocumented, so "live" is
 *                    a claim about the index and not about any single link.
 */
export const LiveStamp = ({ freshness, label = 'DataForSEO' }) => (
  <div
    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
    style={{
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-subtle)',
      color: 'var(--color-text-secondary)',
    }}
  >
    <Radio size={14} className="shrink-0" aria-hidden="true" />
    <span className="font-body" style={{ fontSize: 12.5 }}>
      Live link index
      {freshness.statusType ? ` — “${freshness.statusType}” links` : ''}
    </span>
    <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
      {freshness.collectedAt
        ? `we collected it ${staleness(freshness.collectedAt)}`
        : 'never collected'}
    </span>
    {freshness.index?.backlinks ? (
      <>
        <span aria-hidden="true" style={{ color: 'var(--color-text-muted)' }}>
          ·
        </span>
        <span
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          title={`${label} reports how many links its index holds. It does not publish how often it recrawls any single domain.`}
        >
          {`${label}'s index holds ${formatNumber(freshness.index.backlinks, {
            compact: true,
          })} links`}
        </span>
      </>
    ) : null}
  </div>
);

/**
 * The THIRD stamp, and it makes a third claim again.
 *
 * ---- Why not `IndexStamp` and why not `LiveStamp` --------------------------
 *
 * `IndexStamp` says "competitive index, updated weekly" because Labs is a
 * database whose age DataForSEO's own docs cannot agree on. `LiveStamp` says
 * "live link index" because the backlink index really is rebuilt continuously.
 *
 * A CRAWL IS NEITHER. It is a measurement WE ordered, of one site, on one day,
 * AT A SIZE — and the size is the part that has to be on screen, because
 * `onpage_score` is computed as a share of the pages crawled. DataForSEO say so
 * themselves. A health score of 82 over 120 pages and a health score of 74 over
 * 900 pages are not two points on a line.
 *
 * So this stamp carries three facts, and the third is the one the other two
 * stamps had no equivalent of:
 *
 *   WHEN THE CRAWL RAN  — from the provider's own `crawl_end`, not from when we
 *                         asked. A nine-hour crawl makes those different days.
 *   HOW MUCH IT SAW     — pages crawled against the ceiling asked for.
 *   WHY IT STOPPED      — only when it stopped early, because that reading
 *                         covers what the crawler reached rather than the site.
 */
export const CrawlStamp = ({ freshness, label = 'DataForSEO' }) => (
  <div
    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
    style={{
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-subtle)',
      color: 'var(--color-text-secondary)',
    }}
  >
    <Scan size={14} className="shrink-0" aria-hidden="true" />
    <span className="font-body" style={{ fontSize: 12.5 }}>
      {typeof freshness.pagesCrawled === 'number'
        ? `Crawl of ${formatNumber(freshness.pagesCrawled)} pages`
        : 'Site crawl'}
      {typeof freshness.maxCrawlPages === 'number'
        ? `, up to ${formatNumber(freshness.maxCrawlPages)} asked for`
        : ''}
    </span>
    <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
      {freshness.collectedAt
        ? `${label} ran it ${staleness(freshness.collectedAt)}`
        : 'never collected'}
    </span>
    {freshness.stopReason && freshness.stopReason !== 'finished' ? (
      <>
        <span aria-hidden="true" style={{ color: 'var(--color-text-muted)' }}>
          ·
        </span>
        <span
          className="font-body"
          style={{ fontSize: 12, color: '#DC2626' }}
          title="A crawl that stopped early covers the pages the crawler reached rather than the site, so it is not comparable with a complete one."
        >
          {`stopped early — ${freshness.stopReason}`}
        </span>
      </>
    ) : null}
  </div>
);

/**
 * The sentence a screen shows when its data is not being bought.
 *
 * `BoardConnector.kinds` decides what is PAID FOR and `enabledScreens` decides
 * what is RENDERED, and they are deliberately different switches — narrowing
 * kinds reaches across to any co-tenant board mapping the same site, narrowing
 * screens cannot leave this board. So a screen switched on for a kind nobody
 * collects is a legitimate state, and it deserves a sentence rather than an
 * empty table that reads as a broken connector.
 */
export const NotCollected = ({ label, what }) => (
  <p
    className="font-body px-4 py-3"
    style={{
      fontSize: 12.5,
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-subtle)',
      color: 'var(--color-text-secondary)',
    }}
  >
    {what} is switched off for this board, so nothing is being collected for this
    panel. Anything already collected is kept. Turn it back on under Add-ons — it
    is a separate switch from this screen because it decides what {label} is paid
    to collect, and that is shared with any other board tracking the same site.
  </p>
);

/**
 * Twelve months of search volume, as ~200 bytes of SVG.
 *
 * ---- Why not recharts ------------------------------------------------------
 *
 * Because there are up to two hundred of these on one page. recharts is ~95 KB
 * and mounts a responsive container, a scale and an SVG per instance; two
 * hundred of those is a page that takes seconds to become interactive to draw a
 * shape twelve points wide. The trend chart on the Overview screen is one chart
 * and is worth the library; this is a glyph.
 *
 * A series with fewer than two readable points draws NOTHING rather than a flat
 * line — a flat line is a claim that volume did not move, and "we have one
 * month" is not that claim.
 */
export const Sparkline = ({ points, width = 64, height = 18 }) => {
  const values = (points || [])
    .map((p) => (typeof p.searchVolume === 'number' ? p.searchVolume : null))
    .filter((v) => v !== null);

  if (values.length < 2) {
    return (
      <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }} title="Not enough history">
        —
      </span>
    );
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const d = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(' ');

  const rising = values[values.length - 1] >= values[0];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Search volume, ${values.length} months, ${rising ? 'rising' : 'falling'}`}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <path
        d={d}
        fill="none"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        stroke={rising ? 'var(--color-card-green)' : '#DC2626'}
      />
    </svg>
  );
};

/**
 * The position ladder as a stacked bar.
 *
 * Only the first three buckets are coloured. The ladder runs to position 100 and
 * everything past ten is, for a page's ranking profile, the same fact — "it is
 * on the page somewhere" — so twelve distinct colours would be twelve things to
 * decode for one piece of information.
 */
export const BucketBar = ({ buckets, width = 120 }) => {
  if (!buckets) {
    return (
      <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>—</span>
    );
  }

  const segments = POSITION_BUCKETS.map((bucket, i) => ({
    ...bucket,
    value: typeof buckets[bucket.key] === 'number' ? buckets[bucket.key] : 0,
    color:
      i === 0
        ? 'var(--color-card-green)'
        : i === 1
          ? 'color-mix(in srgb, var(--color-card-green) 62%, transparent)'
          : i === 2
            ? 'color-mix(in srgb, var(--color-card-green) 34%, transparent)'
            : 'var(--color-border-strong)',
  }));

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (!total) {
    return <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>—</span>;
  }

  return (
    <span
      className="inline-flex"
      style={{
        width,
        height: 8,
        borderRadius: 'var(--radius-full)',
        overflow: 'hidden',
        background: 'var(--color-bg-subtle)',
      }}
      title={segments
        .filter((s) => s.value)
        .map((s) => `${s.label}: ${s.value}`)
        .join(' · ')}
    >
      {segments
        .filter((s) => s.value)
        .map((s) => (
          <span
            key={s.key}
            style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
          />
        ))}
    </span>
  );
};

/** A difficulty score with its band's colour behind it. */
export const DifficultyPill = ({ value, band }) => {
  if (typeof value !== 'number') {
    return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;
  }
  const tone =
    band?.tone === 'positive'
      ? 'var(--color-card-green)'
      : band?.tone === 'negative'
        ? '#DC2626'
        : 'var(--color-text-secondary)';
  return (
    <span
      className="font-body"
      style={{ fontSize: 12.5, fontWeight: 600, color: tone }}
      title={band?.label || ''}
    >
      {value}
    </span>
  );
};

/**
 * The filter bar every Labs table shares: a search box, a grouped bucket
 * popover, and the two export buttons.
 *
 * `buckets` may be null, which renders the bar without the popover — the
 * competitor and top-page tables have nothing to bucket by that a search box
 * does not already answer.
 */
export const LabsFilterBar = ({
  query,
  onQuery,
  placeholder,
  buckets = null,
  active = [],
  onToggle,
  onClear,
  onExport,
  children,
}) => {
  const groups = buckets
    ? [...new Set(buckets.map((b) => b.group || ''))].map((group) => ({
        group,
        options: buckets.filter((b) => (b.group || '') === group),
      }))
    : [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div style={{ position: 'relative', minWidth: 220, flex: '1 1 220px', maxWidth: 340 }}>
        <Search
          size={14}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--color-text-muted)',
            pointerEvents: 'none',
          }}
        />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="font-body w-full"
          style={{
            height: 34,
            padding: '0 10px 0 30px',
            fontSize: 13,
            borderRadius: 'var(--radius-md)',
            border: '1.5px solid var(--color-border-strong)',
            background: 'var(--color-bg-surface)',
            color: 'var(--color-text-primary)',
          }}
        />
      </div>

      {buckets && (
        <FilterPopover label="Filter" icon={Filter} activeCount={active.length}>
          <div style={{ minWidth: 210 }}>
            <OptionList emptyLabel="No filters">
              {groups.map(({ group, options }) => (
                <div key={group}>
                  {group ? (
                    <p
                      className="font-body px-3 pt-2 pb-1"
                      style={{
                        fontSize: 10.5,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      {group}
                    </p>
                  ) : null}
                  {options.map((option) => (
                    <OptionRow
                      key={option.key}
                      checked={active.includes(option.key)}
                      onToggle={() => onToggle(option.key)}
                    >
                      <span className="font-body" style={{ fontSize: 13 }}>
                        {option.label}
                      </span>
                    </OptionRow>
                  ))}
                </div>
              ))}
            </OptionList>
          </div>
        </FilterPopover>
      )}

      {active.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 font-body"
          style={{
            fontSize: 12.5,
            color: 'var(--color-text-muted)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <X size={12} aria-hidden="true" /> Clear
        </button>
      )}

      {children}

      <div className="flex-1" />

      <Button variant="secondary" icon={Download} onClick={() => onExport('csv')}>
        CSV
      </Button>
      <Button variant="secondary" icon={Download} onClick={() => onExport('pdf')}>
        PDF
      </Button>
    </div>
  );
};

/** A small count chip, so the three screens caption their tables the same way. */
export const CountChip = ({ children, tone }) => (
  <MiniChip
    bg="var(--color-bg-subtle)"
    text={tone || 'var(--color-text-secondary)'}
  >
    {children}
  </MiniChip>
);

/**
 * A surface. LIFTED OUT OF `BacklinksScreen.jsx` IN PHASE 10.
 *
 * It was a local helper there and phase 10 needed the same box on four more
 * screens, so it moved rather than being copied — the same call phase 7 made
 * when `runLabsJob` became `liveJob.runLiveJob`. Four copies of a border radius
 * is not a correctness problem; four copies that drift is a tab where two panels
 * look subtly different for no reason anybody can find.
 */
export const Panel = ({ children }) => (
  <section
    style={{
      background: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
    }}
  >
    {children}
  </section>
);

/** A panel heading with a subtitle and a right-hand slot. */
export const PanelHead = ({ title, sub, right }) => (
  <header
    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3"
    style={{ borderBottom: '1px solid var(--color-border)' }}
  >
    <h4
      className="font-display font-semibold"
      style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
    >
      {title}
    </h4>
    {sub ? (
      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        {sub}
      </p>
    ) : null}
    <div className="flex-1" />
    {right}
  </header>
);

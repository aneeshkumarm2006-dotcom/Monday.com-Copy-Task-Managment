import { ScrollTable, Td, Th } from '../board/addons/connector/SectionShell';
import { formatNumber } from '../../utils/connectorFormat';

/**
 * ReportWidgetRenderer — how the five report widgets are DRAWN, in one place.
 *
 * `client/src/utils/reportWidgets.js` is the closed table of five primitives (a
 * KPI tile, a table, a line, a bar and a donut) and the `buildWidget` door that
 * refuses a sixth. This file is the other half of that decision: given one of
 * those five descriptors, what appears on screen.
 *
 * ---- WHY THIS IS A MODULE AND NOT A SECOND COPY ---------------------------
 *
 * These renderers were written inside
 * `components/board/addons/seo/ClientReportScreen.jsx`, which was the only
 * screen that drew a report. The executive home's `reportWidget` section draws
 * exactly ONE of the same widgets, built by exactly the same `buildReport` from
 * exactly the same readings — so a second copy of an SVG line and a bar row is
 * not a convenience, it is a promise that the two will drift.
 *
 * And the drift would be invisible in the worst way. The tile on somebody's home
 * page and the panel on the board's Report tab would be captioned identically,
 * report the same title, and disagree — about an inverted axis, about whether a
 * refused delta prints its reason, about whether a truncated table says it was
 * truncated. Every one of those is a wrong number wearing the right label, on the
 * one screen the person who decides things reads figures off.
 *
 * So the screen IMPORTS these and its render path is untouched: `Tile` for the
 * `number` widgets and `RENDERERS[type]` for the other four, the same names it
 * used when it owned them.
 *
 * ---- WHY IT LIVES HERE, WHICH IS ADMITTEDLY A COMPROMISE -------------------
 *
 * Nothing in this file knows anything about SEO, about a connector, or about
 * either of its two consumers. It renders a `reportWidgets` descriptor, and that
 * module lives in `utils/` rather than under any screen. The truest address is
 * therefore `components/ui/`, beside the rest of the shared furniture — and the
 * reason it is not there is the same reason `Panel` and `PanelHead` are still in
 * `LabsBits.jsx` (see `SectionFrame.jsx`, which says so at length): moving a
 * component is a commit that owns its importers.
 *
 * Between the two screens that use it, `executive/` wins on the narrower point.
 * `ClientReportScreen` already reaches outside its own directory three times
 * (`ui/`, `../connector/SectionShell`, `utils/`), so one more outward import
 * changes nothing about how that file reads. The executive side importing DOWN
 * into `board/addons/seo/` would be its second such reach after `LabsBits`, and
 * two of them start to make the SEO folder look like the owner of generic
 * furniture, which it is not.
 *
 * ---- WHAT THIS FILE MAY NOT DO --------------------------------------------
 *
 * It draws. It does not build, guard, compare, truncate or decide an axis:
 * `reportWidgets.js` did all of that when it built the descriptor, on numbers a
 * screen had already paid for. A renderer that recomputed a delta here would be
 * a second answer to a question `comparability` has already refused once.
 */

/**
 * A KPI tile.
 *
 * `number` is the one widget type that is not in `RENDERERS`, because its two
 * consumers lay it out rather than filling a panel with it: the report grids the
 * tiles of a section together, and the home section draws exactly one. Both call
 * this directly.
 */
export const Tile = ({ widget }) => (
  <div className="min-w-0">
    <p
      className="font-body"
      style={{
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--color-text-muted)',
      }}
    >
      {widget.title}
    </p>
    <p
      className="font-display font-semibold mt-0.5"
      style={{ fontSize: 22, color: 'var(--color-text-primary)' }}
    >
      {formatNumber(widget.value)}
    </p>
    {typeof widget.delta === 'number' && widget.delta !== 0 ? (
      <p
        className="font-body mt-0.5"
        style={{
          fontSize: 12,
          color:
            widget.delta > 0 ? 'var(--color-status-done)' : 'var(--color-status-stuck)',
        }}
      >
        {widget.delta > 0 ? '+' : ''}
        {formatNumber(widget.delta)} since the last reading
      </p>
    ) : widget.deltaReason ? (
      /*
        THE REFUSAL, PRINTED. A missing arrow with no explanation reads as "no
        change"; this says which two readings could not be subtracted and why.
      */
      <p
        className="font-body mt-0.5"
        style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
        title={widget.deltaReason}
      >
        no comparable change — {widget.deltaReason.slice(0, 90)}…
      </p>
    ) : (
      <p className="font-body mt-0.5" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
        {widget.sub || 'no change'}
      </p>
    )}
  </div>
);

/** A line, drawn as plain SVG. The report has one; recharts is for the tab. */
export const LineChart = ({ widget }) => {
  const points = widget.points.filter((p) => typeof p.y === 'number');
  if (points.length < 2) {
    return (
      <p className="font-body px-4 py-4" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
        Not enough readings to draw a line yet.
      </p>
    );
  }

  const values = points.map((p) => p.y);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 640;
  const height = 130;

  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * (width - 16) + 8;
      const t = (p.y - min) / span;
      /**
       * INVERTED FOR RANK ONLY. Position 1 belongs at the top, or an improvement
       * draws as a cliff-fall — and a backlink count inverted the same way draws
       * two years of link building as a collapse.
       */
      const y = widget.invertY ? t * (height - 20) + 10 : (1 - t) * (height - 20) + 10;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="px-4 py-4">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={widget.title}>
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth="2" />
      </svg>
      <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
        {widget.yLabel} · {points[0].x} to {points[points.length - 1].x}
        {widget.invertY ? ' · lower is better' : ''}
      </p>
    </div>
  );
};

export const BarChart = ({ widget }) => {
  const max = Math.max(...widget.bars.map((b) => b.value || 0), 1);
  return (
    <div className="flex flex-col gap-2 px-4 py-4">
      {widget.bars.map((bar) => (
        <div key={bar.label} className="flex items-center gap-3">
          <span
            className="font-body"
            style={{ fontSize: 12.5, minWidth: 78, color: 'var(--color-text-secondary)' }}
          >
            {bar.label}
          </span>
          <span
            style={{
              flex: 1,
              height: 8,
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-bg-subtle)',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                display: 'block',
                width: bar.value === null ? 0 : `${Math.max(1, (bar.value / max) * 100)}%`,
                height: '100%',
                background:
                  bar.tone === 'negative'
                    ? 'var(--color-status-stuck)'
                    : 'var(--color-accent)',
              }}
            />
          </span>
          <span
            className="font-body text-right"
            style={{ fontSize: 12.5, minWidth: 62, color: 'var(--color-text-primary)' }}
          >
            {formatNumber(bar.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

export const DonutList = ({ widget }) => (
  <div className="flex flex-col gap-1.5 px-4 py-4">
    {widget.slices.map((slice) => (
      <div key={slice.label} className="flex items-center gap-3">
        <span
          className="font-body truncate"
          style={{ fontSize: 12.5, minWidth: 140, color: 'var(--color-text-secondary)' }}
        >
          {slice.label}
        </span>
        <span
          style={{
            flex: 1,
            height: 8,
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-bg-subtle)',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              display: 'block',
              width: widget.total ? `${Math.max(1, (slice.value / widget.total) * 100)}%` : 0,
              height: '100%',
              background: slice.other ? 'var(--color-text-muted)' : 'var(--color-accent)',
            }}
          />
        </span>
        <span
          className="font-body text-right"
          style={{ fontSize: 12.5, minWidth: 52, color: 'var(--color-text-primary)' }}
        >
          {formatNumber(slice.value)}
        </span>
      </div>
    ))}
  </div>
);

export const TableWidget = ({ widget }) => (
  <>
    <ScrollTable maxHeight={280}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {widget.columns.map((col) => (
              <Th key={col.key} align={col.align}>
                {col.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {widget.rows.map((row, i) => (
            /*
              Keyed on the title plus the index deliberately. A report table is
              built fresh from a snapshot on every render and is never reordered,
              filtered or edited in place, so there is no identity for a key to
              preserve — and the rows genuinely have no stable id of their own.
            */
            <tr key={`${widget.title}-${row[widget.columns[0]?.key] ?? i}`}>
              {widget.columns.map((col) => (
                <Td key={col.key} align={col.align}>
                  {col.format === 'number' ? formatNumber(row[col.key]) : row[col.key]}
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollTable>
    {widget.truncated && (
      <p
        className="font-body px-4 py-2"
        style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
      >
        Showing {widget.rows.length} of {widget.totalRows}. A report is a page.
      </p>
    )}
  </>
);

/**
 * The four panel-filling widgets, by type.
 *
 * The SAME table `ClientReportScreen` declared when it owned these, under the
 * same name and with `number` deliberately absent — see `Tile`. A type with no
 * entry renders nothing, which is what lets a build that has not heard of a
 * widget type meet one in stored data without crashing a page.
 */
export const RENDERERS = { line: LineChart, bar: BarChart, donut: DonutList, table: TableWidget };

/**
 * One widget of ANY of the five, for a caller with one widget and a box.
 *
 * The report screen does not use this — it grids its `number` tiles together and
 * gives each of the other four its own headed panel, which is a layout decision
 * and stays in that file. The home section has exactly one widget and no layout
 * to make, so it needs the dispatch this provides.
 *
 * Renders `null` for an unknown type rather than throwing. `config.widget.type`
 * is STORED data read by code that ships separately from it, which is the same
 * reason `sectionComponentFor` answers null rather than indexing into
 * `undefined.component`.
 */
export const ReportWidget = ({ widget }) => {
  if (!widget) return null;
  if (widget.type === 'number') return <Tile widget={widget} />;
  const Renderer = RENDERERS[widget.type];
  return Renderer ? <Renderer widget={widget} /> : null;
};

export default ReportWidget;

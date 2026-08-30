import { useMemo, useState } from 'react';
import { Download, FileText, Link2 } from 'lucide-react';

import Button from '../../../ui/Button';
import EmptyState from '../../../ui/EmptyState';
import Modal from '../../../ui/Modal';
import { ScrollTable, Td, Th } from '../connector/SectionShell';
import { formatNumber } from '../../../../utils/connectorFormat';
import { downloadReportPdf } from '../../../../utils/reportExport';
import {
  FRESHNESS_CAPTIONS,
  buildReport,
} from '../../../../utils/reportWidgets';
import { Panel, PanelHead } from './LabsBits';

/**
 * The client report — one page somebody can be sent.
 *
 * ---- Five widget primitives, and not one more ------------------------------
 *
 * A KPI tile, a table, a line, a bar and a donut. Semrush's entire reporting
 * product runs on five chart types; the temptation on a builder like this is
 * always twenty, and what twenty buys is a report nobody can read twice.
 * `reportWidgets.buildWidget` throws on a sixth, so adding one is a deliberate
 * edit rather than an object literal in this file.
 *
 * ---- Zero API cost, and it is load-bearing ---------------------------------
 *
 * Every number here came out of a snapshot another screen already paid for. This
 * component makes no request of any kind. On this provider a page that fetched
 * on render would BUY SERPS, per viewer, per render — which is the whole reason
 * the connector tabs are written the way they are.
 *
 * ---- Freshness is stamped per WIDGET, not once at the top ------------------
 *
 * Labs data may never be called live, the backlink index may, and a crawl is
 * neither and carries a size. A report mixes them, so one caption at the top
 * would have to be wrong about two of the three. Each widget names the kind it
 * came from and prints its own line.
 *
 * ---- The summary is generated here, and says so ----------------------------
 *
 * The plan asked for an AI narrative. There is no model seam in this
 * application, and adding an outbound LLM call to a render path whose entire
 * premise is that it contacts nothing would be the wrong trade twice. So the
 * summary is written from THE SAME GUARDED NUMBERS the tiles draw — which buys
 * something a model would not: it cannot state a change that the panel beneath
 * it declined to draw, because it asks the identical `comparability` functions.
 * Every refusal becomes a printed caveat rather than a missing arrow.
 */

const Tile = ({ widget }) => (
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
const LineChart = ({ widget }) => {
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

const BarChart = ({ widget }) => {
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

const DonutList = ({ widget }) => (
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

const TableWidget = ({ widget }) => (
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

const RENDERERS = { line: LineChart, bar: BarChart, donut: DonutList, table: TableWidget };

const ClientReportScreen = ({ data, label }) => {
  const [sharing, setSharing] = useState(false);
  const report = useMemo(() => buildReport(data), [data]);

  if (!report.sections.length) {
    return (
      <EmptyState
        icon={FileText}
        title="Nothing to report yet"
        description="A report is built from readings other screens have already collected. Once the first rank, backlink or crawl reading lands, this page fills itself in — it buys nothing of its own."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-body flex-1" style={{ fontSize: 12, color: 'var(--color-text-muted)', minWidth: 240 }}>
          Built entirely from readings already collected — this page buys nothing.
        </p>
        <Button variant="secondary" icon={Link2} onClick={() => setSharing(true)}>
          Share with the client
        </Button>
        <Button
          variant="secondary"
          icon={Download}
          onClick={() => downloadReportPdf(report, { provider: label })}
        >
          PDF
        </Button>
      </div>

      {/* ---- The summary ------------------------------------------------- */}
      <Panel>
        <PanelHead title="Summary" sub="written from the numbers below" />
        <div className="px-4 py-4 flex flex-col gap-2">
          {report.narrative.lines.map((line) => (
            <p
              key={line}
              className="font-body"
              style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
            >
              {line}
            </p>
          ))}
          {report.narrative.caveats.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {report.narrative.caveats.map((caveat) => (
                <p
                  key={caveat}
                  className="font-body"
                  style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                >
                  {caveat}
                </p>
              ))}
            </div>
          )}
        </div>
      </Panel>

      {report.sections.map((section) => {
        const tiles = section.widgets.filter((w) => w.type === 'number');
        const rest = section.widgets.filter((w) => w.type !== 'number');
        return (
          <Panel key={section.key}>
            <PanelHead
              title={section.title}
              /*
                THE FRESHNESS SENTENCE, PER SECTION, from the kind the widgets
                name. One caption at the top of a report that mixes a competitive
                index, a live link graph and a crawl would have to be wrong about
                two of them.
              */
              sub={FRESHNESS_CAPTIONS[section.widgets[0]?.freshness] || ''}
            />
            {tiles.length > 0 && (
              <div
                className="grid gap-4 px-4 py-4"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}
              >
                {tiles.map((w) => (
                  <Tile key={w.title} widget={w} />
                ))}
              </div>
            )}
            {rest.map((w) => {
              const Renderer = RENDERERS[w.type];
              if (!Renderer) return null;
              return (
                <div key={w.title} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <PanelHead title={w.title} sub={w.sub} />
                  <Renderer widget={w} />
                </div>
              );
            })}
          </Panel>
        );
      })}

      <Modal
        isOpen={sharing}
        onClose={() => setSharing(false)}
        title="Sharing this report with a client"
        maxWidth={480}
      >
        <p className="font-body" style={{ fontSize: 13.5, color: 'var(--color-text-secondary)' }}>
          This board&rsquo;s client portal is the sharing plane. A group on a Client
          Portal board already has a link its contacts can sign in to, and what they
          can read there is decided by one rule for the whole application.
        </p>
        <p className="font-body mt-3" style={{ fontSize: 13.5, color: 'var(--color-text-secondary)' }}>
          Publishing an SEO report into that plane is a change to what a client
          token may read, so it is not something this screen can do on its own.
          Until it exists, export the PDF above and attach it to the client thread —
          which keeps the report in the same place as the rest of their
          correspondence.
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="secondary" onClick={() => setSharing(false)}>
            Close
          </Button>
          <Button
            onClick={() => {
              downloadReportPdf(report, { provider: label });
              setSharing(false);
            }}
          >
            Export the PDF
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default ClientReportScreen;

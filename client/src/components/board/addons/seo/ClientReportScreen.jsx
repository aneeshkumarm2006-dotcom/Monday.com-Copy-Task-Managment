import { useMemo, useState } from 'react';
import { Download, FileText, Link2 } from 'lucide-react';

import Button from '../../../ui/Button';
import EmptyState from '../../../ui/EmptyState';
import Modal from '../../../ui/Modal';
import { RENDERERS, Tile } from '../../../executive/ReportWidgetRenderer';
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
 *
 * ---- The renderers moved out; the LAYOUT stayed ----------------------------
 *
 * `Tile` and `RENDERERS` are imported from
 * `components/executive/ReportWidgetRenderer.jsx`. The executive home's
 * `reportWidget` section draws ONE of the same five widgets, built by this same
 * `buildReport` from the same readings — so a second copy of an SVG line and a
 * bar row would be a promise that the two drift: identically captioned panels
 * disagreeing about an inverted axis, or about whether a refused delta prints
 * its reason. What did NOT move is the arrangement below, which is this
 * screen's own decision and nobody else's: the `number` widgets of a section
 * gridded together at its top, the other four each in a headed panel under the
 * freshness sentence. A home tile has one widget and no layout to make.
 */

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

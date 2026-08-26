import { TriangleAlert } from 'lucide-react';
import EmptyState from '../../../ui/EmptyState';
import { formatDay, staleness } from '../../../../utils/connectorFormat';

/**
 * The frame every connector section sits in.
 *
 * ---- Why the staleness stamp is on every one of them -----------------------
 *
 * Nothing on this tab is live. Every number came out of our database and was
 * collected at some earlier moment — by design, because reaching the provider on
 * render would spend a quota shared by the whole workspace. That is only
 * defensible if the age is always visible: rankings move once a week at
 * Ubersuggest, so "collected 6 days ago" is normal and reassuring, and
 * "collected 3 months ago" is the only outward sign that a connector quietly
 * stopped working.
 *
 * A section with no reading at all says so and stops. It does NOT offer to fetch
 * one — that is the Refresh button in the tab header, held by whoever has
 * `connector.manage`, because it costs the workspace something.
 */
const SectionShell = ({
  kind,
  snapshot,
  icon: Icon,
  emptyTitle,
  emptyDescription,
  children,
  actions,
}) => {
  const collected = snapshot?.collectedAt || snapshot?.fetchedAt || null;

  return (
    <section
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      <header
        className="flex flex-wrap items-start gap-3 px-4 py-3"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <div className="flex-1 min-w-0">
          <h3
            className="font-body font-medium"
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--color-text-secondary)',
            }}
          >
            {kind?.label || 'Data'}
          </h3>
          <p
            className="font-body mt-1"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            {collected ? (
              <>
                Collected {staleness(collected)}
                {snapshot?.periodKey ? ` · ${formatDay(snapshot.periodKey)}` : ''}
              </>
            ) : (
              kind?.blurb || ''
            )}
          </p>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>

      {/* A provider's own sentence — about a crawl still running, a report that
          timed out, a cap we applied. Rendered as TEXT and never as markup: it
          is uncontrolled third-party content. */}
      {snapshot?.note ? (
        <p
          className="flex items-start gap-2 px-4 py-2.5 font-body"
          style={{
            fontSize: 12.5,
            borderBottom: '1px solid var(--color-border)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text-secondary)',
          }}
        >
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{snapshot.note}</span>
        </p>
      ) : null}

      {snapshot?.data ? (
        children
      ) : (
        <div className="px-4 py-6">
          <EmptyState
            icon={Icon}
            title={emptyTitle || 'Nothing collected yet'}
            description={
              emptyDescription ||
              'This section fills in the next time the connector runs. Nothing is fetched when you open the tab — the quota is shared across the whole workspace.'
            }
          />
        </div>
      )}
    </section>
  );
};

/**
 * One headline number.
 *
 * `formatNumber` renders a null as an em dash rather than a zero, and the
 * distinction is load-bearing everywhere it appears: "this domain has no
 * backlinks" and "we could not find the backlinks field in an undocumented
 * payload" look identical as a 0 and mean opposite things.
 */
export const Stat = ({ label, value, sub }) => (
  <div className="min-w-0">
    <p
      className="font-body"
      style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-muted)' }}
    >
      {label}
    </p>
    <p
      className="font-display font-semibold mt-0.5 truncate"
      style={{ fontSize: 20, color: 'var(--color-text-primary)' }}
    >
      {value}
    </p>
    {sub ? (
      <p className="font-body mt-0.5 truncate" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
        {sub}
      </p>
    ) : null}
  </div>
);

/** A row of stats that reflows rather than scrolling. */
export const StatRow = ({ children }) => (
  <div
    className="grid gap-4 px-4 py-4"
    style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}
  >
    {children}
  </div>
);

/**
 * A table that scrolls INSIDE its own box.
 *
 * Tracked-keyword tables are five or six columns wide and these boards are read
 * on tablets. Without this the page body scrolls sideways and the tab bar goes
 * with it.
 */
export const ScrollTable = ({ children, maxHeight = 420 }) => (
  <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight }}>{children}</div>
);

export const Th = ({ children, align = 'left', width }) => (
  <th
    className="font-body font-medium"
    style={{
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      color: 'var(--color-text-muted)',
      textAlign: align,
      padding: '8px 12px',
      position: 'sticky',
      top: 0,
      background: 'var(--color-bg-subtle)',
      borderBottom: '1px solid var(--color-border)',
      whiteSpace: 'nowrap',
      width,
    }}
  >
    {children}
  </th>
);

export const Td = ({ children, align = 'left', muted = false, title }) => (
  <td
    className="font-body"
    style={{
      fontSize: 13,
      color: muted ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
      textAlign: align,
      padding: '8px 12px',
      borderBottom: '1px solid var(--color-border)',
      whiteSpace: 'nowrap',
    }}
    title={title}
  >
    {children}
  </td>
);

export default SectionShell;

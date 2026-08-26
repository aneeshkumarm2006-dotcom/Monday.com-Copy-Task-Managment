import { Plug, Sparkles } from 'lucide-react';
import { formatNumber } from '../../../utils/connectorFormat';

/**
 * The connector's presence on one goal row.
 *
 * Two things, both small, both in the goal's own name cell rather than in a
 * column of their own:
 *
 *   THE LINK      — which keyword this row is about. Silent when there is none,
 *                   because most boards will have rows that are nobody's
 *                   keyword and a permanent "not linked" on every one of them is
 *                   furniture, not information. Same rule as the group owner on
 *                   the section header above it.
 *
 *   THE OFFER     — "Ubersuggest says 1,400 — accept?". This is the visible half
 *                   of the ownership rule: once a human has edited a cell, the
 *                   connector stops writing to it and says what it would have
 *                   said instead. Without this the rule would be invisible and
 *                   would read as the sync having quietly stopped working.
 *
 * ---- Why there is no new column --------------------------------------------
 *
 * `goalGrid.js` is already fighting for horizontal room — three extra columns at
 * the old widths pushed Start/Target/Actual off a 1280px screen. A connector
 * column would be a permanent tax on every board for something most rows have
 * nothing to say about, so this rides in the frozen name cell and truncates.
 */

/** A value as the row should read it. Numbers get separators; text is left alone. */
const readValue = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
};

const chipBase = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  fontSize: 10.5,
  lineHeight: 1.4,
  padding: '1px 6px',
  borderRadius: 999,
  maxWidth: '100%',
  minWidth: 0,
};

const GoalConnectorChip = ({
  link,
  /** May this person accept a value into this row? `goal.track`, at least. */
  canAccept = false,
  accepting = false,
  onAccept,
}) => {
  if (!link) return null;

  const suggestions = Object.entries(link.suggested || {});
  const subject = link.keyword || 'whole project';

  // Every outstanding offer, named in full, in the tooltip. The pill itself has
  // room for one number and a board can have four.
  const offerTitle = suggestions
    .map(([key, s]) => `${s.targetLabel || s.fieldLabel || key}: ${readValue(s.value)}`)
    .join('\n');

  return (
    <span className="flex items-center gap-1 min-w-0 w-full">
      <span
        className="truncate"
        style={{
          ...chipBase,
          background: 'var(--color-bg-subtle)',
          color: 'var(--color-text-muted)',
        }}
        title={[
          `Linked to ${subject}`,
          link.lastSyncAt ? `Last checked ${new Date(link.lastSyncAt).toLocaleString()}` : 'Not synced yet',
          link.autoFill ? '' : 'This row never fills itself — values are offered, not written.',
          link.lastNote || '',
        ]
          .filter(Boolean)
          .join('\n')}
      >
        <Plug size={9} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{subject}</span>
      </span>

      {suggestions.length > 0 && (
        canAccept ? (
          <button
            type="button"
            onClick={onAccept}
            disabled={accepting}
            title={`${offerTitle}\n\nYou edited these by hand, so the connector left them alone. Click to take its numbers instead.`}
            className="shrink-0"
            style={{
              ...chipBase,
              cursor: accepting ? 'default' : 'pointer',
              background: 'var(--color-warning-light, #FEF3C7)',
              color: 'var(--color-warning-text, #92400E)',
              fontWeight: 600,
            }}
          >
            <Sparkles size={9} aria-hidden="true" className="shrink-0" />
            {accepting
              ? 'Accepting…'
              : suggestions.length === 1
                ? `${readValue(suggestions[0][1].value)}?`
                : `${suggestions.length} updates`}
          </button>
        ) : (
          <span
            className="shrink-0"
            style={{
              ...chipBase,
              background: 'var(--color-warning-light, #FEF3C7)',
              color: 'var(--color-warning-text, #92400E)',
            }}
            title={`${offerTitle}\n\nSomebody with permission to fill in goals can accept these.`}
          >
            <Sparkles size={9} aria-hidden="true" className="shrink-0" />
            {suggestions.length}
          </span>
        )
      )}
    </span>
  );
};

export default GoalConnectorChip;

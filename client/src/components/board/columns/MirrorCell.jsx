import { useEffect, useMemo, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { cellWrapperStyle } from './cellShared';
import AnchoredPopover from '../../ui/AnchoredPopover';
import useBoardStore from '../../../store/boardStore';
import useMoney from '../../../hooks/useMoney';

/**
 * MirrorCell — read-only badge showing a `mirror` column's computed value.
 *
 * The value is computed server-side from the rows the sibling `connect_boards`
 * column points at, so the cell fetches it via `boardStore.mirrorValue` on
 * mount and whenever the source links change. The initial `value` prop (the
 * embedded value from the task list, or a cache wrapper) renders instantly to
 * avoid a flash. Clicking opens a small detail panel describing the source —
 * an `AnchoredPopover` (portal, `position: fixed`), because an absolutely
 * positioned panel inside the Table's scroll wrapper was cut off on a short
 * group.
 */

const unwrap = (value) => {
  if (value && typeof value === 'object' && value.__mirror === true) return value.value;
  return value;
};

/**
 * The mirrored value as text.
 *
 * A NUMBER goes through the column's format like any number column's figure —
 * `money.column` renders a currency-format mirror in its unit (and converts it
 * for a reader who chose a display currency) and a plain one as a grouped
 * number. It used to be `String(value)`: a mirrored sum of 540000 read
 * "540000" beside a source column reading "CA$540,000", while the footer under
 * it said "₹5,40,000". Text, lists and empties are unchanged.
 *
 * `on` and `currency` are the optional `NumberCell` props: the record's day
 * for the rate, and the board's currency for a column with no code.
 */
const displayString = (value, format) => {
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'number' && Number.isFinite(value)) return format(value) || '—';
  return String(value);
};

const MirrorCell = ({ value, column, task, on = null, currency = null }) => {
  const mirrorValueAction = useBoardStore((s) => s.mirrorValue);
  const money = useMoney();
  const [display, setDisplay] = useState(() => unwrap(value));
  // The trigger the detail panel hangs off, or null while it is closed.
  const [anchor, setAnchor] = useState(null);

  const settings = column.settings || {};
  const sourceConnectColumnId = settings.sourceConnectColumnId
    ? settings.sourceConnectColumnId.toString()
    : null;
  const aggregation = settings.aggregation || 'first';

  // Linked source rows on this task, read from the sibling connect column —
  // used both to count sources and to re-fetch when links change.
  const links = useMemo(() => {
    if (!task || !task.columnValues || !sourceConnectColumnId) return [];
    const raw = task.columnValues[sourceConnectColumnId];
    return raw && Array.isArray(raw.links) ? raw.links : [];
  }, [task, sourceConnectColumnId]);
  const linksSig = useMemo(() => links.map((l) => l.taskId).join(','), [links]);

  useEffect(() => {
    setDisplay(unwrap(value));
  }, [value]);

  // Fetch the freshly computed value (server resolves aggregation over the
  // linked rows). Re-runs when the linked set changes.
  useEffect(() => {
    if (!task || !task._id) return undefined;
    let cancelled = false;
    mirrorValueAction(task._id, column._id)
      .then((v) => {
        if (!cancelled) setDisplay(v);
      })
      .catch(() => {
        /* leave the embedded value in place on failure */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task && task._id, column._id, linksSig]);

  const text = displayString(display, (n) => money.column(n, settings, on, currency));
  const isEmpty = text === '—';

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div
        style={{ ...cellWrapperStyle, gap: 6, cursor: 'pointer' }}
        onClick={(e) => {
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
        title="Mirrored value — click for source"
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
      >
        <GitBranch size={12} color="var(--color-text-muted)" aria-hidden="true" style={{ flexShrink: 0 }} />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: isEmpty ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
          }}
        >
          {text}
        </span>
      </div>

      {anchor && (
        <AnchoredPopover
          anchorEl={anchor}
          onClose={() => setAnchor(null)}
          minWidth={220}
          padding={12}
          ariaLabel={`${column.name || 'Mirror'} — source`}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--color-text-muted)',
              marginBottom: 6,
            }}
          >
            Mirrored value
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
            {text}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            Aggregation: <strong>{aggregation}</strong>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            Source: {links.length} linked {links.length === 1 ? 'row' : 'rows'}
          </div>
        </AnchoredPopover>
      )}
    </div>
  );
};

export default MirrorCell;

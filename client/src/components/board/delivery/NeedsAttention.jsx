import { useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { MiniChip } from '../../ui/FilterControls';

/**
 * The bottom list: which clients are actually in trouble, and on which tracker.
 *
 * The heatmap answers "what happened"; this answers "what do I do about it",
 * which is the thing somebody opening the tab at 9am actually wants. Sorted
 * worst-first and capped, because a list nobody can act on is decoration.
 */

const VISIBLE = 6;

const buildAttention = (trackers = [], periodsById = new Map()) => {
  const items = [];
  for (const tracker of trackers) {
    if (!tracker.enabled) continue;
    const periods = periodsById.get(String(tracker._id)) || tracker.periods || [];
    for (const row of tracker.rows || []) {
      if (row.summary.missed === 0) continue;
      const missedPeriods = row.cells
        .map((cell, i) => (cell.s === 'missed' ? periods[i] : null))
        .filter(Boolean);
      items.push({
        key: `${tracker._id}:${row.groupId}`,
        trackerId: tracker._id,
        trackerName: tracker.name,
        groupId: row.groupId,
        groupName: row.groupName,
        missed: row.summary.missed,
        required: row.summary.required,
        missedPeriods,
      });
    }
  }
  return items.sort((a, b) => b.missed - a.missed);
};

const NeedsAttention = ({ trackers, onJump }) => {
  const [expanded, setExpanded] = useState(false);
  const items = buildAttention(trackers);
  const shown = expanded ? items : items.slice(0, VISIBLE);

  return (
    <section
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: 20,
      }}
    >
      <h3
        className="font-display font-semibold"
        style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
      >
        Needs attention
      </h3>

      {items.length === 0 ? (
        <p
          className="font-body inline-flex items-center gap-2 mt-3"
          style={{ fontSize: 13, color: 'var(--color-status-done)' }}
        >
          <Check size={15} strokeWidth={3} aria-hidden="true" />
          Everything on time. Nothing needs attention.
        </p>
      ) : (
        <>
          <ul className="flex flex-col mt-3">
            {shown.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => onJump?.(item)}
                  className="w-full flex items-center gap-3 text-left transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                  style={{
                    padding: '10px 8px',
                    borderRadius: 'var(--radius-sm)',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className="font-body font-semibold block truncate"
                      style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                    >
                      {item.groupName}
                    </span>
                    <span
                      className="font-body block"
                      style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                    >
                      {item.trackerName} · missed {item.missed} of {item.required}
                    </span>
                  </span>

                  <span className="hidden sm:flex items-center gap-1.5 shrink-0">
                    {item.missedPeriods.slice(0, 3).map((p) => (
                      <MiniChip
                        key={p.key}
                        bg="var(--color-status-stuck-bg)"
                        text="var(--color-status-stuck)"
                        radius="var(--radius-sm)"
                      >
                        {p.band ? `${p.label} ${p.band}` : p.label}
                      </MiniChip>
                    ))}
                    {item.missedPeriods.length > 3 && (
                      <span
                        className="font-body"
                        style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                      >
                        +{item.missedPeriods.length - 3}
                      </span>
                    )}
                  </span>

                  <ChevronRight
                    size={15}
                    color="var(--color-text-muted)"
                    aria-hidden="true"
                    className="shrink-0"
                  />
                </button>
              </li>
            ))}
          </ul>

          {items.length > VISIBLE && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="font-body mt-2"
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-accent)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {expanded ? 'Show fewer' : `Show all ${items.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
};

export default NeedsAttention;

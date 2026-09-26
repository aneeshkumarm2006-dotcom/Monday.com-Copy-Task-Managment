import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { cellWrapperStyle, boardIdOf } from './cellShared';
import useBoardMembers from '../../../hooks/useBoardMembers';
import AnchoredPopover from '../../ui/AnchoredPopover';

/**
 * PersonCell — multi-select picker over the people on THIS BOARD. Shows
 * stacked initials chips when collapsed; opens a checklist when clicked.
 *
 * Scoped to the board, not the workspace: on a private board the org roster
 * offered people who cannot open it. The board id comes off the row's own task
 * (`task.board`), which every cell already receives — a personal task has none
 * and gets an empty picker, which is correct, since it belongs to no board and
 * nobody else can see it.
 *
 * The checklist is an `AnchoredPopover` (a portal at `position: fixed`), not an
 * absolute box inside the cell: the board grid scrolls horizontally inside an
 * `overflow: hidden` group card, and on a short group the old checklist was cut
 * off below the first name.
 *
 * `selfOnlyId` — the viewer, when they may move only THEIR OWN name (a
 * contributor: `task.edit_assigned` without `task.assign`, the self-claim
 * carve-out). Every other name stays visible but cannot be toggled. Without it
 * the whole roster was clickable and every other pick came back as "You do not
 * have permission to assign people to tasks" — a picker that mostly refuses.
 */
const PersonCell = ({ value, readOnly, onChange, task, column, selfOnlyId = null }) => {
  const [anchor, setAnchor] = useState(null);
  const wrapperRef = useRef(null);
  const members = useBoardMembers(boardIdOf(task));
  const selected = Array.isArray(value) ? value.map((v) => v.toString()) : [];

  const lockedFor = (id) => !!selfOnlyId && id !== String(selfOnlyId);

  const toggle = (id) => {
    if (lockedFor(id)) return;
    const set = new Set(selected);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange?.(Array.from(set));
  };

  const initials = (name) =>
    (name || '?')
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase();

  const names = selected
    .map((id) => members.find((m) => (m._id || m.id || '').toString() === id)?.name)
    .filter(Boolean);
  const summary = names.length ? names.join(', ') : 'nobody';

  const chips = (
    <>
      {selected.length === 0 ? (
        <span style={{ color: 'var(--color-text-muted)' }}>—</span>
      ) : (
        selected.slice(0, 4).map((id) => {
          const member = members.find((m) => (m._id || m.id || '').toString() === id);
          return (
            <span
              key={id}
              title={member?.name || id}
              aria-hidden="true"
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: 'var(--color-accent)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 600,
                marginRight: -6,
                border: '1.5px solid var(--color-bg-elevated)',
                flexShrink: 0,
              }}
            >
              {initials(member?.name)}
            </span>
          );
        })
      )}
      {selected.length > 4 && (
        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-text-secondary)' }}>
          +{selected.length - 4}
        </span>
      )}
    </>
  );

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      {readOnly ? (
        <div style={{ ...cellWrapperStyle, gap: 4 }} aria-label={`${column?.name || 'People'}: ${summary}`}>
          {chips}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAnchor((a) => (a ? null : wrapperRef.current))}
          aria-haspopup="dialog"
          aria-expanded={!!anchor}
          aria-label={`${column?.name || 'People'}: ${summary} — change`}
          className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)] focus-visible:outline-offset-[-2px]"
          style={{
            ...cellWrapperStyle,
            gap: 4,
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            textAlign: 'left',
          }}
        >
          {chips}
        </button>
      )}

      {anchor && !readOnly && (
        <AnchoredPopover
          anchorEl={anchor}
          onClose={() => setAnchor(null)}
          minWidth={220}
          maxHeight={280}
          padding={6}
          ariaLabel={`Choose ${column?.name || 'people'}`}
          initialFocus
        >
          {members.length === 0 ? (
            <div style={{ padding: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
              No members
            </div>
          ) : (
            members.map((m) => {
              const id = (m._id || m.id || '').toString();
              const checked = selected.includes(id);
              const locked = lockedFor(id);
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={checked}
                  disabled={locked}
                  title={locked ? 'Only someone who can assign people can change this' : undefined}
                  onClick={() => toggle(id)}
                  className="hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: 13,
                    background: 'transparent',
                    border: 'none',
                    cursor: locked ? 'not-allowed' : 'pointer',
                    opacity: locked ? 0.55 : 1,
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-text-primary)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: '50%',
                      background: 'var(--color-accent)',
                      color: '#fff',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10,
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    {initials(m.name)}
                  </span>
                  <span style={{ flex: 1, textAlign: 'left' }}>{m.name}</span>
                  {checked && <Check size={14} aria-hidden="true" />}
                </button>
              );
            })
          )}
        </AnchoredPopover>
      )}
    </div>
  );
};

export default PersonCell;

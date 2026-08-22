import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { cellWrapperStyle } from './cellShared';
import useBoardMembers from '../../../hooks/useBoardMembers';

/**
 * PersonCell — multi-select picker over the people on THIS BOARD. Shows
 * stacked initials chips when collapsed; opens a checklist when clicked.
 *
 * Scoped to the board, not the workspace: on a private board the org roster
 * offered people who cannot open it. The board id comes off the row's own task
 * (`task.board`), which every cell already receives — a personal task has none
 * and gets an empty picker, which is correct, since it belongs to no board and
 * nobody else can see it.
 */
const PersonCell = ({ value, readOnly, onChange, task }) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const members = useBoardMembers(task?.board?._id || task?.board);
  const selected = Array.isArray(value) ? value.map((v) => v.toString()) : [];

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e) => {
      if (wrapperRef.current && wrapperRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const toggle = (id) => {
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

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <div
        style={{ ...cellWrapperStyle, gap: 4, cursor: readOnly ? 'default' : 'pointer' }}
        onClick={() => !readOnly && setOpen((v) => !v)}
      >
        {selected.length === 0 ? (
          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
        ) : (
          selected.slice(0, 4).map((id) => {
            const member = members.find((m) => (m._id || m.id || '').toString() === id);
            return (
              <span
                key={id}
                title={member?.name || id}
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
      </div>

      {open && !readOnly && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            minWidth: 220,
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: 280,
            overflowY: 'auto',
            zIndex: 40,
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            padding: 6,
          }}
        >
          {members.length === 0 ? (
            <div style={{ padding: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
              No members
            </div>
          ) : (
            members.map((m) => {
              const id = (m._id || m.id || '').toString();
              const checked = selected.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggle(id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: 13,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-text-primary)',
                  }}
                >
                  <span
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
        </div>
      )}
    </div>
  );
};

export default PersonCell;

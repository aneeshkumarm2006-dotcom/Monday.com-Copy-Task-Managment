import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { cellWrapperStyle, optionSorted } from './cellShared';
import { getColorPair } from '../../../utils/priorityColors';

/**
 * TagsCell — multi-select over `settings.options`. Renders each selected tag
 * as a coloured chip; clicking opens a checklist popover.
 */
const TagsCell = ({ value, column, readOnly, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const options = optionSorted(column?.settings?.options);
  const selected = Array.isArray(value) ? value.map((v) => v.toString()) : [];

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
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

  const chip = (label, color) => {
    const pair = getColorPair(color);
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '2px 8px',
          fontSize: 11,
          fontWeight: 500,
          color: pair.text,
          background: pair.bg,
          borderRadius: 'var(--radius-full)',
          marginRight: 4,
        }}
      >
        {label}
      </span>
    );
  };

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <div
        style={{ ...cellWrapperStyle, flexWrap: 'wrap', gap: 4, cursor: readOnly ? 'default' : 'pointer' }}
        onClick={() => !readOnly && setOpen((v) => !v)}
      >
        {selected.length === 0 ? (
          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
        ) : (
          selected.map((id) => {
            const opt = options.find((o) => o.id.toString() === id);
            if (!opt) return null;
            return <span key={id}>{chip(opt.label, opt.color)}</span>;
          })
        )}
      </div>
      {open && !readOnly && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            minWidth: 200,
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
          {options.map((opt) => {
            const checked = selected.includes(opt.id.toString());
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => toggle(opt.id.toString())}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: 12,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <span style={{ flex: 1, textAlign: 'left' }}>
                  {chip(opt.label, opt.color)}
                </span>
                {checked && <Check size={14} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TagsCell;

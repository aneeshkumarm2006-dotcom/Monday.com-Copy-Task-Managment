import { useEffect, useRef, useState } from 'react';
import { cellWrapperStyle, optionSorted, findOption } from './cellShared';
import { getColorPair } from '../../../utils/priorityColors';

/**
 * StatusCell — renders the selected option as a coloured chip. Clicking
 * opens a popover listing every configured option.
 */
const StatusCell = ({ value, column, readOnly, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const options = optionSorted(column?.settings?.options);
  const selected = findOption(options, value);

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const chip = (label, color) => {
    const pair = getColorPair(color);
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '3px 10px',
          fontSize: 12,
          fontWeight: 500,
          color: pair.text,
          background: pair.bg,
          borderRadius: 'var(--radius-full)',
        }}
      >
        {label}
      </span>
    );
  };

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <div
        style={{ ...cellWrapperStyle, cursor: readOnly ? 'default' : 'pointer' }}
        onClick={() => !readOnly && setOpen((v) => !v)}
      >
        {selected ? chip(selected.label, selected.color) : (
          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
        )}
      </div>
      {open && !readOnly && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            minWidth: 180,
            maxWidth: 'calc(100vw - 24px)',
            zIndex: 40,
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            padding: 6,
          }}
        >
          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                onChange?.(opt.id);
                setOpen(false);
              }}
              style={{
                display: 'block',
                width: '100%',
                margin: '2px 0',
                padding: '6px 8px',
                fontSize: 12,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {chip(opt.label, opt.color)}
            </button>
          ))}
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange?.(null);
                setOpen(false);
              }}
              style={{
                display: 'block',
                width: '100%',
                marginTop: 6,
                padding: '6px 8px',
                fontSize: 11,
                background: 'transparent',
                border: 'none',
                borderTop: '1px solid var(--color-border)',
                cursor: 'pointer',
                color: 'var(--color-text-muted)',
                textAlign: 'left',
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default StatusCell;

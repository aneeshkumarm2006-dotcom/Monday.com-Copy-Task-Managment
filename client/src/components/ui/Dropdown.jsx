import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import useDropdownPosition from '../../utils/useDropdownPosition';

/**
 * Dropdown — styled select with custom panel matching input styling.
 * See Macan_Design.md Section 6.6.
 *
 * Props:
 *   options: Array<{ value: string, label: string, icon?: ReactNode }>
 *   value:   currently selected value
 *   onChange: (newValue) => void
 *   placeholder: string
 *   disabled: bool
 *   label: optional VISIBLE label above trigger
 *   ariaLabel: accessible name when there is no visible label (row/toolbar use)
 */

const Dropdown = ({
  options = [],
  value,
  onChange,
  placeholder = 'Select…',
  disabled = false,
  label,
  ariaLabel,
  className = '',
  size = 'default', // 'default' (38px) | 'sm' (32px)
}) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const selected = options.find((opt) => opt.value === value) || null;
  const { top, left, width, openUpward } = useDropdownPosition(triggerRef, open);

  // Click outside / Escape closes. The menu is portaled to body, so we have to
  // check both the in-DOM wrapper AND the portaled menu node.
  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (e) => {
      if (wrapperRef.current && wrapperRef.current.contains(e.target)) return;
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const triggerHeight = size === 'sm' ? 32 : 38;

  return (
    <div
      ref={wrapperRef}
      className={['relative w-full', className].filter(Boolean).join(' ')}
    >
      {label && (
        <label className="block mb-2 font-body font-medium text-[color:var(--color-text-secondary)] text-xs uppercase tracking-wide">
          {label}
        </label>
      )}

      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        // For dropdowns that sit in a row or a toolbar, where a visible `label`
        // above the trigger would be repeated on every line. Omitted when a
        // visible label is already naming this control.
        aria-label={!label && ariaLabel ? ariaLabel : undefined}
        className={[
          'w-full flex items-center justify-between gap-2 px-3 font-body text-[14px]',
          'bg-[color:var(--color-bg-input)] transition-[border-color,box-shadow,background-color] duration-150 ease-in-out',
          'focus:outline-none focus:bg-white',
          'disabled:opacity-60 disabled:cursor-not-allowed',
          // Mobile tap target for non-compact dropdowns; desktop unchanged.
          size !== 'sm' ? 'min-h-[44px] md:min-h-0' : '',
        ].filter(Boolean).join(' ')}
        style={{
          height: triggerHeight,
          border: open
            ? '1.5px solid var(--color-accent)'
            : '1.5px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: open ? '0 0 0 3px rgba(37, 99, 235, 0.12)' : 'none',
          color: selected
            ? 'var(--color-text-primary)'
            : 'var(--color-text-muted)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <span className="truncate text-left flex-1">
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          size={16}
          color="var(--color-text-secondary)"
          aria-hidden="true"
          style={{
            transition: 'transform 150ms ease-in-out',
            transform: open ? 'rotate(180deg)' : 'rotate(0)',
          }}
        />
      </button>

      {open && createPortal(
        <ul
          ref={menuRef}
          role="listbox"
          className="bg-white overflow-auto"
          style={{
            position: 'fixed',
            top,
            left,
            width,
            maxWidth: 'calc(100vw - 32px)',
            zIndex: 60,
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            maxHeight: 260,
            padding: 4,
            animation: openUpward
              ? 'macan-dropdown-enter-up 150ms ease-out'
              : 'macan-dropdown-enter 150ms ease-out',
          }}
        >
          {options.length === 0 && (
            <li
              className="px-3 py-2 font-body text-sm"
              style={{ color: 'var(--color-text-muted)' }}
            >
              No options
            </li>
          )}
          {options.map((opt) => {
            const isSelected = opt.value === value;
            // Per-option `disabled` is optional: an option that does not set it
            // behaves exactly as before. It exists so a choice that is
            // unavailable for a REASON can still be shown — a group already
            // mapped to another connector project, say — instead of silently
            // vanishing from the list and leaving the user to wonder.
            const isDisabled = !!opt.disabled;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                aria-disabled={isDisabled || undefined}
              >
                <button
                  type="button"
                  disabled={isDisabled}
                  onClick={() => {
                    if (isDisabled) return;
                    onChange?.(opt.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={[
                    'w-full flex items-center gap-2 px-3 text-left font-body text-[14px]',
                    'transition-colors duration-100',
                    isDisabled ? '' : 'hover:bg-[color:var(--color-bg-subtle)]',
                    'focus:outline-none focus:bg-[color:var(--color-bg-subtle)]',
                  ].join(' ')}
                  style={{
                    height: 36,
                    borderRadius: 'var(--radius-sm)',
                    color: isDisabled
                      ? 'var(--color-text-muted)'
                      : isSelected
                        ? 'var(--color-accent-text)'
                        : 'var(--color-text-primary)',
                    fontWeight: isSelected ? 500 : 400,
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 9999,
                      background: isSelected
                        ? 'var(--color-accent)'
                        : 'transparent',
                    }}
                  />
                  {opt.icon ? <span className="shrink-0">{opt.icon}</span> : null}
                  <span className="flex-1 truncate">{opt.label}</span>
                  {isSelected && (
                    <Check
                      size={14}
                      color="var(--color-accent)"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>,
        document.body
      )}

      <style>{`
        @keyframes macan-dropdown-enter {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes macan-dropdown-enter-up {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

export default Dropdown;

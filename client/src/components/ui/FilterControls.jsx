import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';

/**
 * Shared filter UI primitives.
 *
 * These were originally defined inside BoardFilterBar; they're extracted here
 * so every filter toolbar (board view, My Work, …) renders the same popover
 * pills, checkbox rows, and mini chips from a single source of truth.
 */

/**
 * FilterPopover — a pill button that toggles a dropdown panel. Highlights and
 * badges itself when its category has active selections. Closes on outside
 * click / Escape.
 */
export const FilterPopover = ({ label, icon: Icon, activeCount = 0, children }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const isActive = activeCount > 0;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 font-body transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          height: 34,
          padding: '0 10px',
          fontSize: 13,
          fontWeight: 500,
          color: isActive ? 'var(--color-accent)' : 'var(--color-text-primary)',
          background: isActive ? 'var(--color-accent-light)' : 'var(--color-bg-surface, #FFFFFF)',
          border: `1.5px solid ${isActive ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
          borderRadius: 'var(--radius-md)',
          cursor: 'pointer',
        }}
      >
        {Icon && <Icon size={14} aria-hidden="true" />}
        {label}
        {isActive && (
          <span
            className="inline-flex items-center justify-center font-body font-semibold"
            style={{
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              fontSize: 10,
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-accent)',
              color: '#FFFFFF',
            }}
          >
            {activeCount}
          </span>
        )}
        <ChevronDown
          size={14}
          aria-hidden="true"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={`${label} filter options`}
          className="bg-white"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 50,
            minWidth: 220,
            maxWidth: 'min(280px, calc(100vw - 24px))',
            maxHeight: 320,
            overflowY: 'auto',
            padding: 6,
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            animation: 'macan-dropdown-enter 150ms ease-out',
          }}
        >
          {children}
        </div>
      )}

      <style>{`
        @keyframes macan-dropdown-enter {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

export const OptionList = ({ children, emptyLabel }) => {
  const hasChildren = Array.isArray(children)
    ? children.some(Boolean)
    : Boolean(children);
  if (!hasChildren) {
    return (
      <p
        className="font-body text-center"
        style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '12px 8px' }}
      >
        {emptyLabel || 'No options'}
      </p>
    );
  }
  return children;
};

export const OptionRow = ({ checked = false, onToggle, children }) => (
  <button
    type="button"
    role="option"
    aria-selected={checked}
    onClick={onToggle}
    className="w-full flex items-center gap-2 text-left transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      margin: '2px 0',
      padding: '6px 8px',
      borderRadius: 'var(--radius-sm)',
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
    }}
  >
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center shrink-0"
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        border: `1.5px solid ${checked ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
        background: checked ? 'var(--color-accent)' : 'transparent',
        color: '#FFFFFF',
      }}
    >
      {checked && <Check size={12} strokeWidth={3} />}
    </span>
    <span className="flex-1 min-w-0">{children}</span>
  </button>
);

export const MiniChip = ({ bg, text, radius = 'var(--radius-full)', children }) => (
  <span
    className="inline-flex items-center font-body font-medium"
    style={{
      fontSize: 12,
      padding: '3px 10px',
      borderRadius: radius,
      backgroundColor: bg,
      color: text,
      lineHeight: 1.2,
    }}
  >
    {children}
  </span>
);

import { useEffect, useRef, useState } from 'react';
import {
  SlidersHorizontal,
  ChevronDown,
  X,
  Globe,
  Lock,
  CircleDot,
  User,
  Calendar,
} from 'lucide-react';
import { OptionRow } from '../ui/FilterControls';
import { toggleValue } from '../../utils/taskFilters';
import {
  EMPTY_BOARD_FILTERS,
  VISIBILITY_OPTIONS,
  PROGRESS_OPTIONS,
  OWNERSHIP_OPTIONS,
  UPDATED_OPTIONS,
  countActiveBoardFilters,
} from '../../utils/boardFilters';

/**
 * BoardFilterPanel — the "Filter" button on My Boards, opening a SINGLE popup
 * that holds every board filter category (visibility, progress, ownership,
 * last updated) as one panel, rather than a row of per-category pills.
 *
 * Stateless w.r.t. the result: it only edits `filters` via `onChange`; the
 * page owns the state and applies it (see utils/boardFilters.js).
 *
 * Props:
 *   filters      — current filter state (shape: EMPTY_BOARD_FILTERS)
 *   onChange     — (nextFilters) => void
 *   matchedCount — boards currently passing the filters
 *   totalCount   — total boards in the org
 */
const SECTIONS = [
  { key: 'visibility', label: 'Visibility', icon: null, options: VISIBILITY_OPTIONS },
  { key: 'progress', label: 'Progress', icon: CircleDot, options: PROGRESS_OPTIONS },
  { key: 'ownership', label: 'Ownership', icon: User, options: OWNERSHIP_OPTIONS },
  { key: 'updated', label: 'Last updated', icon: Calendar, options: UPDATED_OPTIONS },
];

const VisibilityLabel = ({ optionKey, label }) => {
  const isPublic = optionKey === 'public';
  const Icon = isPublic ? Globe : Lock;
  return (
    <span
      className="inline-flex items-center gap-1 font-body font-medium"
      style={{
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 'var(--radius-full)',
        background: isPublic ? 'var(--color-status-done-bg)' : '#FFF0F0',
        color: isPublic ? 'var(--color-status-done)' : '#DC2626',
      }}
    >
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
};

const BoardFilterPanel = ({
  filters,
  onChange,
  matchedCount = 0,
  totalCount = 0,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const activeCount = countActiveBoardFilters(filters);
  const isActive = activeCount > 0;

  const set = (patch) => onChange?.({ ...filters, ...patch });
  const toggle = (category, value) =>
    set({ [category]: toggleValue(filters[category], value) });

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
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex items-center justify-center gap-2 font-body transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          height: 38,
          padding: '0 16px',
          fontSize: 14,
          fontWeight: 500,
          color: isActive ? 'var(--color-accent)' : 'var(--color-text-primary)',
          background: isActive ? 'var(--color-accent-light)' : 'transparent',
          border: `1.5px solid ${isActive ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
          borderRadius: 'var(--radius-md)',
          cursor: 'pointer',
        }}
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
        Filter
        {isActive && (
          <span
            className="inline-flex items-center justify-center font-body font-semibold"
            style={{
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              fontSize: 11,
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-accent)',
              color: '#FFFFFF',
            }}
          >
            {activeCount}
          </span>
        )}
        <ChevronDown
          size={15}
          aria-hidden="true"
          style={{
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 150ms ease',
          }}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter boards"
          className="bg-white"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 50,
            width: 'min(300px, calc(100vw - 24px))',
            maxHeight: 'min(70vh, 460px)',
            overflowY: 'auto',
            padding: 8,
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            animation: 'macan-dropdown-enter 150ms ease-out',
          }}
        >
          {/* Header: title + clear all */}
          <div
            className="flex items-center justify-between"
            style={{ padding: '4px 8px 8px' }}
          >
            <span
              className="font-display font-bold"
              style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
            >
              Filters
            </span>
            {isActive && (
              <button
                type="button"
                onClick={() => onChange?.({ ...EMPTY_BOARD_FILTERS })}
                className="inline-flex items-center gap-1 font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  padding: '3px 8px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--color-accent)',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
              >
                <X size={13} aria-hidden="true" />
                Clear all
              </button>
            )}
          </div>

          {SECTIONS.map((section, idx) => {
            const SectionIcon = section.icon;
            return (
              <div
                key={section.key}
                style={{
                  paddingTop: idx === 0 ? 0 : 8,
                  marginTop: idx === 0 ? 0 : 4,
                  borderTop:
                    idx === 0 ? 'none' : '1px solid var(--color-border)',
                }}
              >
                <div
                  className="flex items-center gap-1.5 font-body font-semibold"
                  style={{
                    padding: '4px 8px',
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {SectionIcon && <SectionIcon size={12} aria-hidden="true" />}
                  {section.label}
                </div>
                {section.options.map((opt) => (
                  <OptionRow
                    key={opt.key}
                    checked={filters[section.key]?.includes(opt.key)}
                    onToggle={() => toggle(section.key, opt.key)}
                  >
                    {section.key === 'visibility' ? (
                      <VisibilityLabel optionKey={opt.key} label={opt.label} />
                    ) : (
                      <span
                        className="font-body"
                        style={{
                          fontSize: 13,
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        {opt.label}
                      </span>
                    )}
                  </OptionRow>
                ))}
              </div>
            );
          })}

          {/* Result count footer */}
          <div
            className="font-body"
            style={{
              marginTop: 8,
              padding: '8px',
              borderTop: '1px solid var(--color-border)',
              fontSize: 12,
              color: 'var(--color-text-muted)',
              textAlign: 'center',
            }}
          >
            {isActive
              ? `${matchedCount} of ${totalCount} ${
                  totalCount === 1 ? 'board' : 'boards'
                }`
              : `${totalCount} ${totalCount === 1 ? 'board' : 'boards'}`}
          </div>
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

export default BoardFilterPanel;

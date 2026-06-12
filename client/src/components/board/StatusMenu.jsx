import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings as SettingsIcon, Check } from 'lucide-react';
import { getColorPair, STATUS_COLORS } from '../../utils/priorityColors';

const VIEWPORT_MARGIN = 16;

/**
 * StatusMenu — small popover menu anchored to a status chip.
 *
 * Reads the chip set from the board doc passed in via `board.statuses`. Falls
 * back to the legacy 4-status enum when no board (e.g. personal task lists)
 * is provided. Selecting a chip calls `onSelect(statusId)` — the id is the
 * `_id` of the matching `board.statuses` subdoc for board tasks, or one of
 * the legacy enum keys (`done`, `working_on_it`, `stuck`, `not_started`)
 * for personal tasks.
 *
 * Props:
 *   anchorEl    — DOM element the menu is anchored to
 *   board       — current board doc (may be null for personal task contexts)
 *   value       — currently selected status id (or legacy enum key)
 *   onSelect    — (newStatusId) => void
 *   onEditChips — optional: () => void  shows an "Edit Statuses" button
 *   onClose     — () => void
 */
const LEGACY_STATUS_ORDER = ['not_started', 'working_on_it', 'done', 'stuck'];

const StatusMenu = ({ anchorEl, board, value, onSelect, onEditChips, onClose }) => {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ top: 0, left: 0, openUpward: false });

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      if (anchorEl && anchorEl.contains(e.target)) return;
      onClose?.();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [anchorEl, onClose]);

  // Build the rendered list. Board path: read board.statuses in `order` order
  // and emit { id, bg, text, label }. Legacy path: use STATUS_COLORS.
  const options = useMemo(() => {
    if (board && Array.isArray(board.statuses) && board.statuses.length > 0) {
      return [...board.statuses]
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((s) => {
          const pair = getColorPair(s.color);
          return { id: s._id, label: s.name, bg: pair.bg, text: pair.text };
        });
    }
    return LEGACY_STATUS_ORDER.map((key) => ({
      id: key,
      label: STATUS_COLORS[key].label,
      bg: STATUS_COLORS[key].bg,
      text: STATUS_COLORS[key].text,
    }));
  }, [board]);

  useLayoutEffect(() => {
    if (!anchorEl) return undefined;
    const compute = () => {
      const r = anchorEl.getBoundingClientRect();
      const menuH = menuRef.current?.offsetHeight || 0;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUpward = menuH > 0 && spaceBelow < menuH + VIEWPORT_MARGIN && r.top > spaceBelow;
      const top = openUpward ? Math.max(VIEWPORT_MARGIN, r.top - menuH - 6) : r.bottom + 6;
      // Clamp left so the menu can't overflow the right edge on small screens
      // (no-op on desktop where the anchored position already fits).
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(r.left, window.innerWidth - 180 - VIEWPORT_MARGIN)
      );
      setPosition({ top, left, openUpward });
    };
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [anchorEl, options.length]);

  if (!anchorEl) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="listbox"
      className="fixed bg-white"
      style={{
        top: position.top,
        left: position.left,
        zIndex: 200,
        minWidth: 180,
        padding: 6,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        animation: position.openUpward
          ? 'macan-dropdown-enter-up 150ms ease-out'
          : 'macan-dropdown-enter 150ms ease-out',
      }}
    >
      {options.map((opt) => {
        const isSelected = value != null && value.toString() === opt.id.toString();
        return (
          <button
            key={opt.id}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => onSelect?.(opt.id)}
            className="w-full flex items-center gap-2 text-left transition-opacity duration-150 hover:opacity-90 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              margin: '2px 0',
              padding: '6px 8px',
              borderRadius: 'var(--radius-sm)',
              background: isSelected ? 'var(--color-bg-subtle)' : 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <span
              className="inline-flex items-center font-body font-medium"
              style={{
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: opt.bg,
                color: opt.text,
                flex: 1,
                lineHeight: 1.2,
              }}
            >
              {opt.label}
            </span>
            <span
              aria-hidden="true"
              className="inline-flex items-center justify-center"
              style={{
                width: 16,
                height: 16,
                color: isSelected ? 'var(--color-accent)' : 'var(--color-text-muted)',
                opacity: isSelected ? 1 : 0.25,
              }}
            >
              <Check size={14} />
            </span>
          </button>
        );
      })}
      {onEditChips && (
        <button
          type="button"
          onClick={onEditChips}
          className="w-full flex items-center gap-2 font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            marginTop: 6,
            padding: '6px 10px',
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--color-text-secondary)',
            background: 'transparent',
            border: 'none',
            borderTop: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}
        >
          <SettingsIcon size={12} aria-hidden="true" />
          Edit Statuses
        </button>
      )}
      <style>{`
        @keyframes macan-dropdown-enter {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes macan-dropdown-enter-up {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>,
    document.body
  );
};

export default StatusMenu;

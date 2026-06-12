import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { PRIORITY_COLORS } from '../../utils/priorityColors';

const VIEWPORT_MARGIN = 16;

/**
 * PriorityMenu — small popover menu anchored to a priority chip.
 *
 * Opens when a user clicks a priority chip on a task row. Renders the four
 * priority options as chip-styled buttons. Selecting one calls onSelect
 * with the new priority key. Clicks outside / Escape close the menu.
 *
 * Props:
 *   anchorEl — DOM element the menu is anchored to (for positioning)
 *   value    — currently selected priority key (or null)
 *   onSelect — (newPriority) => void
 *   onClose  — () => void
 */
const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];

const PriorityMenu = ({ anchorEl, value, onSelect, onClose }) => {
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
  }, [anchorEl]);

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
      {PRIORITY_ORDER.map((key) => {
        const entry = PRIORITY_COLORS[key];
        const isSelected = key === value;
        return (
          <button
            key={key}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => onSelect?.(key)}
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
                backgroundColor: entry.bg,
                color: entry.text,
                flex: 1,
                lineHeight: 1.2,
              }}
            >
              {entry.label}
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

export default PriorityMenu;

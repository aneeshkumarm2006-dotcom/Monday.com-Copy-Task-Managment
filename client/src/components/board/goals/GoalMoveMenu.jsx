import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, ChevronsUpDown,
} from 'lucide-react';
import { availableGoalMoves } from '../../../utils/goalOrder';

/**
 * "Move this goal" — the four-item popover behind the ⇕ on a goal row.
 *
 * A menu rather than a pair of up/down arrows, and rather than drag-and-drop,
 * because of the tables this actually runs on: a group with twenty-eight
 * keywords in it. Dragging a row from the bottom of that list to the top is a
 * two-screen drag against a horizontally-scrolling grid, and clicking ▲ is
 * twenty-seven clicks. "Move to top" is one.
 *
 * The order it writes is SHARED — see `utils/goalOrder.js`. The button says so
 * in its tooltip, because a control that quietly rearranges what a colleague
 * sees ought to admit it before the click, not after. When a column sort is on,
 * the tooltip says the larger thing too: the move commits the order you are
 * looking at, for everyone.
 *
 * Positioned and dismissed exactly like `TaskActionsMenu`: portalled to body so
 * the table's `overflow-x: auto` cannot clip it, anchored to the trigger,
 * clamped to the viewport, closed by click-outside or Escape.
 */

const MENU_WIDTH = 176;
// Four 32px rows plus the panel's own 4px padding top and bottom.
const MENU_HEIGHT = 4 + (32 * 4) + 4;
const VIEWPORT_MARGIN = 8;

const ITEMS = [
  { dir: 'top', label: 'Move to top', icon: ArrowUpToLine },
  { dir: 'up', label: 'Move up', icon: ArrowUp },
  { dir: 'down', label: 'Move down', icon: ArrowDown },
  { dir: 'bottom', label: 'Move to bottom', icon: ArrowDownToLine },
];

const MenuItem = ({ icon: Icon, label, disabled, onClick }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    className="w-full flex items-center gap-2 px-2 text-left font-body text-[13px] transition-colors duration-100 enabled:hover:bg-[color:var(--color-bg-subtle)] focus:outline-none enabled:focus:bg-[color:var(--color-bg-subtle)]"
    style={{
      height: 32,
      borderRadius: 'var(--radius-sm)',
      color: 'var(--color-text-primary)',
      opacity: disabled ? 0.4 : 1,
      cursor: disabled ? 'default' : 'pointer',
    }}
  >
    <Icon size={14} aria-hidden="true" />
    <span className="flex-1 truncate">{label}</span>
  </button>
);

/**
 * Props:
 *   index, count   — where this goal sits in its group, and how many there are
 *   onMove(dir)    — 'top' | 'up' | 'down' | 'bottom'
 *   goalName       — for the trigger's accessible name
 *   sortActive     — a column sort is on, so this move also commits that order
 *   iconSize       — 14 on desktop rows, 15 on the mobile cards
 */
const GoalMoveMenu = ({
  index,
  count,
  onMove,
  goalName = 'this goal',
  sortActive = false,
  iconSize = 14,
  className = 'p-1 rounded hover:bg-[color:var(--color-bg-subtle)]',
}) => {
  const [anchor, setAnchor] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!anchor) return undefined;
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (triggerRef.current?.contains(e.target)) return;
      setAnchor(null);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Stopped here, or the board page's own Escape handlers read this as a
      // request to close the whole tab behind the menu.
      e.stopPropagation();
      setAnchor(null);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor]);

  // The table scrolls in two directions and the page scrolls behind it; a menu
  // anchored to a row that has since moved is worse than no menu.
  useEffect(() => {
    if (!anchor) return undefined;
    const close = () => setAnchor(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor]);

  const moves = availableGoalMoves(index, count);
  // The only thing that ever greys this out: a table with one row in it. A
  // column sort deliberately does NOT — see the note on `handleMove`.
  const stuck = !moves.top && !moves.down;

  const title = stuck
    ? 'Nowhere to move — this is the only goal here'
    : sortActive
      ? 'Move this goal — saves the order you are looking at, for everyone, '
        + 'and clears the sort'
      : 'Move this goal — the order everyone on the board sees';

  const rect = anchor?.getBoundingClientRect();
  const openUpward = rect
    ? window.innerHeight - rect.bottom < MENU_HEIGHT + VIEWPORT_MARGIN && rect.top > MENU_HEIGHT
    : false;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={stuck}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label={`Move ${goalName}`}
        title={title}
        onClick={(e) => setAnchor((prev) => (prev ? null : e.currentTarget))}
        className={className}
        style={{ opacity: stuck ? 0.3 : 1, cursor: stuck ? 'default' : 'pointer' }}
      >
        <ChevronsUpDown size={iconSize} color="var(--color-text-secondary)" />
      </button>

      {anchor && rect && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Move ${goalName}`}
          className="fixed bg-[color:var(--color-bg-surface)]"
          style={{
            top: openUpward ? rect.top - MENU_HEIGHT - 6 : rect.bottom + 6,
            // Right-aligned to the trigger: it lives in the frozen actions
            // column against the right edge of the table, so a left-aligned
            // menu would hang off the screen.
            left: Math.max(
              VIEWPORT_MARGIN,
              Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN)
            ),
            zIndex: 60,
            width: MENU_WIDTH,
            padding: 4,
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {ITEMS.map((item) => (
            <MenuItem
              key={item.dir}
              icon={item.icon}
              label={item.label}
              disabled={!moves[item.dir]}
              onClick={() => { setAnchor(null); onMove(item.dir); }}
            />
          ))}
        </div>,
        document.body
      )}
    </>
  );
};

export default GoalMoveMenu;

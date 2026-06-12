import { useEffect, useRef } from 'react';
import { Pencil, Trash2 } from 'lucide-react';

/**
 * TaskActionsMenu — small popover shown when the ⋯ button on a task row
 * is clicked. Exposes Edit and Delete actions. Click-outside + Escape close.
 *
 * Props:
 *   anchorEl — DOM element the menu is positioned below
 *   onEdit   — callback when Edit is clicked
 *   onDelete — callback when Delete is clicked
 *   onClose  — callback to close the menu
 */
const TaskActionsMenu = ({ anchorEl, onEdit, onDelete, onClose }) => {
  const menuRef = useRef(null);

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

  if (!anchorEl) return null;

  const rect = anchorEl.getBoundingClientRect();
  const MENU_WIDTH = 160;
  const top = rect.bottom + 6;
  // Clamp horizontally so the menu never spills past the viewport edge on
  // small screens. On desktop the anchored position is already in-bounds, so
  // Math.min/Math.max return the original value — no visual change.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, vw - MENU_WIDTH - 8));

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed bg-white"
      style={{
        top,
        left,
        zIndex: 60,
        width: MENU_WIDTH,
        padding: 4,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        animation: 'macan-dropdown-enter 150ms ease-out',
      }}
    >
      <MenuItem icon={Pencil} label="Edit" onClick={onEdit} />
      <MenuItem icon={Trash2} label="Delete" onClick={onDelete} danger />
      <style>{`
        @keyframes macan-dropdown-enter {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

const MenuItem = ({ icon: Icon, label, onClick, danger = false }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className="w-full flex items-center gap-2 px-2 text-left font-body text-[13px] transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus:bg-[color:var(--color-bg-subtle)]"
    style={{
      height: 32,
      borderRadius: 'var(--radius-sm)',
      color: danger ? '#DC2626' : 'var(--color-text-primary)',
    }}
  >
    <Icon size={14} aria-hidden="true" />
    <span className="flex-1 truncate">{label}</span>
  </button>
);

export default TaskActionsMenu;

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Filter, X } from 'lucide-react';
import useDropdownPosition from '../../utils/useDropdownPosition';
import AssigneePicker from '../board/AssigneePicker';

/**
 * CalendarFilterBar — filter chips above the calendar grid.
 *
 * See TODO_changes.md Stage 3.1 / 3.2.
 *
 * Renders two multi-select pickers that compose with AND logic upstream:
 *  - Boards: custom multi-select dropdown styled to match `Dropdown`.
 *  - Assignees: reuses `AssigneePicker` with a synthetic "Unassigned" row at
 *    the top (injected here, not inside the shared picker).
 *
 * State lives in the parent (CalendarPage) and is persisted to URL search
 * params there so navigating months / reloading keeps the filter applied.
 */

const UNASSIGNED_ID = 'unassigned';

const CalendarFilterBar = ({
  boards = [],
  members = [],
  boardFilter = [],
  onBoardFilterChange,
  assigneeFilter = [],
  onAssigneeFilterChange,
  isAdmin = false,
}) => {
  const membersWithUnassigned = useMemo(
    () => [{ _id: UNASSIGNED_ID, name: 'Unassigned' }, ...members],
    [members]
  );

  const hasActiveFilter =
    boardFilter.length > 0 || assigneeFilter.length > 0;

  const handleClearAll = () => {
    onBoardFilterChange?.([]);
    onAssigneeFilterChange?.([]);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="region"
      aria-label="Calendar filters"
    >
      <span
        className="inline-flex items-center gap-1.5 font-body font-medium"
        style={{
          fontSize: 12,
          color: 'var(--color-text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginRight: 4,
        }}
      >
        <Filter size={13} aria-hidden="true" />
        Filter
      </span>

      <BoardMultiSelect
        boards={boards}
        value={boardFilter}
        onChange={onBoardFilterChange}
      />

      <div className="w-full sm:w-[200px]">
        <AssigneePicker
          members={membersWithUnassigned}
          value={assigneeFilter}
          onChange={onAssigneeFilterChange}
          isAdmin={isAdmin}
        />
      </div>

      {hasActiveFilter && (
        <button
          type="button"
          onClick={handleClearAll}
          className="inline-flex items-center gap-1 font-body transition-colors duration-150 hover:text-[color:var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            background: 'transparent',
            border: 'none',
            padding: '4px 8px',
            cursor: 'pointer',
            borderRadius: 'var(--radius-full)',
          }}
        >
          <X size={12} aria-hidden="true" />
          Clear
        </button>
      )}
    </div>
  );
};

/**
 * Multi-select dropdown for boards — visually mirrors the shared `Dropdown`
 * primitive but lets the user toggle multiple values. Rendered via portal so
 * it escapes the calendar's container overflow (same fix as Stage 1.2).
 */
const BoardMultiSelect = ({ boards = [], value = [], onChange }) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const selectedIds = new Set(value || []);
  const selectedBoards = boards.filter((b) => selectedIds.has(b._id));
  const { top, left, width, openUpward } = useDropdownPosition(triggerRef, open);

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

  const toggle = (boardId) => {
    const next = new Set(selectedIds);
    if (next.has(boardId)) next.delete(boardId);
    else next.add(boardId);
    onChange?.(Array.from(next));
  };

  const triggerLabel = (() => {
    if (selectedBoards.length === 0) return 'All boards';
    if (selectedBoards.length === 1) return selectedBoards[0].name;
    return `${selectedBoards.length} boards`;
  })();

  return (
    <div ref={wrapperRef} className="relative w-full sm:w-[200px]">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          'w-full flex items-center justify-between gap-2 px-3 font-body text-[13px]',
          'bg-[color:var(--color-bg-input)] transition-[border-color,box-shadow,background-color] duration-150 ease-in-out',
          'focus:outline-none focus:bg-white',
        ].join(' ')}
        style={{
          height: 32,
          border: open
            ? '1.5px solid var(--color-accent)'
            : '1.5px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: open ? '0 0 0 3px rgba(37, 99, 235, 0.12)' : 'none',
          color:
            selectedBoards.length > 0
              ? 'var(--color-text-primary)'
              : 'var(--color-text-muted)',
          cursor: 'pointer',
        }}
      >
        <span className="truncate text-left flex-1">{triggerLabel}</span>
        <ChevronDown
          size={14}
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
          aria-multiselectable="true"
          className="bg-white overflow-auto"
          style={{
            position: 'fixed',
            top,
            left,
            width: Math.max(width, 220),
            zIndex: 60,
            minWidth: 220,
            maxWidth: 'calc(100vw - 32px)',
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
          {boards.length === 0 && (
            <li
              className="px-3 py-2 font-body text-sm"
              style={{ color: 'var(--color-text-muted)' }}
            >
              No boards
            </li>
          )}
          {boards.map((b) => {
            const isSelected = selectedIds.has(b._id);
            return (
              <li key={b._id} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onClick={() => toggle(b._id)}
                  className={[
                    'w-full flex items-center gap-2 px-2 text-left font-body text-[13px]',
                    'transition-colors duration-100',
                    'hover:bg-[color:var(--color-bg-subtle)]',
                    'focus:outline-none focus:bg-[color:var(--color-bg-subtle)]',
                  ].join(' ')}
                  style={{
                    height: 36,
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-text-primary)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex items-center justify-center shrink-0"
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 'var(--radius-sm)',
                      border: isSelected
                        ? '1.5px solid var(--color-accent)'
                        : '1.5px solid var(--color-border-strong)',
                      background: isSelected
                        ? 'var(--color-accent)'
                        : 'transparent',
                    }}
                  >
                    {isSelected && (
                      <Check
                        size={12}
                        color="#FFFFFF"
                        strokeWidth={3}
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <span className="flex-1 truncate">{b.name}</span>
                </button>
              </li>
            );
          })}
        </ul>,
        document.body
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
    </div>
  );
};

export default CalendarFilterBar;
export { UNASSIGNED_ID };

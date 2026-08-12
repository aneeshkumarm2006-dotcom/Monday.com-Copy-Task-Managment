import { forwardRef, useEffect, useRef, useState } from 'react';
import {
  Trash2,
  FolderInput,
  X,
  ChevronDown,
  CircleDot,
  Flag,
  UserCheck,
  Check,
  CalendarArrowUp,
} from 'lucide-react';

/**
 * BulkActionBar — floating bottom-center toolbar shown when one or more
 * tasks are ticked anywhere on the board. Exposes:
 *   - Status (popover with the board's status chips)
 *   - Priority (popover with critical/high/medium/low chips)
 *   - Move to group (popover with the board's groups)
 *   - Delete (parent owns the confirm modal)
 *   - Clear selection
 *
 * Selection state lives on BoardDetailPage so this bar can aggregate ticks
 * across every group's TaskTable. The bar itself is presentational — all
 * mutations are dispatched via the props.
 *
 * Props:
 *   count            — number of selected task IDs
 *   groups           — board groups (used to populate the move-to-group menu)
 *   statusOptions    — [{ id, label, bg, text }] from board.statuses, in display order
 *   priorityOptions  — [{ key, label, bg, text }] from PRIORITY_COLORS
 *   onChangeStatus   — (statusId) => void
 *   onChangePriority — (priorityKey) => void
 *   onMoveToGroup    — (groupId) => void
 *   onAssign         — (memberIds: string[]) => void
 *   members          — [{ _id, name, profilePic }] org member list
 *   onDelete         — () => void (parent shows confirmation)
 *   onClear          — () => void
 *   busy             — disables actions while a bulk operation is in flight
 */
const BulkActionBar = ({
  count = 0,
  groups = [],
  statusOptions = [],
  priorityOptions = [],
  members = [],
  onChangeStatus,
  onChangePriority,
  onMoveToGroup,
  onMoveToMonth,
  onAssign,
  onDelete,
  onClear,
  busy = false,
}) => {
  // Only one popover open at a time. `openMenu` is one of: null, 'status',
  // 'priority', 'assign', 'move'.
  const [openMenu, setOpenMenu] = useState(null);
  const [assignSelection, setAssignSelection] = useState([]);
  const statusBtnRef = useRef(null);
  const priorityBtnRef = useRef(null);
  const assignBtnRef = useRef(null);
  const moveBtnRef = useRef(null);
  const popoverRef = useRef(null);

  useEffect(() => {
    if (!openMenu) return undefined;
    const anchors = {
      status: statusBtnRef,
      priority: priorityBtnRef,
      assign: assignBtnRef,
      move: moveBtnRef,
    };
    const handleClick = (e) => {
      if (popoverRef.current?.contains(e.target)) return;
      if (anchors[openMenu]?.current?.contains(e.target)) return;
      setOpenMenu(null);
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [openMenu]);

  const toggleMenu = (key) => {
    if (key === 'assign') setAssignSelection([]);
    setOpenMenu((prev) => (prev === key ? null : key));
  };

  if (count <= 0) return null;

  return (
    <div
      role="toolbar"
      aria-label={`Bulk actions for ${count} selected ${count === 1 ? 'task' : 'tasks'}`}
      className="fixed left-1/2 flex items-center justify-center flex-wrap font-body"
      style={{
        bottom: 24,
        transform: 'translateX(-50%)',
        // The bar is wider than a phone. It cannot scroll — the Status/Priority/
        // Assign/Move menus are absolutely positioned INSIDE it, so any overflow
        // value here would clip them — so it wraps onto a second line instead.
        maxWidth: 'calc(100vw - 16px)',
        zIndex: 70,
        background: 'var(--color-text-primary)',
        color: '#FFFFFF',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.18))',
        padding: '6px 6px 6px 16px',
        gap: 6,
        animation: 'macan-bulkbar-enter 180ms ease-out',
      }}
    >
      <span
        aria-live="polite"
        style={{ fontSize: 13, fontWeight: 600, marginRight: 4 }}
      >
        {count} selected
      </span>

      <span
        aria-hidden="true"
        style={{
          width: 1,
          height: 22,
          background: 'rgba(255,255,255,0.18)',
          marginRight: 2,
        }}
      />

      {/* Status */}
      <div style={{ position: 'relative' }}>
        <BarButton
          ref={statusBtnRef}
          icon={CircleDot}
          label="Status"
          trailing={ChevronDown}
          disabled={busy || statusOptions.length === 0}
          onClick={() => toggleMenu('status')}
          aria-haspopup="listbox"
          aria-expanded={openMenu === 'status'}
        />
        {openMenu === 'status' && (
          <ChipPopover
            ref={popoverRef}
            label="Set status for selected tasks"
            items={statusOptions}
            getKey={(opt) => opt.id}
            onPick={(opt) => {
              setOpenMenu(null);
              onChangeStatus?.(opt.id);
            }}
            emptyMessage="No statuses configured"
          />
        )}
      </div>

      {/* Priority */}
      <div style={{ position: 'relative' }}>
        <BarButton
          ref={priorityBtnRef}
          icon={Flag}
          label="Priority"
          trailing={ChevronDown}
          disabled={busy || priorityOptions.length === 0}
          onClick={() => toggleMenu('priority')}
          aria-haspopup="listbox"
          aria-expanded={openMenu === 'priority'}
        />
        {openMenu === 'priority' && (
          <ChipPopover
            ref={popoverRef}
            label="Set priority for selected tasks"
            items={priorityOptions}
            getKey={(opt) => opt.key}
            onPick={(opt) => {
              setOpenMenu(null);
              onChangePriority?.(opt.key);
            }}
            emptyMessage="No priorities available"
          />
        )}
      </div>

      {/* Assign */}
      <div style={{ position: 'relative' }}>
        <BarButton
          ref={assignBtnRef}
          icon={UserCheck}
          label="Assign"
          trailing={ChevronDown}
          disabled={busy || members.length === 0}
          onClick={() => toggleMenu('assign')}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'assign'}
        />
        {openMenu === 'assign' && (
          <MemberPopover
            ref={popoverRef}
            members={members}
            selected={assignSelection}
            onToggle={(id) =>
              setAssignSelection((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
              )
            }
            onApply={() => {
              setOpenMenu(null);
              onAssign?.(assignSelection);
            }}
          />
        )}
      </div>

      {/* Move to group */}
      <div style={{ position: 'relative' }}>
        <BarButton
          ref={moveBtnRef}
          icon={FolderInput}
          // "Move to group", not "Move to": on a monthly board there are two
          // move actions in this bar and a bare "Move to" is ambiguous.
          label="Move to group"
          trailing={ChevronDown}
          disabled={busy || groups.length === 0}
          onClick={() => toggleMenu('move')}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'move'}
        />
        {openMenu === 'move' && (
          <div
            ref={popoverRef}
            role="menu"
            aria-label="Move selected tasks to group"
            className="bg-white"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 8px)',
              left: 0,
              minWidth: 200,
              maxHeight: 280,
              overflowY: 'auto',
              padding: 4,
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-md)',
              color: 'var(--color-text-primary)',
              animation: 'macan-bulkbar-popover-enter 140ms ease-out',
            }}
          >
            {groups.length === 0 ? (
              <p
                style={{
                  padding: '8px 10px',
                  fontSize: 12,
                  color: 'var(--color-text-muted)',
                }}
              >
                No other groups available
              </p>
            ) : (
              groups.map((g) => (
                <button
                  key={g._id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenu(null);
                    onMoveToGroup?.(g._id);
                  }}
                  className="w-full text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus:bg-[color:var(--color-bg-subtle)]"
                  style={{
                    padding: '8px 10px',
                    fontSize: 13,
                    fontWeight: 500,
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                  }}
                >
                  {g.name}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Move to month (monthly boards only). Opens the same modal the row menu
          uses rather than a second popover — one month picker, one confirmation
          sentence, whether you got here from one row or twenty. */}
      {onMoveToMonth && (
        <BarButton
          icon={CalendarArrowUp}
          label="Move to month"
          disabled={busy}
          onClick={() => {
            setOpenMenu(null);
            onMoveToMonth();
          }}
        />
      )}

      <BarButton
        icon={Trash2}
        label="Delete"
        disabled={busy}
        onClick={onDelete}
        danger
      />

      <span
        aria-hidden="true"
        style={{
          width: 1,
          height: 22,
          background: 'rgba(255,255,255,0.18)',
          marginLeft: 2,
        }}
      />

      <button
        type="button"
        onClick={onClear}
        disabled={busy}
        aria-label="Clear selection"
        title="Clear selection"
        className="flex items-center justify-center transition-colors duration-150 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          width: 32,
          height: 32,
          background: 'transparent',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          color: '#FFFFFF',
          cursor: busy ? 'not-allowed' : 'pointer',
        }}
      >
        <X size={16} aria-hidden="true" />
      </button>

      <style>{`
        @keyframes macan-bulkbar-enter {
          from { opacity: 0; transform: translate(-50%, 12px); }
          to   { opacity: 1; transform: translate(-50%, 0); }
        }
        @keyframes macan-bulkbar-popover-enter {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

/**
 * MemberPopover — multi-select member list for the bulk Assign button.
 * Tracks selection locally; an Apply button confirms and fires onApply.
 */
const MemberPopover = forwardRef(function MemberPopover(
  { members, selected, onToggle, onApply },
  ref
) {
  const selectedSet = new Set(selected);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Assign members to selected tasks"
      className="bg-white"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        minWidth: 220,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        color: 'var(--color-text-primary)',
        animation: 'macan-bulkbar-popover-enter 140ms ease-out',
        overflow: 'hidden',
      }}
    >
      <ul
        role="listbox"
        aria-multiselectable="true"
        style={{ maxHeight: 240, overflowY: 'auto', padding: 4 }}
      >
        {members.length === 0 ? (
          <li style={{ padding: '8px 10px', fontSize: 12, color: 'var(--color-text-muted)' }}>
            No members
          </li>
        ) : (
          members.map((m) => {
            const isSelected = selectedSet.has(m._id);
            return (
              <li key={m._id} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onClick={() => onToggle(m._id)}
                  className="w-full flex items-center gap-2 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus:bg-[color:var(--color-bg-subtle)]"
                  style={{
                    padding: '6px 10px',
                    fontSize: 13,
                    borderRadius: 'var(--radius-sm)',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
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
                      background: isSelected ? 'var(--color-accent)' : 'transparent',
                    }}
                  >
                    {isSelected && (
                      <Check size={12} color="#FFFFFF" strokeWidth={3} aria-hidden="true" />
                    )}
                  </span>
                  <MemberAvatar user={m} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.name}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
      <div
        style={{
          padding: '6px 8px',
          borderTop: '1px solid var(--color-border)',
          display: 'flex',
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          onClick={onApply}
          disabled={selected.length === 0}
          className="transition-colors duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            padding: '5px 14px',
            fontSize: 12,
            fontWeight: 600,
            background: 'var(--color-accent)',
            color: '#FFFFFF',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            cursor: selected.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          Apply{selected.length > 0 ? ` (${selected.length})` : ''}
        </button>
      </div>
    </div>
  );
});

/** Small 24px avatar used inside MemberPopover rows. */
const MemberAvatar = ({ user }) => {
  const [imgError, setImgError] = useState(false);
  const name = user?.name || '';
  const initial = name.charAt(0).toUpperCase() || '?';
  const base = {
    width: 24,
    height: 24,
    borderRadius: '50%',
    border: '2px solid var(--color-bg-surface, #FFFFFF)',
    flexShrink: 0,
  };
  if (user?.profilePic && !imgError) {
    return (
      <img
        src={user.profilePic}
        alt={name}
        style={{ ...base, objectFit: 'cover' }}
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <span
      aria-label={name}
      className="inline-flex items-center justify-center font-body font-semibold"
      style={{
        ...base,
        background: 'var(--color-accent-light)',
        color: 'var(--color-accent-text)',
        fontSize: 10,
      }}
    >
      {initial}
    </span>
  );
};

/**
 * ChipPopover — shared chip picker used by the Status and Priority buttons.
 * Renders each option as a chip styled with its own bg/text colors so the
 * popover looks identical to the per-row StatusMenu / PriorityMenu.
 */
const ChipPopover = forwardRef(function ChipPopover(
  { label, items, getKey, onPick, emptyMessage },
  ref
) {
  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      className="bg-white"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        minWidth: 180,
        maxHeight: 280,
        overflowY: 'auto',
        padding: 6,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        color: 'var(--color-text-primary)',
        animation: 'macan-bulkbar-popover-enter 140ms ease-out',
      }}
    >
      {items.length === 0 ? (
        <p
          style={{
            padding: '8px 10px',
            fontSize: 12,
            color: 'var(--color-text-muted)',
          }}
        >
          {emptyMessage}
        </p>
      ) : (
        items.map((opt) => (
          <button
            key={getKey(opt)}
            type="button"
            role="option"
            onClick={() => onPick(opt)}
            className="w-full flex items-center text-left font-body font-medium transition-opacity duration-150 hover:opacity-90 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              margin: '2px 0',
              padding: '6px 10px',
              fontSize: 12,
              borderRadius: 'var(--radius-full)',
              backgroundColor: opt.bg,
              color: opt.text,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        ))
      )}
    </div>
  );
});

/**
 * Pill-style button used inside the dark bar. forwardRef so the Move-to
 * button can be used as a popover anchor.
 */
const BarButton = forwardRef(function BarButton(
  {
    icon: Icon,
    trailing: Trailing,
    label,
    onClick,
    disabled = false,
    danger = false,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 transition-colors duration-150 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        height: 32,
        padding: '0 12px',
        fontSize: 13,
        fontWeight: 600,
        background: 'transparent',
        color: danger ? '#FCA5A5' : '#FFFFFF',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        lineHeight: 1,
      }}
      {...rest}
    >
      {Icon && <Icon size={14} aria-hidden="true" />}
      <span>{label}</span>
      {Trailing && <Trailing size={12} aria-hidden="true" />}
    </button>
  );
});

export default BulkActionBar;

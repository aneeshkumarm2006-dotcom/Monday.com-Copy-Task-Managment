import { ChevronDown, ChevronRight, StickyNote, Trash2 } from 'lucide-react';

/**
 * TaskGroupHeader — collapsible header for a group within a board.
 *
 * Layout (left → right):
 *   [▾ chevron]  [● dot]  [GROUP NAME]  [N items]  [progress bar]
 *
 * See Macan_Design.md Section 6.8.
 *
 * Props:
 *   name          — group name
 *   colorDot      — css color for the 8px dot (cycle through accent palette)
 *   totalCount    — total tasks in group
 *   doneCount     — done tasks in group
 *   collapsed     — whether the group is currently collapsed
 *   onToggle      — called when chevron (or the header) is clicked
 */
const TaskGroupHeader = ({
  name,
  colorDot = 'var(--color-accent)',
  totalCount = 0,
  doneCount = 0,
  collapsed = false,
  onToggle,
  onDeleteGroup,
  onOpenNotes,
  noteCount = 0,
  dragHandle = null,
}) => {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const progressPct =
    totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);

  return (
    <div
      className="group/group-header flex items-center gap-3"
      style={{
        height: 48,
        padding: '0 16px',
        background: 'var(--color-bg-subtle)',
        // Match the card's top corners so the grey header curves with the
        // rounded card edge (matters while the card is overflow-visible during
        // inline editing). A collapsed group has no table below it, so its
        // bottom border would just double up the card's own border ring.
        borderTopLeftRadius: 'var(--radius-lg)',
        borderTopRightRadius: 'var(--radius-lg)',
        borderBottom: collapsed ? 'none' : '1px solid var(--color-border)',
      }}
    >
      {dragHandle}
      {/* Chevron toggle */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand group' : 'Collapse group'}
        aria-expanded={!collapsed}
        className="flex items-center justify-center rounded-sm transition-colors duration-150 hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{ width: 24, height: 24 }}
      >
        <Chevron
          size={16}
          color="var(--color-text-secondary)"
          aria-hidden="true"
        />
      </button>

      {/* Color dot */}
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: colorDot,
          flexShrink: 0,
        }}
      />

      {/* Group name */}
      <h3
        className="font-display truncate"
        style={{
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--color-text-primary)',
        }}
      >
        {name}
      </h3>

      {/* Item count badge */}
      <span
        className="inline-flex items-center font-body shrink-0"
        style={{
          fontSize: 11,
          fontWeight: 500,
          padding: '2px 8px',
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-surface, #FFFFFF)',
          color: 'var(--color-text-muted)',
          border: '1px solid var(--color-border)',
        }}
      >
        {totalCount} {totalCount === 1 ? 'item' : 'items'}
      </span>

      {/* Progress bar — hidden on small screens to save horizontal space */}
      <div
        className="shrink-0 hidden sm:block"
        role="progressbar"
        aria-valuenow={progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${doneCount} of ${totalCount} done`}
        title={`${doneCount} of ${totalCount} done`}
        style={{
          width: 80,
          height: 4,
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-border)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progressPct}%`,
            height: '100%',
            background: progressPct === 100
              ? 'var(--color-status-done)'
              : 'var(--color-accent)',
            transition: 'width 200ms ease-out',
          }}
        />
      </div>

      {/* Spacer pushes the add button to the right */}
      <div className="flex-1" />

      {/* Group notes — opens the notes side panel. Shown to everyone with read
          access; the create/edit affordances inside are gated by canEdit. */}
      {onOpenNotes && (
        <button
          type="button"
          onClick={onOpenNotes}
          aria-label={`Notes for group ${name}`}
          className="relative inline-flex items-center justify-center transition-colors duration-150 hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <StickyNote size={14} color="var(--color-text-secondary)" aria-hidden="true" />
          {noteCount > 0 && (
            <span
              aria-hidden="true"
              className="font-body"
              style={{
                position: 'absolute',
                top: -3,
                right: -3,
                minWidth: 15,
                height: 15,
                padding: '0 4px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--color-accent)',
                color: '#FFFFFF',
                fontSize: 9,
                fontWeight: 700,
                lineHeight: '15px',
                textAlign: 'center',
              }}
            >
              {noteCount > 99 ? '99+' : noteCount}
            </span>
          )}
        </button>
      )}

      {/* Delete group (admin only) */}
      {onDeleteGroup && (
        <button
          type="button"
          onClick={onDeleteGroup}
          aria-label={`Delete group ${name}`}
          className="inline-flex items-center justify-center transition-colors duration-150 hover:bg-[#FFF0F0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-status-stuck)]"
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <Trash2 size={14} color="var(--color-status-stuck)" aria-hidden="true" />
        </button>
      )}
    </div>
  );
};

export default TaskGroupHeader;

import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  StickyNote,
  Trash2,
  Link2,
  Tags,
} from 'lucide-react';
import { getColorPair } from '../../utils/priorityColors';

/** Mirrors MAX_GROUP_NAME in the server's groupController. */
const MAX_NAME_LENGTH = 60;

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
 *   onRename      — async (name) => {}; its presence shows the pencil button
 *   tags          — resolved [{ _id, name, color }] to render as chips. Empty
 *                   unless the viewer has the `groupTags` extra feature on, so
 *                   the header is byte-identical to before for everyone else.
 *   onOpenTags    — (event) => {}; its presence shows the tag button
 */
const TaskGroupHeader = ({
  name,
  colorDot = 'var(--color-accent)',
  totalCount = 0,
  doneCount = 0,
  collapsed = false,
  onToggle,
  onRename,
  onDeleteGroup,
  onOpenNotes,
  onOpenClientPortal,
  noteCount = 0,
  tags = [],
  onOpenTags,
  dragHandle = null,
}) => {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const progressPct =
    totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);

  // Cap the chips so a heavily-tagged group can't push the progress bar and the
  // action buttons off the right edge of a 48px header. The overflow count is
  // titled with the full list, so nothing becomes unreachable.
  const VISIBLE_TAGS = 3;
  const shownTags = tags.slice(0, VISIBLE_TAGS);
  const hiddenTags = tags.slice(VISIBLE_TAGS);

  // --- Inline rename ------------------------------------------------------
  // Mirrors the column-header rename in DataGrid: Enter commits, Escape
  // reverts, blur commits. `name` stays the source of truth — the draft is
  // reseeded from it whenever we're not editing, so both the optimistic store
  // update and a failed rename's rollback land correctly.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name || '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  // Enter-then-blur would otherwise fire commit twice against the same draft.
  const committingRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(name || '');
  }, [name, editing]);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.select();
  }, [editing]);

  const startRename = () => {
    setDraft(name || '');
    setEditing(true);
  };

  const commitRename = async () => {
    if (committingRef.current) return;
    const next = draft.trim();
    // Nothing to save: an empty name is a cancel, and an unchanged one needs no
    // round trip. Note a case-only change ("To Do" → "TO DO") IS a change.
    if (!next || next === name) {
      setEditing(false);
      return;
    }
    committingRef.current = true;
    setSaving(true);
    try {
      await onRename?.(next);
    } catch {
      // The caller toasts and the store rolls the name back; drop out of edit
      // mode so the header shows the restored name rather than the rejected one.
    } finally {
      committingRef.current = false;
      setSaving(false);
      setEditing(false);
    }
  };

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
      {/* Withheld while renaming so a pointer-drag on the header can't hijack
          text selection inside the input. */}
      {editing ? null : dragHandle}
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

      {/* Group name — swaps for an input while renaming. Both share the same
          typography so the row doesn't jump between the two states. */}
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          autoFocus
          disabled={saving}
          maxLength={MAX_NAME_LENGTH}
          aria-label="Group name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              commitRename();
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(false);
            }
          }}
          className="font-display"
          style={{
            // Sized for editing rather than to the old name's length, but still
            // allowed to shrink so a narrow board doesn't push the badges out.
            width: 240,
            minWidth: 0,
            maxWidth: '100%',
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: 'var(--color-text-primary)',
            background: 'var(--color-surface, #FFFFFF)',
            border: '1px solid var(--color-accent)',
            borderRadius: 'var(--radius-sm)',
            padding: '2px 6px',
            outline: 'none',
            opacity: saving ? 0.6 : 1,
          }}
        />
      ) : (
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
      )}

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

      {/* Group tag chips. Rendered only when the viewer has the `groupTags`
          extra feature on — the caller resolves the ids and passes an empty
          array otherwise, so this whole block collapses to nothing. */}
      {shownTags.length > 0 && (
        <span className="hidden md:flex items-center gap-1 shrink-0">
          {shownTags.map((tag) => {
            const pair = getColorPair(tag.color);
            return (
              <span
                key={tag._id}
                className="inline-flex items-center font-body truncate"
                title={tag.name}
                style={{
                  maxWidth: 120,
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)',
                  background: pair.bg,
                  color: pair.text,
                }}
              >
                {tag.name}
              </span>
            );
          })}
          {hiddenTags.length > 0 && (
            <span
              className="inline-flex items-center font-body"
              title={hiddenTags.map((t) => t.name).join(', ')}
              style={{
                fontSize: 11,
                fontWeight: 500,
                padding: '2px 6px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--color-surface, #FFFFFF)',
                color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
              }}
            >
              +{hiddenTags.length}
            </span>
          )}
        </span>
      )}

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

      {/* Group tags — opens the tag picker. Present only for editors who have
          the extra feature switched on; the server re-checks both. */}
      {onOpenTags && (
        <button
          type="button"
          onClick={onOpenTags}
          aria-label={`Tags for group ${name}`}
          title="Group tags"
          className="inline-flex items-center justify-center transition-colors duration-150 hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)' }}
        >
          <Tags size={14} color="var(--color-text-secondary)" aria-hidden="true" />
        </button>
      )}

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

      {/* Client link (client boards, managers only) — opens the portal setup
          modal for this group. */}
      {onOpenClientPortal && (
        <button
          type="button"
          onClick={onOpenClientPortal}
          aria-label={`Client link for group ${name}`}
          title="Client link"
          className="inline-flex items-center justify-center transition-colors duration-150 hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)' }}
        >
          <Link2 size={14} color="var(--color-text-secondary)" aria-hidden="true" />
        </button>
      )}

      {/* Rename group (admin only). Stays mounted but inert while editing, so
          the button row doesn't shift under the cursor mid-rename — clicking it
          then just blurs the input, which commits. */}
      {onRename && (
        <button
          type="button"
          onClick={startRename}
          disabled={editing}
          aria-label={`Rename group ${name}`}
          title="Rename group"
          className="inline-flex items-center justify-center transition-colors duration-150 hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-sm)',
            opacity: editing ? 0.4 : 1,
          }}
        >
          <Pencil size={14} color="var(--color-text-secondary)" aria-hidden="true" />
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

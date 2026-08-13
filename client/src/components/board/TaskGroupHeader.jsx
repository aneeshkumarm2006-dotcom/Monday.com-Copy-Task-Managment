import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  StickyNote,
  Trash2,
  Link2,
  Tags,
  UserPlus,
} from 'lucide-react';
import { getColorPair } from '../../utils/priorityColors';
import Avatar from '../ui/Avatar';

/** Mirrors MAX_GROUP_NAME in the server's groupController. */
const MAX_NAME_LENGTH = 60;

/**
 * TaskGroupHeader — collapsible header for a group within a board.
 *
 * Layout (left → right):
 *   [▾ chevron] [● dot] [GROUP NAME] [N items] [owner] [progress bar] [tags] … [actions]
 *
 * Everything from the name through the progress bar sits in a FIXED-WIDTH slot,
 * so those badges line up as columns down a board of differently-named groups
 * instead of stepping right with each name. Name overflow truncates; anything
 * whose width can't be pinned (tag chips) goes after the progress bar.
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
 *   owner         — resolved { _id, name, profilePic, email } or null. Tracker
 *                   boards only. The SERVER resolves who owns this group in the
 *                   month on screen; this component never sees the ownership
 *                   timeline and never derives anything from it.
 *   ownerInherited— true when the owner was set in an EARLIER month and carried
 *                   forward into this one. Rendered muted, not differently
 *                   shaped: it is the same fact, just less recently stated.
 *   ownerActive   — false when the owner has left the workspace. The group still
 *                   needs a new owner, so they are flagged rather than hidden.
 *   ownerFromLabel— pre-formatted 'Mar 2026' for the tooltip. Formatted by the
 *                   caller, the way `tags` arrive pre-resolved, so this header
 *                   stays dumb about months.
 *   onOpenOwner   — (event) => {}; its presence shows the picker affordance.
 *                   Absent + owner   → a read-only avatar (what a viewer sees).
 *                   Absent + no owner→ nothing at all.
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
  owner = null,
  ownerInherited = false,
  ownerActive = true,
  ownerFromLabel = '',
  onOpenOwner,
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
          typography so the row doesn't jump between the two states.

          Fixed-width COLUMN, not content-width: every badge that follows starts
          at the same x on every row, so the counts, owners and progress bars
          read down the board as columns instead of a ragged edge. Long names
          truncate (full text stays in the tooltip) rather than shoving the
          column boundary right. */}
      <div className="min-w-0 shrink w-[150px] md:w-[190px] lg:w-[220px]">
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
              // Fills the name column, so entering/leaving edit mode never moves
              // the badges to its right.
              width: '100%',
              minWidth: 0,
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
            title={name}
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
      </div>

      {/* Item count badge — in a fixed-width slot so "9 items" and "13 items"
          leave the next column starting at the same place. */}
      <div className="shrink-0 w-[78px]">
        <span
          className="inline-flex items-center font-body"
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
      </div>

      {/* Group owner (tracker boards). Deliberately on the LEFT, with the
          group's identity rather than with the action buttons: who is
          responsible for a client is part of what the group IS, and it is the
          thing this header exists to make visible at a glance.

          Nothing renders at all on a board that has no owners, so every other
          board's header is byte-identical to before. */}
      {(owner || onOpenOwner) && (
        <div className="shrink-0 w-[34px] lg:w-[164px]">
          <button
            type="button"
            onClick={onOpenOwner}
            disabled={!onOpenOwner}
            aria-label={
              owner
                ? `Owner: ${owner.name}${onOpenOwner ? '. Change owner' : ''}`
                : `Assign an owner to ${name}`
            }
            title={
              owner
                ? [
                  owner.name,
                  !ownerActive ? '(no longer in this workspace)' : '',
                  ownerInherited && ownerFromLabel ? `— carried forward from ${ownerFromLabel}` : '',
                ].filter(Boolean).join(' ')
                : 'Assign an owner'
            }
            className="inline-flex items-center gap-1.5 shrink-0 max-w-full"
            style={{
              height: 28,
              width: owner ? undefined : 28,
              padding: owner ? '0 8px 0 3px' : 0,
              justifyContent: owner ? undefined : 'center',
              borderRadius: 'var(--radius-full)',
              background: owner ? 'var(--color-surface, #FFFFFF)' : 'transparent',
              border: owner ? '1px solid var(--color-border)' : '1px dashed var(--color-border)',
              // Inherited reads as slightly quieter than a decision made THIS
              // month. Same shape, so it never looks like a different kind of thing.
              opacity: ownerInherited ? 0.75 : 1,
              cursor: onOpenOwner ? 'pointer' : 'default',
            }}
          >
            {owner ? (
              <>
                <Avatar user={owner} size={22} />
                <span
                  className="hidden lg:inline font-body truncate"
                  style={{
                    fontSize: 11.5,
                    fontWeight: 500,
                    maxWidth: 110,
                    color: ownerActive
                      ? 'var(--color-text-secondary, var(--color-text-muted))'
                      : 'var(--color-text-muted)',
                    textDecoration: ownerActive ? 'none' : 'line-through',
                  }}
                >
                  {owner.name}
                </span>
              </>
            ) : (
              <UserPlus size={14} color="var(--color-text-muted)" aria-hidden="true" />
            )}
          </button>
        </div>
      )}

      {/* Progress bar — hidden on small screens to save horizontal space. Last
          of the fixed-width columns, so it lines up down the board. */}
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

      {/* Group tag chips. Rendered only when the viewer has the `groupTags`
          extra feature on — the caller resolves the ids and passes an empty
          array otherwise, so this whole block collapses to nothing.

          Sits AFTER the progress bar because its width varies with the tag
          names: anywhere earlier and it would knock the aligned columns out of
          line group by group, which is exactly what these widths fix. */}
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

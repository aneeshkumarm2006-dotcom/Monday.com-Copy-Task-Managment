import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  StickyNote,
  Trash2,
  Tags,
  UserPlus,
  MoreHorizontal,
  ImagePlus,
} from 'lucide-react';
import { getColorPair, deepFor } from '../../utils/priorityColors';
import StatusSpreadBar from './StatusSpreadBar';
import GroupCompletedLabel from './GroupCompletedLabel';
import Avatar from '../ui/Avatar';
import EntityLogo from '../ui/EntityLogo';

/** Mirrors MAX_GROUP_NAME in the server's groupController. */
const MAX_NAME_LENGTH = 60;

/**
 * The status bar's column, in px.
 *
 * It widens for a board that has a completion label — for EVERY header on that
 * board at once, never per group, because the width is derived from the BOARD
 * value and not from whether this particular group is finished. That is what
 * keeps the column edge straight down the page while individual groups flip
 * between a bar and a label. A board with no label gets exactly the old 110.
 */
const BAR_SLOT = 110;
/**
 * 184 is measured, not chosen: "ONBOARDING COMPLETED" — the wording this was
 * built for — renders 146px wide at the pill's 11px/700/0.02em, and the pill
 * adds 18px of padding plus 15px of tick and gap. A 22-character label in
 * ordinary words lands between 172 and 180. Anything wider than that
 * ellipsizes, and the Edit Board dialog renders the real pill at this exact
 * width while you type, so that is visible before it is saved.
 */
const BAR_SLOT_WITH_LABEL = 184;

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
 *   colorDot      — the group's colour, as a HEX from `groupColors.js`. Draws
 *                   the name (darkened for contrast) and, via the caller, the
 *                   card's left edge. Was an 8px dot; the dot is gone.
 *   totalCount    — total tasks in group
 *   doneCount     — done tasks in group
 *   collapsed     — whether the group is currently collapsed
 *   onToggle      — called when chevron (or the header) is clicked
 *   onRename      — async (name) => {}; its presence shows the pencil button
 *   tags          — resolved [{ _id, name, color }] to render as chips. Empty
 *                   unless the viewer has the `groupTags` extra feature on, so
 *                   the header is byte-identical to before for everyone else.
 *   onOpenTags    — (event) => {}; its presence shows the tag button
 *   logo          — the group's logo URL, or ''. Drawn INSIDE the name column,
 *                   ahead of the name, so the badge columns to the right stay
 *                   aligned whether a group has a logo or not. No logo → no
 *                   tile at all: a board with no logos renders as before.
 *   onOpenLogo    — () => {}; its presence shows the logo button in the action
 *                   strip and makes an existing logo clickable.
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
  noteCount = 0,
  tags = [],
  onOpenTags,
  logo = '',
  /** When set, a group WITHOUT a logo draws a lettered tile in this colour, so
   *  names line up on a board where other groups do have logos. The caller
   *  passes it only when at least one group on the board has a logo. */
  logoFallbackColor = null,
  onOpenLogo,
  owner = null,
  ownerInherited = false,
  ownerActive = true,
  ownerFromLabel = '',
  onOpenOwner,
  dragHandle = null,
  /** Column totals for this group, as `[{ key, name, label, display }]`.
   *  Empty on every board whose columns ask for no summary, which is every
   *  board that existed before templates. */
  summaries = [],
  /** "5 invoices" — what one row is called on this board. Falls back to
   *  "items" so a plain task board is byte-identical to before. */
  countLabel = '',
  /** `statusSpread(tasks, board).segments` — one entry per status present in
   *  this group. Empty falls back to the old done-only progress bar, so any
   *  caller that has not been taught to pass it still renders correctly. */
  segments = [],
  /** What this BOARD says in place of the status bar once a group is finished
   *  — "ONBOARDING COMPLETED". `board.groupCompletedLabel` verbatim, and empty
   *  on every board that has not set one, which is what makes those boards
   *  render byte-identically to before. Being a board-level value, it also
   *  decides the bar column's width for every header alike. */
  completedLabel = '',
  /** Whether THIS group is finished. Computed by the caller from the
   *  UNFILTERED rows — `totalCount`/`doneCount` describe what is on screen
   *  under the current filter, so they cannot be trusted with this. */
  isComplete = false,
}) => {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const progressPct =
    totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);

  // Both halves have to be true: the board has to have something to say, and
  // this group has to have finished. Either one alone leaves the bar alone.
  const showCompleted = !!completedLabel && isComplete;
  const barSlotWidth = completedLabel ? BAR_SLOT_WITH_LABEL : BAR_SLOT;

  /**
   * The group's name, in the group's own colour — which is most of what makes
   * a long board scannable without reading a word.
   *
   * DARKENED FIRST. The dot palette is picked for a filled 8px circle, and two
   * of its four fail as TEXT on a white header: #16A34A is 3.30:1 and #EA580C
   * is 3.56:1, both under the 4.5:1 that 14px bold needs. `deepFor` walks them
   * down until they clear it (4.72 and 4.73) and leaves the blue and purple,
   * which already pass, untouched. A CSS variable can't be measured, so those
   * fall back to the ordinary ink rather than being trusted blind.
   */
  const nameColor =
    typeof colorDot === 'string' && colorDot.startsWith('#')
      ? deepFor(colorDot)
      : 'var(--color-text-primary)';

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

  // --- Mobile ⋯ menu ------------------------------------------------------
  // Phones get one overflow menu instead of the desktop icon strip. Same
  // handlers, one calm header row — per the mobile design's group cards.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const mobileMenuItems = [
    onRename && { label: 'Rename group', icon: Pencil, run: () => startRename() },
    onOpenNotes && {
      label: noteCount > 0 ? `Notes (${noteCount})` : 'Notes',
      icon: StickyNote,
      run: () => onOpenNotes(),
    },
    onOpenLogo && { label: logo ? 'Change logo' : 'Add logo', icon: ImagePlus, run: () => onOpenLogo() },
    onOpenTags && { label: 'Tags', icon: Tags, run: (e) => onOpenTags(e) },
    onOpenOwner && { label: 'Group owner', icon: UserPlus, run: (e) => onOpenOwner(e) },
    onDeleteGroup && { label: 'Delete group', icon: Trash2, run: () => onDeleteGroup(), danger: true },
  ].filter(Boolean);

  // The group's logo, when it has one. Clickable for editors (opens the logo
  // dialog); stopPropagation so on phones, where the whole row toggles the
  // group, tapping the logo doesn't also collapse it.
  const logoTile = (px) =>
    logo || logoFallbackColor ? (
      onOpenLogo ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenLogo();
          }}
          title={logo ? 'Change group logo' : 'Add group logo'}
          aria-label={logo ? `Change logo for group ${name}` : `Add a logo to group ${name}`}
          className="shrink-0 inline-flex rounded-md transition-shadow duration-150 hover:shadow-[0_0_0_3px_var(--color-accent-light)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{ padding: 0, border: 'none', background: 'transparent' }}
        >
          <EntityLogo src={logo} name={name} size={px} radius={6} color={logoFallbackColor || undefined} />
        </button>
      ) : (
        <EntityLogo src={logo} name={name} size={px} radius={6} color={logoFallbackColor || undefined} />
      )
    ) : null;

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
    <>
    {/* ---- Phone header: one calm row per the design's group cards ----
        dot · name · ⋯ · owner · done-count · chevron, with a 3px progress
        line while expanded. The whole row is the toggle; the ⋯ carries every
        action the desktop icon strip holds. */}
    <div className="md:hidden" style={{ background: 'var(--color-bg-surface, #FFFFFF)' }}>
      <div
        role="button"
        tabIndex={0}
        onClick={editing ? undefined : onToggle}
        onKeyDown={(e) => {
          if (editing) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle?.();
          }
        }}
        aria-label={collapsed ? `Expand group ${name}` : `Collapse group ${name}`}
        aria-expanded={!collapsed}
        className="flex items-center gap-2.5"
        style={{ padding: '13px 14px 11px', cursor: 'pointer' }}
      >
        {logoTile(22)}
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            autoFocus
            disabled={saving}
            maxLength={MAX_NAME_LENGTH}
            aria-label="Group name"
            onClick={(e) => e.stopPropagation()}
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
            className="font-body flex-1 min-w-0"
            style={{
              fontSize: 13.5,
              fontWeight: 700,
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
          <span
            className="font-body flex-1 min-w-0 truncate"
            title={name}
            style={{ fontSize: 13.5, fontWeight: 700, color: nameColor }}
          >
            {name}
          </span>
        )}

        {mobileMenuItems.length > 0 && (
          <span ref={menuRef} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={`Actions for group ${name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
              style={{ width: 28, height: 28 }}
            >
              <MoreHorizontal size={16} color="var(--color-text-muted)" aria-hidden="true" />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1 bg-white overflow-hidden z-30"
                style={{
                  width: 190,
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-lg)',
                }}
              >
                {mobileMenuItems.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={(e) => {
                      setMenuOpen(false);
                      item.run(e);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left font-body text-[13px] hover:bg-[color:var(--color-bg-subtle)]"
                    style={{
                      color: item.danger
                        ? 'var(--color-status-stuck)'
                        : 'var(--color-text-primary)',
                    }}
                  >
                    <item.icon size={14} aria-hidden="true" />
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}

        {owner && (
          <span className="shrink-0" aria-label={`Owner: ${owner.name}`}>
            <Avatar user={owner} size={22} />
          </span>
        )}

        <span
          className="font-body shrink-0"
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 9px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text-secondary)',
            border: '1px solid var(--color-border)',
          }}
        >
          {doneCount}/{totalCount}
        </span>

        <Chevron size={16} color="var(--color-text-muted)" aria-hidden="true" className="shrink-0" />
      </div>

      {/* Phones keep the bar's own rule — hidden while collapsed — because
          here it is a separate strip BELOW the row, and showing it on every
          collapsed group would make the whole list taller. The `9/9` pill in
          the row above already carries the fact on a collapsed row. */}
      {!collapsed && showCompleted && (
        <div style={{ margin: '0 14px 8px' }}>
          <GroupCompletedLabel label={completedLabel} total={totalCount} />
        </div>
      )}
      {!collapsed && !showCompleted && segments.length > 0 && (
        <div style={{ margin: '0 14px 6px' }}>
          <StatusSpreadBar segments={segments} total={totalCount} doneCount={doneCount} width="100%" height={4} />
        </div>
      )}
      {!collapsed && !showCompleted && segments.length === 0 && (
        <div
          aria-hidden="true"
          style={{ height: 3, background: 'var(--color-bg-subtle)', borderRadius: 2, margin: '0 14px 4px' }}
        >
          <div
            style={{
              width: `${progressPct}%`,
              height: 3,
              background: 'var(--color-status-done, #16A34A)',
              borderRadius: 2,
              transition: 'width 200ms ease-out',
            }}
          />
        </div>
      )}
    </div>

    <div
      className="group/group-header hidden md:flex items-center gap-3"
      style={{
        height: 48,
        padding: '0 16px',
        // WHITE, not grey. The colour now comes from the stripe on the card's
        // edge and from the name itself; a grey header on a grey page under
        // grey chips is why the board read flat.
        background: 'var(--color-bg-surface, #FFFFFF)',
        // Match the card's top corners so the header curves with the rounded
        // card edge (matters while the card is overflow-visible during inline
        // editing). A collapsed group has no table below it, so its bottom
        // border would just double up the card's own border ring.
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

      {/* No colour dot any more. The group's colour is on the card's 4px left
          edge and in the name itself; an 8px circle saying it a third time is
          the kind of detail that reads as clutter rather than care. */}

      {/* Group name — swaps for an input while renaming. Both share the same
          typography so the row doesn't jump between the two states.

          Fixed-width COLUMN, not content-width: every badge that follows starts
          at the same x on every row, so the counts, owners and progress bars
          read down the board as columns instead of a ragged edge. Long names
          truncate (full text stays in the tooltip) rather than shoving the
          column boundary right. */}
      <div className="min-w-0 shrink w-[150px] md:w-[190px] lg:w-[220px] flex items-center gap-2">
        {logoTile(24)}
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
            className="font-display truncate min-w-0"
            title={name}
            style={{
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: nameColor,
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
          {/* "5 invoices", not "5 items". A board that calls its invoices
              items is a board nobody has set up for the work. */}
          {countLabel || `${totalCount} ${totalCount === 1 ? 'item' : 'items'}`}
        </span>
      </div>

      {/* Column totals, beside the count.
          The same numbers the table footer shows, lifted into the header so a
          money board answers "what does this month come to" without scrolling
          to the bottom of the group — which on a twelve-row invoice list is
          the whole question. Only the first two, and only on desktop: a board
          with six summed columns would push the actions off the right edge.

          ITS OWN SLOT. These used to live inside the 78px count box above,
          where "Amount ₹79,500" had nowhere to go but onto a second line —
          inside a header that is 48px tall. Fixed width and clipped, so the
          columns after it still line up down the board, and only rendered at
          all when the board actually sums something. */}
      {summaries.length > 0 && (
        <div className="shrink-0 hidden md:flex items-center gap-3 w-[176px] overflow-hidden">
          {summaries.slice(0, 2).map((s) => (
            <span
              key={s.key}
              className="font-body whitespace-nowrap truncate"
              style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}
              title={`${s.label} of ${s.name}`}
            >
              {s.name}{' '}
              <b style={{ fontWeight: 700, color: 'var(--color-text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                {s.display}
              </b>
            </span>
          ))}
        </div>
      )}

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

      {/* Where the work stands — hidden on small screens to save horizontal
          space. Last of the fixed-width columns, so it lines up down the board.

          One segment per status rather than a done-only fill: the old bar could
          not tell you that four of the seven are STUCK, which is the fact you
          would actually act on. Falls back to the old bar when the caller
          passes no segments. */}
      {/* The slot's width is pinned here rather than taken from the bar's own
          `width`, because the label that can replace it is variable-width and
          would otherwise let this column go ragged group by group. Shown on a
          COLLAPSED group too, which is where "this one is finished" is worth
          most. */}
      <div className="shrink-0 hidden sm:block" style={{ width: barSlotWidth }}>
        {showCompleted ? (
          <GroupCompletedLabel label={completedLabel} total={totalCount} />
        ) : (
          <StatusSpreadBar
            segments={segments}
            total={totalCount}
            doneCount={doneCount}
            width={110}
            height={6}
          />
        )}
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

      {/* The action icons. On phones a COLLAPSED group hides them — five 28px
          targets per row turned the group list into an icon wall (and none of
          them are what a collapsed row is for). Expanding the group brings
          them back; desktop always shows them. */}
      <div
        className={[
          collapsed ? 'hidden md:flex' : 'flex',
          'items-center gap-0.5 shrink-0',
        ].join(' ')}
      >

      {/* Group logo — opens the logo dialog. Editors only. */}
      {onOpenLogo && (
        <button
          type="button"
          onClick={() => onOpenLogo()}
          aria-label={logo ? `Change logo for group ${name}` : `Add a logo to group ${name}`}
          title={logo ? 'Change group logo' : 'Add group logo'}
          className="inline-flex items-center justify-center transition-colors duration-150 hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)' }}
        >
          <ImagePlus size={14} color="var(--color-text-secondary)" aria-hidden="true" />
        </button>
      )}

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

      {/* The client portal link used to live here, per group. A client board
          is now ONE client with one link, managed from the board header. */}

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
    </div>
    </>
  );
};

export default TaskGroupHeader;

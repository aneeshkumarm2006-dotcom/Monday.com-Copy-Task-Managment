import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UserPlus, Check, Mail } from 'lucide-react';
import InviteModal from './InviteModal';
import useDropdownPosition from '../../utils/useDropdownPosition';

/**
 * AssigneePicker — small dropdown listing a board's members with multi-select.
 *
 * Clicking the trigger opens a panel of members (avatar 24px + name + checkbox).
 * Selected avatars stack with 8px overlap on the trigger.
 * See Macan_Design.md Section 11.
 *
 * Props:
 *   members  — the BOARD's roster (see hooks/useBoardMembers), NOT the
 *                workspace's: [{ _id, name, profilePic }]. Passing the org list
 *                here is how a private board came to offer people who cannot
 *                open it, and whom the server refuses as assignees anyway.
 *   value    — string[] of selected member ids
 *   onChange — (ids: string[]) => void
 *   disabled — disables the trigger
 *   isAdmin  — shows the "Invite other member" button when true
 *   canAssignOthers — holds `task.assign` (the `edit` rung). When false, only
 *                the caller's OWN row is clickable: the server allows a
 *                contributor to add or remove themselves and refuses every
 *                other name, so offering the whole roster was a guaranteed
 *                dead click that ended in a 403 toast. Defaults to true so a
 *                call site that has not been taught the difference — the
 *                automations editor, the calendar's filter bar — behaves
 *                exactly as before.
 *   selfId   — the current user's id, i.e. which row stays live above.
 */
const AssigneePicker = ({
  members = [],
  value = [],
  onChange,
  disabled = false,
  isAdmin = false,
  showNames = false,
  canAssignOthers = true,
  selfId = null,
}) => {
  const [open, setOpen] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const selectedIds = new Set(value || []);
  const selectedMembers = members.filter((m) => selectedIds.has(m._id));
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

  // Mirrors the server's carve-out exactly: the delta may only ever be your own
  // name. Hiding the other rows entirely would be worse — you could no longer
  // SEE who a task belongs to — so they render, greyed and inert.
  const canToggle = (memberId) =>
    canAssignOthers || (!!selfId && String(memberId) === String(selfId));

  const toggle = (memberId) => {
    if (!canToggle(memberId)) return;
    const next = new Set(selectedIds);
    if (next.has(memberId)) next.delete(memberId);
    else next.add(memberId);
    onChange?.(Array.from(next));
  };

  return (
    <div ref={wrapperRef} className="relative w-full">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          'w-full flex items-center gap-2 px-2 font-body text-[13px]',
          'bg-[color:var(--color-bg-input)] transition-[border-color,box-shadow,background-color] duration-150 ease-in-out',
          'focus:outline-none focus:bg-white',
          'disabled:opacity-60 disabled:cursor-not-allowed',
        ].join(' ')}
        style={{
          // Grow to fit wrapped assignee chips (showNames mode) instead of a
          // fixed height that clips the "+N more" onto a hidden second line.
          minHeight: 32,
          paddingTop: 4,
          paddingBottom: 4,
          border: open
            ? '1.5px solid var(--color-accent)'
            : '1.5px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: open ? '0 0 0 3px rgba(37, 99, 235, 0.12)' : 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {selectedMembers.length > 0 ? (
          showNames ? (
            <AssigneeAvatarsWithNames assignees={selectedMembers} />
          ) : (
            <AssigneeAvatars assignees={selectedMembers} />
          )
        ) : (
          <span
            className="inline-flex items-center gap-1.5"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <UserPlus size={14} aria-hidden="true" />
            Assign
          </span>
        )}
      </button>

      {open && createPortal(
        <ul
          ref={menuRef}
          role="listbox"
          aria-multiselectable="true"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
          className="bg-white overflow-auto"
          style={{
            position: 'fixed',
            top,
            left,
            width: Math.max(width, 220),
            zIndex: 200,
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
          {members.length === 0 && (
            <li
              className="px-3 py-2 font-body text-sm"
              style={{ color: 'var(--color-text-muted)' }}
            >
              No members
            </li>
          )}
          {members.map((m) => {
            const isSelected = selectedIds.has(m._id);
            const locked = !canToggle(m._id);
            return (
              <li key={m._id} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  disabled={locked}
                  title={locked ? 'Only a board editor can assign other people' : undefined}
                  onClick={() => toggle(m._id)}
                  className={[
                    'w-full flex items-center gap-2 px-2 text-left font-body text-[13px]',
                    'transition-colors duration-100',
                    locked
                      ? 'cursor-not-allowed'
                      : 'hover:bg-[color:var(--color-bg-subtle)] focus:bg-[color:var(--color-bg-subtle)]',
                    'focus:outline-none',
                  ].join(' ')}
                  style={{
                    height: 36,
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-text-primary)',
                    opacity: locked ? 0.45 : 1,
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
                      <Check size={12} color="#FFFFFF" strokeWidth={3} aria-hidden="true" />
                    )}
                  </span>
                  <MemberAvatar user={m} />
                  <span className="flex-1 truncate">{m.name}</span>
                </button>
              </li>
            );
          })}

          {isAdmin && (
            <li role="presentation" style={{ borderTop: '1px solid var(--color-border)', marginTop: 4, paddingTop: 4 }}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setShowInviteModal(true);
                }}
                className={[
                  'w-full flex items-center gap-2 px-2 text-left font-body text-[13px]',
                  'transition-colors duration-100',
                  'hover:bg-[color:var(--color-bg-subtle)]',
                  'focus:outline-none focus:bg-[color:var(--color-bg-subtle)]',
                ].join(' ')}
                style={{
                  height: 36,
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--color-accent)',
                  fontWeight: 500,
                }}
              >
                <Mail size={14} aria-hidden="true" />
                Invite other member
              </button>
            </li>
          )}
        </ul>,
        document.body
      )}

      {showInviteModal && (
        <InviteModal onClose={() => setShowInviteModal(false)} />
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

/**
 * Avatar + name display for the CommentPanel trigger (showNames mode).
 * Each assignee is a compact rounded chip (avatar + name); beyond two they
 * collapse into a matching "+N more" pill. Chips wrap onto new rows with even
 * spacing, and the trigger grows to fit them (see the trigger's minHeight) so
 * nothing is clipped.
 */
const AssigneeAvatarsWithNames = ({ assignees }) => {
  const visible = assignees.slice(0, 2);
  const remaining = assignees.length - visible.length;
  return (
    <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
      {visible.map((u) => (
        <span
          key={u._id}
          className="inline-flex items-center gap-1.5"
          style={{
            paddingRight: 8,
            paddingLeft: 3,
            height: 26,
            borderRadius: 9999,
            background: 'var(--color-bg-subtle)',
            border: '1px solid var(--color-border)',
          }}
        >
          <MemberAvatar user={u} style={{ width: 20, height: 20 }} />
          <span
            className="font-body font-medium truncate"
            style={{ fontSize: 12.5, color: 'var(--color-text-primary)', maxWidth: 110 }}
          >
            {u.name || u.email || 'Unknown'}
          </span>
        </span>
      ))}
      {remaining > 0 && (
        <span
          className="inline-flex items-center font-body font-semibold"
          style={{
            height: 26,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 9999,
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            background: 'var(--color-bg-subtle)',
            border: '1px solid var(--color-border)',
          }}
        >
          +{remaining} more
        </span>
      )}
    </div>
  );
};

/**
 * Stacked mini-avatars for the trigger button (up to 3 + overflow bubble).
 */
const AssigneeAvatars = ({ assignees }) => {
  const visible = assignees.slice(0, 3);
  const remaining = assignees.length - visible.length;
  return (
    <div className="flex items-center">
      {visible.map((u, i) => (
        <MemberAvatar
          key={u._id || i}
          user={u}
          style={{ marginLeft: i === 0 ? 0 : -8, zIndex: visible.length - i }}
        />
      ))}
      {remaining > 0 && (
        <span
          className="inline-flex items-center justify-center font-body font-semibold"
          style={{
            width: 24,
            height: 24,
            marginLeft: -8,
            borderRadius: '50%',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text-secondary)',
            fontSize: 10,
            border: '2px solid var(--color-bg-surface, #FFFFFF)',
          }}
        >
          +{remaining}
        </span>
      )}
    </div>
  );
};

const MemberAvatar = ({ user, style = {} }) => {
  const [imgError, setImgError] = useState(false);
  const name = user?.name || '';
  const initial = name.charAt(0).toUpperCase() || '?';
  const base = {
    width: 24,
    height: 24,
    borderRadius: '50%',
    border: '2px solid var(--color-bg-surface, #FFFFFF)',
    flexShrink: 0,
    ...style,
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

export default AssigneePicker;

/**
 * InlineAssigneeMenu — the member-list dropdown shown directly anchored to a
 * trigger element (e.g. a task row's Owner cell). No trigger button — opens
 * immediately and closes on outside-click or Escape.
 *
 * Props:
 *   anchorEl  — DOM element to anchor the menu to
 *   members   — the BOARD's roster (see hooks/useBoardMembers)
 *   value     — string[] of selected member ids
 *   onChange  — (ids: string[]) => void
 *   onClose   — () => void
 *   canAssignOthers — see AssigneePicker above; when false only `selfId`'s row
 *               is live, matching the server's carve-out. Defaults to true so
 *               the group-owner picker (gated on its own capability at the call
 *               site) is unaffected.
 *   selfId    — the current user's id.
 */
export const InlineAssigneeMenu = ({
  anchorEl,
  members = [],
  value = [],
  onChange,
  onClose,
  canAssignOthers = true,
  selfId = null,
}) => {
  const menuRef = useRef(null);
  const triggerRef = useRef(anchorEl);
  triggerRef.current = anchorEl;

  const selectedIds = new Set(value);
  const { top, left, width, openUpward } = useDropdownPosition(triggerRef, !!anchorEl);

  useEffect(() => {
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (anchorEl?.contains(e.target)) return;
      onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onClose]);

  const canToggle = (memberId) =>
    canAssignOthers || (!!selfId && String(memberId) === String(selfId));

  const toggle = (memberId) => {
    if (!canToggle(memberId)) return;
    const next = new Set(selectedIds);
    if (next.has(memberId)) next.delete(memberId);
    else next.add(memberId);
    onChange?.(Array.from(next));
  };

  if (!anchorEl) return null;

  return createPortal(
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
        zIndex: 200,
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
      {members.length === 0 ? (
        <li className="px-3 py-2 font-body text-sm" style={{ color: 'var(--color-text-muted)' }}>
          No members
        </li>
      ) : members.map((m) => {
        const isSelected = selectedIds.has(m._id);
        const locked = !canToggle(m._id);
        return (
          <li key={m._id} role="option" aria-selected={isSelected}>
            <button
              type="button"
              disabled={locked}
              title={locked ? 'Only a board editor can assign other people' : undefined}
              onClick={() => toggle(m._id)}
              className={[
                'w-full flex items-center gap-2 px-2 text-left font-body text-[13px]',
                'transition-colors duration-100 focus:outline-none',
                locked ? 'cursor-not-allowed' : 'hover:bg-[color:var(--color-bg-subtle)]',
              ].join(' ')}
              style={{
                height: 36,
                borderRadius: 'var(--radius-sm)',
                color: 'var(--color-text-primary)',
                opacity: locked ? 0.45 : 1,
              }}
            >
              <span
                aria-hidden="true"
                className="inline-flex items-center justify-center shrink-0"
                style={{
                  width: 16, height: 16,
                  borderRadius: 'var(--radius-sm)',
                  border: isSelected ? '1.5px solid var(--color-accent)' : '1.5px solid var(--color-border-strong)',
                  background: isSelected ? 'var(--color-accent)' : 'transparent',
                }}
              >
                {isSelected && <Check size={12} color="#FFFFFF" strokeWidth={3} aria-hidden="true" />}
              </span>
              <MemberAvatar user={m} />
              <span className="flex-1 truncate">{m.name}</span>
            </button>
          </li>
        );
      })}
      <style>{`
        @keyframes macan-dropdown-enter { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)} }
        @keyframes macan-dropdown-enter-up { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
      `}</style>
    </ul>,
    document.body
  );
};

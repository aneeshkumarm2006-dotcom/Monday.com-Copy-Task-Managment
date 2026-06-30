import { createElement } from 'react';
import { Check, Circle, Bookmark, X as XIcon } from 'lucide-react';
import Avatar from '../ui/Avatar';
import { timeAgo } from '../../utils/dateUtils';
import useNotificationStore from '../../store/notificationStore';
import { getNotifColor, getNotifIcon } from './notificationMeta';

/**
 * Action button used in the hover/focus action row.
 */
const ActionButton = ({ label, onClick, active, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={active}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    className="shrink-0 flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]"
    style={{ width: 24, height: 24 }}
  >
    {children}
  </button>
);

/**
 * The notification "avatar": the actor's avatar with a small type-icon corner
 * badge, or — for system / automation notifications with no actor — a colored
 * circle holding the type icon.
 */
const NotifGlyph = ({ notif }) => {
  const color = getNotifColor(notif.type);
  const icon = getNotifIcon(notif.type);
  if (notif.actor) {
    return (
      <span className="relative shrink-0" style={{ width: 32, height: 32 }}>
        <Avatar user={notif.actor} size={32} />
        <span
          aria-hidden="true"
          className="absolute flex items-center justify-center"
          style={{
            right: -2,
            bottom: -2,
            width: 16,
            height: 16,
            borderRadius: 9999,
            background: color,
            border: '2px solid white',
          }}
        >
          {createElement(icon, { size: 9, color: 'white' })}
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="shrink-0 flex items-center justify-center"
      style={{ width: 32, height: 32, borderRadius: 9999, background: color }}
    >
      {createElement(icon, { size: 16, color: 'white' })}
    </span>
  );
};

/**
 * A single notification row, shared by the bell dropdown and the full-page
 * center. Renders the glyph, message, relative time, and a hover/focus action
 * row (mark read/unread, bookmark, dismiss). Clicking the body activates the
 * notification (mark read + navigate via `onActivate`).
 */
const NotificationItem = ({ notif, onActivate }) => {
  const markRead = useNotificationStore((s) => s.markRead);
  const markUnread = useNotificationStore((s) => s.markUnread);
  const toggleBookmark = useNotificationStore((s) => s.toggleBookmark);
  const deleteNotification = useNotificationStore((s) => s.deleteNotification);

  const unread = !notif.isRead;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onActivate?.(notif)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate?.(notif);
        }
      }}
      className="group w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus-visible:bg-[color:var(--color-bg-subtle)] cursor-pointer"
      style={{
        background: unread ? 'var(--color-accent-light)' : 'white',
        borderLeft: unread
          ? '3px solid var(--color-accent)'
          : '3px solid transparent',
        minHeight: 56,
      }}
    >
      <span className="mt-0.5">
        <NotifGlyph notif={notif} />
      </span>

      <span className="min-w-0 flex-1">
        <span
          className="block font-body text-[13px] text-[color:var(--color-text-primary)]"
          style={{ fontWeight: unread ? 600 : 500 }}
        >
          {notif.message}
        </span>
        <span className="flex items-center gap-2 mt-0.5">
          <span className="font-body text-[12px] text-[color:var(--color-text-muted)]">
            {timeAgo(notif.createdAt)}
          </span>
          {notif.board?.name && (
            <span className="font-body text-[12px] text-[color:var(--color-text-muted)] truncate">
              · {notif.board.name}
            </span>
          )}
        </span>
      </span>

      {/* Action row — revealed on hover/focus (always visible on touch). */}
      <span
        className="shrink-0 flex items-center gap-1 self-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
      >
        {unread ? (
          <ActionButton label="Mark as read" onClick={() => markRead(notif._id)}>
            <Check size={14} color="var(--color-text-muted)" />
          </ActionButton>
        ) : (
          <ActionButton
            label="Mark as unread"
            onClick={() => markUnread(notif._id)}
          >
            <Circle size={13} color="var(--color-text-muted)" />
          </ActionButton>
        )}
        <ActionButton
          label={notif.bookmarked ? 'Remove bookmark' : 'Bookmark'}
          active={!!notif.bookmarked}
          onClick={() => toggleBookmark(notif._id)}
        >
          <Bookmark
            size={14}
            color={
              notif.bookmarked ? 'var(--color-accent)' : 'var(--color-text-muted)'
            }
            fill={notif.bookmarked ? 'var(--color-accent)' : 'none'}
          />
        </ActionButton>
        <ActionButton
          label="Dismiss notification"
          onClick={() => deleteNotification(notif._id)}
        >
          <XIcon size={13} color="var(--color-text-muted)" />
        </ActionButton>
      </span>
    </div>
  );
};

export default NotificationItem;

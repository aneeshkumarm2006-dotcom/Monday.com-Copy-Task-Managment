import {
  UserPlus,
  UserMinus,
  CheckCircle2,
  MessageSquare,
  Reply,
  AtSign,
  Clock,
  CalendarClock,
  ArrowLeftRight,
  Share2,
  Users,
  Bell,
  Target,
} from 'lucide-react';

/**
 * Per-type accent color for a notification (the colored dot / icon tint).
 * Uses the app's status + accent design tokens — no new hex values.
 */
export const NOTIF_TYPE_COLOR = {
  assigned: 'var(--color-accent)',
  unassigned: 'var(--color-status-stuck)',
  commented: 'var(--color-status-working)',
  replied: 'var(--color-status-working)',
  mentioned: 'var(--color-accent)',
  statusChanged: 'var(--color-status-done)',
  dueSoon: 'var(--color-status-stuck)',
  dueDateChanged: 'var(--color-status-stuck)',
  taskMoved: 'var(--color-status-working)',
  invited: 'var(--color-accent)',
  memberJoined: 'var(--color-status-done)',
  goalsDue: 'var(--color-status-working)',
};

/**
 * Per-type lucide icon, shown inside the actor avatar's corner badge and as the
 * fallback glyph when a notification has no human actor (system / automation).
 */
export const NOTIF_TYPE_ICON = {
  assigned: UserPlus,
  unassigned: UserMinus,
  commented: MessageSquare,
  replied: Reply,
  mentioned: AtSign,
  statusChanged: CheckCircle2,
  dueSoon: Clock,
  dueDateChanged: CalendarClock,
  taskMoved: ArrowLeftRight,
  invited: Share2,
  memberJoined: Users,
  goalsDue: Target,
};

export const getNotifColor = (type) => NOTIF_TYPE_COLOR[type] || 'var(--color-accent)';
export const getNotifIcon = (type) => NOTIF_TYPE_ICON[type] || Bell;

/**
 * The filter tabs shown above the notification list. `unread` carries the live
 * unread count as a badge.
 */
export const FILTER_TABS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'mentioned', label: 'Mentions' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'bookmarked', label: 'Saved' },
];

/**
 * Resolve the in-app destination for a notification click.
 *
 * - Task notifications deep-link to the board and highlight the task (and open a
 *   specific task-panel tab when `tab` is set).
 * - Board-scoped notifications (e.g. `invited`) link to the board.
 * - Workspace notifications (e.g. `memberJoined`) link to the members page.
 * - Otherwise null (non-navigable).
 *
 * `notif.board` is populated ({_id, name}); `notif.task` is populated with its
 * raw `board` ObjectId (and `parent` ObjectId for subtasks) — so we accept both
 * shapes. When the task is a subtask, `parent` lets the board expand the parent
 * row so the subtask is actually visible before it's highlighted.
 */
export const resolveNotifLink = (notif) => {
  if (!notif) return null;
  const boardId =
    notif.board?._id ||
    (typeof notif.board === 'string' ? notif.board : null) ||
    notif.task?.board ||
    null;
  const taskId =
    notif.task?._id || (typeof notif.task === 'string' ? notif.task : null);
  // A subtask's parent id — carried so the board can expand the parent row.
  const parentId = notif.task?.parent
    ? String(notif.task.parent)
    : null;

  // A month-end goal reminder carries no task: it is about the board's Goals
  // tab for one particular month, so it deep-links to the VIEW rather than to a
  // row. `notif.month` rides on the notification so the link lands on the month
  // that actually needs closing, not on whatever month is current by the time
  // somebody clicks it.
  if (boardId && notif.tab === 'goals') {
    const monthParam = notif.month ? `&month=${notif.month}` : '';
    return `/boards/${boardId}?view=goals${monthParam}`;
  }

  if (boardId && taskId) {
    const tabParam = notif.tab ? `&openTab=${notif.tab}` : '';
    const parentParam = parentId ? `&highlightParent=${parentId}` : '';
    return `/boards/${boardId}?highlightTask=${taskId}${parentParam}${tabParam}`;
  }
  if (boardId) return `/boards/${boardId}`;
  if (notif.type === 'memberJoined') return '/members';
  return null;
};

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
};

/**
 * Group a (newest-first) notification list into Today / Yesterday / Earlier
 * sections for the list headers. Preserves order within each group.
 */
export const groupNotificationsByDate = (notifications) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

  const groups = { today: [], yesterday: [], earlier: [] };
  for (const n of notifications) {
    const ts = startOfDay(n.createdAt || now);
    if (ts >= todayStart) groups.today.push(n);
    else if (ts >= yesterdayStart) groups.yesterday.push(n);
    else groups.earlier.push(n);
  }

  return [
    { key: 'today', label: 'Today', items: groups.today },
    { key: 'yesterday', label: 'Yesterday', items: groups.yesterday },
    { key: 'earlier', label: 'Earlier', items: groups.earlier },
  ].filter((g) => g.items.length > 0);
};

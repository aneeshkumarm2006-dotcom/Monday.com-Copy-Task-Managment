/**
 * The in-app path a notification should open.
 *
 * MIRRORS `client/src/components/notifications/notificationMeta.js`
 * (`resolveNotifLink`). The two cannot share code — separate packages — so if
 * you change the route shape in one, change it here too. It is duplicated
 * rather than approximated on purpose: a push notification that opens the wrong
 * place is worse than one that never arrives, because the person has already
 * spent the interruption by the time they find out.
 *
 * Takes a RAW notification document (ids, not populated refs), because push is
 * sent from `createNotification` before anything is populated.
 */
const asId = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v._id) return String(v._id);
  return String(v);
};

const resolveNotifLink = (notif) => {
  if (!notif) return '/dashboard';

  // The morning digest is about the PERSON, not a board.
  if (notif.type === 'dueDigest' || notif.tab === 'myWork') return '/my-tasks';

  if (notif.type === 'chatMention') {
    const channelId = asId(notif.channel);
    return channelId ? `/chat?channel=${channelId}` : '/chat';
  }

  const boardId = asId(notif.board) || asId(notif.task?.board) || null;
  const taskId = asId(notif.task);

  if (boardId && notif.tab === 'goals') {
    const monthParam = notif.month ? `&month=${notif.month}` : '';
    return `/boards/${boardId}?view=goals${monthParam}`;
  }

  if (boardId && notif.tab === 'seo') {
    return `/boards/${boardId}?view=seo`;
  }

  if (boardId && taskId) {
    const tabParam = notif.tab ? `&openTab=${notif.tab}` : '';
    const month = notif.month ? `&month=${notif.month}` : '';
    return `/boards/${boardId}?highlightTask=${taskId}${tabParam}${month}`;
  }

  if (boardId) return `/boards/${boardId}`;
  if (notif.type === 'memberJoined' || notif.type === 'ownershipTransferred') {
    return '/members';
  }
  return '/notifications';
};

module.exports = { resolveNotifLink };

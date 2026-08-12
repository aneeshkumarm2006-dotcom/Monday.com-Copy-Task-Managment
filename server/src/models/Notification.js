const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Who triggered this notification (assigner, commenter, mentioner, etc.).
    // Null for system-generated notifications (dueSoon) and automation actions
    // that have no human actor — the UI falls back to a type icon.
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Organisation the notification belongs to. Null/undefined for personal-task
    // notifications (dueSoon on isPersonal tasks) — those are shown regardless of
    // the user's currently selected org since they don't live in any workspace.
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'assigned',
        'commented',
        'mentioned',
        'statusChanged',
        'dueSoon',
        'replied',
        // Newer event types.
        'invited',
        'memberJoined',
        'taskMoved',
        'unassigned',
        'dueDateChanged',
        // Client Portal — team-facing alerts about external client activity.
        'clientIssueCreated',
        'clientReplied',
        // Tracker boards — the month is ending (or has ended) and its goals
        // still need their final numbers.
        'goalsDue',
      ],
    },
    message: {
      type: String,
    },
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
    },
    // Board this notification relates to. Enables a generalised deep-link
    // (board-scoped notifications such as `invited` carry no task) and lets the
    // client navigate to the board even when no task is attached.
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      default: null,
      index: true,
    },
    // Optional hint telling the client which tab of the task detail panel to open
    // when the notification is clicked (e.g. 'updates' for an update reply,
    // 'client' for the client-facing thread on a Client Portal board).
    // Null → just highlight the task row.
    //
    // 'comments' and 'internal' are retired but still listed: rows carrying them
    // are already in the database, and dropping a value from the enum would make
    // every such document fail validation on any later save. The panel maps both
    // to the Updates tab.
    tab: {
      type: String,
      enum: [
        'updates', 'client', 'internal', 'comments', 'files', 'activity',
        // Not a task-panel tab: a board VIEW. A `goalsDue` notification carries
        // no task, so clicking it opens the board's Goals tab for the month in
        // question rather than a row.
        'goals',
        null,
      ],
      default: null,
    },
    // Which month this notification is about ('YYYY-MM'), on tracker boards.
    // A `goalsDue` reminder deep-links to the Goals tab for the month that needs
    // closing, which by the time anyone clicks is no longer the current one —
    // so the month has to travel with the notification rather than be inferred.
    month: {
      type: String,
      default: null,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    // When the notification was marked read (null while unread). Lets the client
    // show "read N ago" and supports a future read/unread audit.
    readAt: {
      type: Date,
      default: null,
    },
    // Whether the user has bookmarked (starred) this notification for later.
    bookmarked: {
      type: Boolean,
      default: false,
    },
  },
  // `timestamps` adds createdAt (preserved on existing docs) + updatedAt.
  { timestamps: true }
);

// Hot-path indexes: the list query and unread count both filter on `user`,
// which was previously unindexed.
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, isRead: 1 });

module.exports = mongoose.model('Notification', notificationSchema);

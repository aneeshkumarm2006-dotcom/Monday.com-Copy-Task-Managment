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
        // The 9am morning digest — ONE row per morning counting everything due
        // and overdue, where `dueSoon` above is one row per task and only
        // materialises when somebody opens the bell. Mapped to the `dueDates`
        // category in notificationService, so the existing toggle governs both.
        'dueDigest',
        // Client Portal — team-facing alerts about external client activity.
        'clientIssueCreated',
        'clientReplied',
        // Tracker boards — the month is ending (or has ended) and its goals
        // still need their final numbers.
        'goalsDue',
        // A board or the workspace itself changed hands. Deliberately NOT
        // mapped to a preference category in notificationService, so it is
        // always delivered: who owns your workspace is not a subscription.
        'ownershipTransferred',
        // SEO connector alerts — a tracked keyword fell, or a chunk of the
        // backlink profile disappeared.
        //
        // BOTH ARE MAPPED, in notificationService's TYPE_CATEGORY, to the `seo`
        // category. That is not optional and it is the whole reason these two
        // arrived together with a category rather than on their own: an
        // UNMAPPED TYPE IS ALWAYS DELIVERED, and a rank tracker's entire job is
        // noticing movement — so an unmapped rank alert is the most recurring
        // nag this product could generate, with no off switch. The `goals`
        // category above already carries the sentence about what that does to a
        // workspace's relationship with the bell.
        'seoRankDrop',
        'seoLostBacklinks',
        // Chat — someone @mentioned this user in a channel. Carries `channel`
        // below; clicking it opens that channel. Mapped to the 'mentions'
        // preference category in notificationService.
        'chatMention',
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
        // Also a board VIEW rather than a task-panel tab. An SEO alert carries
        // no task either — it is about a site, not a row — so it opens the
        // board's SEO tab.
        'seo',
        // Not a board anything: the morning digest is about the PERSON, so it
        // opens My Work, where every task it counted is already theirs.
        'myWork',
        null,
      ],
      default: null,
    },
    // The chat channel this notification is about (chatMention only). Its own
    // field rather than overloading `board`: a channel can be workspace-level
    // with no board at all, and the deep link needs the channel id regardless.
    channel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
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

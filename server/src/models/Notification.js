const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
    enum: ['assigned', 'commented', 'mentioned', 'statusChanged', 'dueSoon', 'replied'],
  },
  message: {
    type: String,
  },
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
  },
  // Optional hint telling the client which tab of the task detail panel to open
  // when the notification is clicked (e.g. 'updates' for an update reply,
  // 'comments' for a comment reply). Null → just highlight the task row.
  tab: {
    type: String,
    enum: ['updates', 'comments', 'files', 'activity', null],
    default: null,
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Notification', notificationSchema);

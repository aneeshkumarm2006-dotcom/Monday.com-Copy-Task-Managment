const mongoose = require('mongoose');

// Activity event types. Field-level changes use `task.field_changed` with the
// `field` property set; everything else carries its own type.
const ACTIVITY_TYPES = [
  'task.created',
  'task.deleted',
  'task.field_changed',
  'checklist.added',
  'checklist.toggled',
  'checklist.renamed',
  'checklist.deleted',
  'checklist.reordered',
  'attachment.uploaded',
  'attachment.deleted',
  'comment.added',
  'update.added',
  // Client Portal actions (actor is a ClientContact, not a User → actorType 'client').
  'client.request_created',
  'client.update_added',
];

const FIELD_KEYS = [
  'name',
  'status',
  'priority',
  'assignees',
  'dueDate',
  'labels',
  'note',
  'group',
  'pinned',
];

const activityLogSchema = new mongoose.Schema({
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true,
    index: true,
  },
  // Null for personal tasks (no board).
  board: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Board',
    default: null,
    index: true,
  },
  // Who acted. For team actions this is the User (actorType 'user'). For Client
  // Portal actions there is no User — actorType is 'client' and `actorLabel`
  // carries the client's display name instead.
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function requireActorForUserEvents() {
      return this.actorType !== 'client';
    },
    default: null,
  },
  actorType: {
    type: String,
    enum: ['user', 'client'],
    default: 'user',
  },
  actorLabel: {
    type: String,
    default: '',
  },
  type: {
    type: String,
    enum: ACTIVITY_TYPES,
    required: true,
    index: true,
  },
  // Only set when type === 'task.field_changed'.
  field: {
    type: String,
    enum: FIELD_KEYS,
    default: null,
  },
  // Raw ObjectId, string, date, or array. Resolved to display values in the GET response.
  oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
  newValue: { type: mongoose.Schema.Types.Mixed, default: null },
  // Free-form context: { itemText, attachmentName, commentSnippet, updateSnippet, taskName }.
  metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

// Compound index: paginated reads filter by task and sort by createdAt desc.
activityLogSchema.index({ task: 1, createdAt: -1 });

const Model = mongoose.model('ActivityLog', activityLogSchema);
Model.ACTIVITY_TYPES = ACTIVITY_TYPES;
Model.FIELD_KEYS = FIELD_KEYS;

module.exports = Model;

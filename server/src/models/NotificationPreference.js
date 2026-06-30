const mongoose = require('mongoose');

/**
 * Per-channel on/off for a notification category. Both default on, so a missing
 * preference document means "everything enabled".
 */
const channelSchema = new mongoose.Schema(
  {
    inApp: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
  },
  { _id: false }
);

/**
 * NotificationPreference — per-user delivery preferences.
 *
 * Categories gate whether a notification of that kind is created (in-app) and/or
 * emailed. The DND window suppresses real-time delivery (SSE push / toast) and
 * email during quiet hours, while still recording the in-app notification so the
 * user sees it later in the bell.
 *
 * A user with no document has all categories on and DND off.
 */
const notificationPreferenceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    categories: {
      assignments: { type: channelSchema, default: () => ({}) },
      mentions: { type: channelSchema, default: () => ({}) },
      statusChanges: { type: channelSchema, default: () => ({}) },
      updates: { type: channelSchema, default: () => ({}) },
      dueDates: { type: channelSchema, default: () => ({}) },
      taskMoves: { type: channelSchema, default: () => ({}) },
      invites: { type: channelSchema, default: () => ({}) },
    },
    // Do-Not-Disturb quiet hours, expressed as minutes from midnight in the
    // server's local time. An end < start denotes an overnight window
    // (e.g. 1320 → 420 == 22:00 → 07:00).
    dnd: {
      enabled: { type: Boolean, default: false },
      startMinute: { type: Number, default: 1320 },
      endMinute: { type: Number, default: 420 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('NotificationPreference', notificationPreferenceSchema);

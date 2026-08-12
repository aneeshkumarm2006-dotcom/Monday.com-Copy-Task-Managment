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
 *
 * On top of the per-category channels, three email-only mute switches let a user
 * quiet the inbox without touching in-app: `emailMasterOff` (pause ALL email),
 * `mutedBoards` (no email from these boards), and `mutedActors` (no email for
 * actions by these people). These are applied by filterByEmailPreference.
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
      // Month-end goal reminders on tracker boards. Given its own category
      // rather than folded into `dueDates` because an unmapped type is ALWAYS
      // delivered (see TYPE_CATEGORY in notificationService), and a recurring
      // monthly nag with no off switch is how a workspace learns to ignore the
      // bell entirely.
      goals: { type: channelSchema, default: () => ({}) },
    },
    // ---- Email mute switches (email channel only; in-app is unaffected) ----
    // Master kill-switch: when true, NO email notifications are sent to this
    // user, regardless of per-category settings. In-app notifications still land.
    emailMasterOff: { type: Boolean, default: false },
    // Silence email for anything happening on these specific boards.
    mutedBoards: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'Board' },
    ],
    // Silence email for anything triggered by these specific people (the actor).
    mutedActors: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ],
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

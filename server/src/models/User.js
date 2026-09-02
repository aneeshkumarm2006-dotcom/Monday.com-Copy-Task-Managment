const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: {
    type: String,
    required: true,
    unique: true,
  },
  name: {
    type: String,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  profilePic: {
    type: String,
  },
  /**
   * IANA zone, synced from the browser on app load (PUT /api/profile/timezone).
   * What makes "9am" mean THIS person's 9am for the morning due-task digest —
   * the same reason Tracker refuses to default its zone: a digest silently on
   * UTC for a team in Calcutta arrives at 2:30 in the afternoon. Null until the
   * first app-open after this shipped; utils/dueDigest.js falls back to the
   * majority board zone until then.
   */
  timezone: {
    type: String,
    default: null,
    trim: true,
    maxlength: 64,
  },
  organisations: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organisation',
  }],
  // Opt-in extras — tools that are deliberately OFF for everybody until the
  // person turns them on in Settings → Extra features. This is a second,
  // independent gate on top of the capability: holding `board.export_activity`
  // says you MAY export, `features.activityExport` says you have asked to.
  // Both are checked server-side; neither is inferred from the other.
  //
  // Absence means off. Existing user documents carry no `features` at all, so
  // every read must tolerate `undefined` (`user.features?.activityExport`)
  // rather than assuming the default has been written.
  features: {
    activityExport: { type: Boolean, default: false },
    // Group tags — the per-group equivalent of a task's tags column. Off means
    // the board header draws no tag chips and no tag button, and every group-tag
    // WRITE is refused server-side. Tags already set by someone else stay on the
    // group documents untouched; they are simply not shown to you.
    groupTags: { type: Boolean, default: false },
    // `trackers` used to live here and was removed when the Delivery view became
    // part of the tracker board type. Stale `features.trackers` values may still
    // sit on existing user documents; Mongoose ignores an unmapped path on read
    // and strict mode drops it on the next save, so no migration is required.
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('User', userSchema);

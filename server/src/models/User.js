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
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('User', userSchema);

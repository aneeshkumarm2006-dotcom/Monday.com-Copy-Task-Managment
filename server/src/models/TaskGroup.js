const mongoose = require('mongoose');

const taskGroupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  board: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Board',
  },
  order: {
    type: Number,
    default: 0,
  },
  // ---- Client Portal fields (only meaningful when the parent board is a
  // 'client' board — the controller gates every write on board.boardType). A
  // group in a client board represents one client company; the link is minted
  // the moment the group is created and the invite goes out by email. ----
  //
  // Whether the shareable client link is currently live. Disabling instantly
  // closes the portal without discarding the token.
  portalEnabled: {
    type: Boolean,
    default: false,
  },
  // The public link id (crypto.randomBytes hex). Present in the URL the client
  // opens: `${CLIENT_URL}/portal/${portalToken}`. Regenerating rotates it and
  // invalidates the old link.
  //
  // NO `default` on purpose: the field must be ABSENT (not null) on groups
  // without a portal. A sparse index skips absent fields but DOES index null
  // values, so a `default: null` would put every group's null into the unique
  // index and the second such group would collide (E11000). Absent → not indexed.
  portalToken: {
    type: String,
  },
  // Friendly client/company label shown on the client's dashboard header.
  // Falls back to the group `name` when empty.
  portalClientName: {
    type: String,
    default: '',
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Unique only among groups that actually carry a token; null tokens are exempt.
taskGroupSchema.index({ portalToken: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('TaskGroup', taskGroupSchema);

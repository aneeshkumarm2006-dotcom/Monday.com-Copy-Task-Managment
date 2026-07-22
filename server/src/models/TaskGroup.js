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
  // group in a client board represents one client company; enabling the portal
  // mints a link + passcode the team shares out-of-band. ----
  //
  // Whether the shareable client link is currently live. Disabling instantly
  // closes the portal without discarding the token/passcode.
  portalEnabled: {
    type: Boolean,
    default: false,
  },
  // The public link id (crypto.randomBytes hex). Present in the URL the client
  // opens: `${CLIENT_URL}/portal/${portalToken}`. Regenerating rotates it and
  // invalidates the old link. Sparse+unique so non-portal groups (null) don't
  // collide on the unique index.
  portalToken: {
    type: String,
    default: null,
  },
  // scrypt(passcode, salt) — never the raw passcode. Compared with
  // timingSafeEqual on the request-link step. See utils/portalCrypto.js.
  portalPasscodeHash: {
    type: String,
    default: null,
  },
  portalPasscodeSalt: {
    type: String,
    default: null,
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

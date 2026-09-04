const mongoose = require('mongoose');

/**
 * A CLIENT CONTACT's read marker for a chat channel — the exact counterpart of
 * [ChannelRead](./ChannelRead.js), for the other kind of principal.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SECOND COLLECTION AND NOT A NULLABLE FIELD ON ChannelRead
 * ---------------------------------------------------------------------------
 *
 * The obvious move is to add `contact` to `ChannelRead` and make `user`
 * optional. It does not work, and the reason is worth writing down because it
 * looks like it should.
 *
 * `ChannelRead`'s index is `{channel, user}` UNIQUE and NOT partial. A unique
 * index reads a missing field as null, so the first contact row would store
 * `(channel, null)` and the SECOND contact row in the same channel would
 * collide with it — a client silently unable to mark a room read, reported as
 * a 500 from a request nobody thinks of as a write.
 *
 * Fixing that means dropping and recreating a unique index on chat's hottest
 * small collection. During the rebuild the constraint does not exist; one
 * duplicate inserted in that window makes `createIndex(unique)` fail, and the
 * collection is then left permanently unguarded — with the failure showing up
 * in a build log rather than anywhere a person looks.
 *
 * A new collection has no such window. It costs one small index and buys a
 * migration that cannot half-happen.
 *
 * The `$max`-never-backwards rule is NOT restated here: both collections are
 * written only through `services/chatRead.js`, which is the single
 * implementation of it.
 */
const channelContactReadSchema = new mongoose.Schema(
  {
    channel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      required: true,
    },
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientContact',
      required: true,
    },
    lastReadAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

// Plain unique, not partial: BOTH fields are required, so neither can be null
// and the trap described above cannot arise here.
channelContactReadSchema.index({ channel: 1, contact: 1 }, { unique: true });
// The portal computes unread for every visible surface for one contact.
channelContactReadSchema.index({ contact: 1 });

module.exports = mongoose.model('ChannelContactRead', channelContactReadSchema);

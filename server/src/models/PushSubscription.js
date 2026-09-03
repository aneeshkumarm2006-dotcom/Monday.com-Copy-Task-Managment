const mongoose = require('mongoose');

/**
 * One browser's Web Push subscription.
 *
 * A subscription belongs to a BROWSER, not to a person: the same user signed in
 * on a laptop, a phone and an installed PWA is three rows, and a push has to go
 * to all of them. That is why `endpoint` is the unique key rather than `user` —
 * the browser mints the endpoint and it is the only stable identifier we get.
 *
 * The row is also the master switch. No subscription means no push, full stop,
 * with no preference to consult: turning notifications off in Settings deletes
 * the row for that browser, and revoking permission at the OS level makes the
 * endpoint start returning 404/410, which `pushService` cleans up on its own.
 *
 * `user` can CHANGE on an existing endpoint — one browser, two people (a shared
 * machine, or signing out and back in as someone else). Upserting on endpoint
 * and overwriting `user` is what stops the previous person's notifications from
 * continuing to arrive on a browser that is now somebody else's.
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // The push service URL the browser gave us. Unique across all users.
    endpoint: { type: String, required: true, unique: true },
    // The two keys the browser generates for payload encryption. Without them
    // a push can only be an empty "wake up" with no content.
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    // Purely for the Settings list, so a person can tell which row is which
    // device before removing one. Best-effort, from the client's user-agent.
    deviceLabel: { type: String, default: '', maxlength: 120 },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);

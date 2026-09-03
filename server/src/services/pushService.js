const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

/**
 * Web Push delivery.
 *
 * This is the third notification channel, beside the in-app bell and email, and
 * the only one that reaches somebody who does not have Macan open. It rides the
 * SAME gates as the other two — category preferences and Do-Not-Disturb are
 * applied by notificationService before this is ever called, so there is no
 * second set of rules here to drift out of step with the first.
 *
 * CONFIGURED, OR SILENT. Without VAPID keys in the environment this module does
 * nothing and says so once at boot. It never throws: a workspace running
 * without keys keeps its bell and its email, and the only thing that does not
 * happen is the push. Half a notification system is better than a crash loop.
 */

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
// Push services want a contact for the sender. Any mailto: works; it is only
// ever used if they need to tell us we are misbehaving.
const CONTACT = process.env.VAPID_SUBJECT || 'mailto:support@davnoot.com';

const isConfigured = Boolean(PUBLIC_KEY && PRIVATE_KEY);

if (isConfigured) {
  webpush.setVapidDetails(CONTACT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.warn(
    '[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications are off.'
  );
}

/** The key the browser needs to subscribe. Public by design. */
const getPublicKey = () => PUBLIC_KEY;

/**
 * A push service replying 404 or 410 means this endpoint is DEAD — the browser
 * was uninstalled, the permission revoked, the profile wiped. It will never
 * work again, so the row is deleted rather than retried.
 *
 * Every other failure (a timeout, a 500 from the push service, a 429) is
 * transient and the row is left alone. Deleting on a transient error would
 * silently unsubscribe people whose only crime was a bad minute on someone
 * else's infrastructure.
 */
const isGone = (statusCode) => statusCode === 404 || statusCode === 410;

/**
 * Send one payload to every browser a user has registered.
 *
 * Best-effort and never throws: a delivery failure must not roll back the
 * notification that triggered it. Returns the number of endpoints that accepted
 * the push, which is only used for logging.
 */
const sendToUser = async (userId, payload) => {
  if (!isConfigured || !userId) return 0;

  let subs;
  try {
    subs = await PushSubscription.find({ user: userId }).lean();
  } catch (err) {
    console.error('[push] could not load subscriptions:', err.message);
    return 0;
  }
  if (subs.length === 0) return 0;

  const body = JSON.stringify(payload);
  const dead = [];
  let delivered = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          },
          body,
          // A notification nobody read within a day is noise by the time it
          // arrives, so let the push service drop it rather than deliver it
          // stale on the next reconnect.
          { TTL: 60 * 60 * 24 }
        );
        delivered += 1;
      } catch (err) {
        if (isGone(err.statusCode)) {
          dead.push(sub.endpoint);
        } else {
          console.error(
            `[push] send failed (${err.statusCode || 'no status'}):`,
            err.message
          );
        }
      }
    })
  );

  if (dead.length > 0) {
    try {
      await PushSubscription.deleteMany({ endpoint: { $in: dead } });
    } catch (err) {
      console.error('[push] could not prune dead subscriptions:', err.message);
    }
  }

  return delivered;
};

module.exports = {
  isConfigured,
  getPublicKey,
  sendToUser,
  // exported for tests
  isGone,
};

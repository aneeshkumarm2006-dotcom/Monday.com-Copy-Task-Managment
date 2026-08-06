const User = require('../models/User');

/**
 * The second gate — the person's own opt-in.
 *
 * Extra features (Settings → Extra features) are NOT permissions. A capability
 * answers "may this role do it at all"; a feature flag answers "has this person
 * asked for it". They are checked independently and neither is inferred from the
 * other, which is what lets a feature be off for everyone by default without
 * touching the permissions matrix.
 *
 * Hiding an affordance in the UI is a courtesy. THIS is what makes the switch
 * real: a user holding the capability but not the flag is refused, deliberately.
 *
 * Returns `null` when the feature is on, or `{ status, error, code }` to hand
 * straight back to the client. Callers should already have run their capability
 * check — this is the narrower of the two gates and belongs after it, so a user
 * who lacks the permission entirely never learns the feature exists.
 */
const requireFeature = async (userId, key, error) => {
  const me = await User.findById(userId).select('features').lean();
  if (me?.features?.[key]) return null;
  return { status: 403, error, code: 'FEATURE_DISABLED' };
};

module.exports = { requireFeature };

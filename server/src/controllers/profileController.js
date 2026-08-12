const User = require('../models/User');
const Organisation = require('../models/Organisation');
const Task = require('../models/Task');
const Update = require('../models/Update');
const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const ItemFollow = require('../models/ItemFollow');
const { cascadeDeleteOrg } = require('../services/orgCascade');

/**
 * PUT /api/profile — Update the current user's display name.
 */
const updateProfile = async (req, res) => {
  try {
    const { name } = req.body;

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { name: name.trim() },
      { new: true }
    ).select('-__v');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user });
  } catch (err) {
    console.error('updateProfile error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * The opt-in extras a user may switch on for themselves. Whitelisted rather than
 * spread from the body: `features` sits on the User document next to `email` and
 * `organisations`, so an unfiltered `$set` here would be a write primitive into
 * the identity record.
 */
// `trackers` was removed from this list when the Delivery view became part of
// the tracker board type rather than a personal opt-in. A client still sending
// it is ignored rather than rejected — the loop below is a whitelist.
const FEATURE_KEYS = ['activityExport', 'groupTags'];

/**
 * PUT /api/profile/features — toggle the current user's opt-in extras.
 *
 * Partial body: { activityExport: true }. Unknown keys and non-booleans are
 * ignored, so a client sending a wider object cannot flip anything it was not
 * offered.
 *
 * A feature being ON here does NOT grant permission — it only records that the
 * user asked for it. Every feature still checks its own capability at the point
 * of use (`board.export_activity` for the export, `column.manage` / `group.manage`
 * for group tags). A member who somehow sets this flag gains nothing.
 */
const updateFeatures = async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};

    for (const key of FEATURE_KEYS) {
      if (typeof body[key] === 'boolean') {
        update[`features.${key}`] = body[key];
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid feature flags supplied' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $set: update },
      { new: true }
    ).select('-__v');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user });
  } catch (err) {
    console.error('updateFeatures error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/profile/upload-avatar — Upload a new profile picture.
 * Multer + Cloudinary have already uploaded and transformed the image.
 * Here we just persist the resulting URL to the user record.
 */
const uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // multer-storage-cloudinary stores the Cloudinary URL on req.file.path
    const url = req.file.path || req.file.secure_url;

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { profilePic: url },
      { new: true }
    ).select('-__v');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user, profilePic: url });
  } catch (err) {
    console.error('uploadAvatar error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/profile — Permanently delete the current user's account.
 *
 * Cascade:
 *  - Orgs where user is the primary admin → delete org + all boards, groups,
 *    tasks, comments, and notifications inside them.
 *  - Orgs where user is only a member/extra-admin → remove from members/admins.
 *  - Personal tasks created by the user → deleted with their comments/notifications.
 *  - User removed from assignedTo on all remaining tasks.
 *  - All comments authored by the user → deleted.
 *  - All notifications addressed to the user → deleted.
 *  - User document → deleted.
 */
const deleteAccount = async (req, res) => {
  try {
    const userId = req.user.userId;

    // ── 1. Orgs where this user is the primary admin ──────────────────────
    const adminOrgs = await Organisation.find({ admin: userId }).select('_id');
    for (const org of adminOrgs) {
      await cascadeDeleteOrg(org._id);
    }

    // ── 2. Remove user from orgs they are only a member / extra-admin of ──
    await Organisation.updateMany(
      { members: userId },
      { $pull: { members: userId, admins: userId } }
    );

    // ── 3. Personal tasks this user created ───────────────────────────────
    const personalTaskIds = await Task.distinct('_id', {
      isPersonal: true,
      createdBy: userId,
    });
    if (personalTaskIds.length) {
      await Update.deleteMany({ task: { $in: personalTaskIds } });
      await Notification.deleteMany({ task: { $in: personalTaskIds } });
      await ItemFollow.deleteMany({ task: { $in: personalTaskIds } });
      await Task.deleteMany({ _id: { $in: personalTaskIds } });
    }

    // ── 4. Remove user from assignedTo on any remaining tasks ────────────
    await Task.updateMany({ assignedTo: userId }, { $pull: { assignedTo: userId } });

    // ── 5. Delete updates authored by the user ────────────────────────────
    await Update.deleteMany({ author: userId });

    // ── 6. Delete all notifications sent to the user + their prefs/follows ─
    await Notification.deleteMany({ user: userId });
    await NotificationPreference.deleteMany({ user: userId });
    await ItemFollow.deleteMany({ user: userId });

    // ── 7. Delete the user document ───────────────────────────────────────
    await User.findByIdAndDelete(userId);

    return res.json({ message: 'Account deleted' });
  } catch (err) {
    console.error('deleteAccount error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  updateProfile,
  updateFeatures,
  uploadAvatar,
  deleteAccount,
};

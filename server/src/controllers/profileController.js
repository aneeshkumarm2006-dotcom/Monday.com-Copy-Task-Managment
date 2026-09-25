const User = require('../models/User');
const { cascadeDeleteOrg } = require('../services/orgCascade');
const { ownedOrgBlockers, cascadeDeleteUser } = require('../services/userCascade');
const { isValidTimezone } = require('../utils/tzDay');
const { isDisplayCurrency, DISPLAY_CURRENCIES } = require('../utils/money');

/**
 * PUT /api/profile/timezone — record the browser's resolved IANA zone.
 *
 * Fired silently by the client on app load whenever the browser's zone differs
 * from the stored one — nobody chooses a timezone from a dropdown, the machine
 * already knows. Its own endpoint rather than a field on `updateProfile`,
 * because that handler requires `name` and this write must never be able to
 * touch the display name (or anything else) as a side effect.
 *
 * Read by the morning due-task digest, which is the whole reason it exists:
 * "9am" has to be this person's 9am. Invalid zones are refused rather than
 * stored — a zone Intl cannot parse would make the digest silently never fire
 * for this user, which is the worst failure a reminder can have.
 */
const updateTimezone = async (req, res) => {
  try {
    const { timezone } = req.body;
    if (typeof timezone !== 'string' || !isValidTimezone(timezone)) {
      return res.status(400).json({ error: 'That is not a recognised timezone.' });
    }
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { timezone },
      { new: true }
    ).select('_id timezone');
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ timezone: user.timezone });
  } catch (err) {
    console.error('updateTimezone error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/profile/currency — set the currency this person reads money in.
 *
 * Its own endpoint rather than a field on `updateProfile`, for the same reason
 * `updateTimezone` is: that handler REQUIRES `name`, and this write must never
 * be able to touch the display name (or anything else) as a side effect.
 *
 * Unlike the timezone, this is a CHOICE — nobody's browser knows what currency
 * they would rather read. So it is set from a toggle rather than synced
 * silently, and `null` is a first-class value meaning "show me amounts as they
 * were entered", which is what everybody gets until they pick something.
 *
 * Validated against the same `DISPLAY_CURRENCIES` the schema enumerates. A code
 * we cannot convert into would leave every figure silently unconverted with no
 * way to tell that from a missing rate.
 */
const updateDisplayCurrency = async (req, res) => {
  try {
    const { displayCurrency } = req.body || {};

    // Explicit null (or an empty string from a form) clears the choice back to
    // as-entered. Distinct from omitting the field, which is a malformed body.
    const clearing = displayCurrency === null || displayCurrency === '';
    const code = clearing ? null : String(displayCurrency || '').trim().toUpperCase();

    if (!clearing && !isDisplayCurrency(code)) {
      return res.status(400).json({
        error: `Currency must be one of ${DISPLAY_CURRENCIES.join(', ')}.`,
      });
    }

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { displayCurrency: clearing ? null : code },
      { new: true }
    ).select('_id displayCurrency');

    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ displayCurrency: user.displayCurrency });
  } catch (err) {
    console.error('updateDisplayCurrency error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

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
/**
 * GET /api/profile/deletion-preview — what deleting this account would do.
 *
 * Exists so the confirmation modal never has to GUESS at the blast radius. It
 * returns the same two lists `deleteAccount` computes, so the screen and the
 * server can never disagree about which workspaces block the delete.
 */
const deletionPreview = async (req, res) => {
  try {
    const { blocking, solo } = await ownedOrgBlockers(req.user.userId);
    return res.json({
      blocking,
      solo: solo.map((o) => ({ _id: o._id, name: o.name })),
      canDelete: blocking.length === 0,
    });
  } catch (err) {
    console.error('deletionPreview error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/profile — permanently delete this account.
 *
 * ---- THE REFUSAL IS THE FEATURE -------------------------------------------
 *
 * This handler used to loop every workspace where `admin === you` straight into
 * `cascadeDeleteOrg`. Clicking "Delete my account" therefore destroyed every
 * board, task, comment, attachment, vault, client roster and chat message
 * belonging to EVERYONE ELSE in every workspace you happened to own — with no
 * transaction, no export and no undo, behind a weaker confirmation than the app
 * already demands for deleting a single workspace (which makes you type its
 * name).
 *
 * It now refuses. A workspace with other people in it is theirs as much as
 * yours, and the repo already has the right action for this moment:
 * `POST /api/orgs/:id/transfer-ownership`, the only writer of
 * `Organisation.admin` after creation. So the 409 names each blocking workspace
 * and who is in it, and the client turns that into a link per workspace.
 *
 * The check runs over ALL owned orgs BEFORE anything is destroyed. Doing it per
 * org inside the loop would still half-destroy a workspace before hitting the
 * one that blocks — and since there is no transaction here, "we stopped partway"
 * is not a recoverable state.
 *
 * A workspace you are ALONE in is still cascaded: there is nobody to hand it to,
 * and leaving it would orphan every row in it.
 *
 * Everything else about the person is in `services/userCascade.js`, shared with
 * `orgController.removeMember` so the two can no longer drift.
 */
const deleteAccount = async (req, res) => {
  try {
    const userId = req.user.userId;

    // ── 1. Refuse if any workspace you own still has other people in it ──
    const { blocking, solo } = await ownedOrgBlockers(userId);
    if (blocking.length > 0) {
      return res.status(409).json({
        error:
          blocking.length === 1
            ? `"${blocking[0].name}" still has ${blocking[0].memberCount} other member${blocking[0].memberCount === 1 ? '' : 's'}. Transfer it to someone else, or remove them, before deleting your account.`
            : `${blocking.length} workspaces you own still have other members. Transfer or empty them before deleting your account.`,
        code: 'OWNED_WORKSPACES_NOT_EMPTY',
        orgs: blocking,
      });
    }

    // ── 2. Workspaces you are alone in go with you ──────────────────────
    for (const org of solo) {
      await cascadeDeleteOrg(org._id);
    }

    // ── 3. The person, and every delivery path to them ──────────────────
    await cascadeDeleteUser(userId);

    return res.json({ message: 'Account deleted' });
  } catch (err) {
    console.error('deleteAccount error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  updateTimezone,
  updateProfile,
  updateFeatures,
  uploadAvatar,
  deletionPreview,
  deleteAccount,
  updateDisplayCurrency,
};

const crypto = require('crypto');
const mongoose = require('mongoose');
const Organisation = require('../models/Organisation');
const Board = require('../models/Board');
const User = require('../models/User');
const { sendInviteEmail } = require('../services/emailService');
const { cascadeDeleteOrg } = require('../services/orgCascade');
const { revokeUserFromOrg } = require('../services/userCascade');
const { listCatalog } = require('../services/serviceCatalogService');
const connectorCrypto = require('../utils/connectorCrypto');
const {
  sanitizeFxSettings,
  keyPreviewOf,
  normaliseCurrencyCode,
  isOwnMoneyColumn,
  boardCurrencyOf,
  CURRENCY_CODES,
} = require('../utils/money');
const { createNotificationsForUsers } = require('../services/notificationService');
// Boards that FOLLOW the workspace currency move with it — see saveCurrencySettings.
const { relabelFollowingBoards, isFollowing } = require('../services/boardCurrency');
// Ownership transfer is the one event that can leave an executive view on the
// workspace owner, which invariant 8 forbids. See `transferOrgOwnership`.
const executiveView = require('../services/executiveView');
const { logExecutiveRemoved } = require('../services/executiveActivity');
const { resolveAccess, resolveOrgAccess, isOrgOwner } = require('../utils/permissions');
const { DEFAULT_ROLE_KEY, OWNER_ROLE_KEY } = require('../utils/capabilities');
const {
  sanitizeHoliday,
  sanitizeHolidays,
  sanitizeYear,
  holidayListOf,
  holidaysInYear,
  withProvenance,
  mergeProvenance,
  MAX_HOLIDAYS,
} = require('../utils/orgHolidays');

/**
 * Generate a short, unique invite code.
 */
const generateInviteCode = () => {
  return crypto.randomBytes(6).toString('hex'); // 12-char hex
};

/**
 * POST /api/orgs — Create a new organisation.
 * The creator becomes admin and first member.
 */
const createOrg = async (req, res) => {
  try {
    const { name, baseCurrency } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Organisation name is required' });
    }

    // Optional. A workspace that says what it bills in on day one is not
    // silently rupees until an admin finds the Currency tab — every board it
    // creates before then would be born in the wrong unit. Refused rather than
    // defaulted when it is present and not a code we carry.
    let currency = null;
    if (baseCurrency !== undefined && baseCurrency !== null && baseCurrency !== '') {
      currency = normaliseCurrencyCode(baseCurrency);
      if (!currency) {
        return res.status(400).json({ error: `Currency must be one of ${CURRENCY_CODES.join(', ')}.` });
      }
    }

    const userId = req.user.userId;

    const org = new Organisation({
      name: name.trim(),
      admin: userId,
      members: [userId],
      inviteCode: generateInviteCode(),
      ...(currency ? { baseCurrency: currency } : {}),
    });

    // Seed the permissions matrix. Every org gets every `SYSTEM_ROLES` preset
    // up front, so the matrix is never empty and the creator lands on `owner`
    // without any assignment being written. The preset list grows (executive was
    // the sixth), which is why nothing here names them.
    org.ensureSystemRoles();
    await org.save();

    // Attach org to user's organisations list
    await User.findByIdAndUpdate(userId, {
      $addToSet: { organisations: org._id },
    });

    return res.status(201).json({ org });
  } catch (err) {
    console.error('createOrg error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/orgs/:id — Get organisation details with populated members.
 */
const getOrg = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id)
      .populate('members', 'name email profilePic')
      .populate('admin', 'name email profilePic');

    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    // Only members can view org details
    const isMember = org.members.some(
      (m) => m._id.toString() === req.user.userId
    );
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    if (org.ensureSystemRoles()) await org.save();
    const access = resolveOrgAccess(org, req.user.userId);

    // Ship the caller's RESOLVED permissions with the org.
    //
    // The client used to re-derive `isAdmin` itself, from org.admin + org.admins,
    // in eight separate copy-pasted places. Every one of them was a chance for a
    // UI gate to drift from what the server actually enforces. Now the server
    // answers the question once and the client just reads the answer.
    return res.json({
      org,
      permissions: {
        role: access.role,
        isOwner: access.isOwner,
        capabilities: [...access.capabilities],
      },
    });
  } catch (err) {
    console.error('getOrg error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/orgs/join/:inviteCode — Join an organisation via invite code.
 */
const joinOrg = async (req, res) => {
  try {
    const { inviteCode } = req.params;
    const userId = req.user.userId;

    const org = await Organisation.findOne({ inviteCode });
    if (!org) {
      return res.status(404).json({ error: 'Invalid invite code' });
    }

    const alreadyMember = org.members.some((m) => m.toString() === userId);

    // Reconcile BOTH sides of the membership on every join — the org's
    // `members` array AND the user's `organisations` array. These are two
    // separate writes with no transaction, so a user can end up in
    // `org.members` without the org in their `user.organisations` (e.g. a prior
    // join whose second write failed). The old code only updated
    // `user.organisations` inside the `!alreadyMember` branch, so that desync
    // could never heal: the re-join returned 200 but left the user without the
    // org, and RequireOrg bounced them straight back to /onboarding every time.
    // Using $addToSet on both sides makes join idempotent and self-healing, and
    // fixes the read-modify-write race on `members` (IMPROVEMENTS.md B-L4).
    await Organisation.updateOne(
      { _id: org._id },
      { $addToSet: { members: userId } }
    );
    await User.findByIdAndUpdate(userId, {
      $addToSet: { organisations: org._id },
    });

    // Give the joiner the default role. Written on the same $addToSet-style
    // "reconcile, don't assume" principle as the membership above: an org that
    // predates the role system gets its matrix seeded here, and a re-join never
    // overwrites a role someone has already been given deliberately.
    if (org.ensureSystemRoles()) await org.save();
    const alreadyRoled = (org.memberRoles || []).some(
      (m) => m.user.toString() === userId
    );
    if (!alreadyRoled && !isOrgOwner(org, userId)) {
      const defaultRole = org.roleByKey(DEFAULT_ROLE_KEY);
      if (defaultRole) {
        await Organisation.updateOne(
          { _id: org._id },
          { $addToSet: { memberRoles: { user: userId, role: defaultRole._id } } }
        );
      }
    }

    // Only announce a genuinely new member so self-repair re-joins don't spam
    // admins. (The joiner redeemed an invite code, so there's no distinct
    // inviter to notify.)
    if (!alreadyMember) {
      const adminIds = [org.admin, ...(org.admins || [])].filter(Boolean);
      const joinerName = req.user.name || 'A new member';
      await createNotificationsForUsers({
        userIds: adminIds,
        type: 'memberJoined',
        message: `${joinerName} joined the workspace "${org.name}"`,
        orgId: org._id,
        excludeUserId: userId,
        actorId: userId,
      });
    }

    // Reflect the membership in the returned doc so the response is consistent
    // regardless of which branch ran (the client only reads _id/name, but keep
    // it truthful).
    if (!org.members.some((m) => m.toString() === userId)) {
      org.members.push(userId);
    }

    return res.json({ org });
  } catch (err) {
    console.error('joinOrg error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/orgs/:id/members — List members of an organisation.
 */
const listMembers = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id).populate(
      'members',
      'name email profilePic createdAt'
    );
    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    const isMember = org.members.some(
      (m) => m._id.toString() === req.user.userId
    );
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    if (org.ensureSystemRoles()) await org.save();

    const adminIds = Array.isArray(org.admins)
      ? org.admins.map((a) => a.toString())
      : [];

    // Each member's resolved role, so the members table can show a role chip
    // without the client re-implementing the resolution order (owner → explicit
    // assignment → legacy admins[] → default).
    const memberRoles = {};
    for (const m of org.members) {
      const role = resolveOrgAccess(org, m._id.toString()).role;
      if (role) memberRoles[m._id.toString()] = role;
    }

    const access = resolveOrgAccess(org, req.user.userId);

    return res.json({
      members: org.members,
      adminId: org.admin.toString(),
      adminIds,
      memberRoles,
      roles: org.roles.map((r) => ({
        id: r._id,
        key: r.key,
        name: r.name,
        color: r.color,
        isSystem: r.isSystem === true,
      })),
      permissions: {
        role: access.role,
        isOwner: access.isOwner,
        capabilities: [...access.capabilities],
      },
    });
  } catch (err) {
    console.error('listMembers error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/orgs/:id/members/:userId — Remove a member (admin only).
 */
const removeMember = async (req, res) => {
  try {
    const { id: orgId, userId: targetUserId } = req.params;

    const org = await Organisation.findById(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    // The owner cannot be removed
    if (org.admin.toString() === targetUserId) {
      return res.status(400).json({ error: 'The workspace owner cannot be removed' });
    }

    // You cannot remove someone who outranks you. Without this, the old rule
    // "only the owner may demote another admin" was trivially bypassable: an
    // admin who could not DEMOTE a peer could simply REMOVE them instead, which
    // stripped them from admins[] all the same.
    const requester = resolveOrgAccess(org, req.user.userId);
    if (!requester.isOwner) {
      const target = resolveOrgAccess(org, targetUserId);
      const outranks = [...target.capabilities].some(
        (c) => !requester.capabilities.has(c)
      );
      if (outranks) {
        return res
          .status(403)
          .json({ error: 'You cannot remove someone who outranks you' });
      }
    }

    // Membership on both documents, their role assignment, AND every row that
    // exists only because they could see this workspace — per-board grants,
    // follows, notifications, saved messages, read markers, muted boards and
    // their executive profile.
    //
    // This used to be three `filter`s and a `$pull`, which left all of the
    // above behind. That is not untidy, it is a live leak: the task-audience
    // fan-out keeps finding their ItemFollow rows and keeps delivering this
    // workspace's task names to somebody who was removed from it — over Web
    // Push, which they cannot unsubscribe from because the screen that would
    // let them is behind the access just taken away. `services/boardGrants.js`
    // `revoke` made exactly this argument for one board; this is the same fix
    // one scope up, and it is shared with account deletion so the two paths
    // cannot drift again.
    await revokeUserFromOrg({ userId: targetUserId, orgId: org._id, org });

    return res.json({ message: 'Member removed', org });
  } catch (err) {
    console.error('removeMember error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/orgs/:id/regenerate-invite — Generate a new invite code (admin only).
 */
const regenerateInvite = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id);
    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    org.inviteCode = generateInviteCode();
    await org.save();

    return res.json({ inviteCode: org.inviteCode });
  } catch (err) {
    console.error('regenerateInvite error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/orgs/:id/send-invite — Send an invite email to a given address (admin only).
 */
const sendInvite = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const org = await Organisation.findById(req.params.id);
    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const inviteLink = `${clientUrl}/onboarding?invite=${org.inviteCode}`;

    await sendInviteEmail({
      to: email.trim(),
      orgName: org.name,
      inviteLink,
      inviteCode: org.inviteCode,
    });

    return res.json({ message: 'Invite sent successfully' });
  } catch (err) {
    console.error('sendInvite error:', err);
    return res.status(500).json({ error: 'Failed to send invite' });
  }
};

// Role assignment moved to roleController.assignRole. The old `changeRole` could
// only toggle between two hardcoded strings, pushing and pulling the user's id on
// `org.admins[]` — it was the clearest symptom of roles not being data. It is
// superseded, not merely renamed: the new endpoint assigns any role, including
// custom ones, and enforces the no-escalation rules.

/**
 * POST /api/orgs/:id/transfer-ownership — hand the workspace to another member.
 *
 * Body: { userId }
 *
 * `org.admin` is the workspace's root of trust: the resolver short-circuits it to
 * every capability unconditionally, precisely so a bad matrix edit can never lock
 * the owner out of their own workspace. That is also why ownership could not be
 * reached through `assignRole` — the owner role is not assignable there, and it
 * should not be, because moving ownership is not "changing a role". It is moving
 * the identity the role system refuses to constrain, and it has to be one atomic
 * write that never leaves the org with zero owners or two.
 *
 * Gate: `requireOrgOwner` on the route. Deliberately NOT a capability — like
 * deleting the org, this is the one action no role may ever be granted, because
 * a delegate who can appoint an owner can appoint themselves.
 *
 * THE OUTGOING OWNER BECOMES AN ADMIN, not a plain member. They lose the
 * unconditional short-circuit — there is exactly one owner — but keeping the
 * workspace running is usually still their job the day after they hand over the
 * title, and silently demoting them to Member would strip the invite, role and
 * settings powers they had a minute ago. The new owner can change it like any
 * other role assignment.
 *
 * THE INCOMING OWNER LOSES THEIR EXECUTIVE VIEW, if they had one. That is the
 * opposite decision for the opposite reason, and it is spelled out at the line
 * that does it below: the outgoing owner keeps powers they still need, while
 * the incoming owner's curated view describes a smaller workspace than the one
 * they now reach in full.
 */
const transferOrgOwnership = async (req, res) => {
  try {
    // requireOrgOwner already loaded the org and proved the caller owns it.
    const org = req.org;
    const { userId: targetUserId } = req.body || {};

    if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ error: 'Valid userId required' });
    }

    const previousOwnerId = String(org.admin);
    if (String(targetUserId) === previousOwnerId) {
      return res.status(400).json({ error: 'You already own this workspace' });
    }

    const isMember = org.members.some(
      (m) => String(m?._id || m) === String(targetUserId)
    );
    if (!isMember) {
      return res
        .status(400)
        .json({ error: 'User is not a member of this workspace' });
    }

    org.ensureSystemRoles();

    org.admin = targetUserId;

    // Rewrite BOTH role assignments in one pass. The owner's assignment is
    // cosmetic — the resolver answers by identity, not by stored role — but a
    // memberRoles row saying "Member" under the person who owns the workspace is
    // the kind of stale data somebody eventually trusts.
    const ownerRole = org.roleByKey(OWNER_ROLE_KEY);
    const adminRole = org.roleByKey('admin');
    org.memberRoles = (org.memberRoles || []).filter(
      (m) =>
        String(m.user) !== String(targetUserId) &&
        String(m.user) !== previousOwnerId
    );
    if (ownerRole) {
      org.memberRoles.push({ user: targetUserId, role: ownerRole._id });
    }
    if (adminRole) {
      org.memberRoles.push({ user: previousOwnerId, role: adminRole._id });
    }

    // Keep the legacy array truthful for the not-yet-migrated fallback path in
    // `roleForUser`, exactly as assignRole does: the new owner does not need to
    // be in it (identity wins), the old owner now does.
    const admins = new Set((org.admins || []).map((a) => String(a)));
    admins.delete(String(targetUserId));
    admins.add(previousOwnerId);
    org.admins = [...admins];

    await org.save();

    // THE NEW OWNER CANNOT HAVE AN EXECUTIVE VIEW — invariant 8 — and this
    // endpoint is the only way in the app to break that rule, because it is the
    // only one that makes somebody an owner AFTER they already have a profile.
    // An Executive handed the workspace would otherwise keep a curated list of
    // four boards on the very day they started implicitly reaching all of them,
    // and would lose the dashboard and the full board list at the moment they
    // became the one person who cannot be locked out of anything.
    //
    // DELETED rather than left to the read guard. `executiveViewController`
    // already refuses to serve an owner's profile (`ownerIsNeverAnExecutive`),
    // so leaving the document would not reach their screen — but it would keep
    // them in the workspace's Executives strip as somebody every other surface
    // says is not one, and it would be a document no read will ever serve
    // again. Deleting it is honest and it is cheap: a profile is a VIEW, not
    // data (invariant 3), so removing it restores the standard app with nothing
    // to migrate. The header above is careful not to strand the OUTGOING owner,
    // who genuinely loses powers here; this strands nobody, because the
    // incoming owner gains every board and every capability in the same write.
    // There is nothing in the deleted document they can no longer reach.
    //
    // AFTER the save, never before: had the transfer failed we would have
    // deleted the view of somebody who is still not the owner, which is real
    // loss for no reason. And its own failure is not the transfer's failure —
    // ownership has already moved and the read guard makes the state correct
    // either way — so it is caught here rather than allowed to 500 a workspace
    // that has just changed hands.
    try {
      const { removed, profile } = await executiveView.remove(
        org,
        targetUserId,
        { actor: req.user.userId }
      );
      if (removed) {
        // One projected read, and only when something was actually deleted: the
        // row has to keep reading after the profile it describes is gone, which
        // is why every executive row denormalises the name.
        const target = await User.findById(targetUserId).select('name').lean();
        logExecutiveRemoved({
          organisation: org._id,
          targetUser: { _id: targetUserId, name: target?.name || '' },
          // The outgoing owner: they pressed the button this followed from.
          actor: req.user.userId,
          boardCount: (profile?.boards || []).length,
        });
      }
    } catch (err) {
      console.error('transferOrgOwnership: executive view cleanup failed:', err);
    }

    const actor = await User.findById(previousOwnerId).select('name email').lean();
    const actorName = actor?.name || actor?.email || 'The previous owner';

    await createNotificationsForUsers({
      userIds: [targetUserId],
      type: 'ownershipTransferred',
      message: `${actorName} made you the owner of the workspace "${org.name}"`,
      orgId: org._id,
      actorId: previousOwnerId,
    });

    const access = resolveOrgAccess(org, req.user.userId);

    return res.json({
      message: 'Ownership transferred',
      org,
      permissions: {
        role: access.role,
        isOwner: access.isOwner,
        capabilities: [...access.capabilities],
      },
    });
  } catch (err) {
    console.error('transferOrgOwnership error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/orgs/:id — Permanently delete an organisation (owner only).
 * Cascades through all boards, tasks, groups, comments, updates, notifications,
 * automations, and removes the org reference from every member's profile.
 *
 * Gate: requireOrgOwner middleware. Only the primary admin (org.admin) can call
 * this — extra admins in org.admins[] are blocked.
 */
const deleteOrg = async (req, res) => {
  try {
    const orgId = req.params.id;
    await cascadeDeleteOrg(orgId);
    return res.json({ message: 'Organisation deleted' });
  } catch (err) {
    console.error('deleteOrg error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/* -------------------------------------------------------------------------- */
/* Company holidays                                                           */
/*                                                                            */
/* The workspace holiday calendar. Reading is open to any member — knowing the */
/* office is shut on the 15th is not a privilege, and every date-aware surface */
/* in the client needs it to render honestly. Writing needs                    */
/* `org.manage_settings`, enforced by the route middleware, which also hands   */
/* us `req.org` already loaded.                                               */
/*                                                                            */
/* Shape and sanitizers live in utils/orgHolidays.js.                         */
/* -------------------------------------------------------------------------- */


/**
 * Persist a cleaned list and reply with the canonical collection.
 *
 * Writes through `updateOne` rather than `doc.save()`.
 *
 * WHY: the Settings editor saves the name on blur and each effect on click, so
 * two writes to this array overlap on the natural flow. Both requests load
 * their own copy of the org, and `save()` carries an optimistic-concurrency
 * check on `__v` — the second one lost the race with a VersionError, which
 * surfaced as a 500 AND silently dropped the edit. An unconditional `$set` has
 * no version to disagree about.
 *
 * Everything is flattened to PLAIN objects on the way in; handing a Mongoose
 * DocumentArray back to the path it came from is the kind of thing that works
 * until it does not.
 */
const normaliseHolidayRow = (h) => ({
  date: h.date,
  name: h.name || '',
  affects: {
    delivery: h.affects?.delivery !== false,
    automations: h.affects?.automations !== false,
  },
  by: h.by,
  at: h.at,
});

const saveHolidaysAndReturn = async (org, list, res) => {
  const holidays = (list || []).map(normaliseHolidayRow);
  await Organisation.updateOne({ _id: org._id }, { $set: { holidays } });
  return res.json({ holidays: holidayListOf(holidays) });
};

/**
 * Re-read and reply. Used by the atomic single-date paths, which do not hold a
 * correct in-memory copy after the write.
 */
const rereadAndReturn = async (orgId, res) => {
  const fresh = await Organisation.findById(orgId).select('holidays').lean();
  return res.json({ holidays: holidayListOf(fresh) });
};


/**
 * GET /api/orgs/:id/holidays[?year=2026] — any member.
 */
const listHolidays = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id).select('members holidays');
    if (!org) return res.status(404).json({ error: 'Organisation not found' });

    const isMember = org.members.some((m) => m.toString() === req.user.userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    if (req.query.year !== undefined) {
      const y = sanitizeYear(req.query.year);
      if (y.error) return res.status(400).json({ error: y.error });
      return res.json({ holidays: holidaysInYear(org, y.value) });
    }

    return res.json({ holidays: holidayListOf(org) });
  } catch (err) {
    console.error('listHolidays error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/orgs/:id/holidays — bulk save ONE year: { year, holidays: [...] }.
 *
 * REPLACES ONLY THAT YEAR. This is the one endpoint here that can lose data, so
 * the rule is explicit rather than implied: every other year is carried through
 * untouched, and a date in the payload that falls outside `year` is rejected
 * rather than quietly filed. Without that check a stale tab showing 2026 could
 * post a 2027 date, which the next save of 2027 would then wipe.
 */
const saveHolidays = async (req, res) => {
  try {
    const org = req.org;

    const y = sanitizeYear(req.body.year);
    if (y.error) return res.status(400).json({ error: y.error });

    const cleaned = sanitizeHolidays(req.body.holidays);
    if (cleaned.error) return res.status(400).json({ error: cleaned.error });

    const prefix = y.value + '-';
    const stray = cleaned.value.find((h) => !h.date.startsWith(prefix));
    if (stray) {
      return res.status(400).json({ error: stray.date + ' is not in ' + y.value });
    }

    const otherYears = (org.holidays || []).filter(
      (h) => !String(h.date).startsWith(prefix)
    );

    if (otherYears.length + cleaned.value.length > MAX_HOLIDAYS) {
      return res.status(400).json({ error: 'At most ' + MAX_HOLIDAYS + ' holidays' });
    }

    const thisYear = mergeProvenance(
      cleaned.value,
      (org.holidays || []).filter((h) => String(h.date).startsWith(prefix)),
      req.user.userId
    );

    const merged = [...otherYears, ...thisYear].sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );

    return await saveHolidaysAndReturn(org, merged, res);
  } catch (err) {
    console.error('saveHolidays error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/orgs/:id/holidays/:date — upsert one day, { name?, affects? }.
 *
 * The quick-mark path used from the calendar day cell. Deliberately its own
 * route rather than a degenerate bulk save: marking tomorrow off should not
 * require the client to hold, and resend, the whole year.
 *
 * PARTIAL on an existing day: a field the caller omits is left alone. The
 * Settings editor saves the name on blur and each effect on click, and those
 * are separate requests that can overlap — a whole-entry PUT would mean
 * whichever landed second overwrote the other with the stale half it was
 * holding. Creating a day still applies the defaults, so an omitted `affects`
 * on a NEW day means "stops everything", which is what a holiday means.
 */
const setHoliday = async (req, res) => {
  try {
    const org = req.org;

    const one = sanitizeHoliday({
      date: req.params.date,
      name: req.body.name,
      affects: req.body.affects,
    });
    if (one.error) return res.status(400).json({ error: one.error });

    const { date } = one.value;

    const current = await Organisation.findById(org._id).select('holidays').lean();
    const list = current?.holidays || [];

    // ADD, when the day is not marked yet.
    //
    // `$push` is used rather than an `arrayFilters` upsert because it is the
    // only one of the two that works when the `holidays` field is ABSENT — the
    // state of every organisation created before this feature existed. Mongo
    // rejects the other with "The path 'holidays' must exist in the document in
    // order to apply array updates", which is a 500 on the very first click for
    // exactly the workspaces that have been around longest.
    //
    // `$ne` guards it so two concurrent creates cannot double-insert, and
    // `$sort` keeps the array ordered without a read-modify-write.
    if (!list.some((h) => h.date === date)) {
      if (list.length >= MAX_HOLIDAYS) {
        return res.status(400).json({ error: `At most ${MAX_HOLIDAYS} holidays` });
      }

      const inserted = await Organisation.updateOne(
        { _id: org._id, 'holidays.date': { $ne: date } },
        {
          $push: {
            holidays: {
              $each: [withProvenance(one.value, req.user.userId)],
              $sort: { date: 1 },
            },
          },
        }
      );

      if (inserted.modifiedCount > 0) return rereadAndReturn(org._id, res);
      // Somebody else created it between the read and the push. Fall through
      // and apply this request's fields to the row that won.
    }

    // UPDATE in place, touching only the fields the caller actually sent, so
    // two overlapping edits to the same day compose instead of one overwriting
    // the other with the stale half it was holding.
    const $set = {
      'holidays.$[el].by': req.user.userId,
      'holidays.$[el].at': new Date(),
    };
    if (req.body.name !== undefined) $set['holidays.$[el].name'] = one.value.name;
    if (req.body.affects !== undefined) {
      $set['holidays.$[el].affects.delivery'] = one.value.affects.delivery;
      $set['holidays.$[el].affects.automations'] = one.value.affects.automations;
    }

    await Organisation.updateOne(
      { _id: org._id },
      { $set },
      { arrayFilters: [{ 'el.date': date }] }
    );

    return rereadAndReturn(org._id, res);
  } catch (err) {
    console.error('setHoliday error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};


/** DELETE /api/orgs/:id/holidays/:date — unmark one day. */
const deleteHoliday = async (req, res) => {
  try {
    const org = req.org;

    if (sanitizeHoliday({ date: req.params.date }).error) {
      return res.status(400).json({ error: 'Invalid date' });
    }

    await Organisation.updateOne(
      { _id: org._id },
      { $pull: { holidays: { date: req.params.date } } }
    );

    return rereadAndReturn(org._id, res);
  } catch (err) {
    console.error('deleteHoliday error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};


/* -------------------------------------------------------------------------- */
/* Service catalog                                                            */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/orgs/:id/service-catalog — the workspace's service vocabulary.
 *
 * Any member, because this is a dropdown's contents and not a secret: the names
 * an agency sells are on its own website. Gating it on a capability would mean a
 * contributor opening the invite table sees an empty list and types a duplicate
 * of a service that already exists, which is the exact outcome the catalog is
 * there to prevent.
 *
 * READ ONLY, and there is deliberately no sibling POST. Entries are minted by
 * USING a service (`services/serviceCatalogService.recordServiceUse`, called
 * from the batch invite), so the catalog cannot accumulate names nobody ever put
 * on a board. Rename / recolour / archive is a later change; when it comes the
 * capability is `org.manage_settings`, the key the holiday calendar already
 * uses — do not invent a new one, `utils/capabilities.js` is curated.
 */
const listServiceCatalog = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id).select('members');
    if (!org) return res.status(404).json({ error: 'Organisation not found' });

    const isMember = (org.members || []).some(
      (m) => String(m?._id || m) === String(req.user.userId)
    );
    if (!isMember) return res.status(403).json({ error: 'Not a member of this organisation' });

    const services = await listCatalog(req.params.id);
    return res.json({ services });
  } catch (err) {
    console.error('listServiceCatalog error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};


// ---------------------------------------------------------------------------
// Currency + exchange rates
//
// Read is open to any member and write is gated on `org.manage_settings` — the
// same split, and the same reasoning, as the holiday calendar above: every
// screen in the product needs to know what currency this workspace works in,
// and almost nobody may change it.
//
// The capability is REUSED rather than invented. `org.manage_settings` already
// means "rename the workspace, rotate the invite code", and utils/capabilities.js
// is a curated catalog — a new key here would also mean a migration script to
// grant it to everyone who already has it.
// ---------------------------------------------------------------------------

/**
 * What a client is allowed to know about this workspace's currency setup.
 *
 * Built by hand rather than by spreading `org.fx`, and that is the point: the
 * sealed key must never leave the server. `select: false` on the field is the
 * first guard and this function is the second, because a projection is easy to
 * widen by accident and a hand-written object is not.
 */
const currencySettingsOf = (org) => ({
  baseCurrency: org?.baseCurrency || 'INR',
  provider: org?.fx?.provider || 'frankfurter',
  cadence: org?.fx?.cadence || 'monthly',
  // Whether a key is installed, never the key. `keyPreview` is the last four
  // characters so somebody can tell two keys apart on screen.
  hasApiKey: !!org?.fx?.keyPreview,
  keyPreview: org?.fx?.keyPreview || '',
  lastFetchAt: org?.fx?.lastFetchAt || null,
  lastError: org?.fx?.lastError || '',
});

/**
 * GET /api/orgs/:id/currency — any member.
 *
 * No capability middleware runs on this route, so membership is checked inline
 * exactly as `listHolidays` does.
 */
const getCurrencySettings = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id).select(
      'members baseCurrency fx'
    );
    if (!org) return res.status(404).json({ error: 'Organisation not found' });

    const isMember = org.members.some((m) => m.toString() === req.user.userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    return res.json({ currency: currencySettingsOf(org) });
  } catch (err) {
    console.error('getCurrencySettings error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * A workspace relabel's result as THIS caller may be told it: only the boards
 * they can read.
 *
 * The relabel itself reaches every following board — the workspace currency
 * is the workspace's, private boards included. But `org.manage_settings` is a
 * workspace power, not a key to every private board (the same line
 * `listMoneyBoards` draws), so the ids — and the count, which is what the
 * Currency tab says out loud — are of the boards the caller can see. A board
 * they cannot open is also one they could do nothing about had it failed.
 */
const relabelledVisibleTo = async (org, userId, result) => {
  const ids = [...result.boardIds, ...result.failed];
  if (ids.length === 0) return { count: 0, boardIds: [], failed: [] };
  const boards = await Board.find({ _id: { $in: ids } })
    .select('visibility createdBy memberAccess publicDefaultLevel boardType organisation')
    .lean();
  const readable = new Set(
    boards.filter((b) => resolveAccess(b, org, userId).canRead).map((b) => String(b._id))
  );
  const boardIds = result.boardIds.filter((id) => readable.has(String(id)));
  return {
    count: boardIds.length,
    boardIds,
    failed: result.failed.filter((id) => readable.has(String(id))),
  };
};

/**
 * PUT /api/orgs/:id/currency — requires `org.manage_settings`.
 *
 * Body is PARTIAL: { baseCurrency?, provider?, cadence?, apiKey? }. A screen
 * that saves one control at a time must not have to re-send the others, and a
 * whole-object write would mean changing the cadence silently cleared the key.
 *
 * `apiKey: null` explicitly REMOVES the stored credential — distinct from
 * omitting the field, which leaves it alone. Without that distinction there is
 * no way to disconnect a key once set.
 *
 * Written with `updateOne` rather than `doc.save()` for the reason documented
 * on the holiday writes: `save()` carries a `__v` check and two overlapping
 * Settings writes lost the race with a VersionError.
 *
 * ---- Boards that follow the workspace move with it --------------------------
 *
 * A board whose `currency` is null FOLLOWS the workspace. When `baseCurrency`
 * is saved, every such board with an own money column not already in the new
 * unit is RELABELLED to it (`relabelFollowingBoards`): the same relabel as
 * `PATCH /api/boards/:id/currency`, so mirrors on other boards follow and every
 * open tab is told. Stored figures are kept exactly as typed — nothing is
 * converted. Boards with their own currency (an override) are left alone.
 *
 * Run whenever `baseCurrency` is in the body, not only when it differs: it is
 * a no-op for boards already in step, and re-saving is how a board that failed
 * last time is retried. The answer gains `relabelled: { count, boardIds,
 * failed }` — `failed` is boards that could not be relabelled (logged here);
 * the settings change itself has been saved either way. All three name only
 * boards the CALLER can read (`relabelledVisibleTo`); the relabel itself
 * reaches every following board.
 */
const saveCurrencySettings = async (req, res) => {
  try {
    const body = req.body || {};
    const clean = sanitizeFxSettings(body);
    if (!clean.ok) return res.status(400).json({ error: clean.error });

    const update = { ...clean.patch };

    if (body.apiKey !== undefined) {
      if (body.apiKey === null || body.apiKey === '') {
        update['fx.sealedApiKey'] = null;
        update['fx.keyPreview'] = '';
      } else if (typeof body.apiKey !== 'string' || body.apiKey.trim().length < 8) {
        return res.status(400).json({ error: 'That does not look like an API key.' });
      } else {
        /**
         * A deployment can legitimately have no encryption key configured —
         * the default rate provider is keyless, so nothing else here needs
         * one. Checking first turns what would be a 500 on an admin pasting a
         * key into a sentence that says what to do about it.
         */
        const configured = connectorCrypto.checkConfigured();
        if (configured && configured.error) {
          return res.status(400).json({
            error:
              'This deployment cannot store credentials yet — set the connector encryption key first.',
          });
        }
        const key = body.apiKey.trim();
        update['fx.sealedApiKey'] = connectorCrypto.seal(key, {
          orgId: req.params.id,
          provider: 'fx',
        });
        update['fx.keyPreview'] = keyPreviewOf(key);
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nothing to change.' });
    }

    // A provider swap invalidates the last run's outcome: "succeeded at 09:00"
    // is about the provider we were using then, and leaving it on screen beside
    // a newly chosen one reads as a green light nobody earned.
    if (update['fx.provider']) {
      update['fx.lastError'] = '';
    }

    // The unit the workspace was in BEFORE this save — what a following
    // board's code-less money columns rendered in until now.
    const previousBase = (req.org && req.org.baseCurrency) || null;

    const result = await Organisation.updateOne({ _id: req.params.id }, { $set: update });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    let relabelled = { count: 0, boardIds: [], failed: [] };
    if (update.baseCurrency) {
      try {
        // The whole org (members, roles) — the relabel announces each board
        // to everyone who can read it.
        const org = await Organisation.findById(req.params.id);
        if (org) {
          const all = await relabelFollowingBoards(org, {
            actorId: req.user.userId,
            fromBase: previousBase,
          });
          relabelled = await relabelledVisibleTo(org, req.user.userId, all);
        }
      } catch (relabelErr) {
        // The setting is saved; a board left behind is retried by saving again.
        console.error('saveCurrencySettings: following-board relabel failed:', relabelErr);
      }
    }

    const fresh = await Organisation.findById(req.params.id)
      .select('baseCurrency fx')
      .lean();
    return res.json({ currency: currencySettingsOf(fresh), relabelled });
  } catch (err) {
    console.error('saveCurrencySettings error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/orgs/:id/currency/boards — requires `org.manage_settings`.
 *
 * Every board in the workspace that holds money, with the unit it is in — what
 * the Currency tab lists. Boards that FOLLOW the workspace move with it on
 * their own (see `saveCurrencySettings`); the ones with a currency of their
 * own are listed so an admin can see them and relabel them, or put them back to
 * following, one by one (`PATCH /api/boards/:id/currency`).
 *
 *   currency     — the board's resolved unit (`boardCurrencyOf`)
 *   following    — true while `Board.currency` is null: the board follows the
 *                  workspace currency; false for a board with its own
 *   effective    — the unit its money is in now (the same resolution as
 *                  `currency`, named for what the Currency tab shows)
 *   moneyColumns — how many money columns it OWNS (mirrors are not counted:
 *                  their unit belongs to the board they mirror from)
 *   mixed        — its money columns disagree with each other, or with the
 *                  board's own `currency`, so its totals add unlike units or
 *                  are labelled in one they are not in
 *   canManage    — whether THIS caller may relabel it (`column.manage` there);
 *                  the settings capability does not reach into boards
 *
 * Only boards the caller can READ are listed. `org.manage_settings` is a
 * workspace power, not a key to every private board, and a board's name and
 * shape are not the admin's to learn just because they may change the
 * workspace currency.
 */
const listMoneyBoards = async (req, res) => {
  try {
    const org = req.org || (await Organisation.findById(req.params.id));
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const userId = req.user.userId;

    const boards = await Board.find({
      organisation: org._id,
      archived: { $ne: true },
      'columns.settings.format': 'currency',
    })
      .select('name currency columns visibility createdBy memberAccess publicDefaultLevel boardType order')
      .sort({ order: 1 })
      .lean();

    const out = [];
    for (const board of boards) {
      const access = resolveAccess(board, org, userId);
      if (!access.canRead) continue;
      // The board's OWN money only. A mirror's unit is its source board's
      // (`isOwnMoneyColumn`), so counting it here listed an INR invoice board
      // with one CAD mirror as "mixed" forever — and relabelling it, which
      // leaves mirrors alone, could never clear the flag.
      const money = (board.columns || []).filter(isOwnMoneyColumn);
      if (money.length === 0) continue;
      const currency = boardCurrencyOf(board, org.baseCurrency);
      // A column with no code renders in the board's unit, so it only makes
      // the board mixed if the codes that ARE stored disagree with that.
      const units = new Set(money.map((c) => normaliseCurrencyCode(c.settings.currency) || currency));
      // …and the board's OWN unit is one of the voices. Every column relabelled
      // to CAD one at a time from the Table header, on a board that still says
      // INR, agrees with itself and not with the ledger strip or this list —
      // which then reported "INR, not mixed" about a board showing dollars.
      if (currency) units.add(currency);
      out.push({
        _id: board._id,
        name: board.name,
        currency,
        following: isFollowing(board),
        effective: currency,
        moneyColumns: money.length,
        mixed: units.size > 1,
        canManage: !!access.can('column.manage'),
      });
    }

    return res.json({ boards: out });
  } catch (err) {
    console.error('listMoneyBoards error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  listMoneyBoards,
  listServiceCatalog,
  createOrg,
  getOrg,
  joinOrg,
  listMembers,
  removeMember,
  regenerateInvite,
  sendInvite,
  transferOrgOwnership,
  deleteOrg,
  listHolidays,
  saveHolidays,
  setHoliday,
  deleteHoliday,
  getCurrencySettings,
  saveCurrencySettings,
};

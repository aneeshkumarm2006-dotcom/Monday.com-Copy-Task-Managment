const crypto = require('crypto');
const mongoose = require('mongoose');
const Organisation = require('../models/Organisation');
const User = require('../models/User');
const { sendInviteEmail } = require('../services/emailService');
const { cascadeDeleteOrg } = require('../services/orgCascade');
const { createNotificationsForUsers } = require('../services/notificationService');
const { resolveOrgAccess, isOrgOwner } = require('../utils/permissions');
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
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Organisation name is required' });
    }

    const userId = req.user.userId;

    const org = new Organisation({
      name: name.trim(),
      admin: userId,
      members: [userId],
      inviteCode: generateInviteCode(),
    });

    // Seed the permissions matrix. Every org gets the five presets
    // (owner/admin/member/viewer/guest) up front, so the matrix is never empty
    // and the creator lands on `owner` without any assignment being written.
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
      return res.status(403).json({ error: 'Not a member of this organisation' });
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
      return res.status(403).json({ error: 'Not a member of this organisation' });
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

    org.admins = (org.admins || []).filter((a) => a.toString() !== targetUserId);
    org.members = org.members.filter((m) => m.toString() !== targetUserId);
    // Drop their role assignment too, or a re-join would silently restore the
    // role they held before they were removed.
    org.memberRoles = (org.memberRoles || []).filter(
      (m) => m.user.toString() !== targetUserId
    );
    await org.save();

    await User.findByIdAndUpdate(targetUserId, {
      $pull: { organisations: org._id },
    });

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
        .json({ error: 'User is not a member of this organisation' });
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
      return res.status(403).json({ error: 'Not a member of this organisation' });
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


module.exports = {
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
};

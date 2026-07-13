const crypto = require('crypto');
const Organisation = require('../models/Organisation');
const User = require('../models/User');
const { sendInviteEmail } = require('../services/emailService');
const { cascadeDeleteOrg } = require('../services/orgCascade');
const { createNotificationsForUsers } = require('../services/notificationService');
const { resolveOrgAccess, isOrgOwner } = require('../utils/permissions');
const { DEFAULT_ROLE_KEY } = require('../utils/capabilities');

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

module.exports = {
  createOrg,
  getOrg,
  joinOrg,
  listMembers,
  removeMember,
  regenerateInvite,
  sendInvite,
  deleteOrg,
};

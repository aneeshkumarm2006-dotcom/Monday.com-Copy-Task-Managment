const crypto = require('crypto');
const Organisation = require('../models/Organisation');
const User = require('../models/User');
const { sendInviteEmail } = require('../services/emailService');
const { cascadeDeleteOrg } = require('../services/orgCascade');
const { createNotificationsForUsers } = require('../services/notificationService');

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

    const org = await Organisation.create({
      name: name.trim(),
      admin: userId,
      members: [userId],
      inviteCode: generateInviteCode(),
    });

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

    return res.json({ org });
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
    if (!alreadyMember) {
      org.members.push(userId);
      await org.save();
      await User.findByIdAndUpdate(userId, {
        $addToSet: { organisations: org._id },
      });

      // Notify the workspace admins that a new member joined. (The joiner
      // redeemed an invite code, so there's no distinct inviter to notify.)
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

    const adminIds = Array.isArray(org.admins)
      ? org.admins.map((a) => a.toString())
      : [];

    return res.json({
      members: org.members,
      adminId: org.admin.toString(),
      adminIds,
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

    // Main admin cannot be removed
    if (org.admin.toString() === targetUserId) {
      return res.status(400).json({ error: 'Main admin cannot be removed' });
    }

    // Also remove from admins array if they were an admin
    org.admins = (org.admins || []).filter((a) => a.toString() !== targetUserId);
    org.members = org.members.filter((m) => m.toString() !== targetUserId);
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

/**
 * PUT /api/orgs/:id/members/:userId/role — Change a member's role (admin only).
 * Body: { role: 'admin' | 'member' }
 *
 * Rules:
 *  - Only admins can change roles.
 *  - Only the main admin can change another admin's role.
 *  - The main admin's own role cannot be changed by anyone.
 */
const changeRole = async (req, res) => {
  try {
    const { id: orgId, userId: targetUserId } = req.params;
    const { role } = req.body;

    if (!['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "admin" or "member"' });
    }

    const org = await Organisation.findById(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    const requesterId = req.user.userId;
    const isMainAdmin = org.admin.toString() === requesterId;

    // No one can change the main admin's role
    if (org.admin.toString() === targetUserId) {
      return res.status(400).json({ error: 'Cannot change the main admin\'s role' });
    }

    // Non-main admins cannot change another admin's role
    const targetIsAdmin = (org.admins || []).some(
      (a) => a.toString() === targetUserId
    );
    if (targetIsAdmin && !isMainAdmin) {
      return res.status(403).json({ error: 'Only the main admin can change another admin\'s role' });
    }

    if (role === 'admin') {
      // Promote to admin
      if (!targetIsAdmin) {
        org.admins = org.admins || [];
        org.admins.push(targetUserId);
      }
    } else {
      // Demote to member
      org.admins = (org.admins || []).filter(
        (a) => a.toString() !== targetUserId
      );
    }

    await org.save();

    const adminIds = org.admins.map((a) => a.toString());
    return res.json({ message: 'Role updated', adminIds });
  } catch (err) {
    console.error('changeRole error:', err);
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

module.exports = {
  createOrg,
  getOrg,
  joinOrg,
  listMembers,
  removeMember,
  changeRole,
  regenerateInvite,
  sendInvite,
  deleteOrg,
};

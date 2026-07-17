const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requireOrgOwner } = require('../middleware/roleCheck');
const { requireCapability } = require('../middleware/requireCapability');
const {
  createOrg,
  getOrg,
  joinOrg,
  listMembers,
  removeMember,
  regenerateInvite,
  sendInvite,
  deleteOrg,
} = require('../controllers/orgController');
const {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  assignRole,
} = require('../controllers/roleController');

const router = express.Router();

// All org routes require authentication
router.use(authMiddleware);

// Create org
router.post('/', createOrg);

// Join via invite code
router.post('/join/:inviteCode', joinOrg);

// Get org details
router.get('/:id', getOrg);

// ---------------------------------------------------------------------------
// Members
//
// Gated by CAPABILITY, not by "are you an admin". Which role holds which
// capability is data the owner edits in the permissions matrix — so a workspace
// can let, say, a Recruiter role invite people without also handing them the
// power to delete every board. That was impossible when `admin` was one bit.
// ---------------------------------------------------------------------------
router.get('/:id/members', requireCapability('org.view_members'), listMembers);

router.delete(
  '/:id/members/:userId',
  requireCapability('org.remove_members'),
  removeMember
);

// Assign a role to a member. Accepts { roleId }, or the legacy
// { role: 'admin'|'member' } so an older client keeps working. Capability check
// (`org.assign_roles`) plus the no-escalation rules live in the controller.
router.put('/:id/members/:userId/role', assignRole);

// ---------------------------------------------------------------------------
// Roles — the permissions matrix itself.
//
// Reading is open to any member: knowing who can do what is not itself a
// privilege, and the UI needs it to render honest affordances. Writing requires
// `org.manage_roles` — held by the owner always, by the admin role by default,
// and grantable to any role via the matrix.
// ---------------------------------------------------------------------------
router.get('/:id/roles', listRoles);
router.post('/:id/roles', createRole);
router.put('/:id/roles/:roleId', updateRole);
router.delete('/:id/roles/:roleId', deleteRole);

// ---------------------------------------------------------------------------
// Invites + workspace settings
// ---------------------------------------------------------------------------
router.post(
  '/:id/regenerate-invite',
  requireCapability('org.manage_settings'),
  regenerateInvite
);

router.post(
  '/:id/send-invite',
  requireCapability('org.invite_members'),
  sendInvite
);

// Delete the organisation. Owner-only, and deliberately NOT a capability: this
// is the one action no role may ever be granted.
router.delete('/:id', requireOrgOwner, deleteOrg);

module.exports = router;

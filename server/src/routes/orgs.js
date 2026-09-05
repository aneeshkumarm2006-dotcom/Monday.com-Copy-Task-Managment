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
  transferOrgOwnership,
  deleteOrg,
  listHolidays,
  saveHolidays,
  setHoliday,
  deleteHoliday,
  listServiceCatalog,
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
// Company holidays — the workspace calendar of days the office was closed.
//
// Reading is open to any member, for the same reason reading the roles matrix
// is: the client needs it on the calendar, in every date picker and on every
// Delivery grid, and "the office is shut on the 15th" is not a secret.
//
// Writing needs `org.manage_holidays`, its OWN capability with its own row in
// the permissions matrix. Marking a day off changes what every board in the
// workspace counts as owed, and an ops lead may need that without also being
// able to rename the organisation. Workspaces that predate the capability need
// `npm run migrate:holidays` once, or an owner ticking the box by hand.
//
// The bulk PUT is scoped to one year and replaces only that year. The
// single-date PUT/DELETE pair is the quick-mark path used from a calendar day
// cell, so marking tomorrow off never means resending the whole year.
// ---------------------------------------------------------------------------
// The service catalog behind the invite table's "catalog + free text" picker.
// Read-only and open to any member — see the handler for why there is no POST.
router.get('/:id/service-catalog', listServiceCatalog);

router.get('/:id/holidays', listHolidays);

router.put(
  '/:id/holidays',
  requireCapability('org.manage_holidays'),
  saveHolidays
);

router.put(
  '/:id/holidays/:date',
  requireCapability('org.manage_holidays'),
  setHoliday
);

router.delete(
  '/:id/holidays/:date',
  requireCapability('org.manage_holidays'),
  deleteHoliday
);

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

// Transfer ownership of the workspace to another member. Owner-only, and — like
// deleting the org — deliberately NOT a capability: a delegate who can appoint an
// owner can appoint themselves. The outgoing owner is left holding the `admin`
// role rather than being demoted to Member.
router.post('/:id/transfer-ownership', requireOrgOwner, transferOrgOwnership);

// Delete the organisation. Owner-only, and deliberately NOT a capability: this
// is the one action no role may ever be granted.
router.delete('/:id', requireOrgOwner, deleteOrg);

module.exports = router;

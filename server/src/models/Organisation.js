const mongoose = require('mongoose');
const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');

// 'YYYY-MM-DD'. Same convention, and the same reasoning, as Tracker.js: a
// holiday is a CALENDAR DATE with no time and no zone, and a Date would
// silently attach both. utils/tzDay.js is what turns a UTC instant into one of
// these; nothing here ever needs to.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayKeyField = (extra = {}) => ({
  type: String,
  match: DAY_KEY_RE,
  ...extra,
});

/**
 * A role is a NAMED BUNDLE OF CAPABILITY KEYS — see
 * [capabilities.js](../utils/capabilities.js) for the catalog.
 *
 * `key` is a stable slug. The five system roles (owner/admin/member/viewer/guest)
 * keep their well-known keys forever; custom roles get a generated slug. Members
 * point at a role by its `_id`, not its key, so renaming a custom role never
 * orphans anyone.
 *
 * `isSystem` roles cannot be DELETED (members hold them, and `owner` is
 * load-bearing), but their permissions stay editable in the matrix — except the
 * owner's, which the resolver ignores in favour of "always everything".
 */
const roleSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    color: { type: String, default: '#6B7280' },
    isSystem: { type: Boolean, default: false },
    permissions: { type: [String], default: [] },
  },
  { _id: true, timestamps: false }
);

/**
 * Which role each member holds. This is a SEPARATE array from `members` on
 * purpose.
 *
 * `members` stays a plain `[ObjectId]` because org membership is written on both
 * sides (`Organisation.members` AND `User.organisations`) and dozens of call
 * sites `.populate('members')` or `members.some(...)` over it. Reshaping it into
 * subdocuments would have rippled through every one of those and through the
 * join/onboarding reconciliation. Role assignment rides alongside instead.
 *
 * A member with no entry here holds the default role. Absence is not an error
 * state — it just means nothing special was said about this person.
 */
const memberRoleSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
  },
  { _id: false, timestamps: false }
);

const organisationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  /**
   * The workspace owner. Immutable, singular, and holds every capability
   * unconditionally. Retained as the root of trust: a role system whose owner can
   * be locked out by a bad matrix edit is worse than no role system at all.
   */
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  /**
   * LEGACY. Superseded by `roles` + `memberRoles`, but kept in sync by the role
   * assignment path so nothing that still reads it goes stale. Resolve permission
   * through [permissions.js](../utils/permissions.js), never through this array.
   */
  admins: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  roles: { type: [roleSchema], default: [] },
  memberRoles: { type: [memberRoleSchema], default: [] },
  /**
   * The workspace holiday calendar — days the office was closed.
   *
   * The FIRST org-level config field, and deliberately a plain array of
   * subdocuments rather than a settings blob: there is one thing here, and a
   * bag named `settings` invites everything else to move in beside it.
   *
   * There is no `tag`. An entry here IS a holiday — that is what separates it
   * from `Tracker.daysOff`, which carries a reason precisely because it can be
   * an event or a day the team was pulled onto other work. When a holiday
   * surfaces in the Delivery grid it reports `tag: 'holiday'`, so the existing
   * icon and copy tables handle it with no new vocabulary.
   *
   * Years are entered independently. Most holidays outside a handful of fixed
   * civil dates move every year, so an auto-repeat would be wrong more often
   * than right; the Settings editor offers a copy-last-year button instead.
   *
   * `affects` is WHAT THIS DAY STOPS, asked when the day is marked. Not every
   * closed day means the same thing: a public holiday stops everything, while a
   * company offsite means no client work was owed but the nightly digest should
   * still go out. Both default to true because that is what "holiday" means
   * unqualified, and each is ANDed with the opt-out on the other side
   * (`Tracker.observesOrgHolidays`, `Automation.schedule.skipHolidays`) so
   * either end can decline.
   *
   * Merged with the per-tracker list in utils/trackerDaysOff.js and NOWHERE
   * else. See utils/orgHolidays.js for why the scope widened.
   */
  holidays: [
    {
      _id: false,
      date: dayKeyField({ required: true }),
      name: { type: String, default: '', trim: true },
      affects: {
        // Tracker columns go grey instead of red, and the day leaves the ratio.
        delivery: { type: Boolean, default: true },
        // Scheduled automations roll forward to the next working day.
        automations: { type: Boolean, default: true },
      },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: { type: Date, default: Date.now },
    },
  ],
  inviteCode: {
    type: String,
    unique: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/**
 * Seed the system roles onto an org that lacks them. Safe to call repeatedly: it
 * only ADDS roles whose `key` is missing, so a matrix the user has customised is
 * never clobbered, and an org created before this feature picks its roles up the
 * first time it is touched. Returns true if anything changed.
 */
organisationSchema.methods.ensureSystemRoles = function ensureSystemRoles() {
  const existing = new Set((this.roles || []).map((r) => r.key));
  let added = false;
  for (const preset of SYSTEM_ROLES) {
    if (existing.has(preset.key)) continue;
    this.roles.push({
      key: preset.key,
      name: preset.name,
      description: preset.description,
      color: preset.color,
      isSystem: true,
      permissions: sanitizePermissions(preset.permissions),
    });
    added = true;
  }
  return added;
};

/** The role subdocument carrying `key`, or undefined. */
organisationSchema.methods.roleByKey = function roleByKey(key) {
  return (this.roles || []).find((r) => r.key === key);
};

module.exports = mongoose.model('Organisation', organisationSchema);

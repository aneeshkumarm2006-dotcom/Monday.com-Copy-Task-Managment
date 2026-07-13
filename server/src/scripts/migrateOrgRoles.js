/**
 * migrateOrgRoles.js
 *
 * Backfills the role system onto organisations that predate it.
 *
 * Before this, a role was not data — it was a position in an array. `org.admin`
 * meant owner, membership of `org.admins[]` meant admin, and everyone else in
 * `org.members[]` was a member. Nothing was persisted as a role, so there was no
 * way to add a fourth one. This script turns that implicit structure into
 * explicit `Organisation.roles[]` + `Organisation.memberRoles[]`.
 *
 * For every organisation (optionally scoped with `--org <id>`):
 *   1. Seed the five system roles (owner/admin/member/viewer/guest) if absent.
 *   2. Map each member to a role:
 *        org.admin      → owner
 *        org.admins[]   → admin
 *        everyone else  → member
 *      Members who ALREADY have an assignment are left alone.
 *
 * `members[]`, `admin` and `admins[]` are all left in place and untouched. This
 * is purely additive: every existing query, `.populate('members')` and
 * `members.some(...)` keeps working, and the resolver falls back to `admins[]`
 * for any org this has not reached yet. So it is safe to run late, or twice, or
 * never — the app works either way, just with the presets rather than a
 * customised matrix.
 *
 * Idempotent. Run from the server directory:
 *     node src/scripts/migrateOrgRoles.js [--org <orgId>] [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models'); // register all schemas

const Organisation = require('../models/Organisation');
const { DEFAULT_ROLE_KEY, OWNER_ROLE_KEY } = require('../utils/capabilities');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const orgFlagIndex = args.indexOf('--org');
const onlyOrgId = orgFlagIndex !== -1 ? args[orgFlagIndex + 1] : null;

const run = async () => {
  await connectDB();

  const filter = onlyOrgId ? { _id: onlyOrgId } : {};
  const orgs = await Organisation.find(filter);

  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Backfilling roles for ${orgs.length} organisation(s)\n`
  );

  let seeded = 0;
  let assigned = 0;
  let skipped = 0;

  for (const org of orgs) {
    const addedRoles = org.ensureSystemRoles();

    const roleIdFor = (key) => {
      const role = org.roleByKey(key);
      return role ? role._id : null;
    };

    const ownerRoleId = roleIdFor(OWNER_ROLE_KEY);
    const adminRoleId = roleIdFor('admin');
    const defaultRoleId = roleIdFor(DEFAULT_ROLE_KEY);

    const alreadyAssigned = new Set(
      (org.memberRoles || []).map((m) => m.user.toString())
    );
    const adminIds = new Set((org.admins || []).map((a) => a.toString()));
    const ownerId = org.admin ? org.admin.toString() : null;

    let addedAssignments = 0;
    for (const memberRef of org.members || []) {
      const uid = memberRef.toString();
      // Never overwrite an assignment someone has already made deliberately.
      if (alreadyAssigned.has(uid)) continue;

      let roleId = defaultRoleId;
      if (ownerId && uid === ownerId) roleId = ownerRoleId;
      else if (adminIds.has(uid)) roleId = adminRoleId;

      if (!roleId) continue;
      org.memberRoles.push({ user: uid, role: roleId });
      addedAssignments += 1;
    }

    if (!addedRoles && addedAssignments === 0) {
      skipped += 1;
      console.log(`  – ${org.name} (${org._id}) — already migrated, skipped`);
      continue;
    }

    if (addedRoles) seeded += 1;
    assigned += addedAssignments;

    if (!dryRun) await org.save();

    console.log(
      `  ✓ ${org.name} (${org._id}) — ${
        addedRoles ? 'seeded 5 roles' : 'roles present'
      }, assigned ${addedAssignments} member(s)`
    );
  }

  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Done. ${seeded} org(s) seeded, ` +
      `${assigned} member assignment(s), ${skipped} already migrated.\n`
  );

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('migrateOrgRoles failed:', err);
  process.exit(1);
});

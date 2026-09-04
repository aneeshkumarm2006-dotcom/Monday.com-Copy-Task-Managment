/**
 * grantGoalCapabilities.js
 *
 * Ticks the four Monthly Goals capabilities onto the roles of organisations
 * that already existed before those capabilities were added to the catalog.
 *
 * WHY THIS IS NEEDED AT ALL: `ensureSystemRoles` seeds MISSING ROLES, never
 * missing capabilities on roles that already exist. That is deliberate — it must
 * never silently re-grant something an admin has consciously turned off. The
 * consequence is that a workspace created before this feature keeps its stored
 * permission lists, so `goal.view` is absent everywhere and the Goals tab simply
 * never appears.
 *
 * Matches the defaults a NEW workspace is seeded with (see SYSTEM_ROLES in
 * utils/capabilities.js):
 *     admin   → goal.view, goal.track, goal.create, goal.manage
 *     member  → goal.view, goal.track, goal.create, goal.manage
 *     viewer  → goal.view          (reading whether the month was met is a read)
 *     guest   → nothing            (external; a client's scorecard is not theirs)
 *     owner   → untouched; the resolver short-circuits owners to the full catalog
 *
 * `goal.create` JOINED THIS LIST AFTER THE FIRST RUN, so a workspace that ran
 * this script before the rung existed still needs it: re-run and only the one
 * missing capability is added. Nobody is BLOCKED waiting for that run any more —
 * `goal.manage` confers `goal.create` at resolve time (IMPLIED_CAPABILITIES in
 * utils/capabilities.js), which is what unbroke the Add-a-goal button. Running
 * this makes the permissions matrix agree with what the server already does, and
 * grants the rung to roles that hold `goal.track` without `goal.manage`.
 *
 * Custom roles are LEFT ALONE. Somebody wrote those deliberately and this script
 * has no business guessing what they meant.
 *
 * Purely additive and idempotent — a capability already present is not
 * duplicated, and a role that has it is reported as already done. Safe to run
 * twice, or never: without it the feature is simply invisible until someone
 * ticks the boxes by hand in Members → Permissions.
 *
 * Run from the server directory:
 *     node src/scripts/grantGoalCapabilities.js [--org <orgId>] [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models'); // register all schemas

const Organisation = require('../models/Organisation');

/** Role key → the capabilities a freshly-seeded workspace would give it. */
const GRANTS = {
  admin: ['goal.view', 'goal.track', 'goal.create', 'goal.manage'],
  member: ['goal.view', 'goal.track', 'goal.create', 'goal.manage'],
  viewer: ['goal.view'],
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const orgFlagIndex = args.indexOf('--org');
const onlyOrgId = orgFlagIndex !== -1 ? args[orgFlagIndex + 1] : null;

const run = async () => {
  await connectDB();

  const filter = onlyOrgId ? { _id: onlyOrgId } : {};
  const orgs = await Organisation.find(filter);

  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Granting goal capabilities across `
    + `${orgs.length} organisation(s)\n`
  );

  let changedOrgs = 0;
  let grantCount = 0;
  let alreadyCount = 0;

  for (const org of orgs) {
    const changes = [];

    for (const role of org.roles || []) {
      const wanted = GRANTS[role.key];
      if (!wanted) continue; // owner, guest, and every custom role

      const have = new Set(role.permissions || []);
      const missing = wanted.filter((c) => !have.has(c));

      if (missing.length === 0) {
        alreadyCount += 1;
        continue;
      }

      changes.push(`${role.key} += ${missing.join(', ')}`);
      grantCount += missing.length;
      if (!dryRun) role.permissions = [...(role.permissions || []), ...missing];
    }

    if (changes.length === 0) continue;

    changedOrgs += 1;
    console.log(`  ${org.name}`);
    for (const change of changes) console.log(`    ${change}`);

    if (!dryRun) {
      org.markModified('roles');
      await org.save();
    }
  }

  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Done. `
    + `${changedOrgs} organisation(s) updated, ${grantCount} capability grant(s), `
    + `${alreadyCount} role(s) already had them.\n`
  );

  if (dryRun) console.log('No changes were written. Re-run without --dry-run to apply.\n');

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('grantGoalCapabilities failed:', err);
  process.exit(1);
});

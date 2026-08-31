/**
 * grantAdsBudgetCapabilities.js
 *
 * Ticks the three Ads Budget capabilities onto the roles of organisations that
 * already existed before those capabilities were added to the catalog.
 *
 * WHY THIS IS NEEDED AT ALL: `ensureSystemRoles` seeds MISSING ROLES, never
 * missing capabilities on roles that already exist. That is deliberate — it must
 * never silently re-grant something an admin has consciously turned off. The
 * consequence is that a workspace created before this feature keeps its stored
 * permission lists, so `adsBudget.view` is absent everywhere and the Ads Budget
 * tab never appears no matter who switches the add-on on.
 *
 * Matches the defaults a NEW workspace is seeded with (see SYSTEM_ROLES in
 * utils/capabilities.js):
 *     admin   → adsBudget.view, adsBudget.track, adsBudget.manage
 *     member  → adsBudget.view, adsBudget.track, adsBudget.manage
 *     viewer  → adsBudget.view   (what a client is spending is board content)
 *     guest   → nothing          (external; a client's ad spend is not theirs)
 *     owner   → untouched; the resolver short-circuits owners to the full catalog
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
 *     node src/scripts/grantAdsBudgetCapabilities.js [--org <orgId>] [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models'); // register all schemas

const Organisation = require('../models/Organisation');

/** Role key → the capabilities a freshly-seeded workspace would give it. */
const GRANTS = {
  admin: ['adsBudget.view', 'adsBudget.track', 'adsBudget.manage'],
  member: ['adsBudget.view', 'adsBudget.track', 'adsBudget.manage'],
  viewer: ['adsBudget.view'],
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
    `\n${dryRun ? '[DRY RUN] ' : ''}Granting ads budget capabilities across `
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
  console.error('grantAdsBudgetCapabilities failed:', err);
  process.exit(1);
});

/**
 * grantVaultCapabilities.js
 *
 * Ticks the two Vault capabilities onto the roles of organisations that already
 * existed before those capabilities were added to the catalog.
 *
 * WHY THIS IS NEEDED AT ALL: `ensureSystemRoles` seeds MISSING ROLES, never
 * missing capabilities on roles that already exist. That is deliberate — it must
 * never silently re-grant something an admin has consciously turned off. The
 * consequence is that a workspace created before this feature keeps its stored
 * permission lists, so `vault.view` is absent everywhere and the Vault tab
 * simply never appears.
 *
 * Matches the defaults a NEW workspace is seeded with (see SYSTEM_ROLES in
 * utils/capabilities.js):
 *     admin   → vault.view, vault.manage
 *     member  → vault.view, vault.manage
 *     viewer  → vault.view  (the door only: the tab appears and the ENCRYPTED
 *                            items load, and the password that reads them is
 *                            not the workspace's to grant. `vault.manage` is
 *                            withheld — deleting an item needs no password.)
 *     guest   → nothing   (external — a client has no business near the door)
 *     owner   → untouched; the resolver short-circuits owners to the full catalog
 *
 * RE-RUN THIS after the change that dropped `vault.view` to the `view` rung.
 * Workspaces migrated by the earlier version of this script have viewers with no
 * `vault.view`, and `ensureSystemRoles` will never backfill it. Idempotent, so
 * re-running costs nothing where it has already been applied.
 *
 * Granting `vault.manage` to every member sounds broad and is not: both
 * capabilities are BOARD_SCOPED, so the org grant is only the floor. The board
 * ladder is the ceiling, and the vault sits on its top rung — so in practice
 * this reaches boards a member owns or has been given full edit on, which is the
 * same set they could already delete outright.
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
 *     node src/scripts/grantVaultCapabilities.js [--org <orgId>] [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models'); // register all schemas

const Organisation = require('../models/Organisation');

/** Role key → the capabilities a freshly-seeded workspace would give it. */
const GRANTS = {
  admin: ['vault.view', 'vault.manage'],
  member: ['vault.view', 'vault.manage'],
  // The door, not the keys. See the note above.
  viewer: ['vault.view'],
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
    `\n${dryRun ? '[DRY RUN] ' : ''}Granting vault capabilities across `
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
  console.error('grantVaultCapabilities failed:', err);
  process.exit(1);
});

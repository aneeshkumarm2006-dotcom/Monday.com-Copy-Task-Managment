/**
 * grantConnectorCapabilities.js
 *
 * Ticks the two Connector capabilities onto the roles of organisations that
 * already existed before those capabilities were added to the catalog.
 *
 * WHY THIS IS NEEDED AT ALL: `ensureSystemRoles` seeds MISSING ROLES, never
 * missing capabilities on roles that already exist. That is deliberate — it must
 * never silently re-grant something an admin has consciously turned off. The
 * consequence is that a workspace created before this feature keeps its stored
 * permission lists, so `connector.view` is absent everywhere and the Add-ons tab
 * simply never appears.
 *
 * Matches the defaults a NEW workspace is seeded with (see SYSTEM_ROLES in
 * utils/capabilities.js):
 *     admin   → connector.view, connector.manage
 *     member  → connector.view, connector.manage
 *     viewer  → connector.view  (a read served out of OUR database — it never
 *                                contacts a provider and spends none of the
 *                                workspace's API quota. `connector.manage` is
 *                                withheld: mapping decides which client's
 *                                numbers land on which row, and Refresh spends
 *                                a shared, finite quota.)
 *     guest   → NOTHING, and this one is load-bearing rather than incidental.
 *               `connector.view` opens at the board `view` rung, and the
 *               endpoint behind it lists every connected account in the
 *               workspace by label so a board can pick projects from any of
 *               them. For an external collaborator shared into a single board
 *               that is a list of other clients' account names. Do not add it.
 *     owner   → untouched; the resolver short-circuits owners to the full catalog
 *
 * Granting `connector.manage` to every member sounds broad and is not: both
 * capabilities are BOARD_SCOPED, so the org grant is only the floor. The board
 * ladder is the ceiling and `connector.manage` sits on its top rung — so in
 * practice this reaches boards a member owns or has full edit on, which is the
 * same set they could already restructure outright. It also does NOT let them
 * connect an account: that is org-scoped `org.manage_settings`.
 *
 * Custom roles are LEFT ALONE. Somebody wrote those deliberately and this script
 * has no business guessing what they meant.
 *
 * Purely additive and idempotent — a capability already present is not
 * duplicated, and a role that has it is reported as already done. Safe to run
 * twice, or never: without it the feature is simply invisible until someone
 * ticks the boxes by hand in Members → Permissions. It changes NOTHING else
 * about a workspace.
 *
 * Run from the server directory:
 *     node src/scripts/grantConnectorCapabilities.js [--org <orgId>] [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models'); // register all schemas

const Organisation = require('../models/Organisation');

/** Role key → the capabilities a freshly-seeded workspace would give it. */
const GRANTS = {
  admin: ['connector.view', 'connector.manage'],
  member: ['connector.view', 'connector.manage'],
  // The read only. See the note above.
  viewer: ['connector.view'],
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const orgFlagIndex = args.indexOf('--org');
const onlyOrgId = orgFlagIndex !== -1 ? args[orgFlagIndex + 1] : null;

const run = async () => {
  await connectDB();

  const filter = onlyOrgId ? { _id: onlyOrgId } : {};
  const orgs = await Organisation.find(filter);

  if (orgs.length === 0) {
    console.log('No organisations matched.');
    await mongoose.connection.close();
    return;
  }

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}Checking ${orgs.length} organisation(s)...\n`
  );

  let changedOrgs = 0;
  let changedRoles = 0;
  let alreadyDone = 0;
  let skippedCustom = 0;

  for (const org of orgs) {
    const touched = [];

    for (const role of org.roles || []) {
      // Custom roles are somebody's deliberate work. Leave them alone.
      if (!role.isSystem) {
        skippedCustom += 1;
        continue;
      }

      const grants = GRANTS[role.key];
      if (!grants) continue; // owner, guest, or an unrecognised system role

      const missing = grants.filter((c) => !role.permissions.includes(c));
      if (missing.length === 0) {
        alreadyDone += 1;
        continue;
      }

      role.permissions.push(...missing);
      touched.push(`${role.key}: +${missing.join(', +')}`);
      changedRoles += 1;
    }

    if (touched.length > 0) {
      changedOrgs += 1;
      console.log(`  ${org.name} (${org._id})`);
      touched.forEach((t) => console.log(`      ${t}`));
      if (!dryRun) await org.save();
    }
  }

  console.log('');
  console.log(`${dryRun ? 'Would update' : 'Updated'}: ${changedRoles} role(s) across ${changedOrgs} organisation(s)`);
  console.log(`Already had them:  ${alreadyDone} role(s)`);
  console.log(`Custom roles left alone: ${skippedCustom}`);
  if (dryRun) console.log('\nNothing was written. Re-run without --dry-run to apply.');

  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('grantConnectorCapabilities failed:', err);
  try {
    await mongoose.connection.close();
  } catch {
    /* already closed */
  }
  process.exit(1);
});

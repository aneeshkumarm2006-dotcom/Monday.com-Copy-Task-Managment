/**
 * grantExecutiveCapabilities.js
 *
 * Brings organisations that predate the Executive View up to what a workspace
 * created today is seeded with. There are TWO separate gaps to close, and the
 * reason this script exists is that they are not the same gap:
 *
 *   1. THE MISSING ROLE — `executive`. Handled by `ensureSystemRoles()`, which
 *      adds any preset role an org does not yet carry.
 *   2. THE MISSING CAPABILITY — `org.manage_executive_views` on the roles that
 *      ALREADY exist (owner, admin). `ensureSystemRoles()` does NOT do this, and
 *      never will.
 *
 * THE TRAP, stated once and plainly: `ensureSystemRoles` seeds MISSING ROLES,
 * never missing capabilities on roles that already exist. That is deliberate —
 * it must never silently switch back on something an admin consciously turned
 * off in Members → Permissions. The cost is that a capability added to the
 * catalog later is absent from every workspace older than it, forever, until
 * somebody runs a script or ticks a box by hand. So adding
 * `org.manage_executive_views` to the Admin preset in `utils/capabilities.js`
 * changes precisely nothing for any existing workspace: the role document on
 * disk is what the resolver reads, and it still says what it said last year.
 *
 * Which is why gap 1 fixes itself the moment anyone opens the roles list
 * (`listRoles` calls `ensureSystemRoles` and saves) while gap 2 does not fix
 * itself ever. Without this script, the Executive role quietly appears in the
 * matrix and nobody — not one admin in the workspace — can set up a view with
 * it. "Why is there no Make executive button" would be the first thing asked.
 *
 * Matches the defaults a NEW workspace is seeded with (see SYSTEM_ROLES in
 * utils/capabilities.js):
 *     owner      → org.manage_executive_views (see the note on GRANTS below)
 *     admin      → org.manage_executive_views
 *     executive  → seeded whole by ensureSystemRoles, preset intact
 *     member     → nothing; composing somebody else's workspace is not their job
 *     viewer     → nothing
 *     guest      → nothing (external)
 *
 * Custom roles are LEFT ALONE. Somebody wrote those deliberately and this script
 * has no business guessing what they meant. That includes a custom role that
 * happens to be keyed `executive`: `ensureSystemRoles` skips a key the org
 * already has, so nothing here overwrites it.
 *
 * Purely additive and idempotent — a capability already present is not
 * duplicated, and a role that has it is reported as already done. Safe to run
 * twice, or never: without it the feature is simply invisible until someone
 * ticks the boxes by hand in Members → Permissions.
 *
 * Run from the server directory:
 *     node src/scripts/grantExecutiveCapabilities.js [--org <orgId>] [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models'); // register all schemas

const Organisation = require('../models/Organisation');

/**
 * Role key → the capabilities a freshly-seeded workspace would give it.
 *
 * `owner` is in here and the tracker script's equivalent table deliberately left
 * it out, so the difference is worth a line. Functionally it changes nothing:
 * the resolver short-circuits the org owner to the whole catalog and never reads
 * their stored list (`orgCapabilities` in utils/permissions.js), and the owner
 * preset is derived from ALL_CAPABILITIES so a new workspace already stores it.
 * What it buys is that the stored document matches what a fresh org would have —
 * so the owner's row is not the one place where "what the database says" and
 * "what the code seeds" disagree, and anything that ever reads that list for
 * real (a re-populated NEVER_IMPLICIT, an export, an audit) finds the truth.
 */
const GRANTS = {
  owner: ['org.manage_executive_views'],
  admin: ['org.manage_executive_views'],
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
    `\n${dryRun ? '[DRY RUN] ' : ''}Granting executive capabilities across `
    + `${orgs.length} organisation(s)\n`
  );

  let changedOrgs = 0;
  let grantCount = 0;
  let alreadyCount = 0;
  let seededCount = 0;

  for (const org of orgs) {
    const changes = [];

    // Gap 1: the missing ROLE. `ensureSystemRoles` returns only a boolean, so
    // snapshot the keys either side of it to report WHICH preset it seeded —
    // "executive" is the one anybody running this wants to see confirmed, and an
    // org missing some other preset entirely is worth knowing about too.
    //
    // It mutates the in-memory document rather than writing, which is exactly
    // the discipline the capability loop below uses: nothing reaches the
    // database until the single `org.save()` at the bottom, so --dry-run is
    // honoured by simply never getting there.
    const keysBefore = new Set((org.roles || []).map((r) => r.key));
    if (org.ensureSystemRoles()) {
      const seeded = (org.roles || [])
        .map((r) => r.key)
        .filter((k) => !keysBefore.has(k));
      seededCount += seeded.length;
      changes.push(`seeded role(s): ${seeded.join(', ')}`);
    }

    // Gap 2: the missing CAPABILITY on roles that already existed.
    for (const role of org.roles || []) {
      const wanted = GRANTS[role.key];
      if (!wanted) continue; // member, viewer, guest, and every custom role

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
      // `markModified` is for the in-place `role.permissions` rewrites above:
      // reassigning a field on a subdocument of a Mixed-ish array is not always
      // picked up by change tracking, and a silently-skipped save is the worst
      // possible outcome for a migration that reports success.
      org.markModified('roles');
      await org.save();
    }
  }

  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Done. `
    + `${changedOrgs} organisation(s) updated, ${grantCount} capability grant(s), `
    + `${seededCount} role(s) seeded, `
    + `${alreadyCount} role(s) already had them.\n`
  );

  if (dryRun) console.log('No changes were written. Re-run without --dry-run to apply.\n');

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('grantExecutiveCapabilities failed:', err);
  process.exit(1);
});

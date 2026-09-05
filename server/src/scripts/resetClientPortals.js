/**
 * resetClientPortals — take the client portal to its multi-service shape.
 *
 * The rewrite that introduced SERVICES (a group on a client board is a service
 * the agency sells, with its own client chat, client mailbox and private team
 * room) landed against portals that were all throwaway test data. This script is
 * how that data is cleared and the new constraints are put in place.
 *
 * ---- RUNBOOK, IN THIS ORDER -----------------------------------------------
 *
 *   node src/scripts/resetClientPortals.js --report          # read-only, default
 *   node src/scripts/resetClientPortals.js --seed-catalog    # BEFORE the wipe
 *   node src/scripts/resetClientPortals.js --wipe --force
 *   node src/scripts/resetClientPortals.js --indexes
 *   node src/scripts/resetClientPortals.js --verify
 *
 * `--seed-catalog` must run BEFORE `--wipe`, and it is the only phase whose
 * value is lost by running it in the wrong order: it turns the group names on
 * the doomed boards into the organisation's starting service vocabulary, so the
 * first invite table after the reset already offers "SEO" and "Meta Ads" rather
 * than an empty dropdown.
 *
 * ---- WHAT --wipe DESTROYS, IN PLAIN WORDS ---------------------------------
 *
 * Every `boardType: 'client'` board and EVERYTHING under it: its groups, every
 * task on it (client requests AND internal work filed there), every Update on
 * those tasks, every Channel, Message and read marker, every ClientContact — and
 * therefore every client password and every live client session — every
 * Notification pointing at any of it, and the Cloudinary files.
 *
 * EVERY `/portal/:token` LINK DIES. No existing client can sign in afterwards;
 * each must be re-invited through the new batch invite.
 *
 * ---- WHY THE RAW DRIVER ----------------------------------------------------
 *
 * `mongoose.connection.collection(...)` throughout, for the reasons
 * migratePortalToBoard.js gives: `Board.portalToken` is `select: false`,
 * `ClientContact.group` is being removed from the schema (so a model-level
 * `$unset` cannot name it), and a migration is the one caller allowed to write
 * whatever the data actually requires.
 *
 * ---- DELETION ORDER IS FOR CRASH-SAFETY ------------------------------------
 *
 * Leaf rows first, the row that FINDS them last — the same rule
 * `services/workstreamSurfaces.purgeChannels` follows. An interruption then
 * leaves rows that are still findable and still deletable, rather than orphans
 * nothing knows how to reach. Cloudinary comes first of all: once the rows are
 * gone nothing knows the public ids, and the files sit in the account forever.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { destroyCloudinaryAssets } = require('../config/cloudinary');
const { serviceSlug, normaliseServiceName, colorForSlug } = require('../utils/serviceCatalog');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const DRY = has('--dry-run') || has('-n');
const FORCE = has('--force');
const ONLY_BOARD = valueOf('--board');
const ONLY_ORG = valueOf('--org');
const DROP_BOARDS = has('--drop-boards');

const log = (...a) => console.log(...a);
const head = (t) => log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);

const col = (name) => mongoose.connection.collection(name);

const clientBoardFilter = () => {
  const f = { boardType: 'client' };
  if (ONLY_BOARD) f._id = new mongoose.Types.ObjectId(ONLY_BOARD);
  if (ONLY_ORG) f.organisation = new mongoose.Types.ObjectId(ONLY_ORG);
  return f;
};

const clientBoards = () =>
  col('boards').find(clientBoardFilter()).project({ name: 1, organisation: 1 }).toArray();

/* ------------------------------------------------------------------ */
/* --report                                                            */
/* ------------------------------------------------------------------ */
const report = async () => {
  head('REPORT — what a --wipe would destroy');

  const boards = await clientBoards();
  if (!boards.length) {
    log('No client boards found. Nothing to do.');
    return;
  }

  const ids = boards.map((b) => b._id);
  const groups = await col('taskgroups').find({ board: { $in: ids } }).toArray();
  const groupIds = groups.map((g) => g._id);
  const channels = await col('channels').find({ board: { $in: ids } }).toArray();
  const channelIds = channels.map((c) => c._id);
  const tasks = await col('tasks').find({ board: { $in: ids } }).project({ _id: 1 }).toArray();
  const taskIds = tasks.map((t) => t._id);

  // Named, one per line. This is the "here is what you are about to lose"
  // screen, and a count alone does not let anyone recognise a board they
  // actually still want.
  log(`\n${boards.length} CLIENT BOARD(S):`);
  for (const b of boards) {
    const g = groups.filter((x) => String(x.board) === String(b._id)).length;
    log(`  • "${b.name}"  —  ${g} service(s)`);
  }

  log('\nUNDER THEM:');
  log(`  services (groups)   ${groups.length}`);
  log(`  tasks               ${taskIds.length}`);
  log(`  updates             ${await col('updates').countDocuments({ task: { $in: taskIds } })}`);
  log(`  channels            ${channels.length}`);
  log(`  messages            ${await col('messages').countDocuments({ channel: { $in: channelIds } })}`);
  log(`  client contacts     ${await col('clientcontacts').countDocuments({ board: { $in: ids } })}`);
  log(`  notifications       ${await col('notifications').countDocuments({ board: { $in: ids } })}`);
  log(`  activity rows       ${await col('activitylogs').countDocuments({ board: { $in: ids } })}`);

  const withToken = await col('boards').countDocuments({ ...clientBoardFilter(), portalToken: { $exists: true } });
  log(`\n${withToken} live portal link(s) would STOP WORKING. Every client must be re-invited.`);

  const cat = await col('servicecatalogentries').countDocuments({});
  log(`\nService catalog currently holds ${cat} entr(ies).`);
  log(`Groups that would seed it: ${new Set(groups.map((g) => serviceSlug(g.name)).filter(Boolean)).size} distinct name(s).`);

  log('\nNothing was changed. Next: --seed-catalog, then --wipe --force.');
  void groupIds;
};

/* ------------------------------------------------------------------ */
/* --seed-catalog  (run BEFORE --wipe)                                 */
/* ------------------------------------------------------------------ */
const seedCatalog = async () => {
  head('SEED CATALOG — turn existing group names into the service vocabulary');

  const boards = await clientBoards();
  if (!boards.length) return log('No client boards. Nothing to seed from.');

  const orgOf = new Map(boards.map((b) => [String(b._id), b.organisation]));
  const groups = await col('taskgroups')
    .find({ board: { $in: boards.map((b) => b._id) } })
    .project({ name: 1, board: 1 })
    .toArray();

  // (org, slug) -> { name, count }. First casing wins, exactly as the live
  // catalog upsert does, so the two cannot disagree about "SEO" vs "seo".
  const seen = new Map();
  for (const g of groups) {
    const org = orgOf.get(String(g.board));
    const slug = serviceSlug(g.name);
    if (!org || !slug) continue;
    const key = `${org}|${slug}`;
    if (seen.has(key)) seen.get(key).count += 1;
    else seen.set(key, { org, slug, name: normaliseServiceName(g.name), count: 1 });
  }

  if (!seen.size) return log('No sluggable group names found.');

  log(`${seen.size} distinct (organisation, service) pair(s):`);
  for (const e of seen.values()) log(`  • ${e.name}  [${e.slug}]  ×${e.count}`);

  if (DRY) return log('\n--dry-run: nothing written.');

  let made = 0;
  for (const e of seen.values()) {
    const res = await col('servicecatalogentries').updateOne(
      { organisation: e.org, slug: e.slug },
      {
        $setOnInsert: {
          organisation: e.org,
          slug: e.slug,
          name: e.name,
          color: colorForSlug(e.slug),
          order: 0,
          archived: false,
          createdBy: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        $set: { lastUsedAt: new Date() },
        $inc: { usageCount: e.count },
      },
      { upsert: true }
    );
    if (res.upsertedCount) made += 1;
  }
  log(`\nSeeded ${made} new catalog entr(ies); the rest already existed.`);
};

/* ------------------------------------------------------------------ */
/* --wipe                                                              */
/* ------------------------------------------------------------------ */
const wipe = async () => {
  head('WIPE — destroy every client board and everything under it');

  if (!FORCE) {
    log('REFUSING without --force.');
    log('Run --report first, read what it names, then re-run with --force.');
    process.exitCode = 1;
    return;
  }

  const boards = await clientBoards();
  if (!boards.length) return log('No client boards. Nothing to wipe.');

  const ids = boards.map((b) => b._id);
  log(`Wiping ${ids.length} board(s): ${boards.map((b) => `"${b.name}"`).join(', ')}`);
  if (DRY) return log('--dry-run: nothing deleted.');

  const channels = await col('channels').find({ board: { $in: ids } }).project({ _id: 1 }).toArray();
  const channelIds = channels.map((c) => c._id);
  const tasks = await col('tasks').find({ board: { $in: ids } }).project({ _id: 1 }).toArray();
  const taskIds = tasks.map((t) => t._id);

  // ---- 1. Cloudinary FIRST, read before delete --------------------------
  // The step a hand-rolled wipe forgets. Once the rows are gone nothing knows
  // the public ids and the files stay in the account forever, costing money for
  // data nobody can reach.
  const attachments = [];
  const collect = async (name, filter) => {
    const rows = await col(name).find(filter).project({ attachments: 1 }).toArray();
    for (const r of rows) for (const a of r.attachments || []) if (a?.publicId) attachments.push(a);
  };
  await collect('messages', { channel: { $in: channelIds } });
  await collect('tasks', { board: { $in: ids } });
  await collect('updates', { task: { $in: taskIds } });
  if (attachments.length) {
    log(`  destroying ${attachments.length} Cloudinary asset(s)…`);
    await destroyCloudinaryAssets(attachments);
  }

  // ---- 2..9. leaf rows first, the row that finds them last ---------------
  const del = async (name, filter) => {
    const { deletedCount } = await col(name).deleteMany(filter);
    log(`  ${name.padEnd(22)} ${deletedCount}`);
  };

  await del('mailthreadreads', { channel: { $in: channelIds } });
  await del('channelcontactreads', { channel: { $in: channelIds } });
  await del('channelreads', { channel: { $in: channelIds } });
  await del('messages', { channel: { $in: channelIds } });
  await del('channels', { board: { $in: ids } });

  await del('updates', { task: { $in: taskIds } });
  await del('itemfollows', { task: { $in: taskIds } });
  await del('notifications', {
    $or: [{ board: { $in: ids } }, { task: { $in: taskIds } }, { channel: { $in: channelIds } }],
  });
  await del('activitylogs', { board: { $in: ids } });

  await del('tasks', { board: { $in: ids } });
  await del('taskgroups', { board: { $in: ids } });
  await del('notes', { board: { $in: ids } });
  await del('clientcontacts', { board: { $in: ids } });

  if (DROP_BOARDS) {
    await del('boards', { _id: { $in: ids } });
  } else {
    // A client board with no services and no contacts is not a useful shell —
    // it just clutters the sidebar — so --drop-boards is the recommended form.
    // Without it the shells stay, with every portal field cleared.
    const { modifiedCount } = await col('boards').updateMany(
      { _id: { $in: ids } },
      {
        $unset: {
          portalToken: '',
          portalEnabled: '',
          portalClientName: '',
          portalTier: '',
          portalTierUpgradedAt: '',
          portalTierUpgradedBy: '',
          portalCategories: '',
          portalTicketSeq: '',
          portalAnnouncement: '',
          portalFaqs: '',
        },
      }
    );
    log(`  boards                 ${modifiedCount} stripped (kept — pass --drop-boards to delete)`);
  }

  log('\nWipe complete. Every portal link is dead; re-invite through the batch invite.');
};

/* ------------------------------------------------------------------ */
/* --indexes                                                           */
/* ------------------------------------------------------------------ */
const indexes = async () => {
  head('INDEXES');

  if (DRY) return log('--dry-run: no index changes.');

  // CREATE EXPLICITLY, not via autoIndex. An autoIndex build failure is emitted
  // on the model and, with no listener, swallowed — so you would deploy
  // believing the constraint exists while duplicates quietly accumulate.
  await col('servicecatalogentries').createIndex(
    { organisation: 1, slug: 1 },
    { unique: true, name: 'organisation_1_slug_1' }
  );
  log('  + servicecatalogentries.organisation_1_slug_1 (unique)');

  const dropIfPresent = async (name, index) => {
    const existing = await col(name).indexes().catch(() => []);
    if (!existing.some((i) => i.name === index)) return log(`  · ${name}.${index} already absent`);
    await col(name).dropIndex(index);
    log(`  - ${name}.${index} dropped`);
  };

  // Worse than inert: a unique index still costs a write on every group insert,
  // and would fire E11000 the day anything wrote a portalToken-shaped field back.
  await dropIfPresent('taskgroups', 'portalToken_1');
  await dropIfPresent('clientcontacts', 'group_1');
  await dropIfPresent('clientcontacts', 'group_1_email_1');

  // A no-op after --wipe, but the phase has to exist so the script is still
  // correct for an operator who skipped it.
  const { modifiedCount } = await col('clientcontacts').updateMany(
    { group: { $exists: true } },
    { $unset: { group: '' } }
  );
  log(`  · ClientContact.group unset on ${modifiedCount} row(s)`);

  log('\nNOT created, each on purpose:');
  log('  · taskgroups.serviceKey — {board:1} already prefixes every query that reads it');
  log('  · clientcontacts.services — multikey write cost for a query nobody makes');
  log('  · updates.* — {task,visibility,createdAt} already serves the home aggregate');
};

/* ------------------------------------------------------------------ */
/* --verify                                                            */
/* ------------------------------------------------------------------ */
const verify = async () => {
  head('VERIFY');
  let bad = 0;
  const ok = (label, condition, detail) => {
    if (!condition) bad += 1;
    log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  };

  const dupes = await col('servicecatalogentries')
    .aggregate([
      { $group: { _id: { o: '$organisation', s: '$slug' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  ok('no duplicate (organisation, slug) in the catalog', dupes.length === 0, `${dupes.length} dupes`);

  const catIdx = await col('servicecatalogentries').indexes().catch(() => []);
  ok('the catalog unique index exists',
    catIdx.some((i) => i.name === 'organisation_1_slug_1' && i.unique));

  const tgIdx = await col('taskgroups').indexes().catch(() => []);
  ok('taskgroups.portalToken_1 is gone', !tgIdx.some((i) => i.name === 'portalToken_1'));

  ok('no board still carries portalTier',
    (await col('boards').countDocuments({ portalTier: { $exists: true } })) === 0);
  ok('no contact still carries the vestigial group field',
    (await col('clientcontacts').countDocuments({ group: { $exists: true } })) === 0);

  const boards = await clientBoards();
  const ids = boards.map((b) => b._id);
  const groups = await col('taskgroups').find({ board: { $in: ids } }).project({ _id: 1, name: 1 }).toArray();
  const withClientChannel = new Set(
    (
      await col('channels')
        .find({ board: { $in: ids }, audience: 'client' })
        .project({ group: 1 })
        .toArray()
    ).map((c) => String(c.group))
  );
  const naked = groups.filter((g) => !withClientChannel.has(String(g._id)));
  ok('every service has client-facing rooms', naked.length === 0,
    naked.map((g) => g.name).join(', '));

  // A services entry pointing at a group on another board would be a labelling
  // bug the roster would render as someone else's service.
  const contacts = await col('clientcontacts')
    .find({ board: { $in: ids }, services: { $exists: true, $ne: [] } })
    .project({ board: 1, services: 1 })
    .toArray();
  const groupBoard = new Map(
    (await col('taskgroups').find({ board: { $in: ids } }).project({ board: 1 }).toArray()).map(
      (g) => [String(g._id), String(g.board)]
    )
  );
  const strayed = contacts.filter((c) =>
    (c.services || []).some((s) => groupBoard.get(String(s)) !== String(c.board))
  );
  ok('no contact holds a service from another board', strayed.length === 0, `${strayed.length}`);

  log(bad ? `\n${bad} CHECK(S) FAILED` : '\nAll checks passed.');
  if (bad) process.exitCode = 1;
};

/* ------------------------------------------------------------------ */
const main = async () => {
  await connectDB();
  try {
    if (has('--seed-catalog')) await seedCatalog();
    else if (has('--wipe')) await wipe();
    else if (has('--indexes')) await indexes();
    else if (has('--verify')) await verify();
    else await report();
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((err) => {
  console.error('resetClientPortals failed:', err);
  process.exit(1);
});

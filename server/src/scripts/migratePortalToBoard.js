/**
 * SUPERSEDED by scripts/resetClientPortals.js.
 *
 * This migrated the portal link from the GROUP up to the BOARD, back when a
 * group was a client company. It is kept for the record and for anyone rolling
 * a very old database forward, but the data it migrates is the data the reset
 * script wipes, and the `portalTier` it used to carry no longer exists.
 */

/**
 * migratePortalToBoard.js
 *
 * Moves the Client Portal from being GROUP-scoped to BOARD-scoped.
 *
 * WHY THIS EXISTS: a `boardType:'client'` board used to hold several clients,
 * one per group — each group carried its own `portalToken`/`portalEnabled`/
 * `portalClientName`, and a `ClientContact` was unique on `(group, email)`. The
 * board IS the client now, and its groups are that one client's WORKSTREAMS
 * (SEO, Ads, Web Development). The link, the contact roster and the task filter
 * all moved up a level, so the stored data has to move with them.
 *
 * THE ONE THING TO KNOW BEFORE RUNNING IT: promotion carries the EXISTING group
 * token upward rather than minting a new one. That is deliberate and it is the
 * whole reason clients are not disrupted — `/portal/:portalToken` is the same
 * URL shape either way, so every link already sitting in a client's inbox, and
 * every live 7-day session JWT (whose `ptk` claim is that same string), keeps
 * working across the deploy.
 *
 * IT REFUSES BOARDS THAT CARRY MORE THAN ONE LIVE TOKEN, and that refusal is
 * the most important thing in this file. The premise of the whole change is
 * "one client company per board". A board with two token-bearing groups is the
 * only evidence you will ever get that the premise is false *there* — and if it
 * is, merging those rosters under `(board, email)` and letting `portalShared`
 * span the board is a cross-company disclosure, not an inconvenience. So it
 * stops and names the board. Split it by hand, then re-run.
 *
 * WRITES THROUGH THE RAW DRIVER COLLECTION, not through Mongoose. Same escape
 * hatch `renameMonthlyBoardType.js` uses and for the same reasons: the fields
 * being read no longer exist on the TaskGroup schema, `Board.portalToken` is
 * `select: false`, and the model's hooks must not fire on a
 * migration that is allowed to write whatever the data actually requires.
 *
 * IDEMPOTENT. Every phase's criterion is a fact about the data ("this board has
 * no portalToken"), never "have I run before", so re-running is a no-op and a
 * partial run can simply be repeated.
 *
 * DELIBERATELY NOT TOUCHED:
 *   - Tracker boards and their groups. A group is a client there too, but that
 *     is a different, internal notion of "client" and it is staying as it is.
 *   - Standard boards. They have never had a portal.
 *   - Task.portalShared / Task.source / Update.visibility. The two doors into
 *     the portal are unchanged; only their SCOPE moved.
 *   - Board.portalTier. REMOVED ENTIRELY — there is no tier any more; see
 *     utils/clientBoard.js. This script no longer writes the field. It arrives only through
 *     the explicit one-way upgrade in the app.
 *
 * Run from the server directory:
 *   node src/scripts/migratePortalToBoard.js --report
 *   node src/scripts/migratePortalToBoard.js --contacts --dry-run
 *   node src/scripts/migratePortalToBoard.js --contacts
 *   node src/scripts/migratePortalToBoard.js --promote --dry-run
 *   node src/scripts/migratePortalToBoard.js --promote
 *   node src/scripts/migratePortalToBoard.js --indexes
 *   node src/scripts/migratePortalToBoard.js --verify
 *   # only after the soak window:
 *   node src/scripts/migratePortalToBoard.js --drop-legacy
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const DRY = has('--dry-run') || has('-n');
const ONLY_BOARD = valueOf('--board');
const ONLY_ORG = valueOf('--org');
const FORCE = has('--force');
/**
 * The group whose portal link is to be given up, so a refused board is left
 * with exactly one and can be promoted normally.
 *
 * There is deliberately NO "adopt both links" flag. One existed, wrote a
 * `portalTokenAliases` array onto the board and announced that it had kept the
 * second link alive — and nothing anywhere read that field. Supporting two live
 * credentials per board is a real feature (a second lookup path in
 * `loadPortalBoard` AND in `verifyPortalToken`, plus an index, plus a rotation
 * story for each), and half of it is worse than none: the operator believes the
 * old link works and the client discovers it does not.
 */
const RELEASE_TOKEN = valueOf('--release-token');

const log = (...a) => console.log(...a);
const head = (t) => log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);

/* ------------------------------------------------------------------ */
/* Collections (raw driver — no schema, no hooks, no select:false)      */
/* ------------------------------------------------------------------ */
const col = (name) => mongoose.connection.collection(name);

const clientBoardFilter = () => {
  const f = { boardType: 'client' };
  if (ONLY_BOARD) f._id = new mongoose.Types.ObjectId(ONLY_BOARD);
  if (ONLY_ORG) f.organisation = new mongoose.Types.ObjectId(ONLY_ORG);
  return f;
};

/* ------------------------------------------------------------------ */
/* --report                                                            */
/* ------------------------------------------------------------------ */
/**
 * Audit only. Answers the two questions the rest of the migration depends on:
 * does any board hold more than one client, and does any board hold the same
 * email twice?
 */
const report = async () => {
  head('AUDIT');
  const boards = await col('boards').find(clientBoardFilter()).toArray();
  log(`Client boards: ${boards.length}`);

  let multi = 0;
  let promoted = 0;
  let noToken = 0;

  for (const b of boards) {
    const groups = await col('taskgroups')
      .find({ board: b._id })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    const withToken = groups.filter((g) => g.portalToken);
    const alreadyUp = !!b.portalToken;
    if (alreadyUp) promoted += 1;

    if (withToken.length > 1) {
      multi += 1;
      log(`\n  ⚠ REFUSED  "${b.name}" (${b._id}) — ${withToken.length} groups carry a portal token:`);
      withToken.forEach((g) =>
        log(`      · group "${g.name}" (${g._id})  enabled=${!!g.portalEnabled}  clientName="${g.portalClientName || ''}"`)
      );
      log('      This board may hold more than one client company. A board is ONE');
      log('      client now, so exactly one of these links can survive as the');
      log('      board\'s. Resolve it, then re-run --promote:');
      log('');
      log('        · genuinely two companies → move one group to its own client');
      log('          board (team side), which leaves one token here; or');
      log('        · one is stale or a test → release it:');
      log(`            npm run migrate:portal-board -- --release-token <groupId>`);
      log('');
      log('      Run `npm run inspect:client-board -- --all-refused` first: it is');
      log('      read-only and prints the contacts and email domains on each');
      log('      group, which is what actually settles the question.');
    } else if (withToken.length === 0 && !alreadyUp) {
      noToken += 1;
      log(`  · "${b.name}" (${b._id}) — no live portal on any group; will mint a DISABLED token`);
    }
  }

  // Duplicate (board, email) pairs — these are legal today and are an E11000
  // the moment the new unique index is built.
  const dupes = await col('clientcontacts')
    .aggregate([
      { $group: { _id: { b: '$board', e: '$email' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();

  head('SUMMARY');
  log(`  client boards            : ${boards.length}`);
  log(`  already promoted         : ${promoted}`);
  log(`  with no live portal      : ${noToken}`);
  log(`  REFUSED (multi-token)    : ${multi}`);
  log(`  duplicate (board,email)  : ${dupes.length} pair(s) to merge`);
  if (dupes.length) {
    for (const d of dupes) log(`      · board=${d._id.b} email=${d._id.e} ×${d.n}`);
  }
  log('');
  if (multi) {
    log('  Resolve the refused boards before running --promote.');
  } else {
    log('  Safe to run: --contacts, then --promote, then --indexes.');
  }
};

/* ------------------------------------------------------------------ */
/* --contacts : dedupe (board, email)                                  */
/* ------------------------------------------------------------------ */
/**
 * Merge contacts that share (board, email) — legal under the old (group, email)
 * identity, fatal under the new one.
 *
 * The winner keeps the row. Its losers' REFERENCES are re-pointed FIRST:
 * skipping that is silent data loss, because `portalTaskFilter` matches on
 * `portalSubmitter` and a client's own tickets would simply stop appearing in
 * their list while still sitting on the team's board.
 */
const dedupeContacts = async () => {
  head(DRY ? 'CONTACTS (dry run)' : 'CONTACTS');
  const match = {};
  if (ONLY_BOARD) match.board = new mongoose.Types.ObjectId(ONLY_BOARD);

  const dupes = await col('clientcontacts')
    .aggregate([
      ...(Object.keys(match).length ? [{ $match: match }] : []),
      { $group: { _id: { b: '$board', e: '$email' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();

  if (!dupes.length) {
    log('  Nothing to merge — every (board, email) is already unique.');
    return;
  }

  let merged = 0;
  let movedTasks = 0;
  let movedUpdates = 0;

  for (const d of dupes) {
    const rows = await col('clientcontacts').find({ _id: { $in: d.ids } }).toArray();
    // Winner: verified first, then most recently seen, then has a password,
    // then oldest. The most "real" account survives.
    rows.sort((a, b) => {
      if (!!b.verified !== !!a.verified) return b.verified ? 1 : -1;
      const at = a.lastSeenAt ? a.lastSeenAt.getTime() : 0;
      const bt = b.lastSeenAt ? b.lastSeenAt.getTime() : 0;
      if (bt !== at) return bt - at;
      if (!!b.passwordHash !== !!a.passwordHash) return b.passwordHash ? 1 : -1;
      return (a.createdAt?.getTime() || 0) - (b.createdAt?.getTime() || 0);
    });
    const winner = rows[0];
    const losers = rows.slice(1).map((r) => r._id);

    const nTasks = await col('tasks').countDocuments({ portalSubmitter: { $in: losers } });
    const nUpdates = await col('updates').countDocuments({ portalAuthor: { $in: losers } });

    log(
      `  merge ${d._id.e} on board ${d._id.b}: keep ${winner._id}, drop ${losers.length}` +
        ` (re-point ${nTasks} task(s), ${nUpdates} update(s))`
    );

    if (!DRY) {
      if (nTasks) {
        await col('tasks').updateMany(
          { portalSubmitter: { $in: losers } },
          { $set: { portalSubmitter: winner._id } }
        );
      }
      if (nUpdates) {
        await col('updates').updateMany(
          { portalAuthor: { $in: losers } },
          { $set: { portalAuthor: winner._id } }
        );
      }
      await col('clientcontacts').deleteMany({ _id: { $in: losers } });
    }
    merged += 1;
    movedTasks += nTasks;
    movedUpdates += nUpdates;
  }

  log(`\n  ${DRY ? 'would merge' : 'merged'} ${merged} pair(s); ${movedTasks} task(s), ${movedUpdates} update(s) re-pointed.`);
};

/* ------------------------------------------------------------------ */
/* --promote : group portal fields -> board                            */
/* ------------------------------------------------------------------ */
const promote = async () => {
  head(DRY ? 'PROMOTE (dry run)' : 'PROMOTE');
  const boards = await col('boards').find(clientBoardFilter()).toArray();

  let done = 0;
  let skipped = 0;
  let refused = 0;
  let minted = 0;

  for (const b of boards) {
    if (b.portalToken && !FORCE) {
      skipped += 1;
      continue;
    }

    const groups = await col('taskgroups')
      .find({ board: b._id })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    const withToken = groups.filter((g) => g.portalToken);

    if (withToken.length > 1) {
      refused += 1;
      log(`  ⚠ REFUSED "${b.name}" (${b._id}) — ${withToken.length} live tokens. See --report.`);
      continue;
    }

    let set;
    if (withToken.length === 0) {
      // No live portal ever existed here. Mint one, but leave it OFF: turning
      // a portal on is a decision, and this script is not the one making it.
      const { generatePortalToken } = require('../utils/portalCrypto');
      set = {
        portalToken: generatePortalToken(),
        portalEnabled: false,
        portalClientName: b.portalClientName || b.name,
      };
      minted += 1;
      log(`  + "${b.name}" — minted a DISABLED token (no group carried one)`);
    } else {
      // Exactly one, always — the multi-token case was refused above.
      const primary = withToken[0];
      const anyEnabled = !!primary.portalEnabled;
      set = {
        portalToken: primary.portalToken,
        portalEnabled: !!anyEnabled,
        portalClientName: (primary.portalClientName || '').trim() || b.name,
      };
      log(`  ✓ "${b.name}" — promoted token from group "${primary.name}" (enabled=${anyEnabled})`);
    }

    if (!DRY) {
      await col('boards').updateOne({ _id: b._id }, { $set: set });
      // Contacts already carry `board` (it has always been required), so there
      // is nothing to backfill — but verify rather than assume.
      const stray = await col('clientcontacts').countDocuments({
        board: { $ne: b._id },
        group: { $in: groups.map((g) => g._id) },
      });
      if (stray) {
        log(`      fixing ${stray} contact(s) whose board did not match their group`);
        await col('clientcontacts').updateMany(
          { group: { $in: groups.map((g) => g._id) } },
          { $set: { board: b._id, organisation: b.organisation } }
        );
      }
    }
    done += 1;
  }

  log(`\n  ${DRY ? 'would promote' : 'promoted'} ${done} board(s); ${skipped} already done, ${minted} minted, ${refused} refused.`);
  if (refused) log('  Refused boards need a human decision — see the header comment.');
};

/* ------------------------------------------------------------------ */
/* --release-token <groupId>                                           */
/* ------------------------------------------------------------------ */
/**
 * Give up ONE group's portal link, so a refused board is left with a single
 * token and can be promoted.
 *
 * THIS KILLS A LIVE LINK. Anyone holding it is signed out on their next
 * request, exactly as "regenerate link" does — that is not a side effect, it is
 * the point: the board is about to have one link, and this says which one loses.
 *
 * So it prints who it is about to cut off and refuses without `--force`. A
 * migration step that silently revokes a client's access is not a step anyone
 * should be able to take by typing the wrong id.
 *
 * The group keeps its tasks, its contacts and its name; it simply becomes an
 * ordinary workstream on the board, which is what every group on a client board
 * now is.
 */
const releaseToken = async () => {
  head(DRY ? 'RELEASE TOKEN (dry run)' : 'RELEASE TOKEN');

  let gid;
  try {
    gid = new mongoose.Types.ObjectId(RELEASE_TOKEN);
  } catch {
    log(`  ✗ "${RELEASE_TOKEN}" is not a valid group id.`);
    return false;
  }

  const group = await col('taskgroups').findOne({ _id: gid });
  if (!group) {
    log(`  ✗ No group ${RELEASE_TOKEN}.`);
    return false;
  }
  if (!group.portalToken) {
    log(`  · Group "${group.name}" carries no portal token. Nothing to release.`);
    return true;
  }

  const board = await col('boards').findOne({ _id: group.board });
  const contacts = await col('clientcontacts')
    .find({ group: gid })
    .project({ email: 1 })
    .toArray();

  log(`  board  : "${board?.name}" (${group.board})`);
  log(`  group  : "${group.name}" (${gid})`);
  log(`  enabled: ${!!group.portalEnabled}`);
  log(`  ${contacts.length} contact(s) lose this link:`);
  contacts.forEach((c) => log(`      · ${c.email}`));
  log('');
  log('  Their CONTACT ROWS are kept — they stay on the board and will reach it');
  log('  through the surviving link once it is promoted. Only this URL dies.');

  if (!FORCE) {
    log('');
    log('  ✗ REFUSED — re-run with --force once the list above is what you meant.');
    return false;
  }

  if (!DRY) {
    await col('taskgroups').updateOne(
      { _id: gid },
      { $unset: { portalToken: '', portalEnabled: '', portalClientName: '' } }
    );
  }
  log(`\n  ${DRY ? 'would release' : 'released'} the link on "${group.name}".`);
  log('  Now re-run --report; this board should no longer be refused.');
  return true;
};

/* ------------------------------------------------------------------ */
/* --indexes                                                           */
/* ------------------------------------------------------------------ */
/**
 * The unique-index swap on clientcontacts, in the only safe order.
 *
 * The old `{group:1, email:1}` index MUST be dropped in the same window the new
 * one is created — not later. New contacts are written with `group` ABSENT, and
 * a compound unique index that is not partial treats a missing field as null,
 * so two new contacts sharing an email on different boards would both key as
 * {group:null, email:x} and collide.
 */
const indexes = async () => {
  head(DRY ? 'INDEXES (dry run)' : 'INDEXES');
  const cc = col('clientcontacts');
  const existing = await cc.indexes();
  const names = existing.map((i) => i.name);
  log(`  clientcontacts indexes: ${names.join(', ')}`);

  if (!names.includes('board_1_email_1')) {
    log('  + create board_1_email_1 (unique)');
    if (!DRY) {
      // Explicit, not via autoIndex: an autoIndex build failure is emitted on
      // the model and, with no listener, effectively swallowed — you would
      // deploy believing the constraint exists.
      await cc.createIndex({ board: 1, email: 1 }, { unique: true, name: 'board_1_email_1' });
    }
  } else {
    log('  · board_1_email_1 already present');
  }

  for (const stale of ['group_1_email_1', 'group_1']) {
    if (names.includes(stale)) {
      log(`  - drop ${stale}`);
      if (!DRY) await cc.dropIndex(stale);
    } else {
      log(`  · ${stale} already gone`);
    }
  }

  // The board's own sparse unique token index, created explicitly for the same
  // "do not trust autoIndex" reason.
  const bIdx = (await col('boards').indexes()).map((i) => i.name);
  if (!bIdx.includes('portalToken_1')) {
    log('  + create boards.portalToken_1 (unique, sparse)');
    if (!DRY) {
      await col('boards').createIndex(
        { portalToken: 1 },
        { unique: true, sparse: true, name: 'portalToken_1' }
      );
    }
  } else {
    log('  · boards.portalToken_1 already present');
  }
};

/* ------------------------------------------------------------------ */
/* --drop-legacy : AFTER the soak window                               */
/* ------------------------------------------------------------------ */
/**
 * Point of no return. The group fields are the only copy of the pre-migration
 * truth, so this must not run until rolling back to the old code is off the
 * table.
 */
const dropLegacy = async () => {
  head(DRY ? 'DROP LEGACY (dry run)' : 'DROP LEGACY');

  // ---- THE POINT OF NO RETURN, AND THE ONLY GUARD ON IT --------------------
  //
  // This unsets the group-level portal fields. Until it runs, BOTH the old code
  // (which reads the token off the group) and the new code (which reads it off
  // the board) work against the same database — which is the entire rollback
  // story for this migration. After it runs, rolling the code back means every
  // client portal link is dead.
  //
  // Worse, run BEFORE --promote it does not just remove a duplicate: the group
  // holds the ONLY copy of each token, so this would delete every client's
  // credential outright. The links would not come back by re-running anything,
  // because there would be nothing left to promote — every client would need a
  // freshly minted link and a new invitation email.
  //
  // So: refuse while any live client portal has not been promoted.
  const boards = await col('boards').find(clientBoardFilter()).toArray();
  const unpromoted = [];
  for (const b of boards) {
    if (b.portalToken) continue;
    const n = await col('taskgroups').countDocuments({
      board: b._id,
      portalToken: { $exists: true, $ne: null },
    });
    if (n) unpromoted.push(b);
  }
  if (unpromoted.length) {
    log(`  ✗ REFUSED — ${unpromoted.length} client board(s) still hold their token on a GROUP:`);
    unpromoted.forEach((b) => log(`      · "${b.name}" (${b._id})`));
    log('');
    log('    The group is the only copy. Unsetting it now would destroy those');
    log('    links permanently — not move them. Run --promote first (and resolve');
    log('    any refused board), then come back.');
    return false;
  }

  const tg = col('taskgroups');
  const tgIdx = (await tg.indexes()).map((i) => i.name);
  if (tgIdx.includes('portalToken_1')) {
    log('  - drop taskgroups.portalToken_1');
    if (!DRY) await tg.dropIndex('portalToken_1');
  } else {
    log('  · taskgroups.portalToken_1 already gone');
  }

  const nGroups = await tg.countDocuments({ portalToken: { $exists: true } });
  log(`  - $unset portal fields on ${nGroups} group(s)`);
  if (!DRY && nGroups) {
    await tg.updateMany(
      { $or: [{ portalToken: { $exists: true } }, { portalEnabled: { $exists: true } }, { portalClientName: { $exists: true } }] },
      { $unset: { portalToken: '', portalEnabled: '', portalClientName: '' } }
    );
  }

  const nContacts = await col('clientcontacts').countDocuments({ group: { $exists: true } });
  log(`  - $unset ClientContact.group on ${nContacts} contact(s)`);
  if (!DRY && nContacts) {
    await col('clientcontacts').updateMany({ group: { $exists: true } }, { $unset: { group: '' } });
  }

  log('\n  Rollback is no longer available: the old code cannot find these');
  log('  portals any more. The new code is now the only one that works.');
  return true;
};

/* ------------------------------------------------------------------ */
/* --verify                                                            */
/* ------------------------------------------------------------------ */
const verify = async () => {
  head('VERIFY');
  const checks = [];
  const add = (label, actual, expected = 0) =>
    checks.push({ label, actual, ok: actual === expected });

  // A client board with SERVICES on it must hold a token: the first service is
  // what mints one (server/src/utils/portalActivation.js). A client board with
  // NO services legitimately has none and must not be counted — that is now the
  // normal state of a board somebody created five minutes ago, and asserting
  // otherwise would fail this check on every healthy deployment.
  const boardsWithServices = await col('taskgroups').distinct('board');
  add(
    'client boards that have services but no portalToken',
    await col('boards').countDocuments({
      boardType: 'client',
      _id: { $in: boardsWithServices },
      portalToken: { $exists: false },
    })
  );
  add(
    'non-client boards carrying a portalToken',
    await col('boards').countDocuments({ boardType: { $ne: 'client' }, portalToken: { $exists: true } })
  );
  add(
    'contacts with no board',
    await col('clientcontacts').countDocuments({ board: { $exists: false } })
  );

  const dupes = await col('clientcontacts')
    .aggregate([
      { $group: { _id: { b: '$board', e: '$email' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  add('duplicate (board, email) pairs', dupes.length);

  // Every client-raised task must still point at a contact that exists AND sits
  // on that task's own board. This is what proves the dedupe re-pointing worked.
  const orphans = await col('tasks')
    .aggregate([
      { $match: { source: 'client', portalSubmitter: { $ne: null } } },
      {
        $lookup: {
          from: 'clientcontacts',
          localField: 'portalSubmitter',
          foreignField: '_id',
          as: 'c',
        },
      },
      {
        $match: {
          $or: [
            { c: { $size: 0 } },
            { $expr: { $ne: [{ $arrayElemAt: ['$c.board', 0] }, '$board'] } },
          ],
        },
      },
      { $count: 'n' },
    ])
    .toArray();
  add('client tasks with a missing/mismatched submitter', orphans[0]?.n || 0);

  const ccIdx = (await col('clientcontacts').indexes()).map((i) => i.name);
  checks.push({
    label: 'clientcontacts has board_1_email_1',
    actual: ccIdx.includes('board_1_email_1'),
    ok: ccIdx.includes('board_1_email_1'),
  });
  checks.push({
    label: 'clientcontacts group_1_email_1 dropped',
    actual: !ccIdx.includes('group_1_email_1'),
    ok: !ccIdx.includes('group_1_email_1'),
  });

  for (const c of checks) log(`  ${c.ok ? '✓' : '✗'} ${c.label}: ${c.actual}`);
  const bad = checks.filter((c) => !c.ok);
  log(bad.length ? `\n  ${bad.length} CHECK(S) FAILED` : '\n  All checks passed.');
  return bad.length === 0;
};

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */
const main = async () => {
  await connectDB();
  if (DRY) log('\n*** DRY RUN — nothing will be written ***');
  if (ONLY_BOARD) log(`*** scoped to board ${ONLY_BOARD} ***`);
  if (ONLY_ORG) log(`*** scoped to org ${ONLY_ORG} ***`);

  const phases = ['--contacts', '--promote', '--indexes', '--drop-legacy', '--verify'];
  const chosen = phases.filter(has);

  if (!chosen.length || has('--report')) {
    await report();
  }
  let ok = true;
  if (RELEASE_TOKEN) ok = (await releaseToken()) && ok;
  if (has('--contacts')) await dedupeContacts();
  if (has('--promote')) await promote();
  if (has('--indexes')) await indexes();
  if (has('--drop-legacy')) ok = (await dropLegacy()) && ok;
  if (has('--verify')) ok = await verify();

  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
};

main().catch(async (err) => {
  console.error('\nmigratePortalToBoard failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* already down */
  }
  process.exit(1);
});

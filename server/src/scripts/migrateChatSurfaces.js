/**
 * migrateChatSurfaces.js
 *
 * Backfills `Channel.mode` / `Channel.audience` and swaps the uniqueness key
 * from `(board, group)` to `(board, group, mode, audience)`.
 *
 * WHY THIS EXISTS: a channel used to be one thing — a chat room — so one per
 * (board, group) was the right constraint. A workstream on a client board can
 * now carry up to four SURFACES (chat/mail x team/client), so the pair no
 * longer identifies a row. See models/Channel.js.
 *
 * THE THING THAT MAKES THIS DANGEROUS, and the only reason it is a script
 * rather than a schema edit: a Mongoose `default` applies on WRITE and never to
 * documents already stored. Every channel written before these fields existed
 * carries neither, and a unique index reads a missing field as null. So
 * `(board, group, null, null)` and `(board, group, 'chat', 'team')` are
 * DIFFERENT index entries — and the moment anything upserts with the defaults,
 * MongoDB happily creates a SECOND room for every existing tracker group,
 * splitting each team's history in half with no error anywhere.
 *
 * Hence the order, which must not be rearranged:
 *
 *   1. $set mode/audience on every existing channel   (nothing to collide yet)
 *   2. create (board, group, mode, audience) unique   (the new guarantee)
 *   3. drop (board, group)                            (the old one, last)
 *
 * Step 1 before 3 is what prevents the duplicate. Step 2 before 3 is what keeps
 * the collection guarded at every instant: while the old index still exists it
 * is the only thing preventing the very race this migration is protecting.
 *
 * IDEMPOTENT. Every phase's criterion is a fact about the data ("this channel
 * has no mode"), never "have I run before", so re-running is a no-op and a
 * partial run can simply be repeated.
 *
 * WRITES THROUGH THE RAW DRIVER COLLECTION. Same escape hatch
 * renameMonthlyBoardType.js uses, and for the same reason: this is the one
 * caller allowed to set fields to whatever the data actually requires, without
 * schema defaults or hooks intervening.
 *
 * DELIBERATELY NOT TOUCHED:
 *   - Every existing channel stays `mode:'chat'`, `audience:'team'`. That is
 *     exactly what they already were: private team rooms. Nothing gains an
 *     audience it did not have, and no client can see anything as a result of
 *     running this.
 *   - DMs. They are `kind:'dm'` with `group: null`, outside the partial index
 *     entirely, and their audience is their two members.
 *   - Messages. No message is rewritten; `subject` is absent on all of them,
 *     which is correct for chat.
 *
 * Run from the server directory:
 *   node src/scripts/migrateChatSurfaces.js --report
 *   node src/scripts/migrateChatSurfaces.js --backfill --dry-run
 *   node src/scripts/migrateChatSurfaces.js --backfill
 *   node src/scripts/migrateChatSurfaces.js --indexes
 *   node src/scripts/migrateChatSurfaces.js --verify
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
const ONLY_ORG = valueOf('--org');

const log = (...a) => console.log(...a);
const head = (t) => log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);

const col = (name) => mongoose.connection.collection(name);

const OLD_INDEX = 'board_1_group_1';
const NEW_INDEX = 'board_1_group_1_mode_1_audience_1';

const scope = () => {
  const f = {};
  if (ONLY_ORG) f.organisation = new mongoose.Types.ObjectId(ONLY_ORG);
  return f;
};

/* ------------------------------------------------------------------ */
/* --report                                                            */
/* ------------------------------------------------------------------ */
const report = async () => {
  head('AUDIT');
  const channels = col('channels');

  const total = await channels.countDocuments(scope());
  const missingMode = await channels.countDocuments({ ...scope(), mode: { $exists: false } });
  const missingAudience = await channels.countDocuments({
    ...scope(),
    audience: { $exists: false },
  });

  const names = (await channels.indexes()).map((i) => i.name);

  log(`  channels                    : ${total}`);
  log(`  missing \`mode\`              : ${missingMode}`);
  log(`  missing \`audience\`          : ${missingAudience}`);
  log(`  indexes                     : ${names.join(', ')}`);
  log('');
  log(`  ${names.includes(OLD_INDEX) ? '⚠' : '✓'} old ${OLD_INDEX} ${names.includes(OLD_INDEX) ? 'still present' : 'gone'}`);
  log(`  ${names.includes(NEW_INDEX) ? '✓' : '·'} new ${NEW_INDEX} ${names.includes(NEW_INDEX) ? 'present' : 'not created yet'}`);

  // The state that must never exist: a duplicate (board, group) pair among
  // documents that have not been backfilled. The old index guarantees it
  // cannot, so this is a paranoia check against a half-migrated collection.
  const dupes = await channels
    .aggregate([
      { $match: { ...scope(), group: { $type: 'objectId' } } },
      {
        $group: {
          _id: { b: '$board', g: '$group', m: '$mode', a: '$audience' },
          n: { $sum: 1 },
          ids: { $push: '$_id' },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();

  log('');
  if (dupes.length) {
    log(`  ⚠ ${dupes.length} duplicate surface key(s) — the new unique index CANNOT build:`);
    for (const d of dupes) {
      log(`      board=${d._id.b} group=${d._id.g} mode=${d._id.m} audience=${d._id.a} ×${d.n}`);
    }
    log('    Resolve these by hand before running --indexes.');
  } else {
    log('  ✓ no duplicate surface keys — the new index can build.');
  }

  log('');
  if (missingMode || missingAudience) {
    log('  Next: --backfill --dry-run, then --backfill, then --indexes.');
  } else if (names.includes(OLD_INDEX)) {
    log('  Backfill is done. Next: --indexes.');
  } else {
    log('  Nothing to do.');
  }
};

/* ------------------------------------------------------------------ */
/* --backfill                                                          */
/* ------------------------------------------------------------------ */
/**
 * Give every existing channel the values it already effectively had.
 *
 * Two separate updates rather than one `$set` on both fields, because a channel
 * could in principle have one and not the other (a rerun interrupted between
 * them), and the criterion has to be per-field for the rerun to be a no-op.
 */
const backfill = async () => {
  head(DRY ? 'BACKFILL (dry run)' : 'BACKFILL');
  const channels = col('channels');

  const needMode = await channels.countDocuments({ ...scope(), mode: { $exists: false } });
  const needAudience = await channels.countDocuments({
    ...scope(),
    audience: { $exists: false },
  });

  log(`  ${DRY ? 'would set' : 'setting'} mode='chat'      on ${needMode} channel(s)`);
  log(`  ${DRY ? 'would set' : 'setting'} audience='team'  on ${needAudience} channel(s)`);

  if (!DRY) {
    try {
      if (needMode) {
        await channels.updateMany(
          { ...scope(), mode: { $exists: false } },
          { $set: { mode: 'chat' } }
        );
      }
      if (needAudience) {
        await channels.updateMany(
          { ...scope(), audience: { $exists: false } },
          { $set: { audience: 'team' } }
        );
      }
    } catch (err) {
      // E11000 HERE MEANS THE PHASES WERE RUN OUT OF ORDER, and it is worth
      // naming rather than letting a raw driver error surface.
      //
      // Backfilling is what MAKES a row's index entry `(board, group, 'chat',
      // 'team')`. If the four-key unique index already exists and something has
      // already created that room — because `--indexes` was run first, or a
      // half-migrated dump was restored — then filling this row in collides
      // with it. Which is the migration working: those two rows really are the
      // same surface, and one of them is a duplicate that has to be resolved by
      // a human, because only a human can say which history to keep.
      if (err?.code !== 11000) throw err;
      log('');
      log('  ✗ REFUSED — backfilling would create a DUPLICATE surface.');
      log('');
      log('    A channel here would become (board, group, chat, team), and a row');
      log('    with that key already exists. That happens when --indexes was run');
      log('    before --backfill, or when a partly-migrated dump was restored.');
      log('');
      log('    Nothing further has been written. Run --report to see the pairs,');
      log('    then merge or delete one of each by hand before re-running.');
      log('    Re-running after that is safe: every phase re-reads the data.');
      return false;
    }
  }

  log(
    '\n  Every existing room is a private team chat room — which is exactly what'
  );
  log('  it already was. Nothing gained an audience by running this.');
  return true;
};

/* ------------------------------------------------------------------ */
/* --indexes                                                           */
/* ------------------------------------------------------------------ */
const indexes = async () => {
  head(DRY ? 'INDEXES (dry run)' : 'INDEXES');
  const channels = col('channels');

  // Refuse to touch the indexes while any document is unbackfilled: creating
  // the new index now would succeed, and then the first upsert would mint the
  // duplicate this whole script exists to prevent.
  const unbackfilled = await channels.countDocuments({
    $or: [{ mode: { $exists: false } }, { audience: { $exists: false } }],
  });
  if (unbackfilled) {
    log(`  ✗ REFUSED — ${unbackfilled} channel(s) still have no mode/audience.`);
    log('    Run --backfill first. Creating the index now would let the next');
    log('    upsert mint a duplicate room for every one of them.');
    return false;
  }

  const names = (await channels.indexes()).map((i) => i.name);

  if (!names.includes(NEW_INDEX)) {
    log(`  + create ${NEW_INDEX} (unique, partial on group)`);
    if (!DRY) {
      // Explicit rather than via autoIndex: an autoIndex build failure is
      // emitted on the model and, with no listener, effectively swallowed —
      // you would deploy believing the constraint exists.
      await channels.createIndex(
        { board: 1, group: 1, mode: 1, audience: 1 },
        {
          unique: true,
          partialFilterExpression: { group: { $type: 'objectId' } },
          name: NEW_INDEX,
        }
      );
    }
  } else {
    log(`  · ${NEW_INDEX} already present`);
  }

  // Only ever after the new one exists.
  if (names.includes(OLD_INDEX) || !DRY) {
    const after = (await channels.indexes()).map((i) => i.name);
    if (after.includes(OLD_INDEX)) {
      if (!after.includes(NEW_INDEX) && !DRY) {
        log('  ✗ REFUSED to drop the old index — the new one is not there.');
        return false;
      }
      log(`  - drop ${OLD_INDEX}`);
      if (!DRY) await channels.dropIndex(OLD_INDEX);
    } else {
      log(`  · ${OLD_INDEX} already gone`);
    }
  }
  return true;
};

/* ------------------------------------------------------------------ */
/* --verify                                                            */
/* ------------------------------------------------------------------ */
const verify = async () => {
  head('VERIFY');
  const channels = col('channels');
  const checks = [];
  const add = (label, actual, ok) => checks.push({ label, actual, ok });

  const noMode = await channels.countDocuments({ mode: { $exists: false } });
  add('channels with no mode', noMode, noMode === 0);

  const noAudience = await channels.countDocuments({ audience: { $exists: false } });
  add('channels with no audience', noAudience, noAudience === 0);

  // Nothing should have become client-visible by migrating.
  const clientFacing = await channels.countDocuments({ audience: 'client' });
  add(
    'client-facing surfaces (0 until a board is upgraded)',
    clientFacing,
    clientFacing === 0
  );

  const names = (await channels.indexes()).map((i) => i.name);
  add('new (board, group, mode, audience) index', names.includes(NEW_INDEX), names.includes(NEW_INDEX));
  add('old (board, group) index dropped', !names.includes(OLD_INDEX), !names.includes(OLD_INDEX));

  const dupes = await channels
    .aggregate([
      { $match: { group: { $type: 'objectId' } } },
      {
        $group: {
          _id: { b: '$board', g: '$group', m: '$mode', a: '$audience' },
          n: { $sum: 1 },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  add('duplicate surface keys', dupes.length, dupes.length === 0);

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
  if (ONLY_ORG) log(`*** scoped to org ${ONLY_ORG} ***`);

  const phases = ['--backfill', '--indexes', '--verify'];
  const chosen = phases.filter(has);

  if (!chosen.length || has('--report')) await report();

  let ok = true;
  // `ok` matters: a backfill that refused must exit non-zero, or a deploy
  // script chaining the phases together sails on to --indexes.
  if (has('--backfill')) ok = (await backfill()) && ok;
  if (has('--indexes')) ok = (await indexes()) && ok;
  if (has('--verify')) ok = (await verify()) && ok;

  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
};

main().catch(async (err) => {
  console.error('\nmigrateChatSurfaces failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* already down */
  }
  process.exit(1);
});

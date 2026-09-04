/**
 * inspectClientBoard.js — READ ONLY. Makes no writes of any kind.
 *
 * Answers one question, for a board the portal migration refused: is this ONE
 * client company with two portal links, or TWO companies sharing a board?
 *
 * The migration cannot decide that and must not guess — the two answers lead to
 * opposite actions, and picking wrong shows one client the other's work. So it
 * refuses and points here, and a person reads the evidence and decides.
 *
 * What to look at, in order of how much it tells you:
 *
 *   1. THE CONTACT EMAIL DOMAINS. Two different company domains is the single
 *      strongest signal that these are two companies. One shared domain (or one
 *      person on both) is the strongest signal that they are not.
 *   2. The client names the team typed on each group.
 *   3. Whether any contact appears on both groups.
 *
 * Usage, from server/:
 *   node src/scripts/inspectClientBoard.js <boardId>
 *   node src/scripts/inspectClientBoard.js --all-refused
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const argv = process.argv.slice(2);
const ALL = argv.includes('--all-refused');
const boardId = argv.find((a) => !a.startsWith('--'));

const log = (...a) => console.log(...a);
const head = (t) => log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);
const col = (n) => mongoose.connection.collection(n);

const domainOf = (email) => String(email || '').split('@')[1] || '(none)';

const inspect = async (board) => {
  head(`BOARD "${board.name}"  (${board._id})`);
  log(`  boardType   : ${board.boardType}`);
  log(`  portalTier  : ${board.portalTier || '(unset → basic)'}`);
  log(`  board-level portalToken: ${board.portalToken ? 'present' : 'ABSENT (not yet promoted)'}`);

  const groups = await col('taskgroups')
    .find({ board: board._id })
    .sort({ order: 1, createdAt: 1 })
    .toArray();

  log(`\n  ${groups.length} group(s):\n`);

  const allDomains = new Set();
  const contactsByGroup = new Map();

  for (const g of groups) {
    const tasks = await col('tasks').countDocuments({ group: g._id });
    const contacts = await col('clientcontacts')
      .find({ group: g._id })
      .project({ email: 1, name: 1, verified: 1, lastSeenAt: 1 })
      .toArray();
    contactsByGroup.set(String(g._id), contacts);

    log(`  ── "${g.name}" (${g._id})`);
    log(`       portalToken   : ${g.portalToken ? 'YES' : 'no'}   enabled: ${!!g.portalEnabled}`);
    log(`       clientName    : ${g.portalClientName || '(none)'}`);
    log(`       tasks         : ${tasks}`);
    if (!contacts.length) {
      log('       contacts      : (none)');
    } else {
      log(`       contacts      : ${contacts.length}`);
      contacts.forEach((c) => {
        allDomains.add(domainOf(c.email));
        const seen = c.lastSeenAt
          ? new Date(c.lastSeenAt).toISOString().slice(0, 10)
          : 'never signed in';
        log(`         · ${c.email}${c.name ? ` (${c.name})` : ''} — ${seen}`);
      });
    }
    log('');
  }

  // Contacts on BOTH token-bearing groups: the clearest "one company" evidence.
  const tokenGroups = groups.filter((g) => g.portalToken);
  if (tokenGroups.length > 1) {
    const sets = tokenGroups.map(
      (g) => new Set((contactsByGroup.get(String(g._id)) || []).map((c) => c.email))
    );
    const shared = [...sets[0]].filter((e) => sets.slice(1).every((s) => s.has(e)));
    log(`  people on EVERY token-bearing group : ${shared.length ? shared.join(', ') : 'none'}`);
  }

  log(`  distinct email domains across the board: ${[...allDomains].join(', ') || '(no contacts)'}`);

  log('\n  ---- reading -------------------------------------------------------');
  if (allDomains.size > 1) {
    log('  MORE THAN ONE EMAIL DOMAIN. That usually means two companies, and this');
    log('  board should be SPLIT — one board per client — before migrating.');
  } else if (allDomains.size === 1 && [...allDomains][0] !== '(none)') {
    log('  ONE email domain across the whole board. Consistent with one company');
    log('  that happens to have two links. --adopt-aliases is the likely answer,');
    log('  but confirm the client names above describe the same organisation.');
  } else {
    log('  NO CONTACTS AT ALL on this board. Nobody has portal access, so neither');
    log('  choice can expose anyone: whichever you pick, no live client session');
    log('  exists to break. This is what test data looks like.');
  }
};

const main = async () => {
  await connectDB();
  log('\n*** READ ONLY — this script performs no writes ***');

  const filter = { boardType: 'client' };
  const boards = await col('boards').find(filter).toArray();

  let targets = [];
  if (boardId) {
    targets = boards.filter((b) => String(b._id) === boardId);
    if (!targets.length) {
      log(`\nNo client board with id ${boardId}`);
    }
  } else if (ALL) {
    for (const b of boards) {
      if (b.portalToken) continue;
      const n = await col('taskgroups').countDocuments({
        board: b._id,
        portalToken: { $exists: true, $ne: null },
      });
      if (n > 1) targets.push(b);
    }
    log(`\n${targets.length} refused board(s).`);
  } else {
    log('\nPass a board id, or --all-refused.');
  }

  for (const b of targets) await inspect(b);

  await mongoose.disconnect();
  process.exit(0);
};

main().catch(async (err) => {
  console.error('\ninspectClientBoard failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* already down */
  }
  process.exit(1);
});

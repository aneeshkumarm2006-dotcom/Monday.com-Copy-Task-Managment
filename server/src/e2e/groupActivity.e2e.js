/**
 * End-to-end check of group lifecycle logging against a THROWAWAY in-memory
 * MongoDB.
 *
 * Boots the real Express app, seeds a board, and drives the real HTTP endpoints
 * — same controllers, same Mongoose, same export path the app uses. The user's
 * Atlas cluster is never touched.
 *
 * Run: npm run e2e:group-activity   (from server/)
 *
 * What it is actually for: the unit tests cover the loggers and the sentences in
 * isolation, with `logActivity` stubbed out. Everything most likely to be wrong
 * here lives BELOW that stub and only shows up against a real database —
 *
 *   1. the model's conditional `required` on `task`. A group row carries no
 *      task, so if that validator was not widened the write throws, and
 *      `logActivity` swallows the error — the row is simply never written and
 *      nothing anywhere says so. This is the single highest-risk change.
 *   2. a rename firing on a save that did not rename anything (tags-only and
 *      order-only saves both re-send the name).
 *   3. the `group.deleted` row surviving its own subject AND surviving the
 *      export's orphaned-group filter, which drops rows whose group is gone —
 *      which is every deleted-group row, by definition.
 */
const path = require('path');
const http = require('http');

const ROOT = process.argv[2] || path.resolve(__dirname, '../../..');
const S = (p) => path.join(ROOT, 'server', p);

process.env.JWT_SECRET = 'e2e-secret';
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = 'e2e-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'e2e-client-secret';
process.env.GOOGLE_CALLBACK_URL = 'http://localhost/api/auth/google/callback';
process.env.SESSION_SECRET = 'e2e-session';
process.env.CLIENT_URL = 'http://localhost';

let failures = 0;
const results = [];
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `\n        ${detail}` : ''}`);
  console.log(results[results.length - 1]);
};

const main = async () => {
  const { MongoMemoryServer } = require(path.join(ROOT, 'server/node_modules/mongodb-memory-server'));
  const mongoose = require(path.join(ROOT, 'server/node_modules/mongoose'));
  const jwt = require(path.join(ROOT, 'server/node_modules/jsonwebtoken'));

  console.log('starting in-memory mongod…');
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;

  await mongoose.connect(uri);
  console.log('connected:', uri);

  require(S('src/models'));
  const User = mongoose.model('User');
  const Organisation = mongoose.model('Organisation');
  const Board = mongoose.model('Board');
  const Task = mongoose.model('Task');
  // Not part of the models index barrel, so required by path.
  const ActivityLog = require(S('src/models/ActivityLog'));

  // --- seed ----------------------------------------------------------------
  const owner = await User.create({ name: 'Nora C', email: 'nora@example.com', googleId: 'g-nora' });

  const org = await Organisation.create({
    name: 'Davnoot',
    admin: owner._id,
    members: [owner._id],
    inviteCode: 'e2e-invite',
  });
  org.ensureSystemRoles();
  await org.save();
  await User.updateMany({ _id: owner._id }, { $set: { organisations: [org._id] } });

  // The export is gated on the person's own opt-in flag as well as on the
  // capability — see boardExportController's three gates.
  owner.features = { ...(owner.features || {}), activityExport: true };
  await owner.save();

  const board = await Board.create({
    name: 'DAVNOOT SEO',
    organisation: org._id,
    boardType: 'tracker',
    monthTimezone: 'Asia/Kolkata',
    createdBy: owner._id,
    visibility: 'public',
  });

  const token = jwt.sign(
    { userId: owner._id.toString(), email: owner.email, name: owner.name },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  // --- boot the real app ---------------------------------------------------
  const app = require(S('src/app'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log('app listening on', base, '\n');

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  };

  const B = board._id;
  const rowsFor = (id) => ActivityLog.find({ group: id }).sort({ createdAt: 1 }).lean();

  // =========================================================================
  console.log('--- 1. creating a group records who did it -------------------');

  const created = await call('POST', `/api/boards/${B}/groups`, { name: 'Black Suede' });
  check('the group is created', created.status === 201, `${created.status} ${JSON.stringify(created.body)}`);
  const gid = created.body?.group?._id;

  check(
    'the byline comes back hydrated on the create response',
    created.body?.group?.createdBy?.name === 'Nora C',
    JSON.stringify(created.body?.group?.createdBy)
  );

  // THE load-bearing assertion. A row here proves the model's conditional
  // `required` on `task` was widened; without that this array is empty and
  // absolutely nothing else reports a problem.
  const afterCreate = await rowsFor(gid);
  check(
    'an activity row was actually written (proves task-required was widened)',
    afterCreate.length === 1 && afterCreate[0].type === 'group.created',
    JSON.stringify(afterCreate.map((r) => r.type))
  );
  check(
    'it names the actor and carries no task',
    String(afterCreate[0]?.actor) === String(owner._id) && afterCreate[0]?.task === null,
    JSON.stringify({ actor: afterCreate[0]?.actor, task: afterCreate[0]?.task })
  );
  check(
    'it captures the name, so it still reads once the group is gone',
    afterCreate[0]?.metadata?.groupName === 'Black Suede',
    JSON.stringify(afterCreate[0]?.metadata)
  );

  // =========================================================================
  console.log('\n--- 2. renames, and the saves that are not renames -----------');

  const renamed = await call('PUT', `/api/groups/${gid}`, { name: 'Gorski' });
  check('the rename succeeds', renamed.status === 200, `${renamed.status}`);

  let rows = await rowsFor(gid);
  const renames = rows.filter((r) => r.type === 'group.renamed');
  check('one rename row was written', renames.length === 1, JSON.stringify(rows.map((r) => r.type)));
  check(
    'it carries both sides of the change',
    renames[0]?.oldValue === 'Black Suede' && renames[0]?.newValue === 'Gorski',
    JSON.stringify({ old: renames[0]?.oldValue, new: renames[0]?.newValue })
  );

  // The update endpoint re-sends `name` on every save. These must be silent.
  await call('PUT', `/api/groups/${gid}`, { name: 'Gorski' });
  await call('PUT', `/api/groups/${gid}`, { name: 'Gorski', order: 3 });
  await call('PUT', `/api/groups/${gid}`, { order: 5 });
  rows = await rowsFor(gid);
  check(
    'a save that did not change the name writes nothing',
    rows.filter((r) => r.type === 'group.renamed').length === 1,
    `${rows.filter((r) => r.type === 'group.renamed').length} rename rows`
  );

  // Whitespace-only differences are normalised by resolveGroupName, so they are
  // not renames either.
  await call('PUT', `/api/groups/${gid}`, { name: '  Gorski  ' });
  rows = await rowsFor(gid);
  check(
    'a name that only differs by whitespace is not a rename',
    rows.filter((r) => r.type === 'group.renamed').length === 1,
    `${rows.filter((r) => r.type === 'group.renamed').length} rename rows`
  );

  // =========================================================================
  console.log('\n--- 3. the export shows it, under the right item type --------');

  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const exp1 = await call('GET', `/api/boards/${B}/activity-export?from=${from}&to=${to}`);
  check('the export reads 200', exp1.status === 200, `${exp1.status} ${JSON.stringify(exp1.body)}`);

  const groupRows = (exp1.body?.rows || []).filter((r) => r.itemType === 'group');
  check('both group events are in the export', groupRows.length === 2,
    JSON.stringify((exp1.body?.rows || []).map((r) => r.itemType)));
  // The SENTENCE quotes the name as it stood at the time; the Group/Item
  // COLUMNS carry the live name. That split is deliberate and is exactly what
  // goal rows already do — together the rows read as a chronology ("created
  // Black Suede" … "renamed Black Suede to Gorski") while the columns stay
  // joinable against the board as it looks today.
  check(
    'the created row reads as a sentence, naming the group as it was then',
    groupRows.some((r) => r.description === 'Nora C created the group "Black Suede".'),
    JSON.stringify(groupRows.map((r) => r.description))
  );
  check(
    'a renamed group exports under the name it has NOW, matching the board',
    groupRows.every((r) => r.groupName === 'Gorski' && r.taskName === 'Gorski'),
    JSON.stringify(groupRows.map((r) => ({ g: r.groupName, i: r.taskName })))
  );
  check(
    'the rename row names both sides',
    groupRows.some((r) => r.description === 'Nora C renamed the group "Black Suede" to "Gorski".'),
    JSON.stringify(groupRows.map((r) => r.description))
  );

  // =========================================================================
  console.log('\n--- 4. group rows never leak into a task history -------------');

  const t = await call('POST', '/api/tasks', { name: 'A task', board: B, group: gid });
  check('a task is created', t.status === 201, `${t.status} ${JSON.stringify(t.body)}`);
  const taskId = t.body?.task?._id || t.body?._id;

  const hist = await call('GET', `/api/tasks/${taskId}/activity`);
  check('the task history reads 200', hist.status === 200, `${hist.status}`);
  check(
    'and contains no group rows',
    (hist.body?.items || []).every((i) => !String(i.type).startsWith('group.')),
    JSON.stringify((hist.body?.items || []).map((i) => i.type))
  );

  // =========================================================================
  console.log('\n--- 5. the delete row outlives the group it describes --------');

  const taskCountBefore = await Task.countDocuments({ group: gid });
  const del = await call('DELETE', `/api/groups/${gid}`);
  check('the group is deleted', del.status === 200, `${del.status}`);

  const gone = await mongoose.model('TaskGroup').findById(gid).lean();
  check('the group document really is gone', gone === null, JSON.stringify(gone));

  rows = await rowsFor(gid);
  const delRow = rows.find((r) => r.type === 'group.deleted');
  check('the delete row survives its own subject', !!delRow, JSON.stringify(rows.map((r) => r.type)));
  check(
    'and counted what went down with it, before the cascade removed it',
    delRow?.metadata?.taskCount === taskCountBefore && taskCountBefore === 1,
    JSON.stringify({ logged: delRow?.metadata?.taskCount, actual: taskCountBefore })
  );

  // The export drops rows whose group no longer exists. A deleted-group row is
  // exactly that case, so this is the assertion the exemption exists for.
  const exp2 = await call('GET', `/api/boards/${B}/activity-export?from=${from}&to=${to}`);
  const exported = (exp2.body?.rows || []).filter((r) => r.itemType === 'group');
  check(
    'the export still shows the delete (the orphan filter does not eat it)',
    exported.some((r) => r.description === 'Nora C deleted the group "Gorski" and the 1 task in it.'),
    JSON.stringify(exported.map((r) => r.description))
  );
  // With the live document gone every row falls back to the name it captured,
  // which is the name the group had AT THAT MOMENT — 'Black Suede' for the
  // creation, 'Gorski' after the rename. Never the '(deleted group)' placeholder,
  // which would mean the metadata capture had failed.
  check(
    'every row is still named from captured metadata, not "(deleted group)"',
    exported.length > 0 && exported.every((r) => r.groupName && r.groupName !== '(deleted group)'),
    JSON.stringify(exported.map((r) => r.groupName))
  );
  check(
    'all three lifecycle events survive in the export',
    exported.length === 3,
    JSON.stringify(exported.map((r) => r.type))
  );

  // Task rows are untouched by this change, and worth pinning down because the
  // orphaned-group rule is easy to misread. It drops rows for a task that STILL
  // EXISTS in a group that does not — a task nobody can find on the board. A
  // task the cascade deleted has no document left, so the rule never fires and
  // its rows survive on their captured name, which is the pre-existing
  // "'Ann deleted the task' is what an audit export is for" behaviour.
  const taskRows = (exp2.body?.rows || []).filter((r) => r.itemType === 'task');
  check(
    'rows for a task the cascade deleted survive, named from metadata',
    taskRows.length > 0 && taskRows.every((r) => r.taskName === 'A task'),
    JSON.stringify(taskRows.map((r) => [r.type, r.taskName]))
  );

  // =========================================================================
  console.log('\n' + '='.repeat(62));
  console.log(failures === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failures} of ${results.length} FAILED`);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures === 0 ? 0 : 1);
};

/**
 * Only when RUN, never when required — `capabilityUsage.test.js` loads every
 * .js file under src/ to catch dangling imports, and without this guard that
 * scan boots an in-memory mongod as a side effect of importing this file.
 */
if (require.main === module) {
  main().catch((err) => {
    console.error('\nHARNESS ERROR:', err);
    process.exit(2);
  });
}

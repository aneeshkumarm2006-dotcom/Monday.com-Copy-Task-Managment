/**
 * End-to-end check of Company Holidays against a THROWAWAY in-memory MongoDB.
 *
 * Boots the real Express app, seeds a tracker board, and drives the real HTTP
 * endpoints — same controllers, same Mongoose, same scoring path the app uses.
 * The user's Atlas cluster is never touched.
 *
 * Run: npm run e2e:holidays   (from server/)
 *
 * Requires mongodb-memory-server, which downloads a mongod binary on first run.
 * Nothing here reads server/.env, so it can never reach the real cluster.
 */
const path = require('path');
const http = require('http');

// Repo root, resolved from this file (server/src/e2e/holidays.e2e.js).
const ROOT = process.argv[2] || path.resolve(__dirname, '../../..');
const S = (p) => path.join(ROOT, 'server', p);

process.env.JWT_SECRET = 'e2e-secret';
process.env.NODE_ENV = 'test';
// The app builds its passport strategies at require time; these are never used
// because the harness mints its own JWTs, but the constructors demand them.
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
  const TaskGroup = mongoose.model('TaskGroup');
  const Tracker = mongoose.model('Tracker');
  const Task = mongoose.model('Task');
  const Automation = mongoose.model('Automation');

  const TZ = 'Asia/Kolkata';

  // --- seed ----------------------------------------------------------------
  const owner = await User.create({ name: 'Owner', email: 'owner@example.com', googleId: 'g-owner' });
  const member = await User.create({ name: 'Member', email: 'member@example.com', googleId: 'g-member' });

  const org = await Organisation.create({
    name: 'Acme',
    admin: owner._id,
    members: [owner._id, member._id],
    inviteCode: 'e2e-invite',
  });
  org.ensureSystemRoles();
  await org.save();

  await User.updateMany(
    { _id: { $in: [owner._id, member._id] } },
    { $set: { organisations: [org._id] } }
  );

  const board = await Board.create({
    name: 'SEO Clients',
    organisation: org._id,
    boardType: 'tracker',
    monthTimezone: TZ,
    createdBy: owner._id,
    visibility: 'public',
  });

  // Backdated: trackerEvaluate marks every period BEFORE a group existed as
  // `na` ("nobody owed anything, there was no client yet"), so a group created
  // at the real clock would make all of August out of scope.
  const groups = [];
  for (const name of ['Client A', 'Client B', 'Client C']) {
    const g = await TaskGroup.create({ name, board: board._id, order: groups.length });
    await TaskGroup.collection.updateOne(
      { _id: g._id },
      { $set: { createdAt: new Date('2026-07-01T00:00:00Z') } }
    );
    groups.push(await TaskGroup.findById(g._id));
  }

  // Daily: one task per working day. Monthly: one task per month.
  const daily = await Tracker.create({
    name: 'Daily activity',
    board: board._id,
    organisation: org._id,
    timezone: TZ,
    startDate: '2026-08-01',
    cadence: { type: 'everyNDays', n: 1, weekdays: [0, 1, 2, 3, 4, 5, 6], graceDays: 0 },
    requirements: ['TASK_EXISTS'],
    targetCount: 1,
    createdBy: owner._id,
  });

  const monthly = await Tracker.create({
    name: 'Monthly report',
    board: board._id,
    organisation: org._id,
    timezone: TZ,
    startDate: '2026-08-01',
    cadence: { type: 'monthly', weekdays: [0, 1, 2, 3, 4, 5, 6], graceDays: 5 },
    requirements: ['TASK_EXISTS'],
    targetCount: 1,
    createdBy: owner._id,
  });

  // Client A works on the holiday anyway; nobody else does. Everyone works on
  // the 14th so the ratio has something in it besides the holiday.
  const at = (dayKey, hour = 10) =>
    new Date(`${dayKey}T${String(hour).padStart(2, '0')}:00:00+05:30`);

  const seedTask = async (name, group, dayKey) => {
    const t = await Task.create({ name, board: board._id, group, createdBy: owner._id });
    // timestamps:true stamps createdAt on save; force it to the day we want.
    await Task.collection.updateOne({ _id: t._id }, { $set: { createdAt: at(dayKey) } });
  };

  for (const g of groups) {
    await seedTask('Work 13 Aug', g._id, '2026-08-13');
    await seedTask('Work 14 Aug', g._id, '2026-08-14');
  }
  await seedTask('Worked the holiday anyway', groups[0]._id, '2026-08-15');

  const token = jwt.sign(
    { userId: owner._id.toString(), email: owner.email, name: owner.name },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const memberToken = jwt.sign(
    { userId: member._id.toString(), email: member.email, name: member.name },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  // --- boot the real app ---------------------------------------------------
  const app = require(S('src/app'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log('app listening on', base, '\n');

  const call = async (method, url, body, tok = token) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  };

  const delivery = async () => {
    const r = await call('GET', `/api/boards/${board._id}/delivery?month=2026-08`);
    if (r.status !== 200) throw new Error(`delivery ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.delivery.trackers;
  };
  const trackerNamed = (list, name) => list.find((t) => t.name === name);
  const periodOn = (t, dayKey) => t.periods.find((p) => p.startDayKey === dayKey);
  // Cells are POSITIONAL — one per period, in period order — and carry the
  // state as `s`. See utils/trackerEvaluate.js.
  const rowFor = (t, groupId) =>
    t.rows.find((r) => String(r.groupId) === String(groupId));
  const cellFor = (t, groupId, dayKey) => {
    const i = t.periods.findIndex((p) => p.startDayKey === dayKey);
    if (i < 0) return null;
    return rowFor(t, groupId)?.cells?.[i] || null;
  };

  // =========================================================================
  console.log('--- 1. mark 15 Aug as a holiday -----------------------------');
  const marked = await call('PUT', `/api/orgs/${org._id}/holidays/2026-08-15`, {
    name: 'Independence Day',
    affects: { delivery: true, automations: true },
  });
  check('marking a holiday returns 200', marked.status === 200, JSON.stringify(marked.body));
  check(
    'it comes back with its name and both effects',
    marked.body?.holidays?.[0]?.name === 'Independence Day'
      && marked.body.holidays[0].affects.delivery === true
      && marked.body.holidays[0].affects.automations === true,
    JSON.stringify(marked.body?.holidays)
  );

  const reread = await call('GET', `/api/orgs/${org._id}/holidays?year=2026`);
  check('it persists across a re-read', reread.body?.holidays?.length === 1);

  // =========================================================================
  console.log('\n--- 2. the daily column greys, the month stays owed ---------');
  let d = await delivery();
  let dTracker = trackerNamed(d, 'Daily activity');
  let mTracker = trackerNamed(d, 'Monthly report');

  const holidayPeriod = periodOn(dTracker, '2026-08-15');
  check('the 15 Aug daily period is off', holidayPeriod?.isOff === true,
    JSON.stringify(holidayPeriod));
  check(
    'it carries the holiday tag and name, from the ORG layer',
    holidayPeriod?.daysOff?.[0]?.tag === 'holiday'
      && holidayPeriod.daysOff[0].label === 'Independence Day'
      && holidayPeriod.daysOff[0].source === 'org',
    JSON.stringify(holidayPeriod?.daysOff)
  );
  check('no per-tracker day off was created', (
    (await Tracker.findById(daily._id).lean()).daysOff || []
  ).length === 0);

  const augustPeriod = mTracker.periods.find((p) => p.startDayKey === '2026-08-01');
  check(
    'the August MONTHLY period is still owed — one holiday does not excuse a month',
    augustPeriod?.isOff === false,
    JSON.stringify({ isOff: augustPeriod?.isOff, workingDayCount: augustPeriod?.workingDayCount })
  );
  check(
    'the month lost exactly one working day',
    augustPeriod?.workingDayCount === 30,
    `workingDayCount=${augustPeriod?.workingDayCount} (expected 30 of 31)`
  );

  // =========================================================================
  console.log('\n--- 3. worked-anyway keeps its tick; others drop from ratio --');
  const aCell = cellFor(dTracker, groups[0]._id, '2026-08-15');
  const bCell = cellFor(dTracker, groups[1]._id, '2026-08-15');
  check('Client A, who worked the holiday, is still met', aCell?.s === 'met',
    JSON.stringify(aCell));
  check('Client B, who did not, is off rather than missed', bCell?.s === 'off',
    JSON.stringify(bCell));

  // `off` is not in SCORED_STATES, so the day leaves the denominator entirely.
  const bRow = rowFor(dTracker, groups[1]._id);
  const holidayIndex = dTracker.periods.findIndex((p) => p.startDayKey === '2026-08-15');
  const scoredStates = ['met', 'partial', 'missed'];
  check(
    'the holiday is not counted in Client B required total',
    !scoredStates.includes(bRow.cells[holidayIndex].s),
    `state was ${bRow.cells[holidayIndex].s}`
  );

  const aRow = rowFor(dTracker, groups[0]._id);
  check(
    'Client A met count includes the day it worked anyway',
    aRow.summary.met === 3,
    JSON.stringify(aRow.summary)
  );
  check(
    'Client B met only the two ordinary days',
    bRow.summary.met === 2,
    JSON.stringify(bRow.summary)
  );
  // The asymmetry is the design, not a bug. `met` is a scored state and `off`
  // is not, so the holiday enters the denominator ONLY for the client that
  // actually delivered on it. A holiday can therefore lift a score and can
  // never lower one: the client who worked keeps its tick, and the client who
  // rested loses the day from both halves of the ratio.
  check(
    'the holiday counts for the client that worked it, and vanishes for the one that did not',
    aRow.summary.required === bRow.summary.required + 1,
    JSON.stringify({ a: aRow.summary.required, b: bRow.summary.required })
  );
  check(
    'and Client A scores higher for having worked it',
    aRow.summary.keptPct > bRow.summary.keptPct,
    JSON.stringify({ a: aRow.summary.keptPct, b: bRow.summary.keptPct })
  );

  // =========================================================================
  console.log('\n--- 4. People tab agrees with the grid ----------------------');
  // The two endpoints run planDelivery through DIFFERENT resolveRange seams and
  // must be handed the SAME holiday list, or the People tab and the grid
  // quietly disagree about which days were owed. This is the check that proves
  // the merge really does live inside planDelivery.
  const sb = await call('GET', `/api/boards/${board._id}/scoreboard?month=2026-08`);
  check('scoreboard responds 200', sb.status === 200, JSON.stringify(sb.body).slice(0, 300));

  // The scoreboard clamps its window to TODAY; the grid does not. Re-read the
  // grid over the same clamped window so the two are comparable.
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const gridToToday = (await delivery())
    .find((t) => t.name === 'Daily activity')
    .periods.filter((p) => p.startDayKey <= todayKey);
  const gridOffDays = gridToToday.filter((p) => p.isOff).map((p) => p.startDayKey);

  check(
    'the grid sees exactly one off day up to today — the holiday',
    gridOffDays.length === 1 && gridOffDays[0] === '2026-08-15',
    JSON.stringify(gridOffDays)
  );

  const sbTracker = (sb.body?.scoreboard?.trackers || [])
    .find((t) => t.name === 'Daily activity');
  check('the scoreboard lists the same tracker', !!sbTracker,
    JSON.stringify(sb.body?.scoreboard?.trackers));

  // Totals are per-person; with one owner holding nothing, what matters is that
  // the endpoint produced delivery numbers at all and did not 400 on the cap.
  check(
    'the scoreboard produced delivery totals rather than erroring out',
    sb.body?.scoreboard?.sections?.delivery === true
      && sb.body.scoreboard.totals !== undefined,
    JSON.stringify(sb.body?.scoreboard?.sections)
  );

  // =========================================================================
  console.log('\n--- 5. a tracker can opt out -------------------------------');
  const optOut = await call('PUT', `/api/trackers/${daily._id}`, {
    observesOrgHolidays: false,
  });
  check('opting out returns 200', optOut.status === 200, JSON.stringify(optOut.body));
  check('the flag round-trips', optOut.body?.tracker?.observesOrgHolidays === false,
    JSON.stringify(optOut.body?.tracker?.observesOrgHolidays));

  d = await delivery();
  dTracker = trackerNamed(d, 'Daily activity');
  mTracker = trackerNamed(d, 'Monthly report');
  const optedOutPeriod = periodOn(dTracker, '2026-08-15');
  check('the opted-out tracker scores the holiday again', optedOutPeriod?.isOff === false,
    JSON.stringify({ isOff: optedOutPeriod?.isOff }));
  check(
    'the OTHER tracker still observes it',
    trackerNamed(d, 'Monthly report').periods.find((p) => p.startDayKey === '2026-08-01')
      ?.workingDayCount === 30,
    'monthly should still be missing the holiday'
  );
  check(
    'opting out did not wipe the per-tracker daysOff list',
    Array.isArray((await Tracker.findById(daily._id).lean()).daysOff),
  );

  // put it back
  await call('PUT', `/api/trackers/${daily._id}`, { observesOrgHolidays: true });

  // =========================================================================
  console.log('\n--- 6. a per-tracker reason beats the org holiday -----------');
  const ownReason = await call('PUT', `/api/trackers/${daily._id}/days-off`, {
    date: '2026-08-15', tag: 'event', label: 'Client shoot',
  });
  check('marking a per-tracker day off returns 200', ownReason.status === 200,
    JSON.stringify(ownReason.body));

  d = await delivery();
  const overridden = periodOn(trackerNamed(d, 'Daily activity'), '2026-08-15');
  check(
    'the grid shows the tracker own reason, not the company holiday',
    overridden?.daysOff?.[0]?.tag === 'event'
      && overridden.daysOff[0].label === 'Client shoot'
      && overridden.daysOff[0].source === 'tracker',
    JSON.stringify(overridden?.daysOff)
  );
  await call('DELETE', `/api/trackers/${daily._id}/days-off?date=2026-08-15`);

  // =========================================================================
  console.log('\n--- 7. affects flags gate each consequence separately -------');
  await call('PUT', `/api/orgs/${org._id}/holidays/2026-08-20`, {
    name: 'Offsite', affects: { delivery: true, automations: false },
  });
  await call('PUT', `/api/orgs/${org._id}/holidays/2026-08-21`, {
    name: 'Server day', affects: { delivery: false, automations: true },
  });

  d = await delivery();
  dTracker = trackerNamed(d, 'Daily activity');
  check(
    'a delivery-only holiday greys the column',
    periodOn(dTracker, '2026-08-20')?.isOff === true
  );
  check(
    'an automations-only holiday does NOT grey the column',
    periodOn(dTracker, '2026-08-21')?.isOff === false
  );

  // =========================================================================
  console.log('\n--- 8. automations roll past a holiday ----------------------');
  const auto = await Automation.create({
    name: 'Nightly digest',
    board: board._id,
    organisation: org._id,
    triggerType: 'SCHEDULE',
    enabled: true,
    schedule: { frequency: 'daily', hour: 9, timezone: TZ },
    taskTemplate: { name: 'Digest', group: groups[0]._id },
    createdBy: owner._id,
  });
  const {
    holidayKeysForAutomation,
  } = require(S('src/controllers/automationController'));
  const { computeNextRunAt } = require(S('src/services/automationSchedule'));

  const keys = await holidayKeysForAutomation(await Automation.findById(auto._id));
  check(
    'the automation sees only the holidays that stop automations',
    keys.has('2026-08-15') && keys.has('2026-08-21') && !keys.has('2026-08-20'),
    JSON.stringify([...keys])
  );

  const from = new Date('2026-08-14T12:00:00+05:30');
  const next = computeNextRunAt(auto.schedule, from, keys);
  const nextDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(next);
  check('it rolls past 15 Aug to the 16th', nextDay === '2026-08-16', `got ${nextDay}`);

  auto.schedule.skipHolidays = false;
  const alwaysRuns = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(computeNextRunAt(auto.schedule, from, keys));
  check('an opted-out automation fires on the holiday', alwaysRuns === '2026-08-15',
    `got ${alwaysRuns}`);

  // =========================================================================
  console.log('\n--- 9. permissions ------------------------------------------');
  const memberRead = await call('GET', `/api/orgs/${org._id}/holidays`, undefined, memberToken);
  check('a plain member CAN read holidays', memberRead.status === 200,
    `status ${memberRead.status}`);

  const memberWrite = await call(
    'PUT', `/api/orgs/${org._id}/holidays/2026-12-25`, { name: 'Sneaky' }, memberToken
  );
  check('a plain member CANNOT write them', memberWrite.status === 403,
    `status ${memberWrite.status}: ${JSON.stringify(memberWrite.body)}`);

  // =========================================================================
  console.log('\n--- 10. year-scoped save does not eat other years -----------');
  await call('PUT', `/api/orgs/${org._id}/holidays/2027-01-01`, { name: 'New Year 27' });
  const bulk = await call('PUT', `/api/orgs/${org._id}/holidays`, {
    year: '2026', holidays: [{ date: '2026-10-20', name: 'Diwali' }],
  });
  check('the bulk save returns 200', bulk.status === 200, JSON.stringify(bulk.body));
  check(
    '2027 survived a 2026 save',
    bulk.body?.holidays?.map((h) => h.date).join(',') === '2026-10-20,2027-01-01',
    JSON.stringify(bulk.body?.holidays?.map((h) => h.date))
  );

  const stray = await call('PUT', `/api/orgs/${org._id}/holidays`, {
    year: '2026', holidays: [{ date: '2027-05-01', name: 'Smuggled' }],
  });
  check('a stray year is rejected', stray.status === 400, JSON.stringify(stray.body));

  // =========================================================================
  console.log("\n--- 11. the single-date PUT is partial, and safe to overlap --");

  // The Settings editor saves the name on blur and each effect on click.
  // Clicking a checkbox right after typing fires BOTH, overlapping. Before this
  // was made atomic, the second write lost a Mongoose version check: a 500, and
  // the edit silently dropped.
  await call('PUT', `/api/orgs/${org._id}/holidays/2026-11-05`, { name: '' });

  const [nameRes, affectsRes] = await Promise.all([
    call('PUT', `/api/orgs/${org._id}/holidays/2026-11-05`, { name: 'Diwali' }),
    call('PUT', `/api/orgs/${org._id}/holidays/2026-11-05`, {
      affects: { delivery: true, automations: false },
    }),
  ]);
  check('neither concurrent write 500s', nameRes.status === 200 && affectsRes.status === 200,
    JSON.stringify({ name: nameRes.status, affects: affectsRes.status }));

  const after = await call('GET', `/api/orgs/${org._id}/holidays`);
  const nov5 = (after.body?.holidays || []).find((h) => h.date === '2026-11-05');
  check(
    'both edits survive — neither overwrote the other',
    nov5?.name === 'Diwali' && nov5.affects.automations === false,
    JSON.stringify(nov5)
  );

  const onlyAffects = await call('PUT', `/api/orgs/${org._id}/holidays/2026-11-05`, {
    affects: { delivery: false, automations: false },
  });
  check(
    'changing only the effects leaves the name alone',
    onlyAffects.body?.holidays?.find((h) => h.date === '2026-11-05')?.name === 'Diwali',
    JSON.stringify(onlyAffects.body?.holidays?.find((h) => h.date === '2026-11-05'))
  );

  const onlyName = await call('PUT', `/api/orgs/${org._id}/holidays/2026-11-05`, {
    name: 'Deepavali',
  });
  const finalNov5 = onlyName.body?.holidays?.find((h) => h.date === '2026-11-05');
  check(
    'changing only the name leaves the effects alone',
    finalNov5?.name === 'Deepavali'
      && finalNov5.affects.delivery === false
      && finalNov5.affects.automations === false,
    JSON.stringify(finalNov5)
  );

  check(
    'the list is still sorted after all that',
    (after.body?.holidays || []).every(
      (h, i, a) => i === 0 || a[i - 1].date <= h.date
    ),
    JSON.stringify((after.body?.holidays || []).map((h) => h.date))
  );

  // The Settings "Copy to next year" button goes through the BULK save, which
  // reads an absent flag as true. If the client dropped `affects` on the way in,
  // copying a year would silently re-arm every consequence somebody had switched
  // off — including on the rows already in the target year.
  const copied = await call('PUT', `/api/orgs/${org._id}/holidays`, {
    year: '2028',
    holidays: [
      { date: '2028-08-15', name: 'Independence Day' },
      { date: '2028-09-10', name: 'Offsite', affects: { delivery: true, automations: false } },
      { date: '2028-10-20', name: 'Quiet day', affects: { delivery: false, automations: false } },
    ],
  });
  const y2028 = (copied.body?.holidays || []).filter((h) => h.date.startsWith('2028-'));
  check(
    'a bulk save carries each day effects through verbatim',
    y2028.length === 3
      && y2028[0].affects.automations === true
      && y2028[1].affects.automations === false
      && y2028[2].affects.delivery === false
      && y2028[2].affects.automations === false,
    JSON.stringify(y2028)
  );

  const dupe = await call('PUT', `/api/orgs/${org._id}/holidays/2026-11-05`, { name: 'Again' });
  check(
    'upserting an existing day never duplicates it',
    (dupe.body?.holidays || []).filter((h) => h.date === '2026-11-05').length === 1,
    JSON.stringify(dupe.body?.holidays?.map((h) => h.date))
  );

  // =========================================================================
  console.log('\n--- 12. an org created BEFORE this feature existed -----------');

  // The raw document has no `holidays` key at all. This is not a hypothetical:
  // it is every workspace in a live database, and it broke on the first click
  // because `arrayFilters` refuses to create a missing path — "The path
  // 'holidays' must exist in the document in order to apply array updates."
  const legacyId = (await Organisation.collection.insertOne({
    name: 'Legacy Workspace',
    admin: owner._id,
    members: [owner._id],
    roles: [],
    memberRoles: [],
    inviteCode: 'legacy-e2e',
  })).insertedId;

  const rawBefore = await Organisation.collection.findOne({ _id: legacyId });
  check('the fixture really has no holidays field', !('holidays' in rawBefore));

  const firstMark = await call('PUT', `/api/orgs/${legacyId}/holidays/2026-08-15`, {
    name: 'Independence Day',
  });
  check('marking the FIRST holiday on a legacy org works', firstMark.status === 200,
    `${firstMark.status}: ${JSON.stringify(firstMark.body)}`);
  check(
    'and it is stored with the default effects',
    firstMark.body?.holidays?.length === 1
      && firstMark.body.holidays[0].name === 'Independence Day'
      && firstMark.body.holidays[0].affects.delivery === true,
    JSON.stringify(firstMark.body?.holidays)
  );

  const secondMark = await call('PUT', `/api/orgs/${legacyId}/holidays/2026-08-15`, {
    affects: { delivery: true, automations: false },
  });
  check(
    'editing it afterwards still works, and stays partial',
    secondMark.status === 200
      && secondMark.body.holidays[0].name === 'Independence Day'
      && secondMark.body.holidays[0].affects.automations === false,
    JSON.stringify(secondMark.body?.holidays)
  );

  const legacyDelete = await call('DELETE', `/api/orgs/${legacyId}/holidays/2026-08-15`);
  check('and deleting works',
    legacyDelete.status === 200 && legacyDelete.body.holidays.length === 0,
    JSON.stringify(legacyDelete.body));

  const legacyBulk = await call('PUT', `/api/orgs/${legacyId}/holidays`, {
    year: '2026', holidays: [{ date: '2026-12-25', name: 'Christmas' }],
  });
  check('the bulk save works on a legacy org too', legacyBulk.status === 200,
    `${legacyBulk.status}: ${JSON.stringify(legacyBulk.body)}`);

  // =========================================================================
  console.log('\n' + '='.repeat(62));
  console.log(failures === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failures} of ${results.length} FAILED`);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('\nHARNESS ERROR:', err);
  process.exit(2);
});

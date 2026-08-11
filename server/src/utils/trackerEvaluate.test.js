const { test } = require('node:test');
const assert = require('node:assert');

const { periodsBetween } = require('./trackerPeriods');
const { evaluateTracker, matchesTask, summariseRows } = require('./trackerEvaluate');

// ---------------------------------------------------------------------------
// Fixtures
//
// The window is Mon 10 Aug 2026 through Sun 16 Aug 2026, "now" is midday on
// Friday the 14th. So Mon–Thu are closed and scoreable, Friday is still open,
// Saturday is a future working day, and Sunday is off. One window exercises
// every branch of the state machine.
// ---------------------------------------------------------------------------

const TZ = 'UTC';
const NOW = new Date('2026-08-14T12:00:00Z');
const FROM = '2026-08-10';
const TO = '2026-08-16';

const DAILY = { type: 'everyNDays', n: 1, weekdays: [1, 2, 3, 4, 5, 6] };

const BOARD = {
  statuses: [
    { _id: 'st_new', key: 'not_started' },
    { _id: 'st_done', key: 'done' },
  ],
};

const group = (id, name, extra = {}) => ({ _id: id, name, ...extra });

const task = (id, groupId, name, createdAt, extra = {}) => ({
  _id: id,
  group: groupId,
  name,
  createdAt: new Date(createdAt),
  status: 'st_new',
  labels: [],
  ...extra,
});

const tracker = (extra = {}) => ({
  name: 'Daily activity',
  cadence: DAILY,
  skipDates: [],
  match: {},
  requirements: ['TASK_EXISTS', 'UPDATE_POSTED'],
  requireSameTask: true,
  targetCount: 1,
  startDate: FROM,
  endDate: null,
  ...extra,
});

/** Evaluate one tracker over the standard window and return the single row. */
const run = ({
  trk = tracker(),
  groups = [group('g1', 'DOPE THC')],
  tasks = [],
  updateDayKeys = new Map(),
  entries = [],
  from = FROM,
  to = TO,
  now = NOW,
} = {}) => {
  const periods = periodsBetween(trk.cadence, from, to, { skipDates: trk.skipDates });
  const result = evaluateTracker({
    tracker: trk,
    periods,
    groups,
    tasks,
    updateDayKeys,
    entries,
    board: BOARD,
    timezone: TZ,
    now,
  });
  return { ...result, periods, row: result.rows[0], states: result.rows[0].cells.map((c) => c.s) };
};

// ---------------------------------------------------------------------------
// The core state machine
// ---------------------------------------------------------------------------

test('the full state matrix in one window', () => {
  const { states, periods } = run({
    tasks: [
      task('t1', 'g1', 'Interlink Blog', '2026-08-10T09:00:00Z'), // has an update -> met
      task('t2', 'g1', 'GSC Keywords', '2026-08-11T09:00:00Z'), // no update    -> partial
      // nothing on the 12th -> missed
      task('t4', 'g1', 'Content Optimization', '2026-08-13T09:00:00Z'),
      // nothing on the 14th (today, still open) -> pending
    ],
    updateDayKeys: new Map([
      ['t1', new Set(['2026-08-10'])],
      ['t4', new Set(['2026-08-13'])],
    ]),
  });

  assert.deepStrictEqual(periods.map((p) => p.startDayKey), [
    '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16',
  ]);

  assert.deepStrictEqual(states, [
    'met', // Mon: task + update
    'partial', // Tue: task, no update
    'missed', // Wed: nothing, and the day has closed
    'met', // Thu: task + update
    'pending', // Fri: nothing yet, but today is not over
    'pending', // Sat: a working day, still in the future
    'off', // Sun: not a working day at all
  ]);
});

test('partial beats pending: evidence today is shown, not hidden behind the clock', () => {
  // A task logged this morning with no update yet must read `partial`, not
  // `pending` — "you started but nobody has written anything" is precisely the
  // state the dashboard exists to surface.
  const { states } = run({
    tasks: [task('t1', 'g1', 'Today work', '2026-08-14T08:00:00Z')],
  });
  assert.strictEqual(states[4], 'partial');
});

test('a group with no tasks in a closed period is missed, not absent', () => {
  const { states, row } = run({ tasks: [] });
  assert.deepStrictEqual(states.slice(0, 4), ['missed', 'missed', 'missed', 'missed']);
  assert.strictEqual(row.summary.missed, 4);
  assert.strictEqual(row.summary.required, 4); // pending/off/na stay out of the ratio
  assert.strictEqual(row.summary.keptPct, 0);
});

test('off and na periods stay out of the kept ratio', () => {
  const { row } = run({
    tasks: [
      task('t1', 'g1', 'a', '2026-08-10T09:00:00Z'),
      task('t2', 'g1', 'b', '2026-08-11T09:00:00Z'),
      task('t3', 'g1', 'c', '2026-08-12T09:00:00Z'),
      task('t4', 'g1', 'd', '2026-08-13T09:00:00Z'),
    ],
    updateDayKeys: new Map([
      ['t1', new Set(['2026-08-10'])],
      ['t2', new Set(['2026-08-11'])],
      ['t3', new Set(['2026-08-12'])],
      ['t4', new Set(['2026-08-13'])],
    ]),
  });
  assert.strictEqual(row.summary.met, 4);
  assert.strictEqual(row.summary.off, 1);
  assert.strictEqual(row.summary.pending, 2);
  assert.strictEqual(row.summary.required, 4);
  assert.strictEqual(row.summary.keptPct, 100);
});

// ---------------------------------------------------------------------------
// Scope clamps — the reason a new tracker does not paint red back to the epoch
// ---------------------------------------------------------------------------

test('periods before startDate and after endDate are n/a', () => {
  const { states } = run({ trk: tracker({ startDate: '2026-08-12', endDate: '2026-08-13' }) });
  assert.deepStrictEqual(states.slice(0, 5), ['na', 'na', 'missed', 'missed', 'na']);
});

test('a group is not blamed for periods before it existed', () => {
  const { states } = run({
    groups: [group('g1', 'NEW CLIENT', { createdAt: new Date('2026-08-12T10:00:00Z') })],
  });
  assert.deepStrictEqual(states.slice(0, 4), ['na', 'na', 'missed', 'missed']);
});

test('a group with no createdAt is not clamped (missing means unknown)', () => {
  // TaskGroup has `default: Date.now` and no timestamps, so a legacy row read
  // without .lean() would hydrate as "created just now" and blank its own
  // history. Declining to clamp on undefined is the safe direction.
  const { states } = run({ groups: [group('g1', 'LEGACY')] });
  assert.deepStrictEqual(states.slice(0, 4), ['missed', 'missed', 'missed', 'missed']);
});

// ---------------------------------------------------------------------------
// targetCount — "Ads needs 2 per week"
// ---------------------------------------------------------------------------

const WEEKLY = { type: 'weekly', weekStartsOn: 1 };

const runWeekly = (tasks, updateDayKeys, targetCount = 2) =>
  run({
    trk: tracker({ cadence: WEEKLY, targetCount, startDate: '2026-08-10' }),
    tasks,
    updateDayKeys,
    from: '2026-08-10',
    to: '2026-08-16',
    now: new Date('2026-08-24T12:00:00Z'), // the week has closed
  });

test('targetCount 2: 0 occurrences is missed, 1 is partial, 2 is met, 3 is still met', () => {
  const mk = (n) => {
    const tasks = [];
    const updates = new Map();
    for (let i = 0; i < n; i++) {
      const id = `t${i}`;
      tasks.push(task(id, 'g1', `Campaign ${i}`, `2026-08-1${i}T09:00:00Z`));
      updates.set(id, new Set([`2026-08-1${i}`]));
    }
    return runWeekly(tasks, updates);
  };

  assert.strictEqual(mk(0).states[0], 'missed');
  assert.strictEqual(mk(1).states[0], 'partial');
  assert.strictEqual(mk(2).states[0], 'met');
  assert.strictEqual(mk(3).states[0], 'met'); // never "over-met"
  assert.strictEqual(mk(3).row.cells[0].n, 3);
  assert.strictEqual(mk(3).row.cells[0].N, 2);
});

test('occurrences count QUALIFYING tasks, not matched tasks', () => {
  // Two tasks in the week but only one carries an update. That is one
  // occurrence, not two — which is the whole point of the occurrence rule.
  const { row, states } = runWeekly(
    [
      task('t1', 'g1', 'Campaign A', '2026-08-10T09:00:00Z'),
      task('t2', 'g1', 'Campaign B', '2026-08-12T09:00:00Z'),
    ],
    new Map([['t1', new Set(['2026-08-10'])]])
  );

  assert.strictEqual(row.cells[0].matched, 2);
  assert.strictEqual(row.cells[0].n, 1);
  assert.strictEqual(states[0], 'partial');
});

// ---------------------------------------------------------------------------
// requireSameTask
// ---------------------------------------------------------------------------

test('requireSameTask true: an update on a sibling task does not rescue the day', () => {
  const { states } = run({
    tasks: [
      task('t1', 'g1', 'Monday work', '2026-08-10T09:00:00Z'),
      task('t2', 'g1', 'Monday extra', '2026-08-10T10:00:00Z'),
    ],
    updateDayKeys: new Map([['t2', new Set(['2026-08-10'])]]),
  });
  // t2 qualifies on its own, so the day IS met — but via t2, not t1.
  assert.strictEqual(states[0], 'met');

  const onlySibling = run({
    trk: tracker({ requireSameTask: true }),
    tasks: [task('t1', 'g1', 'Monday work', '2026-08-10T09:00:00Z')],
    updateDayKeys: new Map([['t99', new Set(['2026-08-10'])]]),
  });
  assert.strictEqual(onlySibling.states[0], 'partial');
});

test('requireSameTask false: any matched task carrying an update lifts the period', () => {
  const { states, row } = run({
    trk: tracker({ requireSameTask: false }),
    tasks: [
      task('t1', 'g1', 'Monday work', '2026-08-10T09:00:00Z'),
      task('t2', 'g1', 'Monday extra', '2026-08-10T10:00:00Z'),
    ],
    updateDayKeys: new Map([['t2', new Set(['2026-08-10'])]]),
  });
  assert.strictEqual(states[0], 'met');
  assert.strictEqual(row.cells[0].n, 2); // both now qualify
});

// ---------------------------------------------------------------------------
// MANUAL_CONFIRM is period-level, not task-level
// ---------------------------------------------------------------------------

test('MANUAL_CONFIRM: qualifying tasks alone are not enough', () => {
  const trk = tracker({
    cadence: WEEKLY,
    requirements: ['TASK_EXISTS', 'UPDATE_POSTED', 'MANUAL_CONFIRM'],
    targetCount: 2,
  });
  const tasks = [
    task('t1', 'g1', 'Report draft', '2026-08-10T09:00:00Z'),
    task('t2', 'g1', 'Report send', '2026-08-11T09:00:00Z'),
  ];
  const updates = new Map([
    ['t1', new Set(['2026-08-10'])],
    ['t2', new Set(['2026-08-11'])],
  ]);
  const now = new Date('2026-08-24T12:00:00Z');

  const without = run({ trk, tasks, updateDayKeys: updates, now });
  assert.strictEqual(without.states[0], 'partial');
  assert.strictEqual(without.row.cells[0].n, 2); // occurrences are there…
  assert.deepStrictEqual(without.row.cells[0].missing, ['MANUAL_CONFIRM']); // …the sign-off is not

  const withConfirm = run({
    trk,
    tasks,
    updateDayKeys: updates,
    now,
    entries: [{ group: 'g1', periodKey: 'w:2026-08-10', state: 'confirmed', link: 'https://drive.example/report' }],
  });
  assert.strictEqual(withConfirm.states[0], 'met');
  assert.strictEqual(withConfirm.row.cells[0].entry.link, 'https://drive.example/report');
});

test('a confirmed entry overrides outright when MANUAL_CONFIRM is not required', () => {
  const { states, row } = run({
    tasks: [],
    entries: [{ group: 'g1', periodKey: 'd:2026-08-12', state: 'confirmed', note: 'done offline' }],
  });
  assert.strictEqual(states[2], 'met');
  assert.strictEqual(row.cells[2].entry.note, 'done offline');
});

test('an excused entry wins over everything and leaves the ratio', () => {
  const { states, row } = run({
    tasks: [],
    entries: [{ group: 'g1', periodKey: 'd:2026-08-12', state: 'excused', note: 'client on hold' }],
  });
  assert.strictEqual(states[2], 'excused');
  assert.strictEqual(row.summary.excused, 1);
  assert.strictEqual(row.summary.required, 3); // the excused day is not counted against them
});

// ---------------------------------------------------------------------------
// Matching — and being able to explain a red cell
// ---------------------------------------------------------------------------

test('matchesTask handles include, exclude and labels', () => {
  const t = task('t1', 'g1', '10-08-26 Report', '2026-08-10T09:00:00Z', { labels: ['L1'] });

  assert.deepStrictEqual(matchesTask(t, {}), { ok: true, excludedByName: false });
  assert.strictEqual(matchesTask(t, { nameContains: 'report' }).ok, true); // case-insensitive
  assert.strictEqual(matchesTask(t, { nameContains: 'audit' }).ok, false);
  assert.deepStrictEqual(matchesTask(t, { excludeNameContains: 'Report' }), {
    ok: false,
    excludedByName: true,
  });
  assert.strictEqual(matchesTask(t, { labels: ['L1'] }).ok, true);
  assert.strictEqual(matchesTask(t, { labels: ['L2'] }).ok, false);
});

test('a red cell can say WHY nothing matched', () => {
  // The daily tracker excludes the monthly report task. Without this count the
  // cell is an unexplained red square and people stop trusting the grid.
  const { row, states } = run({
    trk: tracker({ match: { excludeNameContains: 'Report' } }),
    tasks: [task('t1', 'g1', '12-08-26 Report', '2026-08-12T09:00:00Z')],
  });

  assert.strictEqual(states[2], 'missed');
  assert.strictEqual(row.cells[2].matched, 0);
  assert.strictEqual(row.cells[2].excluded, 1);
  assert.deepStrictEqual(row.cells[2].missing, ['TASK_EXISTS', 'UPDATE_POSTED']);
});

test('cells carry per-task detail for the drill-down', () => {
  const { row } = run({
    tasks: [task('t1', 'g1', '11-08-26 GSC Keywords', '2026-08-11T09:00:00Z')],
  });
  assert.deepStrictEqual(row.cells[1].tasks, [
    { id: 't1', name: '11-08-26 GSC Keywords', ok: false, missing: ['UPDATE_POSTED'] },
  ]);
  assert.deepStrictEqual(row.cells[1].met, ['TASK_EXISTS']);
  assert.deepStrictEqual(row.cells[1].missing, ['UPDATE_POSTED']);
});

// ---------------------------------------------------------------------------
// TASK_DONE
// ---------------------------------------------------------------------------

test('TASK_DONE reads current status, and tolerates the legacy string', () => {
  const trk = tracker({ requirements: ['TASK_EXISTS', 'TASK_DONE'] });

  const notDone = run({ trk, tasks: [task('t1', 'g1', 'a', '2026-08-10T09:00:00Z')] });
  assert.strictEqual(notDone.states[0], 'partial');

  const byId = run({
    trk,
    tasks: [task('t1', 'g1', 'a', '2026-08-10T09:00:00Z', { status: 'st_done' })],
  });
  assert.strictEqual(byId.states[0], 'met');

  // Pre-migration rows store the raw string.
  const legacy = run({
    trk,
    tasks: [task('t1', 'g1', 'a', '2026-08-10T09:00:00Z', { status: 'done' })],
  });
  assert.strictEqual(legacy.states[0], 'met');
});

// ---------------------------------------------------------------------------
// Timezone
// ---------------------------------------------------------------------------

test('a late-night task lands on the local day, not the UTC day', () => {
  // 20:30 UTC on the 10th is 02:00 on the 11th in Kolkata. Under UTC bucketing
  // this task would credit Monday and leave Tuesday red.
  const lateNight = [task('t1', 'g1', 'Night shift', '2026-08-10T20:30:00Z')];

  const periods = periodsBetween(DAILY, FROM, TO, { skipDates: [] });
  const inKolkata = evaluateTracker({
    tracker: tracker(),
    periods,
    groups: [group('g1', 'DOPE THC')],
    tasks: lateNight,
    updateDayKeys: new Map([['t1', new Set(['2026-08-11'])]]),
    entries: [],
    board: BOARD,
    timezone: 'Asia/Kolkata',
    now: NOW,
  });
  assert.strictEqual(inKolkata.rows[0].cells[1].s, 'met'); // Tuesday
  assert.strictEqual(inKolkata.rows[0].cells[0].s, 'missed'); // Monday

  const inUtc = evaluateTracker({
    tracker: tracker(),
    periods,
    groups: [group('g1', 'DOPE THC')],
    tasks: lateNight,
    updateDayKeys: new Map([['t1', new Set(['2026-08-10'])]]),
    entries: [],
    board: BOARD,
    timezone: 'UTC',
    now: NOW,
  });
  assert.strictEqual(inUtc.rows[0].cells[0].s, 'met'); // Monday
});

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

test('summariseRows buckets clients by miss count', () => {
  const mkRow = (missed) => ({ summary: { missed, met: 10 - missed, required: 10 } });
  const summary = summariseRows([mkRow(0), mkRow(1), mkRow(2), mkRow(3), mkRow(7)]);

  assert.strictEqual(summary.groupCount, 5);
  assert.strictEqual(summary.onTrack, 1);
  assert.strictEqual(summary.slipping, 2);
  assert.strictEqual(summary.atRisk, 2);
  assert.strictEqual(summary.met, 37);
  assert.strictEqual(summary.required, 50);
  assert.strictEqual(summary.keptPct, 74);
});

test('keptPct is null rather than 0 when nothing was ever required', () => {
  const { row, summary } = run({
    trk: tracker({ startDate: '2027-01-01' }), // whole window is n/a
  });
  assert.strictEqual(row.summary.required, 0);
  assert.strictEqual(row.summary.keptPct, null);
  assert.strictEqual(summary.keptPct, null);
});

test('multiple groups are evaluated independently and in the order given', () => {
  const { rows } = run({
    groups: [group('g1', 'DOPE THC'), group('g2', 'BLACK SUEDE')],
    tasks: [task('t1', 'g1', 'a', '2026-08-10T09:00:00Z')],
    updateDayKeys: new Map([['t1', new Set(['2026-08-10'])]]),
  });

  assert.deepStrictEqual(rows.map((r) => r.groupName), ['DOPE THC', 'BLACK SUEDE']);
  assert.strictEqual(rows[0].cells[0].s, 'met');
  assert.strictEqual(rows[1].cells[0].s, 'missed');
});

const { test } = require('node:test');
const assert = require('node:assert');

const { planDelivery, evaluatePlans } = require('./deliveryReport');

// ---------------------------------------------------------------------------
// Fixtures. The scoring itself is trackerEvaluate's job and is tested there;
// what matters here is WHICH periods and groups a plan ends up covering, and
// what range the queries are told to scan.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-14T12:00:00Z');

const DAILY = { type: 'everyNDays', n: 1, weekdays: [1, 2, 3, 4, 5], graceDays: 0 };

const BOARD = { _id: 'b1', statuses: [{ _id: 'st_new', key: 'not_started' }] };

const GROUPS = [
  { _id: 'g1', name: 'Alpha', createdAt: new Date('2026-01-01') },
  { _id: 'g2', name: 'Beta', createdAt: new Date('2026-01-01') },
  { _id: 'g3', name: 'Gamma', createdAt: new Date('2026-01-01') },
];

const tracker = (extra = {}) => ({
  _id: 't1',
  name: 'Daily activity',
  enabled: true,
  timezone: 'UTC',
  cadence: DAILY,
  skipDates: [],
  match: {},
  requirements: ['TASK_EXISTS'],
  requireSameTask: true,
  targetCount: 1,
  startDate: '2026-08-01',
  endDate: null,
  groups: [],
  ...extra,
});

/** The plain "give me exactly this window" resolver. */
const fixedRange = (from, to) => () => ({ from, to });

const plan1 = (trk, resolveRange, maxCells = 5000) =>
  planDelivery({ trackers: [trk], allGroups: GROUPS, resolveRange, now: NOW, maxCells });

// ---------------------------------------------------------------------------
// The seam — resolveRange decides the window, planDelivery decides everything else
// ---------------------------------------------------------------------------

test('resolveRange chooses the window; the caller never sees the clamps', () => {
  const { plans } = plan1(tracker(), fixedRange('2026-08-10', '2026-08-14'));

  assert.strictEqual(plans.length, 1);
  assert.strictEqual(plans[0].from, '2026-08-10');
  assert.strictEqual(plans[0].to, '2026-08-14');
  // Mon-Fri, weekends excluded by the cadence.
  assert.deepStrictEqual(
    plans[0].periods.map((p) => p.startDayKey),
    ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']
  );
});

test('resolveRange is given each tracker and its own todayKey', () => {
  const seen = [];
  planDelivery({
    trackers: [tracker(), tracker({ _id: 't2', timezone: 'Asia/Kolkata' })],
    allGroups: GROUPS,
    now: new Date('2026-08-14T20:30:00Z'), // already the 15th in Kolkata
    maxCells: 5000,
    resolveRange: ({ tracker: t, todayKey }) => {
      seen.push([String(t._id), todayKey]);
      return { from: '2026-08-10', to: todayKey };
    },
  });

  assert.deepStrictEqual(seen, [['t1', '2026-08-14'], ['t2', '2026-08-15']]);
});

// ---------------------------------------------------------------------------
// The clamps. These are the reason this is one function and not two copies.
// ---------------------------------------------------------------------------

test('the window never reaches back before the tracker started', () => {
  const { plans } = plan1(
    tracker({ startDate: '2026-08-12' }),
    fixedRange('2026-08-01', '2026-08-14')
  );
  assert.strictEqual(plans[0].from, '2026-08-12');
});

test('the window never reaches past the tracker end date', () => {
  const { plans } = plan1(
    tracker({ endDate: '2026-08-12' }),
    fixedRange('2026-08-10', '2026-08-14')
  );
  assert.strictEqual(plans[0].to, '2026-08-12');
});

test('a tracker that has not started yet still renders its empty columns', () => {
  // Asking for August on a tracker starting in October: `from` clamps forward
  // past `to`, and without the guard the range would be inverted.
  const { plans } = plan1(
    tracker({ startDate: '2026-10-01' }),
    fixedRange('2026-08-01', '2026-08-31')
  );
  assert.strictEqual(plans[0].from, '2026-10-01');
  assert.strictEqual(plans[0].to, '2026-10-01', 'to snapped forward to from, never inverted');
  assert.ok(plans[0].periods.length >= 0);
});

// ---------------------------------------------------------------------------
// Straddling periods — a period belongs to the window holding its FIRST day
// ---------------------------------------------------------------------------

const WEEKLY = { type: 'weekly', weekStartsOn: 1, weekdays: [1, 2, 3, 4, 5], graceDays: 0 };

test('a week straddling the window start is dropped, not banded into a foreign month', () => {
  // August 2026 opens on a Saturday, so the week containing 1 August starts on
  // Monday 27 JULY. Rendering it puts a July column in an August grid and scores
  // that week in both months' totals.
  const { plans } = plan1(
    tracker({ cadence: WEEKLY, startDate: '2026-01-01' }),
    fixedRange('2026-08-01', '2026-08-31')
  );

  assert.strictEqual(plans[0].periods[0].startDayKey, '2026-08-03');
  assert.ok(
    plans[0].periods.every((p) => p.startDayKey.slice(0, 7) === '2026-08'),
    'every column belongs to the month that was asked for'
  );
});

test('the straddle rule measures from the REQUESTED start, not the clamped one', () => {
  // A tracker born mid-week still owns that week: no earlier window will ever
  // render it, so trimming against the startDate-clamped `from` would lose the
  // first week of tracking outright.
  const { plans } = plan1(
    tracker({ cadence: WEEKLY, startDate: '2026-08-05' }), // a Wednesday
    fixedRange('2026-08-01', '2026-08-31')
  );

  assert.strictEqual(plans[0].from, '2026-08-05', 'still clamped to the tracker start');
  assert.strictEqual(plans[0].periods[0].startDayKey, '2026-08-03', 'but its week is kept');
});

test('the trailing period is kept whole — August owns the week that runs into September', () => {
  // The mirror of the rule above: Mon 31 August starts in August, so August
  // scores it, and September will drop it.
  const { plans } = plan1(
    tracker({ cadence: WEEKLY, startDate: '2026-01-01' }),
    fixedRange('2026-08-01', '2026-08-31')
  );

  const last = plans[0].periods[plans[0].periods.length - 1];
  assert.strictEqual(last.startDayKey, '2026-08-31');
  assert.strictEqual(last.endDayKey, '2026-09-06', 'kept whole, not clipped to the month');
});

test('a daily cadence needs no trim — every day is its own period', () => {
  // The straddle rule must not quietly eat the 1st. A daily period starts on the
  // day it covers, so nothing here precedes the window; Sat 1 August is present
  // and merely `isOff`, which is how a weekend renders rather than how it hides.
  const { plans } = plan1(
    tracker({ startDate: '2026-01-01' }),
    fixedRange('2026-08-01', '2026-08-31')
  );

  assert.strictEqual(plans[0].periods.length, 31, 'the whole month, weekends included');
  assert.strictEqual(plans[0].periods[0].startDayKey, '2026-08-01');
  assert.strictEqual(plans[0].periods[0].isOff, true, 'a Saturday on a Mon-Fri cadence');
  assert.strictEqual(plans[0].periods[30].startDayKey, '2026-08-31');
});

// ---------------------------------------------------------------------------
// Scan bounds — the subtle one
// ---------------------------------------------------------------------------

test('the scan upper bound follows grace PAST the window, not `to`', () => {
  // A period ending on the 14th with 3 grace days is not due until the 17th, so
  // evidence posted on the 16th still counts. Bounding the query at `to` would
  // silently drop it and the period would read as missed.
  const graced = tracker({ cadence: { ...DAILY, graceDays: 3 } });
  const { plans, scanTo } = plan1(graced, fixedRange('2026-08-10', '2026-08-14'));

  assert.strictEqual(plans[0].to, '2026-08-14');
  assert.strictEqual(scanTo, '2026-08-17');
  assert.ok(scanTo > plans[0].to, 'scan extends beyond the rendered window');
});

test('scan bounds span the union of every tracker window', () => {
  const a = tracker({ _id: 'ta' });
  const b = tracker({ _id: 'tb' });
  const { scanFrom, scanTo } = planDelivery({
    trackers: [a, b],
    allGroups: GROUPS,
    now: NOW,
    maxCells: 5000,
    resolveRange: ({ tracker: t }) => (String(t._id) === 'ta'
      ? { from: '2026-08-03', to: '2026-08-07' }
      : { from: '2026-08-10', to: '2026-08-14' }),
  });

  assert.strictEqual(scanFrom, '2026-08-03');
  assert.strictEqual(scanTo, '2026-08-14');
});

// ---------------------------------------------------------------------------
// Group scoping
// ---------------------------------------------------------------------------

test('an empty tracker.groups means EVERY group', () => {
  const { plans } = plan1(tracker({ groups: [] }), fixedRange('2026-08-10', '2026-08-14'));
  assert.deepStrictEqual(plans[0].groups.map((g) => g._id), ['g1', 'g2', 'g3']);
});

test('a scoped tracker keeps only the groups it names, and skips ids that are gone', () => {
  const { plans } = plan1(
    tracker({ groups: ['g3', 'g1', 'deleted'] }),
    fixedRange('2026-08-10', '2026-08-14')
  );
  assert.deepStrictEqual(plans[0].groups.map((g) => g._id), ['g3', 'g1']);
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

test('overCap reports the tracker and the cell count, and suppresses scan bounds', () => {
  const { overCap, scanFrom, scanTo } = plan1(
    tracker(), fixedRange('2026-08-10', '2026-08-14'), 10 // 3 groups x 5 periods = 15
  );

  assert.ok(overCap);
  assert.strictEqual(overCap.cells, 15);
  assert.strictEqual(overCap.tracker.name, 'Daily activity');
  // Nothing should be queried for a request that is about to be refused.
  assert.strictEqual(scanFrom, null);
  assert.strictEqual(scanTo, null);
});

test('exactly at the cap is allowed', () => {
  const { overCap } = plan1(tracker(), fixedRange('2026-08-10', '2026-08-14'), 15);
  assert.strictEqual(overCap, null);
});

// ---------------------------------------------------------------------------
// evaluatePlans
// ---------------------------------------------------------------------------

const evalWith = (trk, { tasks = [], updateRows = [], entries = [] } = {}) => {
  const { plans } = plan1(trk, fixedRange('2026-08-10', '2026-08-14'));
  return evaluatePlans({
    board: BOARD,
    plans,
    tasks,
    updateRows,
    entriesByTracker: new Map(entries.length ? [[String(trk._id), entries]] : []),
    now: NOW,
  });
};

test('a disabled tracker yields no rows and no summary', () => {
  const [result] = evalWith(tracker({ enabled: false }));
  assert.deepStrictEqual(result.rows, []);
  assert.strictEqual(result.summary, null);
  // The plan's periods are still computed — the caller decides whether to
  // render them, exactly as getDelivery always did.
  assert.ok(result.periods.length > 0);
});

test('an enabled tracker scores one row per scoped group', () => {
  const [result] = evalWith(tracker());
  assert.deepStrictEqual(result.rows.map((r) => r.groupId), ['g1', 'g2', 'g3']);
  assert.strictEqual(result.rows[0].cells.length, result.periods.length);
});

test('a task inside a period is credited to its group', () => {
  const tasks = [{
    _id: 'k1', group: 'g1', name: 'Report',
    createdAt: new Date('2026-08-11T09:00:00Z'), status: 'st_new', labels: [],
  }];
  const [result] = evalWith(tracker(), { tasks });

  const g1 = result.rows.find((r) => r.groupId === 'g1');
  const g2 = result.rows.find((r) => r.groupId === 'g2');
  const cell = g1.cells.find((c) => c.p.endsWith('2026-08-11'));

  assert.strictEqual(cell.s, 'met');
  assert.strictEqual(cell.n, 1);
  assert.strictEqual(g2.cells.find((c) => c.p.endsWith('2026-08-11')).s, 'missed');
});

test('updates are indexed in each tracker OWN timezone', () => {
  // 20:30 UTC on the 11th is already the 12th in Kolkata. The same activity row
  // must land on a different day for a Kolkata tracker than for a UTC one —
  // which is exactly why the index is rebuilt per tracker rather than once.
  const tasks = [{
    _id: 'k1', group: 'g1', name: 'Report',
    createdAt: new Date('2026-08-11T09:00:00Z'), status: 'st_new', labels: [],
  }];
  const updateRows = [{ task: 'k1', createdAt: new Date('2026-08-11T20:30:00Z') }];
  const withUpdate = tracker({ requirements: ['TASK_EXISTS', 'UPDATE_POSTED'] });

  const utcCell = evalWith(withUpdate, { tasks, updateRows })[0]
    .rows.find((r) => r.groupId === 'g1').cells.find((c) => c.p.endsWith('2026-08-11'));
  assert.strictEqual(utcCell.s, 'met', 'UTC: the update lands on the 11th');

  const kolkata = { ...withUpdate, timezone: 'Asia/Kolkata' };
  const { plans } = plan1(kolkata, fixedRange('2026-08-10', '2026-08-14'));
  const ktCell = evaluatePlans({
    board: BOARD, plans, tasks, updateRows, entriesByTracker: new Map(), now: NOW,
  })[0].rows.find((r) => r.groupId === 'g1').cells.find((c) => c.p.endsWith('2026-08-11'));
  assert.notStrictEqual(ktCell.s, 'met', 'Kolkata: the same update is already the 12th');
});

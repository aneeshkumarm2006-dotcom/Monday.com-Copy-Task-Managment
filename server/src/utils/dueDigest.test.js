const { test } = require('node:test');
const assert = require('node:assert');

const {
  DIGEST_HOUR,
  isMorningReached,
  resolveDigestTimezone,
  splitDueTasks,
  digestMessage,
  lateLabel,
} = require('./dueDigest');

/**
 * The digest's decisions, asserted without a database — the same discipline as
 * goalReminderRunner.test.js next door. Everything that decides WHOSE morning
 * it is, WHICH tasks count and WHAT the sentence says is here; the runner that
 * queries and sends is deliberately too thin to need a mock.
 */

// A fixed instant: 2026-09-02 05:00 UTC == 10:30 in Asia/Calcutta, 01:00 in
// New York the same date, 05:00 of course in UTC.
const NOW = new Date('2026-09-02T05:00:00Z');

const board = (id, tz = 'Asia/Calcutta', extra = {}) => ({
  _id: id,
  name: `Board ${id}`,
  monthTimezone: tz,
  statuses: [
    { _id: 's-open', key: 'not_started' },
    { _id: 's-done', key: 'done' },
  ],
  ...extra,
});

const task = (over = {}) => ({
  name: 'A task',
  dueDate: new Date('2026-09-02T04:00:00Z'),
  board: 'b1',
  status: 's-open',
  priority: 'medium',
  isPersonal: false,
  ...over,
});

const boardsById = new Map([['b1', board('b1')]]);

// ---------------------------------------------------------------------------
// whose morning
// ---------------------------------------------------------------------------

test('morning is reached at or after the digest hour, in the given zone', () => {
  // 10:30 in Calcutta — past 9.
  assert.strictEqual(isMorningReached(NOW, 'Asia/Calcutta'), true);
  // 01:00 in New York — long before 9.
  assert.strictEqual(isMorningReached(NOW, 'America/New_York'), false);
  // 05:00 UTC — before 9.
  assert.strictEqual(isMorningReached(NOW, 'UTC'), false);
  assert.strictEqual(DIGEST_HOUR, 9);
});

test('timezone resolves user first, then majority board zone, then UTC', () => {
  const boards = [board('a', 'Asia/Calcutta'), board('b', 'Asia/Calcutta'), board('c', 'Europe/London')];
  assert.strictEqual(
    resolveDigestTimezone({ timezone: 'Europe/London' }, boards),
    'Europe/London'
  );
  assert.strictEqual(resolveDigestTimezone({ timezone: null }, boards), 'Asia/Calcutta');
  // An invalid stored zone is ignored rather than trusted.
  assert.strictEqual(resolveDigestTimezone({ timezone: 'Mars/Olympus' }, boards), 'Asia/Calcutta');
  assert.strictEqual(resolveDigestTimezone({ timezone: null }, []), 'UTC');
});

// ---------------------------------------------------------------------------
// which tasks
// ---------------------------------------------------------------------------

test('splits into overdue and due-today; future and done are out', () => {
  const tasks = [
    task({ name: 'due today' }),
    task({ name: 'overdue', dueDate: new Date('2026-08-30T04:00:00Z') }),
    task({ name: 'future', dueDate: new Date('2026-09-05T04:00:00Z') }),
    task({ name: 'finished', status: 's-done' }),
    task({ name: 'no due date', dueDate: null }),
  ];
  const { overdue, dueToday } = splitDueTasks({
    tasks, boardsById, now: NOW, timezone: 'Asia/Calcutta',
  });
  assert.deepStrictEqual(dueToday.map((t) => t.name), ['due today']);
  assert.deepStrictEqual(overdue.map((t) => t.name), ['overdue']);
  assert.strictEqual(overdue[0].daysLate, 3);
});

test('a personal task uses the legacy string done-test', () => {
  const tasks = [
    task({ name: 'personal open', isPersonal: true, board: null, status: 'in_progress' }),
    task({ name: 'personal done', isPersonal: true, board: null, status: 'done' }),
  ];
  const { dueToday } = splitDueTasks({
    tasks, boardsById: new Map(), now: NOW, timezone: 'Asia/Calcutta',
  });
  assert.deepStrictEqual(dueToday.map((t) => t.name), ['personal open']);
});

test('the same instant lands in different buckets in different zones', () => {
  // Due 2026-09-01 20:00 UTC: that is 01:30 on the 2nd in Calcutta (due today)
  // but still the evening of the 1st in New York (overdue there... not yet —
  // in New York NOW is 01:00 on the 2nd, so the 1st is yesterday: overdue).
  const t = [task({ name: 'boundary', dueDate: new Date('2026-09-01T20:00:00Z') })];
  const cal = splitDueTasks({ tasks: t, boardsById, now: NOW, timezone: 'Asia/Calcutta' });
  const ny = splitDueTasks({ tasks: t, boardsById, now: NOW, timezone: 'America/New_York' });
  assert.strictEqual(cal.dueToday.length, 1, 'Calcutta: that instant is today');
  assert.strictEqual(ny.overdue.length, 1, 'New York: that instant was yesterday');
});

test('overdue reads oldest-first; today reads by priority', () => {
  const tasks = [
    task({ name: 'late-1d', dueDate: new Date('2026-09-01T04:00:00Z') }),
    task({ name: 'late-5d', dueDate: new Date('2026-08-28T04:00:00Z') }),
    task({ name: 'today-low', priority: 'low' }),
    task({ name: 'today-critical', priority: 'critical' }),
  ];
  const { overdue, dueToday } = splitDueTasks({
    tasks, boardsById, now: NOW, timezone: 'Asia/Calcutta',
  });
  assert.deepStrictEqual(overdue.map((t) => t.name), ['late-5d', 'late-1d']);
  assert.deepStrictEqual(dueToday.map((t) => t.name), ['today-critical', 'today-low']);
});

// ---------------------------------------------------------------------------
// what the sentence says
// ---------------------------------------------------------------------------

test('the one-line message covers all three shapes and goes silent at zero', () => {
  assert.strictEqual(
    digestMessage({ overdueCount: 2, todayCount: 2 }),
    'Good morning — 4 tasks need you today, 2 overdue.'
  );
  assert.strictEqual(
    digestMessage({ overdueCount: 0, todayCount: 1 }),
    'Good morning — 1 task due today.'
  );
  assert.strictEqual(
    digestMessage({ overdueCount: 3, todayCount: 0 }),
    'Good morning — 3 tasks overdue and waiting.'
  );
  // Nothing due means NO message — an empty digest is noise, not news.
  assert.strictEqual(digestMessage({ overdueCount: 0, todayCount: 0 }), null);
});

test('late labels pluralise', () => {
  assert.strictEqual(lateLabel(1), '1 day late');
  assert.strictEqual(lateLabel(4), '4 days late');
});

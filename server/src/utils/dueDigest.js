/**
 * The morning due-task digest — the decisions, in one pure place.
 *
 * PURE, in the trackerEvaluate/goalTypes sense: plain objects in, plain objects
 * out, no mongoose, no `Date.now()` except through arguments. The runner
 * (services/dueDigestRunner.js) owns the querying and the sending; this owns
 * what a digest IS — whose morning it is, which tasks count, and in what order
 * a person should read them.
 *
 * WHY A DIGEST AND NOT A PING PER TASK. The `dueSoon` notification already
 * demonstrates the failure mode this exists to avoid twice over: it is
 * poll-based (fires only when somebody opens the bell, so the people who most
 * need reminding never see it), and it is one row per task (ten reminders at
 * 9am teach a person to ignore all ten). One message, once a morning, listing
 * everything — that is the entire design.
 *
 * WHOSE 9AM? The user's, resolved in this order:
 *   1. `User.timezone` — the browser's own zone, synced on app load.
 *   2. The majority `monthTimezone` among the boards their due tasks sit on —
 *      so a brand-new account on an Asia/Calcutta agency still gets an
 *      Asia/Calcutta morning before its first app-open records a zone.
 *   3. UTC, as the honest last resort.
 */

const { getTzParts, dayKeyOf, compareDayKeys, daysBetween, isValidTimezone } = require('./tzDay');
const { isResolvedStatus } = require('./doneStatus');

/**
 * The digest fires on the first runner tick AT OR AFTER this local hour —
 * not in a narrow window. The once-per-day claim row is what prevents repeats,
 * so a runner that was down at 09:00 still delivers at 09:45 rather than
 * skipping the day. Same discipline as goalReminderRunner's REMIND_HOUR.
 */
const DIGEST_HOUR = 9;

/** Priority rank for ordering the due-today list — the urgent read first. */
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/** Has this timezone's morning arrived? */
const isMorningReached = (now, timezone) => {
  const parts = getTzParts(now, timezone);
  return !!parts && parts.hour >= DIGEST_HOUR;
};

/**
 * Which timezone is this user's morning measured in?
 * `boards` are the boards their candidate tasks live on.
 */
const resolveDigestTimezone = (user, boards = []) => {
  if (user?.timezone && isValidTimezone(user.timezone)) return user.timezone;

  const counts = new Map();
  for (const b of boards) {
    const tz = b?.monthTimezone;
    if (!tz || !isValidTimezone(tz)) continue;
    counts.set(tz, (counts.get(tz) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [tz, n] of counts) {
    if (n > bestCount) { best = tz; bestCount = n; }
  }
  return best || 'UTC';
};

/**
 * Split a user's candidate tasks into the two lists the digest shows.
 *
 * A task is DONE when its board's own done status says so — `isResolvedStatus`
 * is the one permitted test, and it also accepts the legacy string a personal
 * task carries. Done tasks are out entirely: a digest that nags about finished
 * work is deleted from the inbox rules by Friday.
 *
 * Tasks due later than today are out too. "Due this week" belongs to a person
 * planning; the morning digest answers only "what does TODAY owe".
 *
 * Ordering is deliberate:
 *   overdue  — oldest first. The thing rotting longest is read first.
 *   dueToday — by priority, then name. Today's list is a plan, not a queue.
 */
const splitDueTasks = ({ tasks = [], boardsById = new Map(), now, timezone }) => {
  const today = dayKeyOf(now, timezone);
  const overdue = [];
  const dueToday = [];
  if (!today) return { overdue, dueToday, today: null };

  for (const task of tasks) {
    if (!task?.dueDate) continue;
    const board = task.board ? boardsById.get(String(task.board)) : null;
    if (isResolvedStatus(board, task.status)) continue;

    const dueKey = dayKeyOf(task.dueDate, timezone);
    if (!dueKey) continue;

    const cmp = compareDayKeys(dueKey, today);
    if (cmp < 0) {
      overdue.push({ ...task, dueKey, daysLate: daysBetween(dueKey, today) });
    } else if (cmp === 0) {
      dueToday.push({ ...task, dueKey, daysLate: 0 });
    }
    // Future tasks: not this morning's business.
  }

  overdue.sort((a, b) => compareDayKeys(a.dueKey, b.dueKey) || a.name.localeCompare(b.name));
  dueToday.sort((a, b) => {
    const ra = PRIORITY_RANK[a.priority] ?? 2;
    const rb = PRIORITY_RANK[b.priority] ?? 2;
    return ra - rb || a.name.localeCompare(b.name);
  });

  return { overdue, dueToday, today };
};

/** "2 days late" / "1 day late" — the label an overdue row wears. */
const lateLabel = (daysLate) =>
  (daysLate === 1 ? '1 day late' : `${daysLate} days late`);

/**
 * The one-line message the in-app notification carries. Counts only — the
 * task names live in the email and behind the link, because a notification
 * row has one line and the point of it is the number.
 */
const digestMessage = ({ overdueCount = 0, todayCount = 0 }) => {
  const total = overdueCount + todayCount;
  const tasks = (n) => `${n} task${n === 1 ? '' : 's'}`;
  if (total === 0) return null;
  if (overdueCount === 0) return `Good morning — ${tasks(todayCount)} due today.`;
  if (todayCount === 0) {
    return `Good morning — ${tasks(overdueCount)} overdue and waiting.`;
  }
  return `Good morning — ${tasks(total)} need you today, ${overdueCount} overdue.`;
};

module.exports = {
  DIGEST_HOUR,
  isMorningReached,
  resolveDigestTimezone,
  splitDueTasks,
  digestMessage,
  lateLabel,
};

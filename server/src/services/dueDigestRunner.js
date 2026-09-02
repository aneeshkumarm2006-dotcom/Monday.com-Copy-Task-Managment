const cron = require('node-cron');

const User = require('../models/User');
const Task = require('../models/Task');
const Board = require('../models/Board');
const DueDigest = require('../models/DueDigest');
const {
  isMorningReached,
  resolveDigestTimezone,
  splitDueTasks,
  digestMessage,
} = require('../utils/dueDigest');
const { dayKeyOf } = require('../utils/tzDay');
const {
  createNotificationsForUsers,
  filterByEmailPreference,
} = require('./notificationService');
const { sendDueDigestEmail } = require('./emailService');

/**
 * The morning due-task digest.
 *
 * A direct sibling of [goalReminderRunner.js](./goalReminderRunner.js) — same
 * node-cron tick, same module-level `started` guard, same start-from-server.js
 * shape, same claim-before-send idempotency. The differences are the subject
 * (a USER's tasks rather than a board's goals) and the calendar (every morning
 * rather than twice a month).
 *
 * WHY EVERY FIFTEEN MINUTES: 9am has to be 9am in each user's own timezone,
 * and one team can span zones. The tick asks, per user, what time it is THERE;
 * the unique (user, dayKey) row in DueDigest makes the answer "once", however
 * many ticks agree it is past nine.
 *
 * WHAT COUNTS: tasks assigned to the user (plus personal tasks they created)
 * that are not done and are due TODAY or EARLIER in their own zone. The pure
 * rules — done-tests, ordering, message wording — live in utils/dueDigest.js
 * where they are unit-tested; this file only queries, claims and sends.
 *
 * A user with nothing due gets NOTHING — no "inbox zero!" message. A digest
 * that shows up empty is noise, and noise is how reminders get filtered to a
 * folder nobody opens. Overdue tasks, though, return every morning until they
 * are done or re-dated: quietly relentless is the entire point.
 */

let started = false;

/** How far ahead a raw dueDate can sit and still be "today" somewhere: 26h
 * covers UTC+14 with margin; precise inclusion is decided per-zone in
 * splitDueTasks, so overshooting here only costs a few filtered rows. */
const HORIZON_MS = 26 * 60 * 60 * 1000;

const digestOne = async (user, now) => {
  const horizon = new Date(now.getTime() + HORIZON_MS);

  const tasks = await Task.find({
    dueDate: { $ne: null, $lte: horizon },
    parent: null,
    $or: [
      { assignedTo: user._id },
      { isPersonal: true, createdBy: user._id },
    ],
  })
    .select('name dueDate board group status priority isPersonal')
    .lean();
  if (tasks.length === 0) return;

  const boardIds = [...new Set(tasks.map((t) => t.board).filter(Boolean).map(String))];
  const boards = boardIds.length
    ? await Board.find({ _id: { $in: boardIds } })
      .select('name organisation monthTimezone statuses columns useFlexibleColumns')
      .lean()
    : [];
  const boardsById = new Map(boards.map((b) => [String(b._id), b]));

  const timezone = resolveDigestTimezone(user, boards);
  if (!isMorningReached(now, timezone)) return;

  const today = dayKeyOf(now, timezone);
  if (!today) return;

  // Claim FIRST, then send — see models/DueDigest.js for why this ordering.
  try {
    await DueDigest.create({ user: user._id, dayKey: today, timezone, sentAt: now });
  } catch (err) {
    if (err?.code === 11000) return; // this morning is already handled
    throw err;
  }

  const { overdue, dueToday } = splitDueTasks({ tasks, boardsById, now, timezone });
  if (overdue.length === 0 && dueToday.length === 0) return; // checked, nothing owed

  // ---- in-app: one notification per workspace the bell is scoped to --------
  // The bell shows one org at a time, so counts are per org — a combined total
  // would name tasks the open workspace cannot show. Personal tasks ride under
  // a null org, which the bell shows everywhere (the dueSoon convention).
  const orgBuckets = new Map(); // orgId|'' → {overdueCount, todayCount}
  const bucket = (orgId) => {
    const key = orgId ? String(orgId) : '';
    if (!orgBuckets.has(key)) orgBuckets.set(key, { overdueCount: 0, todayCount: 0 });
    return orgBuckets.get(key);
  };
  for (const t of overdue) {
    bucket(t.isPersonal ? null : boardsById.get(String(t.board))?.organisation).overdueCount += 1;
  }
  for (const t of dueToday) {
    bucket(t.isPersonal ? null : boardsById.get(String(t.board))?.organisation).todayCount += 1;
  }

  for (const [orgKey, counts] of orgBuckets) {
    const message = digestMessage(counts);
    if (!message) continue;
    // eslint-disable-next-line no-await-in-loop
    await createNotificationsForUsers({
      userIds: [user._id],
      type: 'dueDigest',
      message,
      orgId: orgKey || null,
      actorId: null,
      tab: 'myWork',
    });
  }

  // ---- email: ONE, covering everything ------------------------------------
  // Email has no workspace scope, and two digest mails at 9am is how both get
  // marked read without being read. Preferences still gate it: the digest is
  // category 'dueDates', so the existing toggle, DND and master-off all apply.
  let emailed = false;
  if (user.email) {
    const allowed = await filterByEmailPreference([user._id], 'dueDigest', { now });
    if (allowed.has(String(user._id))) {
      const describe = (t) => ({
        name: t.name,
        context: t.isPersonal
          ? 'Personal'
          : (boardsById.get(String(t.board))?.name || 'Board'),
        daysLate: t.daysLate,
        priority: t.priority || null,
      });
      await sendDueDigestEmail({
        to: user.email,
        name: user.name,
        overdue: overdue.map(describe),
        dueToday: dueToday.map(describe),
      });
      emailed = true;
    }
  }

  await DueDigest.updateOne(
    { user: user._id, dayKey: today },
    { $set: { overdueCount: overdue.length, todayCount: dueToday.length, emailed } }
  );
};

const tick = async () => {
  const now = new Date();
  let users;
  try {
    users = await User.find({}).select('name email timezone').lean();
  } catch (err) {
    console.error('[dueDigest] failed to query users:', err);
    return;
  }

  for (const user of users) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await digestOne(user, now);
    } catch (err) {
      console.error('[dueDigest] failed for user', user?._id?.toString(), err);
    }
  }
};

const startDueDigestRunner = () => {
  if (started) return;
  started = true;
  cron.schedule('*/15 * * * *', () => {
    tick().catch((err) => console.error('[dueDigest] tick failed:', err));
  });
  console.log('due digest runner started');
};

module.exports = { startDueDigestRunner, tick, digestOne };

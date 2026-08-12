const cron = require('node-cron');
const Board = require('../models/Board');
const Goal = require('../models/Goal');
const GoalReminder = require('../models/GoalReminder');
const Organisation = require('../models/Organisation');
const { createNotificationsForUsers } = require('./notificationService');
const { usersWithBoardCapability } = require('../utils/boardAudience');
const { getTzParts, dayKeyOf, getLastDayOfMonth } = require('../utils/tzDay');
const { addMonths, formatMonth } = require('../utils/monthKey');
const { missingFinalValues } = require('../utils/goalTypes');

/**
 * The month-end goal reminder.
 *
 * A direct sibling of [automationRunner.js](./automationRunner.js) — same
 * `node-cron` dependency, same module-level `started` guard, same
 * start-from-server.js shape. Deliberately NOT folded into that tick, which
 * queries `Automation`: this is not an automation anyone can see or disable.
 *
 * WHY EVERY FIFTEEN MINUTES rather than once a day: the reminder has to fire at
 * a sensible hour in each BOARD's own timezone, and boards in one workspace can
 * sit in different ones. So the tick considers every tracker board and asks what
 * time it is *there*. Fifteen-minute granularity is plenty for a monthly nag and
 * costs a fifteenth of a per-minute tick.
 *
 * It fires twice: on the last day of the month ("this is your last chance") and
 * again on the 1st ("the month is over and it is still not closed").
 */

const REMIND_HOUR = 9; // 09:00 in the board's own timezone
let started = false;

/** Which reminder, if any, is due for this board right now? */
const dueKind = (board, now) => {
  const tz = board.monthTimezone || 'UTC';
  const parts = getTzParts(now, tz);
  if (parts.hour < REMIND_HOUR) return null;

  const todayKey = dayKeyOf(now, tz);
  if (!todayKey) return null;
  const thisMonth = todayKey.slice(0, 7);

  if (parts.day === getLastDayOfMonth(parts.year, parts.month)) {
    return { kind: 'monthEnd', monthKey: thisMonth };
  }
  if (parts.day === 1) {
    return { kind: 'monthStart', monthKey: addMonths(thisMonth, -1) };
  }
  return null;
};

const remindOne = async (board, now) => {
  const due = dueKind(board, now);
  if (!due) return;

  const columns = (board.goalColumns || []).filter((c) => !c.archived);
  const goals = await Goal.find({ board: board._id, monthKey: due.monthKey })
    .select('type config actual actualDayKey columnValues createdAt')
    .lean();

  // A board that does not use goals is never nagged about them.
  if (goals.length === 0) return;

  const missingCount = goals.filter((g) => missingFinalValues(g, columns).length > 0).length;

  // Claim FIRST, then work. The unique index on (board, monthKey, kind) is what
  // makes "once per board per month" survive a restart, a second app instance,
  // or a clock that steps backwards. Inserting before the fan-out means a crash
  // halfway through under-notifies rather than notifying twice — the right
  // direction to fail for a reminder.
  try {
    await GoalReminder.create({
      board: board._id,
      organisation: board.organisation,
      monthKey: due.monthKey,
      kind: due.kind,
      sentAt: now,
      missingCount,
    });
  } catch (err) {
    if (err?.code === 11000) return; // already sent
    throw err;
  }

  // Everything is already reported: record that we checked, send nothing. The
  // row above is what stops this recomputing every fifteen minutes all day.
  if (missingCount === 0) return;

  const org = await Organisation.findById(board.organisation)
    .select('admin admins members roles memberRoles');
  if (!org) return;
  // A workspace predating the role system resolves every capability to false,
  // which would silently mean zero recipients. Same lazy heal loadBoardContext
  // does on first touch.
  if (org.ensureSystemRoles?.()) await org.save();

  const recipients = usersWithBoardCapability(board, org, 'goal.track');
  if (recipients.length === 0) return;

  const label = formatMonth(due.monthKey, { long: true });
  const message = due.kind === 'monthEnd'
    ? `${board.name}: ${label} ends today and ${missingCount} goal${missingCount === 1 ? '' : 's'} still need final numbers.`
    : `${board.name}: ${label} is over and ${missingCount} goal${missingCount === 1 ? '' : 's'} were never given final numbers.`;

  await createNotificationsForUsers({
    userIds: recipients,
    type: 'goalsDue',
    message,
    orgId: board.organisation,
    boardId: board._id,
    actorId: null,
    tab: 'goals',
    // Carried so the link lands on the month that needs closing, not on
    // whatever month is current by the time somebody clicks it.
    month: due.monthKey,
  });

  await GoalReminder.updateOne(
    { board: board._id, monthKey: due.monthKey, kind: due.kind },
    { $set: { recipientCount: recipients.length } }
  );
};

const tick = async () => {
  const now = new Date();
  let boards;
  try {
    boards = await Board.find({ boardType: 'tracker' }).select(
      '_id name organisation monthTimezone goalColumns visibility publicDefaultLevel '
      + 'memberAccess createdBy'
    );
  } catch (err) {
    console.error('[goalReminder] failed to query tracker boards:', err);
    return;
  }

  for (const board of boards) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await remindOne(board, now);
    } catch (err) {
      console.error('[goalReminder] failed for board', board?._id?.toString(), err);
    }
  }
};

const startGoalReminderRunner = () => {
  if (started) return;
  started = true;
  cron.schedule('*/15 * * * *', () => {
    tick().catch((err) => console.error('[goalReminder] tick error:', err));
  });
  console.log('goal reminder runner started');
};

module.exports = { startGoalReminderRunner, tick, dueKind };

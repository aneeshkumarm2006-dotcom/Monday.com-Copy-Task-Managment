/**
 * executiveActivity.js — what happened to an executive view, and who did it.
 *
 * An executive view is a per-(organisation, user) profile describing what ONE
 * person's screen looks like: which boards sit on their list and in what order,
 * what their home page is composed of, which rail entries they kept. It is the
 * FIFTH subject in `ActivityLog`, after tasks, goals, ads budgets and groups,
 * and the first that is not a thing living on a board — which is why its rows
 * carry `organisation` and no task at all.
 *
 * WHY EVERY ROW CAPTURES A NAME
 *
 * The profile is deletable by design: removing it puts that person back on the
 * standard app immediately, with nothing to migrate, because the document only
 * ever described a view. So the thing these rows point at is EXPECTED to
 * disappear, and on an `executive.removed` row it has already disappeared by
 * the time anybody reads the history back. The pointer would then resolve to
 * nothing and the row would say that somebody did something to somebody.
 * `metadata.targetUserName`, denormalised here at the moment of the write, is
 * what the row is actually read by. Goal rows invented the trick for deleted
 * goals and group rows use it for deleted groups; this is the same move for a
 * subject whose deletion is a FEATURE rather than an accident.
 *
 * WHAT THESE ROWS MUST NEVER BE READ AS
 *
 * A profile is a view and never a grant. Reach is the org role AND the board's
 * own `memberAccess`, resolved by `resolveAccess`, and nothing written here
 * changes any of it. `executive.board_added` says a board was put on somebody's
 * curated list — the grant that lets them open it is a separate fact with a
 * separate writer, and the two are deliberately not merged. The level captured
 * below is what the configurator ASKED the share path for, recorded so the two
 * records can be compared later, not evidence that it was applied.
 *
 * WHY THIS WRITES `ActivityLog` DIRECTLY INSTEAD OF THROUGH `logActivity`
 *
 * Every other logger in this folder calls `activityService.logActivity`, and
 * this one would too if it could. That helper admits exactly four subjects —
 * its guard returns early unless one of task / goal / adsBudget / group is
 * present, and it never passes an `organisation` through — so an executive row
 * handed to it does not fail, it silently becomes nothing, which is the worst
 * of the three possible outcomes. Rather than widen a function every other
 * subject in the app depends on, this file writes the row itself and copies
 * that helper's contract exactly: same fire-and-forget try/catch, same actor
 * rules, same "never throw into the caller". The day `logActivity` learns a
 * fifth subject, `writeRow` below collapses into a call to it and nothing else
 * in this file changes.
 *
 * FIRE AND FORGET, like every other logger here. A broken log never blocks the
 * save that triggered it, and nothing in this file is awaited in a way that can
 * fail a declare, an edit or a delete.
 *
 * NO `executive.field_changed`. The five dedicated types say what happened
 * without a reader having to decode a `field` column, and a profile has no
 * fields worth naming one by one: its three parts are a board list, a layout
 * and eight switches. See `logExecutiveUpdated` for why the list of what moved
 * is passed in rather than diffed.
 */

const ActivityLog = require('../models/ActivityLog');

/**
 * How much of a name we are willing to carry into a log row. Deliberately the
 * same number `groupActivity.MAX_NAME` uses: these names land in the same
 * column of the same export, and two ceilings would truncate one sheet twice.
 */
const MAX_NAME = 120;

/** A board or role name is a shorter thing than a person's, and shares a line. */
const MAX_LABEL = 60;

const truncate = (s, n) => {
  const v = String(s == null ? '' : s);
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

/**
 * The vocabulary `logExecutiveUpdated` expects in its `changed` list — the
 * three parts of a profile, plus the two per-board details that are edited on
 * their own screen. Exported so the controller and this file agree on the
 * spelling; NOT enforced, because an unknown word reads as itself in the
 * sentence rather than being dropped, and a save that recorded a word nobody
 * has mapped yet is still better history than a save that recorded nothing.
 */
const CHANGE_KEYS = ['boards', 'home', 'nav', 'labels', 'presets'];

/** No single save may write a paragraph into one column. */
const MAX_CHANGES = 10;

/** Refs arrive as documents when the caller has one and as ids when it does not. */
const idOf = (v) => (v && typeof v === 'object' ? (v._id || null) : (v || null));

/**
 * The context every executive row carries.
 *
 * `targetUserName` is the load-bearing one — see the header. `targetUser` sits
 * beside it as a plain id for a future "everything that happened to this
 * person's view" filter; it is NOT what the row is read by, precisely because
 * the profile it belongs to is expected to go away.
 */
const baseMetadata = (targetUser) => ({
  targetUserName: truncate(targetUser?.name, MAX_NAME),
  targetUser: idOf(targetUser) ? String(idOf(targetUser)) : null,
});

const actorOf = ({ actor, actorType = 'user', actorLabel = '' }) => ({
  actor,
  actorType,
  actorLabel,
});

/**
 * Write one row, the way `activityService.logActivity` would have.
 *
 * `field` is never set: these are not `field_changed`-shaped events, so the
 * column stays null and the model's field validator never has to learn a word
 * about executive views.
 */
const writeRow = async ({
  organisation,
  board = null,
  actor,
  actorType = 'user',
  actorLabel = '',
  type,
  oldValue = null,
  newValue = null,
  metadata = null,
}) => {
  try {
    // A row with no organisation has no subject at all, and the model would
    // then demand a task. Refuse it here rather than write something unreadable.
    if (!organisation || !type) return null;
    // Team events need a User actor; a client-plane or unattended actor carries
    // a label instead. The same rule every other logger applies.
    if (actorType === 'user' && !actor) return null;

    return await ActivityLog.create({
      organisation: idOf(organisation) || organisation,
      // Set on the two board-scoped types only. That is what puts those rows in
      // one board's activity export and keeps the other three out of every one.
      board: board ? (idOf(board) || board) : null,
      task: null,
      goal: null,
      adsBudget: null,
      group: null,
      actor: actorType === 'user' ? actor : null,
      actorType,
      actorLabel,
      type,
      oldValue,
      newValue,
      metadata,
    });
  } catch (err) {
    // Swallowed, like every logger here: a history that failed to record must
    // never undo the change it was describing.
    console.error('executiveActivity error:', err);
    return null;
  }
};

/**
 * A view was declared: a role assigned and an empty profile created, in one
 * action by one person.
 *
 * `roleKey` / `roleName` are captured because roles are DATA — the matrix can
 * rename or re-scope one afterwards — so "which role did this hand them at the
 * time" is a question only this row can answer later. They stay out of the
 * sentence on purpose: assigning a role is the roles system's own event, and a
 * sentence naming it here would read as if this row had granted it.
 */
const logExecutiveDeclared = ({
  organisation,
  targetUser,
  actor,
  actorType,
  actorLabel,
  roleKey = null,
  roleName = '',
}) =>
  writeRow({
    organisation,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'executive.declared',
    newValue: truncate(targetUser?.name, MAX_NAME),
    metadata: {
      ...baseMetadata(targetUser),
      roleKey: roleKey || null,
      roleName: truncate(roleName, MAX_LABEL),
    },
  });

/**
 * A profile was edited — by an admin in the configurator, or by the person
 * themselves from their own home page or their Settings tab.
 *
 * `changed` IS THE DIFF, and it is passed in rather than computed here. The
 * service doing the save already knows which part of the document the request
 * touched; a full before/after comparison would have to walk a layout blob — an
 * ordered list of sections each carrying a free-form `config` — and would
 * produce "config.month changed from null to null" noise for a save a person
 * would describe in one word. What a reader wants is "home and navigation", and
 * the caller is the only one who can say that cheaply.
 *
 * An empty or missing list still writes a row. A save that recorded nothing
 * would be a hole in the history, and unlike a group rename — where the update
 * endpoint re-sends an unchanged name on every unrelated save — this event only
 * fires when somebody pressed Save on this profile. The sentence simply
 * degrades to "updated the executive view" with no detail.
 */
const logExecutiveUpdated = ({
  organisation,
  targetUser,
  changed = [],
  actor,
  actorType,
  actorLabel,
}) => {
  // Normalised so the formatter labels words rather than guessing at shapes:
  // strings only, trimmed, lower-cased, de-duplicated, capped.
  const list = [...new Set(
    (Array.isArray(changed) ? changed : [changed])
      .filter((c) => typeof c === 'string')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
  )].slice(0, MAX_CHANGES);

  return writeRow({
    organisation,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'executive.updated',
    newValue: truncate(targetUser?.name, MAX_NAME),
    metadata: { ...baseMetadata(targetUser), changed: list },
  });
};

/**
 * A profile was deleted, and that person is back on the standard app.
 *
 * `boardCount` records how much shape went with it — a view listing twelve
 * boards and a view listing none are different losses, and after the delete
 * there is nothing left to count, which is why the caller counts first. It is
 * deliberately NOT in the sentence: deleting a profile touches no grant, and
 * "removed the view and the 12 boards in it" would read as a revocation that
 * never happened.
 */
const logExecutiveRemoved = ({
  organisation,
  targetUser,
  actor,
  actorType,
  actorLabel,
  boardCount = 0,
}) =>
  writeRow({
    organisation,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'executive.removed',
    oldValue: truncate(targetUser?.name, MAX_NAME),
    metadata: { ...baseMetadata(targetUser), boardCount },
  });

/**
 * A board joined somebody's curated list.
 *
 * Carries `board`, so this row lands in that board's activity export beside the
 * share events it sits next to in time — the only place a person auditing one
 * board would ever look for it.
 *
 * `boardName` is captured for the same reason the person's name is: a board can
 * be renamed or deleted, and the row has to keep reading afterwards. `level`
 * and `canManage` record what the configurator asked for; see the header on why
 * that is a record of intent, not of access. `activityFormat` renders them with
 * the word "requested" for exactly that reason — the two fields and that word
 * are one decision, so do not pass a level here that the sentence would be
 * wrong to hedge, and do not drop the hedge there to tighten the prose.
 */
const logExecutiveBoardAdded = ({
  organisation,
  targetUser,
  board,
  level = null,
  canManage = false,
  actor,
  actorType,
  actorLabel,
}) =>
  writeRow({
    organisation,
    board,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'executive.board_added',
    newValue: truncate(board?.name, MAX_LABEL),
    metadata: {
      ...baseMetadata(targetUser),
      boardName: truncate(board?.name, MAX_LABEL),
      level: level || null,
      canManage: !!canManage,
    },
  });

/**
 * A board left somebody's curated list.
 *
 * `revoked` answers the question the configurator asks when a board is removed
 * ("also revoke access?"), and it is the one detail that makes this two
 * different events to a reader: a board taken off a list is tidying, a board
 * taken off a list AND revoked is somebody losing reach.
 *
 * It is the ONE place in this file where a sentence states access as fact, and
 * that is only safe because the caller can know it: the revoke is a write it has
 * already performed by the time it logs. Pass `true` only after that write
 * succeeded — never because the request asked for it. Compare `level` on the
 * added row above, which the caller genuinely cannot vouch for and which the
 * sentence therefore hedges.
 */
const logExecutiveBoardRemoved = ({
  organisation,
  targetUser,
  board,
  revoked = false,
  actor,
  actorType,
  actorLabel,
}) =>
  writeRow({
    organisation,
    board,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'executive.board_removed',
    oldValue: truncate(board?.name, MAX_LABEL),
    metadata: {
      ...baseMetadata(targetUser),
      boardName: truncate(board?.name, MAX_LABEL),
      revoked: !!revoked,
    },
  });

module.exports = {
  logExecutiveDeclared,
  logExecutiveUpdated,
  logExecutiveRemoved,
  logExecutiveBoardAdded,
  logExecutiveBoardRemoved,
  CHANGE_KEYS,
  MAX_NAME,
  MAX_LABEL,
};

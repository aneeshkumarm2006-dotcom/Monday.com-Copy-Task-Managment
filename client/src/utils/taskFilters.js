/**
 * Task filtering helpers for the board filter bar.
 *
 * Filters operate on the standard task fields (name, status, priority,
 * labels, dueDate, assignedTo) — EXCEPT the due date and the owner on a
 * flexible-column board, which are read from the columns that PLAY those roles
 * (see "Where a row's due date and owner live" below).
 *
 * This file used to claim the legacy fields "stay populated even on
 * flexible-column boards because Task.js syncs columnValues back onto them".
 * That was only ever true for the pre-template keys `due_date` / `assignees`:
 * a Billing board's `due` and `owner` columns never reached `task.dueDate` /
 * `task.assignedTo`, so its Due filter matched nothing and its Owner filter
 * offered nobody. The server now syncs role columns both ways, but rows written
 * before that sync still carry an empty legacy field — and the column is what
 * the grid, the ledger and the panel show — so the column is what we read.
 *
 * Semantics: a task must satisfy EVERY active category (AND); within a single
 * category, matching ANY selected value is enough (OR). An empty category
 * imposes no constraint.
 *
 * Labels are the one exception — they match EXCLUSIVELY, so the filtered view
 * shows exactly the label combination that was asked for. See below.
 *
 * `groupOwners` is the one category that does NOT describe a task. A tracker
 * board's group carries a per-month owner (see server utils/groupOwner.js), so
 * that filter cuts at the GROUP level: a non-matching group leaves the view
 * whole, and the tasks inside it are never consulted. Hence the two predicates
 * below — `taskMatchesFilters` for the task categories, `groupMatchesFilters`
 * for this one — and the split active-count helpers, which callers use to tell
 * "the task list has been subset" (unsafe to reorder / create into) from "some
 * groups are hidden" (tasks untouched).
 */

// Explicit `.js` extensions so the node test runner can load this module (and
// everything it imports) without Vite's resolver. Vite accepts either form.
import { isStatusDone } from './statusUtils.js';
import { columnValue } from './columnValues.js';
import { roleColumn } from './columnRoles.js';
import { invoiceState, ledgerColumns } from './ledger.js';
import { isLedgerBoard } from './boardRowCreation.js';

export const EMPTY_FILTERS = {
  search: '',
  statuses: [],   // status _id strings (or legacy enum keys)
  priorities: [], // 'critical' | 'high' | 'medium' | 'low'
  labels: [],     // label _id strings
  due: [],        // DUE_BUCKETS keys
  assignees: [],  // user _id strings, plus the synthetic 'unassigned'
  groupOwners: [], // GROUP owner user _id strings, plus 'unassigned' (tracker boards)
};

/**
 * Due-date buckets offered in the filter, in display order.
 */
export const DUE_BUCKETS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'week', label: 'Due this week' },
  { key: 'month', label: 'Due this month' },
  { key: 'none', label: 'No due date' },
];

const MS_IN_DAY = 24 * 60 * 60 * 1000;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const matchesDueBucket = (dueInput, bucket, now, isDone = false) => {
  if (bucket === 'none') return !dueInput;
  if (!dueInput) return false;
  const due = new Date(dueInput);
  if (Number.isNaN(due.getTime())) return false;
  const dueDay = startOfDay(due).getTime();
  const today = startOfDay(now).getTime();
  switch (bucket) {
    case 'overdue':
      // A completed task is never "overdue", even if its due date has passed.
      return !isDone && dueDay < today;
    case 'today':
      return dueDay === today;
    case 'week':
      // From today through the next 7 days (inclusive), not past.
      return dueDay >= today && dueDay <= today + 7 * MS_IN_DAY;
    case 'month':
      // From today through the next 30 days (inclusive), not past.
      return dueDay >= today && dueDay <= today + 30 * MS_IN_DAY;
    default:
      return false;
  }
};

/* ------------------------------------------------------------------------ */
/* Where a row's due date and owner live                                     */
/* ------------------------------------------------------------------------ */

const NO_FIELDS = Object.freeze({ due: null, owner: null, ledger: null });

/**
 * The columns the due / owner filters read on `board`, or nulls.
 *
 *   due     the column playing the `dueDate` role (billing `due`, pipeline
 *           `closeDate`, …) — `roleColumn` resolves it by role, never by key, so
 *           no trade vocabulary lives here;
 *   owner   the column playing the `assignee` role (`owner`, `writer`, …);
 *   ledger  `ledgerColumns(board)` when the board keeps a ledger — it offers
 *           the Ledger view and has an amount (`isLedgerBoard`) — AND has a due
 *           column, else null. Its presence is what switches the "Overdue"
 *           bucket over to `invoiceState` — see `taskMatchesFilters`. Merely
 *           having a currency column and a due date is not enough: a Pipeline
 *           ("Deal value" + close date) or a blank board with a money column
 *           is not a list of invoices, and reading its rows as drafts, sent
 *           and paid broke its Stuck and Overdue filters.
 *
 * Only a FLEXIBLE board has columns to read. A legacy board gets all nulls, and
 * every reader below then falls back to `task.dueDate` / `task.assignedTo`
 * exactly as this file always did — which is what keeps legacy boards unchanged.
 */
export const filterFieldsOf = (board) => {
  if (!board?.useFlexibleColumns || !Array.isArray(board.columns) || !board.columns.length) {
    return NO_FIELDS;
  }
  const cols = ledgerColumns(board);
  return {
    due: roleColumn(board, 'dueDate'),
    owner: roleColumn(board, 'assignee'),
    ledger: isLedgerBoard(board) && cols.due ? cols : null,
  };
};

/**
 * The due date the filter tests for one row: the due-role cell, else the legacy
 * `task.dueDate`.
 *
 * The fallback covers a row whose cell holds nothing — a flexible board with no
 * due-role column at all, or a row that predates the server's role sync (which
 * copies a legacy date into an empty cell on the row's next save). Falling
 * back on an explicitly CLEARED cell is safe too: clearing the cell clears
 * `task.dueDate` in the same save (Task.js pre-save hook), so there is no stale
 * legacy date left to resurrect.
 */
export const taskDueValue = (task, board, fields = filterFieldsOf(board)) => {
  if (!task) return null;
  if (fields.due) {
    const cell = columnValue(task, fields.due);
    return cell ?? task.dueDate ?? null;
  }
  return task.dueDate ?? null;
};

/**
 * The raw owner entries for one row — bare ids from a person cell, populated
 * users from `task.assignedTo` — before they are reduced to ids. Kept separate
 * from `taskOwnerIds` because the owner OPTIONS want a populated entry's name.
 */
const ownerEntriesOf = (task, fields) => {
  if (!task) return [];
  let raw = fields.owner ? columnValue(task, fields.owner) : undefined;
  // Same `??` rule as the due date. An empty person cell is `[]`, which is NOT
  // nullish: it means "unassigned" and must not fall back to a legacy list.
  if (raw === undefined || raw === null) raw = task.assignedTo;
  if (Array.isArray(raw)) return raw;
  return raw === undefined || raw === null || raw === '' ? [] : [raw];
};

/** A user reference — bare id or populated doc — as an id string, or null. */
const idOf = (entry) => {
  const id = entry && typeof entry === 'object' ? (entry._id ?? entry.id) : entry;
  return id === undefined || id === null || id === '' ? null : String(id);
};

/**
 * The owner ids the filter tests for one row: the assignee-role cell, else the
 * legacy `task.assignedTo`. Always strings.
 */
export const taskOwnerIds = (task, board, fields = filterFieldsOf(board)) =>
  ownerEntriesOf(task, fields).map(idOf).filter(Boolean);

/**
 * The Owner filter's options: everybody who owns at least one of `tasks`,
 * sorted by name.
 *
 * Derived from the rows rather than the org roster, so the list works for every
 * member (org member lists are only fetched for admins) and only offers people
 * who are actually on this board's work.
 *
 * A person CELL stores bare ids, so on a flexible board the names come from
 * `members` — the board roster (`useBoardMembers`). A populated entry (the
 * legacy `assignedTo`) names itself. Someone who has since left the board has
 * no roster entry and reads "Member", which is still better than dropping a
 * filter value that matches real rows.
 */
export const ownerOptionsFor = (tasks, board, members = null) => {
  const fields = filterFieldsOf(board);
  const roster = new Map();
  for (const m of Array.isArray(members) ? members : []) {
    const id = idOf(m);
    if (id) roster.set(id, m);
  }

  const byId = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    for (const entry of ownerEntriesOf(t, fields)) {
      const id = idOf(entry);
      if (!id) continue;
      const populated = entry && typeof entry === 'object' ? entry : null;
      const member = roster.get(id) || null;
      const name = populated?.name || member?.name || '';
      const existing = byId.get(id);
      // First sighting wins, unless it had no name and this one does.
      if (existing && (existing.named || !name)) continue;
      byId.set(id, {
        id,
        name: name || 'Member',
        profilePic: populated?.profilePic || member?.profilePic,
        named: !!name,
      });
    }
  }
  return Array.from(byId.values())
    .map((opt) => ({ id: opt.id, name: opt.name, profilePic: opt.profilePic }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Add `value` to `list` if absent, remove it if present. Returns a new array.
 * Convenience for toggling a checkbox option in a filter category.
 */
export const toggleValue = (list, value) => {
  const arr = Array.isArray(list) ? list : [];
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
};

/**
 * Count how many TASK-level categories are constraining the view — i.e. how
 * many of them can remove rows from inside a group.
 */
export const countActiveTaskFilters = (filters) => {
  if (!filters) return 0;
  let n = 0;
  if (filters.search && filters.search.trim()) n += 1;
  if (filters.statuses?.length) n += 1;
  if (filters.priorities?.length) n += 1;
  if (filters.labels?.length) n += 1;
  if (filters.due?.length) n += 1;
  if (filters.assignees?.length) n += 1;
  return n;
};

/** Count of GROUP-level categories. Today: group owner. */
export const countActiveGroupFilters = (filters) =>
  filters?.groupOwners?.length ? 1 : 0;

/**
 * Count how many filter categories are currently constraining the view.
 * Used to badge the affordance and to toggle the "Clear all" button.
 */
export const countActiveFilters = (filters) =>
  countActiveTaskFilters(filters) + countActiveGroupFilters(filters);

export const hasActiveFilters = (filters) => countActiveFilters(filters) > 0;

/** True when the visible task list is a SUBSET of a group's real task list. */
export const hasActiveTaskFilters = (filters) => countActiveTaskFilters(filters) > 0;

/** True when whole groups are being hidden. */
export const hasActiveGroupFilters = (filters) => countActiveGroupFilters(filters) > 0;

/**
 * The status key a ledger reads as "Overdue" when somebody SETS it — the same
 * key `invoiceState` honours as a hand-set Overdue. A status, not trade
 * vocabulary: every board's status set carries its `stuck` slot, and on an
 * invoice board that slot is named "Overdue".
 */
const OVERDUE_STATUS_KEY = 'stuck';

/**
 * Is one of the selected status values the board's overdue status?
 *
 * A selected value is normally a status `_id`; personal and legacy rows carry
 * the key itself, so a bare key is accepted too — the same two shapes
 * `statusOf` reads.
 */
const selectsOverdueStatus = (selected, board) => {
  const statuses = Array.isArray(board?.statuses) ? board.statuses : [];
  if (statuses.length === 0) return false;
  return selected.some((value) => {
    const id = value == null ? '' : String(value);
    const status =
      statuses.find((s) => s?._id != null && String(s._id) === id) ||
      statuses.find((s) => s?.key === id);
    return status?.key === OVERDUE_STATUS_KEY;
  });
};

/** `now` as epoch millis, whichever shape the caller passed. */
const nowMillis = (now) => (now instanceof Date ? now.getTime() : Number(now));

/**
 * Does a single task satisfy the active filters?
 * `now` defaults to the current time; injectable for deterministic tests.
 */
export const taskMatchesFilters = (task, filters, now = new Date(), board = null) => {
  if (!filters || !task) return true;

  // Only resolved when a category that reads COLUMNS needs it — the common
  // case (search, a plain status pick) never pays for the column lookups.
  let fields = null;
  const fieldsFor = () => {
    if (!fields) fields = filterFieldsOf(board);
    return fields;
  };

  // Name search
  const q = (filters.search || '').trim().toLowerCase();
  if (q && !(task.name || '').toLowerCase().includes(q)) return false;

  // Status — compare as strings to tolerate ObjectId vs legacy enum shapes
  if (filters.statuses?.length) {
    const s = task.status != null ? task.status.toString() : null;
    const stored = !!s && filters.statuses.includes(s);
    /**
     * ON A LEDGER, THE OVERDUE STATUS ALSO MEANS "LATE BY THE DATE".
     *
     * Overdue is never stored on an invoice (see `invoiceState`): a Sent
     * invoice whose due date has passed still carries Sent, and the tile
     * stamps it Overdue by deriving it. Picking the board's Overdue status in
     * the filter matched only the rows somebody had flipped by hand — so the
     * one filter a person reaches for to find late invoices hid almost all of
     * them. A row whose STAMP says overdue now matches too; the stored status
     * still matches on its own, exactly as it always did. Boards that are not
     * a ledger (no Ledger view, amount and due column) keep the plain
     * stored-status rule.
     */
    const derived =
      !stored &&
      selectsOverdueStatus(filters.statuses, board) &&
      !!fieldsFor().ledger &&
      invoiceState(task, board, fieldsFor().ledger, nowMillis(now))?.key === 'overdue';
    if (!stored && !derived) return false;
  }

  // Priority
  if (filters.priorities?.length) {
    if (!task.priority || !filters.priorities.includes(task.priority)) return false;
  }

  // Labels — exclusive, unlike every other category: a task passes only if its
  // label set is exactly the selected set. A task tagged only "Approved" fails
  // an "Approved" + "Meeting Done" filter (it is missing one), and so does a
  // task tagged "Approved" + "Meeting Done" + "Sent" (it carries a spare).
  //
  // The synthetic 'none' value is the one OR-style escape hatch: it matches
  // unlabelled tasks. Selected on its own it shows exactly the tasks with no
  // labels; combined with real labels it ORs in — a task passes if it is
  // unlabelled OR it exactly matches the selected real-label set.
  if (filters.labels?.length) {
    const wantsNone = filters.labels.includes('none');
    const realLabels = filters.labels.filter((id) => id !== 'none');
    const taskLabels = (task.labels || []).map((id) => id.toString());

    const matchesNone = wantsNone && taskLabels.length === 0;

    let matchesReal = false;
    if (realLabels.length && taskLabels.length) {
      const hasEverySelected = realLabels.every((id) => taskLabels.includes(id));
      const carriesNothingElse = taskLabels.every((id) => realLabels.includes(id));
      matchesReal = hasEverySelected && carriesNothingElse;
    }

    if (!matchesNone && !matchesReal) return false;
  }

  // Due date — match ANY selected bucket. Done tasks are excluded from the
  // "Overdue" bucket so completed work drops out of an overdue view.
  if (filters.due?.length) {
    const fields = fieldsFor();
    const done = isStatusDone(board, task.status);
    const due = taskDueValue(task, board, fields);
    const hit = filters.due.some((b) => {
      /**
       * ON A LEDGER, "OVERDUE" IS THE STAMP'S ANSWER, NOT THE CALENDAR'S.
       *
       * The tile's red "12 days late" comes from `invoiceState`, which knows
       * things a bare date does not: a paid invoice is never late, a hand-set
       * Overdue status counts even without a due date, and whatever it decides
       * about drafts. A filter that re-derived "late" from the date alone
       * would list rows the ledger shows as fine — two answers to one
       * question on the same screen. Every other bucket ("due this week") is
       * plain date arithmetic, so it keeps reading the due-role cell.
       */
      if (b === 'overdue' && fields.ledger) {
        return invoiceState(task, board, fields.ledger, nowMillis(now))?.key === 'overdue';
      }
      return matchesDueBucket(due, b, now, done);
    });
    if (!hit) return false;
  }

  // Assignees — match ANY selected member, plus the synthetic "unassigned"
  if (filters.assignees?.length) {
    const ids = taskOwnerIds(task, board, fieldsFor());
    const wantsUnassigned = filters.assignees.includes('unassigned');
    const matchesUnassigned = wantsUnassigned && ids.length === 0;
    const matchesMember = filters.assignees.some(
      (id) => id !== 'unassigned' && ids.includes(id)
    );
    if (!matchesUnassigned && !matchesMember) return false;
  }

  return true;
};

/**
 * Does a group survive the GROUP-level filters?
 *
 * Reads `group.owner` — the already-RESOLVED owner for the month on screen,
 * which groupController serializes onto each group. The `ownerTimeline` never
 * reaches the client precisely so that no second copy of the carry-forward rule
 * can exist here; this function must therefore never try to derive an owner
 * from anything but that field.
 *
 * A group carrying no owner for the month — never assigned, or a tombstone —
 * matches only the synthetic 'unassigned' value, mirroring how the assignee
 * category treats a task with nobody on it.
 */
export const groupMatchesFilters = (group, filters) => {
  if (!filters?.groupOwners?.length) return true;
  if (!group) return false;

  const owner = group.owner;
  const ownerId = owner ? String(owner._id ?? owner) : null;

  if (!ownerId) return filters.groupOwners.includes('unassigned');
  return filters.groupOwners.includes(ownerId);
};

export default taskMatchesFilters;

/**
 * adsBudgetActivity.js — what happened to an ads budget, and who did it.
 *
 * ---- This history is not an audit trail. It is a FEATURE. ------------------
 *
 * The Ads Budget tab shows a "Budget Activity" ledger — money in and money out,
 * dated, attributed. There are two ways to get one. Either people enter ledger
 * lines by hand and the row totals are sums of them, or people edit the row and
 * the ledger is derived from what changed. This codebase does the second, which
 * is why these rows matter more than a normal activity log: if a change is not
 * recorded here, it does not merely go unaudited — it never appears in the
 * ledger the tab exists to show.
 *
 * That is also why the amounts are computed from `oldValue`/`newValue` at READ
 * time rather than stored: a corrected typo should move the ledger, not add a
 * second entry contradicting the first.
 *
 * Rows land in the SAME `ActivityLog` collection as task and goal events, keyed
 * on `adsBudget`. One collection, for the reason `goalActivity.js` states: the
 * board activity export reads a board's whole history by board id, and a second
 * collection would mean a second query, a second merge, and a report that could
 * quietly disagree with itself about what happened that afternoon.
 *
 * FIRE AND FORGET, like `activityService` itself — a broken log never blocks the
 * save that triggered it, and never runs inside it.
 *
 * THE DIFF IS THE POINT. `logRowChanges` compares two snapshots and writes one
 * row per field that actually moved, so an edit form re-sending every field on
 * every save is harmless: a save that changed nothing logs nothing.
 */

const { logActivity } = require('./activityService');

/** No single edit should ever be able to write more rows than this. */
const MAX_ROWS_PER_CHANGE = 20;

/**
 * The comparable image of a budget row.
 *
 * Taken BEFORE the patch is applied and again after the save, so the diff is
 * between two plain objects rather than between a mongoose document and its own
 * mutated self — which would compare a thing to itself and find nothing.
 */
const snapshotRow = (row) => ({
  platform: row.platform || '',
  account: row.account || '',
  name: row.name || '',
  objective: row.objective || '',
  allocated: typeof row.allocated === 'number' ? row.allocated : 0,
  spent: typeof row.spent === 'number' ? row.spent : 0,
  dailyBudget: row.dailyBudget === undefined ? null : row.dailyBudget,
  owner: row.owner ? String(row.owner) : null,
  lifecycle: row.lifecycle || 'active',
  notes: row.notes || '',
});

/** Blank in every shape it arrives in. `0` and `false` are values, not blanks. */
const isBlank = (v) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Two field values, compared the way a person would read them. */
const same = (a, b) => {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
};

/** Blank of any flavour is stored as null, so the log has one shape for it. */
const orNull = (v) => (isBlank(v) ? null : v);

/**
 * The two fields the ledger is made of.
 *
 * Exported because the ledger reader on the client filters on exactly these,
 * and a third money field added here without being added there would be logged
 * and then never shown.
 */
const MONEY_FIELDS = ['allocated', 'spent'];

/**
 * The context every budget row carries, whatever the field.
 *
 * `group` and `monthKey` are not decoration — they are what the LEDGER QUERY
 * filters on. It asks for one client's month, including rows since deleted, so
 * it cannot join through `AdsBudget` to find them; it matches these instead,
 * under the `{ board, createdAt }` index. Drop either and a client's ledger
 * silently returns the whole board's.
 *
 * `platform` and `campaignName` are here so a row still reads after the budget
 * itself is gone — a deleted row has no document left to join to, and the board
 * activity export is where that matters most. `isCampaign` saves the reader
 * guessing from whether `campaignName` happens to be blank.
 */
const baseMetadata = (row) => ({
  monthKey: row.monthKey || null,
  group: row.group ? String(row.group) : null,
  platform: row.platform || '',
  campaignName: row.name || '',
  isCampaign: !!row.parent,
});

/** The actor half, shared by every logger here. */
const actorOf = ({ actor, actorType = 'user', actorLabel = '' }) => ({
  actor,
  actorType,
  actorLabel,
});

/**
 * A new budget row — the commitment, as it was first written down.
 *
 * `newValue` carries the opening allocation on its own key as well as inside
 * the whole-row blob, because this event is the ledger's FIRST LINE for that
 * row ("Budget added, +$8,000") and the reader should not have to know the
 * shape of a creation payload to find the number.
 */
const logRowCreated = ({ row, actor, actorType, actorLabel, groupName }) =>
  logActivity({
    adsBudget: row,
    board: row.board,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'ads_budget.created',
    newValue: {
      platform: row.platform,
      name: row.name,
      objective: row.objective,
      allocated: typeof row.allocated === 'number' ? row.allocated : 0,
      spent: typeof row.spent === 'number' ? row.spent : 0,
      lifecycle: row.lifecycle,
    },
    metadata: { ...baseMetadata(row), groupName: groupName || '' },
  });

const logRowDeleted = ({ row, actor, actorType, actorLabel, groupName }) =>
  logActivity({
    adsBudget: row,
    board: row.board,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'ads_budget.deleted',
    // The money that left the plan with it, so a ledger that shows a month's
    // movements does not quietly omit the largest one.
    oldValue: {
      allocated: typeof row.allocated === 'number' ? row.allocated : 0,
      spent: typeof row.spent === 'number' ? row.spent : 0,
    },
    metadata: { ...baseMetadata(row), groupName: groupName || '' },
  });

/**
 * Every field that actually moved between two snapshots, as log rows.
 *
 * Pure — no writes, no mongoose — so the rules about what counts as a change
 * can be read and tested without a database. `logRowChanges` is the thin shell
 * that persists what this returns.
 *
 * @param {Object} before - snapshotRow(), taken before the patch
 * @param {Object} after  - snapshotRow(), taken after the save
 * @returns {Array<{field: string, oldValue: *, newValue: *, metadata: Object}>}
 */
const diffRow = (before, after) => {
  const rows = [];
  const push = (field, oldValue, newValue, metadata) => {
    rows.push({ field, oldValue: orNull(oldValue), newValue: orNull(newValue), metadata });
  };

  // ---- The money, first, because it is what the ledger is for ---------------
  // `delta` rides in metadata so the ledger does not have to trust that both
  // sides survived as numbers. A null oldValue (the field was blank) reads as
  // zero here, which is the arithmetic a person would do.
  for (const field of MONEY_FIELDS) {
    if (same(before[field], after[field])) continue;
    const from = typeof before[field] === 'number' ? before[field] : 0;
    const to = typeof after[field] === 'number' ? after[field] : 0;
    push(field, before[field], after[field], { delta: to - from });
  }

  // ---- What the row IS ------------------------------------------------------
  if (!same(before.platform, after.platform)) push('platform', before.platform, after.platform);
  if (!same(before.account, after.account)) push('account', before.account, after.account);
  if (!same(before.name, after.name)) push('name', before.name, after.name);
  if (!same(before.objective, after.objective)) push('objective', before.objective, after.objective);

  // ---- How it is being run --------------------------------------------------
  if (!same(before.dailyBudget, after.dailyBudget)) {
    push('dailyBudget', before.dailyBudget, after.dailyBudget);
  }
  if (!same(before.lifecycle, after.lifecycle)) {
    push('lifecycle', before.lifecycle, after.lifecycle);
  }
  if (!same(before.owner, after.owner)) push('owner', before.owner, after.owner);
  // `notes` is logged as `note`, the key tasks and goals already use for the
  // same idea. One key for one concept keeps the board activity export from
  // needing a per-subject translation table.
  if (!same(before.notes, after.notes)) push('note', before.notes, after.notes);

  return rows;
};

/**
 * Persist the diff between two snapshots. One row per field that moved.
 *
 * @param {Object} args
 * @param {Object} args.row     - the saved budget doc (supplies ids and context)
 * @param {Object} args.before  - snapshotRow() from before the patch
 * @param {Object} [args.after] - snapshotRow() from after the save; defaults to `row`
 * @returns {Promise<number>} how many rows were written
 */
const logRowChanges = async ({ row, before, after, actor, actorType, actorLabel, groupName }) => {
  if (!row || !before) return 0;
  const changes = diffRow(before, after || snapshotRow(row)).slice(0, MAX_ROWS_PER_CHANGE);
  if (!changes.length) return 0;

  const context = { ...baseMetadata(row), groupName: groupName || '' };
  await Promise.all(
    changes.map((c) =>
      logActivity({
        adsBudget: row,
        board: row.board,
        ...actorOf({ actor, actorType, actorLabel }),
        type: 'ads_budget.field_changed',
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        metadata: { ...context, ...(c.metadata || {}) },
      })
    )
  );
  return changes.length;
};

module.exports = {
  snapshotRow,
  diffRow,
  logRowCreated,
  logRowDeleted,
  logRowChanges,
  MONEY_FIELDS,
  MAX_ROWS_PER_CHANGE,
};

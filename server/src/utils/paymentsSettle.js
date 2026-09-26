/**
 * paymentsSettle.js — when a row's recorded payments cover what it bills, the
 * row is DONE, whatever its status still says.
 *
 * A board that tracks money received as a list of receipts (a `payments`
 * column) against a figure owed (a currency `number` column) already knows,
 * from its own cells, whether a row is settled. Before this, "Paid" was only a
 * status somebody had to remember to tick — so an invoice whose final payment
 * had been recorded stayed open: the due digest kept chasing it every morning,
 * My Work kept listing it as overdue and the executive tiles kept counting it
 * as outstanding, because every one of those reads the STATUS (see
 * utils/dueDigest.js, `isResolvedStatus`), never the payments cell.
 *
 * So the server settles it: after a write that touches the payments or the
 * amount, a covered row is moved to the board's done status through the same
 * path a person's status change takes (taskController — activity row,
 * `notifyTaskAudience`, the client-portal "resolved" email).
 *
 * GENERIC, deliberately. Nothing here knows what an invoice is, what the board
 * was made from or what anybody called its columns: the rule is two column
 * TYPES and one status KEY. A board that is not a billing board but happens to
 * pair a payments column with a currency amount (a deposits tracker, a
 * purchase-order log) gets the same behaviour, and a billing board whose
 * payments column was deleted simply stops settling. No `templateKey` read, no
 * board-name sniffing — see the memory note "tracker boards stay generic",
 * which applies to every template tenant, not only trackers.
 *
 * The columns are chosen by the SAME rule the client's ledger uses
 * (client/src/utils/ledger.js `ledgerColumns`), so the figure the server
 * settles against is the figure the ledger tile shows:
 *
 *   amount   the `number` column keyed 'amount' whose format is currency, else
 *            the first currency `number` column. A MIRROR is never it: a
 *            mirror's figure belongs to the board it mirrors (the same reason
 *            `isOwnMoneyColumn` exists in utils/money.js), and its type is
 *            'mirror', so the `type === 'number'` test already keeps it out.
 *   payments the first `payments` column.
 *
 * ONE-WAY. This only ever moves a row INTO done. Removing a payment never
 * un-marks it: a status somebody set, or the server set on their behalf, is
 * theirs to take back, and silently reopening a row that a person may have
 * closed for reasons the cells cannot see (written off, settled in kind) would
 * be worse than leaving a mis-recorded payment to be corrected by hand.
 *
 * Pure: no database, no Mongoose. `task.columnValues` may be a Mongoose Map or
 * a plain object (a lean read), and `board` a document or a lean object.
 */

const { isResolvedStatus } = require('./doneStatus');
// money.js requires nothing, so this adds no cycle.
const { normaliseCurrencyCode, boardCurrencyOf } = require('./money');

/** A plain-number column formatted as money. Mirrors ledger.js `isMoneyNumber`. */
const isMoneyNumber = (col) =>
  !!col &&
  col.type === 'number' &&
  !!col.settings &&
  typeof col.settings === 'object' &&
  col.settings.format === 'currency';

/**
 * The two columns settling reads, or nulls when the board lacks either.
 * Same precedence as the client's `ledgerColumns` — keep the two in step.
 */
const settleColumns = (board) => {
  const all = board && Array.isArray(board.columns) ? board.columns.filter(Boolean) : [];
  return {
    amount:
      all.find((c) => c.key === 'amount' && isMoneyNumber(c)) ||
      all.find(isMoneyNumber) ||
      null,
    payments: all.find((c) => c.type === 'payments') || null,
  };
};

/** One cell of a task, from a Mongoose Map or a lean plain object. */
const cellOf = (task, col) => {
  const values = task && task.columnValues;
  if (!values || !col || col._id == null) return undefined;
  const id = String(col._id);
  return typeof values.get === 'function' ? values.get(id) : values[id];
};

/** A finite number from a stored cell, or null. Tolerates a numeric string. */
const numberOf = (value) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * What a payments cell adds up to — 0 for an empty or malformed cell. The
 * server twin of the client's `paymentsTotal` (client/src/utils/payments.js):
 * a receipt whose amount is not a finite number is skipped, not fatal.
 */
const paymentsTotal = (value) =>
  (Array.isArray(value) ? value : []).reduce((sum, p) => {
    if (!p || typeof p !== 'object') return sum;
    const n = numberOf(p.amount);
    return n === null ? sum : sum + n;
  }, 0);

/**
 * In whole cents, so three instalments of 33.37 + 33.37 + 33.36 against 100.10
 * compare equal. Binary floating point adds those to 100.09999999999999, and a
 * row that is paid to the cent must not stay open because of it. Every
 * currency in the catalog (utils/money.js CURRENCY_CODES) has two minor digits.
 */
const toCents = (n) => Math.round(n * 100);

/**
 * The unit a money column's figures are TYPED in: its own code, else the
 * board's — the same fallback PaymentsCell / NumberCell render with. Two
 * columns that name no code on a board that names none both resolve to null
 * and so compare equal, which is the behaviour from before units were read.
 */
const unitOf = (board, col) =>
  normaliseCurrencyCode(col && col.settings && col.settings.currency) || boardCurrencyOf(board);

/** The board's done status — the one keyed 'done' — or null. */
const doneStatusOf = (board) => {
  const statuses = board && Array.isArray(board.statuses) ? board.statuses : [];
  return statuses.find((s) => s && s.key === 'done' && s._id != null) || null;
};

/**
 * Should this row be moved to done because its payments cover its amount?
 *
 * Returns the done status's `_id` when ALL of these hold, else null:
 *   - the board has both an amount column and a payments column;
 *   - both are in the same currency (`unitOf`);
 *   - the amount is a number greater than zero (an unpriced row is never
 *     "covered" — a receipt against nothing is not a settlement);
 *   - the payments total is at least the amount (overpaying settles too);
 *   - the board has a status keyed 'done';
 *   - the task is not already in a done status.
 *
 * It answers about the row AS IT NOW STANDS; the caller decides whether this
 * write is one that should trigger it (see `touchesSettleColumns`).
 */
const settledStatusFor = (board, task) => {
  if (!board || !task) return null;
  const { amount, payments } = settleColumns(board);
  if (!amount || !payments) return null;
  // Receipts in one currency never settle a bill in another: ₹1,000 against a
  // CA$1,000 invoice is not "paid in full", and comparing the raw numbers
  // would close the row and email the client that it was. The Table header
  // can still relabel one column of the pair, so a board may be split; such a
  // row is left for a person to close. No FX lookup — this stays pure.
  if (unitOf(board, amount) !== unitOf(board, payments)) return null;

  const owed = numberOf(cellOf(task, amount));
  if (owed === null || owed <= 0) return null;
  const received = paymentsTotal(cellOf(task, payments));
  if (toCents(received) < toCents(owed)) return null;

  const done = doneStatusOf(board);
  if (!done) return null;
  if (task.status != null && isResolvedStatus(board, task.status)) return null;
  if (task.status != null && String(task.status) === String(done._id)) return null;
  return done._id;
};

/**
 * Did this write move either figure settling reads? `changes` is the list
 * `applyColumnValuePatch` returns (`[{ column }]`). Only such a write may
 * settle a row: a row somebody deliberately moved back out of done keeps that
 * status through every later edit of its due date, owner or title, and only a
 * new payment (or a new amount) re-opens the question.
 */
const touchesSettleColumns = (board, changes) => {
  if (!Array.isArray(changes) || changes.length === 0) return false;
  const { amount, payments } = settleColumns(board);
  if (!amount || !payments) return false;
  const ids = new Set([String(amount._id), String(payments._id)]);
  return changes.some((c) => c && c.column && c.column._id != null && ids.has(String(c.column._id)));
};

module.exports = {
  settledStatusFor,
  touchesSettleColumns,
  settleColumns,
  paymentsTotal,
  doneStatusOf,
};

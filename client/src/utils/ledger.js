import { columnValue } from './columnValues.js';

/**
 * THE LEDGER'S ARITHMETIC — what an invoice board is actually asking.
 *
 * Kept out of the view because all of it is the kind of thing that is wrong by
 * one row and looks completely fine: a total that quietly excludes drafts, an
 * "overdue" that counts something already paid. The view renders; this decides.
 */

/** Board tasks store `status` as an ObjectId into `board.statuses`. */
export const statusOf = (task, board) => {
  const statuses = Array.isArray(board?.statuses) ? board.statuses : [];
  if (statuses.length === 0) return null;
  const raw = task?.status;
  if (raw === null || raw === undefined) return null;
  const id = raw.toString();
  return (
    statuses.find((s) => s._id?.toString() === id) ||
    // Personal tasks — and any legacy board row — carry the key as a string.
    statuses.find((s) => s.key === id) ||
    null
  );
};

/**
 * OVERDUE IS NEVER STORED.
 *
 * A billing board has an Overdue status, and the obvious implementation is a
 * nightly job that flips rows into it. That job is wrong twice a day: the row
 * is stale from the moment the due date passes until the job next runs, and it
 * stays wrong forever if the job dies. Worse, it fights the person — mark
 * something Sent again and the job stamps it back.
 *
 * So overdue is DERIVED at render: a due date in the past and not yet paid.
 * It cannot go stale, it needs no scheduler, and correcting it is just paying
 * the invoice. The stored Overdue status is still honoured when somebody sets
 * it by hand.
 */
export const invoiceState = (task, board, cols, now = Date.now()) => {
  const status = statusOf(task, board);
  const key = status?.key || null;

  if (key === 'done') {
    return { key: 'paid', label: status?.name || 'Paid', daysLate: 0 };
  }

  const due = cols?.due ? columnValue(task, cols.due) : null;
  const dueMs = due ? new Date(due).getTime() : NaN;
  if (!Number.isNaN(dueMs) && dueMs < now) {
    const daysLate = Math.floor((now - dueMs) / 86400000);
    return { key: 'overdue', label: 'Overdue', daysLate };
  }

  if (key === 'stuck') return { key: 'overdue', label: status?.name || 'Overdue', daysLate: 0 };
  if (key === 'working_on_it') return { key: 'sent', label: status?.name || 'Sent', daysLate: 0 };
  return { key: 'draft', label: status?.name || 'Draft', daysLate: 0 };
};

/** A number out of a currency cell, or 0. Strings included — a typed cell. */
const amountOf = (task, cols) => {
  const raw = cols?.amount ? columnValue(task, cols.amount) : null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && !Number.isNaN(n) ? n : 0;
};

/**
 * The day an invoice's exchange rate is read from — when it was ISSUED.
 *
 * `issued`, deliberately, not `due`. They are different facts: an invoice
 * raised on 2 March and payable on 1 April is a March invoice, and valuing it
 * at April's rate would make it worth something it never was. Same reasoning
 * that makes `ledgerColumns` find `due` by key rather than by role.
 *
 * Null when the board has no issued column or the cell is empty, which means
 * the figure converts at the latest rate we hold. Honest, and the same answer a
 * board with no dates at all gets.
 */
export const issuedDayOf = (task, cols) => {
  const raw = cols?.issued ? columnValue(task, cols.issued) : null;
  if (!raw) return null;
  const str = String(raw);
  return /^\d{4}-\d{2}-\d{2}/.test(str) ? str.slice(0, 10) : null;
};

/**
 * The four figures above the ledger.
 *
 * `billed` counts EVERY row including drafts, because it answers "what is on
 * this board". `outstanding` is billed minus paid, so the three always
 * reconcile — computing outstanding independently is how two numbers on the
 * same strip come to disagree. `overdue` is a subset of outstanding, not a
 * fourth slice of it.
 */
export const ledgerTotals = (tasks, board, cols, opts = {}) => {
  // Back-compatible: this used to take `now` as a fourth positional argument.
  const { now = Date.now(), convert = null } =
    typeof opts === 'number' ? { now: opts } : opts || {};

  const out = { billed: 0, paid: 0, outstanding: 0, overdue: 0, overdueCount: 0, count: 0 };
  for (const task of tasks || []) {
    const raw = amountOf(task, cols);
    /**
     * CONVERT EACH ROW, THEN ADD — never add then convert.
     *
     * Every invoice values at the rate in force on ITS OWN issue date, so two
     * rows in one group can carry different rates. Summing first and converting
     * the total at one rate would make this strip disagree with the tiles above
     * it, which is precisely the failure the comment on this function is about.
     *
     * `convert` returning null (no rate for that day) falls back to the raw
     * figure, so a ledger with rates for some months and not others still adds
     * up — in the source currency, which is what the surface then says.
     */
    const amount = convert ? (convert(raw, task) ?? raw) : raw;
    const state = invoiceState(task, board, cols, now);
    out.count += 1;
    out.billed += amount;
    if (state.key === 'paid') out.paid += amount;
    if (state.key === 'overdue') {
      out.overdue += amount;
      out.overdueCount += 1;
    }
  }
  // Derived from the CONVERTED sums, at full precision, so the three still
  // reconcile. Converting a separately-computed `outstanding` would round it
  // independently of the two it is made from: 1,044 - 627 != 418.
  out.outstanding = out.billed - out.paid;
  return out;
};

/**
 * A filename turned into a row title.
 *
 * Deliberately dumb and predictable — no OCR, nothing read from inside the
 * document. `INV-2026-012_Kredoo_final.pdf` becomes `INV-2026-012 Kredoo
 * final`, which you can guess before you drop the file. If it is wrong you fix
 * one cell, and you were going to check the invoice number anyway.
 */
export const titleFromFilename = (filename) => {
  const base = String(filename || '')
    // Strip the LAST extension only: "INV.2026.011.pdf" keeps its dots.
    .replace(/\.[^./\\]+$/, '')
    // Path separators, in case a browser ever hands over a full path.
    .replace(/^.*[\\/]/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base || 'Untitled';
};

/** Which columns the ledger reads, found by role and by the template's keys. */
export const ledgerColumns = (board) => {
  const all = Array.isArray(board?.columns) ? board.columns : [];
  return {
    primary: all.find((c) => c.isPrimary) || null,
    // By role, so a board whose owner renamed or reordered columns still works.
    amount: all.find((c) => c.settings?.format === 'currency') || null,
    file: all.find((c) => c.type === 'file') || null,
    client: all.find((c) => c.type === 'connect_boards') || null,
    // By KEY, because billing has two date columns and only one of them is the
    // one an invoice is late against. Role alone cannot tell `issued` from
    // `due`, and picking the first date column would make every invoice overdue
    // the day after it was raised.
    due: all.find((c) => c.key === 'due' && c.type === 'date') || null,
    // By KEY for the same reason as `due`, and it matters more here: `issued`
    // is what dates the exchange rate, and picking the wrong date column would
    // value every invoice at the wrong month's rate.
    issued: all.find((c) => c.key === 'issued' && c.type === 'date') || null,
  };
};

/** Has anybody actually been told about this row? */
export const notified = (task) => {
  const people = Array.isArray(task?.notifiedUsers) ? task.notifiedUsers : [];
  return { people, at: task?.notifiedAt || null, told: people.length > 0 };
};

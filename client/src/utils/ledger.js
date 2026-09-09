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
 * The four figures above the ledger.
 *
 * `billed` counts EVERY row including drafts, because it answers "what is on
 * this board". `outstanding` is billed minus paid, so the three always
 * reconcile — computing outstanding independently is how two numbers on the
 * same strip come to disagree. `overdue` is a subset of outstanding, not a
 * fourth slice of it.
 */
export const ledgerTotals = (tasks, board, cols, now = Date.now()) => {
  const out = { billed: 0, paid: 0, outstanding: 0, overdue: 0, overdueCount: 0, count: 0 };
  for (const task of tasks || []) {
    const amount = amountOf(task, cols);
    const state = invoiceState(task, board, cols, now);
    out.count += 1;
    out.billed += amount;
    if (state.key === 'paid') out.paid += amount;
    if (state.key === 'overdue') {
      out.overdue += amount;
      out.overdueCount += 1;
    }
  }
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
  };
};

/** Has anybody actually been told about this row? */
export const notified = (task) => {
  const people = Array.isArray(task?.notifiedUsers) ? task.notifiedUsers : [];
  return { people, at: task?.notifiedAt || null, told: people.length > 0 };
};

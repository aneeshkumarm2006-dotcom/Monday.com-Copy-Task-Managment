import { columnValue } from './columnValues.js';
import { paymentsTotal } from './payments.js';
import { roleColumn } from './columnRoles.js';
import { toDayKey } from './money.js';
import { isStatusDone } from './statusUtils.js';

/**
 * THE LEDGER'S ARITHMETIC — what an invoice board is actually asking.
 *
 * Kept out of the view because all of it is the kind of thing that is wrong by
 * one row and looks completely fine: a total that quietly excludes drafts, an
 * "overdue" that counts something already paid. The view renders; this decides.
 *
 * The three questions every figure here answers, per invoice and in total:
 *
 *   billed       what we have asked clients for (sent invoices, never drafts)
 *   received     what has actually come in against that
 *   outstanding  the difference — derived, never computed on its own
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

/** The board's own name for the status carrying `key`, or null. */
const statusNameFor = (board, key) => {
  const statuses = Array.isArray(board?.statuses) ? board.statuses : [];
  return statuses.find((s) => s.key === key)?.name || null;
};

/** A number out of a currency cell, or 0. Strings included — a typed cell. */
export const amountOf = (task, cols) => {
  const raw = cols?.amount ? columnValue(task, cols.amount) : null;
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** What the payments cell adds up to, or 0 on a board with no payments column. */
const recordedOf = (task, cols) =>
  cols?.payments ? paymentsTotal(columnValue(task, cols.payments)) : 0;

/**
 * Whole calendar days from `fromKey` to `toKey` (both 'YYYY-MM-DD').
 *
 * Done on the bare dates in UTC, so no daylight-saving change can make a day
 * 23 or 25 hours long; `Math.round` is belt and braces on top of that. The
 * keys themselves are LOCAL days (see `toDayKey`), which is what makes "due
 * today" mean the reader's today.
 */
const daysBetween = (fromKey, toKey) => {
  const parse = (k) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || '');
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  const a = parse(fromKey);
  const b = parse(toKey);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
};

/** The due cell as a LOCAL day key, or null. */
export const dueDayOf = (task, cols) => {
  const raw = cols?.due ? columnValue(task, cols.due) : null;
  return raw ? toDayKey(raw) : null;
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
 *
 * ---- Three rules the first version got wrong --------------------------------
 *
 * 1. DAYS, NOT INSTANTS. A date cell stores the local midnight of the day
 *    somebody picked, so comparing instants made an invoice "overdue" for the
 *    whole of its own due date. Both sides are local calendar days now: due
 *    today is not late, due yesterday is one day late.
 *
 * 2. A DRAFT IS NEVER OVERDUE. Nobody has been sent it, so nobody is late
 *    paying it. It reports `pastDue: true` instead, which the tile words as
 *    "not sent, due date passed" — a prompt to send it, not a debt to chase —
 *    and it stays out of the Overdue and Outstanding figures.
 *
 * 3. PAID IS MONEY, NOT ONLY A STATUS. `received` is what the payments cell
 *    adds up to. An invoice is paid when that covers the amount, OR when
 *    somebody marked it Paid — a "marked paid" invoice with no receipts
 *    recorded counts as fully received, because that is what the person said
 *    and a board that pre-dates payment tracking has no receipts at all.
 *    Between nothing and everything is `partial`, until the due date passes,
 *    when it is `overdue` with `received > 0`.
 *
 * Returns
 *   { key: 'draft'|'sent'|'partial'|'paid'|'overdue', label,
 *     daysLate, daysUntilDue, pastDue,
 *     amount, received, balance, overpaid, recorded, markedPaid }
 *
 * `received` is what the invoice counts as having received (capped at nothing —
 * `overpaid` carries any excess); `recorded` is the raw payments total, so the
 * sheet can tell "marked paid" apart from "paid by receipts".
 */
export const invoiceState = (task, board, cols, now = Date.now()) => {
  const status = statusOf(task, board);
  const key = status?.key || null;

  const amount = amountOf(task, cols);
  const recorded = recordedOf(task, cols);
  const markedPaid = key === 'done' || (task?.status != null && isStatusDone(board, task.status));
  const received = markedPaid ? Math.max(recorded, amount) : recorded;
  const balance = Math.max(0, amount - received);
  const overpaid = amount > 0 ? Math.max(0, recorded - amount) : 0;

  const todayKey = toDayKey(new Date(now));
  const dueKey = dueDayOf(task, cols);
  const daysUntilDue = dueKey && todayKey ? daysBetween(todayKey, dueKey) : null;

  const base = { amount, received, balance, overpaid, recorded, markedPaid };

  const paid = markedPaid || (amount > 0 && recorded >= amount);
  if (paid) {
    return {
      ...base,
      key: 'paid',
      label: (key === 'done' && status?.name) || statusNameFor(board, 'done') || 'Paid',
      daysLate: 0,
      daysUntilDue,
      pastDue: false,
    };
  }

  const pastDue = daysUntilDue !== null && daysUntilDue < 0;
  const daysLate = pastDue ? -daysUntilDue : 0;

  // Money has come in, so it was obviously sent, whatever the status still
  // says. A row with no status at all is treated as the draft it was created
  // as; a CUSTOM status (key null) is somewhere past Draft by definition.
  const isDraft = recorded === 0 && (key === 'not_started' || (key === null && !status));
  if (isDraft) {
    return {
      ...base,
      key: 'draft',
      label: status?.name || statusNameFor(board, 'not_started') || 'Draft',
      daysLate: 0,
      daysUntilDue,
      pastDue,
    };
  }

  if (pastDue || key === 'stuck') {
    return {
      ...base,
      key: 'overdue',
      label: (key === 'stuck' && status?.name) || statusNameFor(board, 'stuck') || 'Overdue',
      daysLate,
      daysUntilDue,
      pastDue,
    };
  }

  if (received > 0 && received < amount) {
    return { ...base, key: 'partial', label: 'Part-paid', daysLate: 0, daysUntilDue, pastDue };
  }

  return {
    ...base,
    key: 'sent',
    label: status?.name || statusNameFor(board, 'working_on_it') || 'Sent',
    daysLate: 0,
    daysUntilDue,
    pastDue,
  };
};

/**
 * The short line a tile or the sheet shows beside the stamp, or null.
 *
 * One wording for both surfaces, so the tile and the sheet cannot describe the
 * same invoice two ways.
 */
export const statePill = (state) => {
  if (!state) return null;
  if (state.key === 'paid') return null;
  if (state.key === 'draft') return state.pastDue ? 'Not sent · due date passed' : null;
  if (state.key === 'overdue') {
    if (state.daysLate > 0) return `${state.daysLate} ${state.daysLate === 1 ? 'day' : 'days'} late`;
    return state.label;
  }
  const d = state.daysUntilDue;
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  if (typeof d === 'number' && d > 1) return `Due in ${d} days`;
  return state.key === 'partial' ? 'Part-paid' : null;
};

/**
 * The day an invoice's exchange rate is read from — when it was ISSUED.
 *
 * `issued`, deliberately, not `due`. They are different facts: an invoice
 * raised on 2 March and payable on 1 April is a March invoice, and valuing it
 * at April's rate would make it worth something it never was.
 *
 * Read as the LOCAL day (`toDayKey`), never by slicing the stored string: a
 * date cell holds local midnight as UTC, so in India an invoice issued on
 * 1 March is stored as "…-02-28T18:30Z", and slicing dated it in February —
 * the wrong month's rate, or no rate at all.
 *
 * Null when the board has no issued column or the cell is empty, which means
 * the figure converts at the latest rate we hold. Honest, and the same answer a
 * board with no dates at all gets.
 */
export const issuedDayOf = (task, cols) => {
  const raw = cols?.issued ? columnValue(task, cols.issued) : null;
  if (!raw) return null;
  return toDayKey(raw);
};

/**
 * The figures above the ledger.
 *
 *   billed       every NON-DRAFT amount. A draft has not been sent, so nobody
 *                owes it yet; it is reported on its own as `drafts`.
 *   received     what came in against those, each row capped at its own
 *                amount (an overpayment is reported as `overpaid`, not as
 *                income against some other invoice).
 *   outstanding  billed − received, EXACTLY. Derived, never summed on its own,
 *                so the strip can never disagree with itself.
 *   overdue      the BALANCES of overdue rows — a subset of outstanding, and
 *                a part-paid invoice only counts what is still owed.
 *   noAmount     `{ count, received }` — non-draft rows with no amount typed
 *                yet, and what has been recorded against them (see below).
 *
 * ---- Money in against an invoice with no amount -------------------------------
 *
 * A dropped PDF is a row with no amount, and somebody can record the client's
 * transfer before anybody types what the invoice was for. Capping that receipt
 * at the amount (zero) made it vanish from the strip while the sheet said
 * "Received ₹500" — the strip and the sheet disagreeing about real money.
 *
 * Counting it as received ALONE would break the one identity the strip rests
 * on: outstanding would go negative. So an invoice with NO amount is billed at
 * what has come in against it — the least it can have been for — which counts
 * the money in both figures and leaves outstanding exactly where it was. It is
 * a floor, not a guess at the real amount, and `noAmount` says how many rows
 * the strip is flooring so the view can ask for the missing amounts. Only an
 * amount of exactly zero means "not typed"; a negative amount (a credit note)
 * is a real figure and is left alone.
 *
 * `paid` is kept as an alias of `received` for callers written before
 * payments existed.
 */
export const ledgerTotals = (tasks, board, cols, opts = {}) => {
  // Back-compatible: this used to take `now` as a fourth positional argument.
  const { now = Date.now(), convert = null } =
    typeof opts === 'number' ? { now: opts } : opts || {};

  const out = {
    billed: 0,
    received: 0,
    paid: 0,
    outstanding: 0,
    overdue: 0,
    overdueCount: 0,
    partialCount: 0,
    drafts: { count: 0, amount: 0 },
    noAmount: { count: 0, received: 0 },
    count: 0,
    overpaid: 0,
  };
  for (const task of tasks || []) {
    /**
     * CONVERT EACH ROW, THEN ADD — never add then convert.
     *
     * Every invoice values at the rate in force on ITS OWN issue date, so two
     * rows in one group can carry different rates. Summing first and converting
     * the total at one rate would make this strip disagree with the tiles above
     * it. The amount AND the receipts go through the same row's rate, which is
     * what keeps `outstanding` reconciling after conversion.
     *
     * `convert` returning null (no rate for that day) falls back to the raw
     * figure. The view only passes a converter when EVERY row can convert, so
     * that fallback never mixes units in practice.
     */
    const conv = (n) => (convert ? (convert(n, task) ?? n) : n);
    const state = invoiceState(task, board, cols, now);
    out.count += 1;

    if (state.key === 'draft') {
      out.drafts.count += 1;
      out.drafts.amount += conv(state.amount);
      continue;
    }

    // No amount typed: billed at what has come in (see the header), so the
    // receipt reaches Received without pushing Outstanding below zero.
    const unpriced = state.amount === 0;
    const billedAt = unpriced ? state.received : state.amount;
    if (unpriced) {
      out.noAmount.count += 1;
      out.noAmount.received += conv(state.received);
    }

    out.billed += conv(billedAt);
    out.received += conv(Math.min(state.received, billedAt));
    out.overpaid += conv(state.overpaid);
    if (state.key === 'overdue') {
      out.overdue += conv(state.balance);
      out.overdueCount += 1;
    }
    if (state.key === 'partial') out.partialCount += 1;
  }
  // Derived from the CONVERTED sums, at full precision, so the figures still
  // reconcile. Converting a separately-computed `outstanding` would round it
  // independently of the two it is made from: 1,044 - 627 != 418.
  out.outstanding = out.billed - out.received;
  out.paid = out.received;
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

/**
 * The number the NEXT invoice should carry, guessed from the ones on the board.
 *
 * "INV-2026-012" → "INV-2026-013": the prefix and the zero padding are kept, so
 * the new row sorts and reads like its neighbours. A name whose number is not
 * at the very end ("INV-2026-012 Kredoo", a dropped file's title) is read by
 * its FIRST word, which is where an invoice number sits in a filename.
 *
 * Which series? The one the most RECENTLY created invoice belongs to, and the
 * largest number within it. Most-recent rather than most-common is what gets
 * the new year right: after somebody types "INV-2027-001" by hand, the next
 * guess is "INV-2027-002", not "INV-2026-045" because 2026 has more rows.
 * `createdAt` decides "recent" where rows carry it; otherwise array order,
 * which is the board's own order (new rows are appended).
 *
 * A guess, and said to be one: the title is editable at the top of the sheet
 * the moment the row opens. "INV-001" when nothing on the board has a number.
 */
export const nextInvoiceNumber = (tasks) => {
  const candidates = [];
  (Array.isArray(tasks) ? tasks : []).forEach((t, index) => {
    const name = String(t?.name || '').trim();
    if (!name) return;
    const read = (s) => /^(.*?)(\d+)$/.exec(s);
    const m = read(name) || read(name.split(/\s+/)[0] || '');
    if (!m) return;
    const at = t?.createdAt ? new Date(t.createdAt).getTime() : NaN;
    candidates.push({
      prefix: m[1],
      digits: m[2],
      num: Number(m[2]),
      at: Number.isNaN(at) ? null : at,
      index,
    });
  });
  if (candidates.length === 0) return 'INV-001';

  const newest = candidates.reduce((best, c) => {
    if (!best) return c;
    if (c.at !== null && best.at !== null && c.at !== best.at) return c.at > best.at ? c : best;
    if (c.at !== null && best.at === null) return c;
    if (c.at === null && best.at !== null) return best;
    return c.index > best.index ? c : best;
  }, null);

  const series = candidates.filter((c) => c.prefix === newest.prefix);
  const top = series.reduce((best, c) => (c.num > best.num ? c : best), series[0]);
  const next = String(top.num + 1).padStart(top.digits.length, '0');
  return `${top.prefix}${next}`;
};

/** The sort orders the ledger offers, in the order its menu lists them. */
export const INVOICE_SORTS = [
  { value: 'board', label: 'Board order' },
  { value: 'due', label: 'Due date' },
  { value: 'issued', label: 'Newest issued' },
  { value: 'balance', label: 'Largest balance' },
  { value: 'overdue', label: 'Most overdue' },
];

/**
 * The invoices in `mode` order. Never mutates `tasks`, and always STABLE —
 * two invoices that tie keep the board's order, so the grid does not shuffle
 * itself when an unrelated row changes.
 *
 *   board    as given
 *   due      soonest due first, no due date last
 *   issued   newest issued first, no issue date last
 *   balance  largest balance first (unconverted: one board, one currency)
 *   overdue  overdue first, most days late first; then soonest due; no due last
 */
export const sortInvoices = (tasks, mode, board, cols, now = Date.now()) => {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  if (!mode || mode === 'board') return list;

  const rows = list.map((task, index) => ({
    task,
    index,
    state: invoiceState(task, board, cols, now),
    due: dueDayOf(task, cols),
    issued: issuedDayOf(task, cols),
  }));

  // Missing keys sort last in either direction.
  const byKey = (a, b, dir) => {
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -dir : dir;
  };

  const compare = {
    due: (a, b) => byKey(a.due, b.due, 1),
    issued: (a, b) => byKey(a.issued, b.issued, -1),
    balance: (a, b) => b.state.balance - a.state.balance,
    overdue: (a, b) => {
      const ao = a.state.key === 'overdue';
      const bo = b.state.key === 'overdue';
      if (ao !== bo) return ao ? -1 : 1;
      if (ao && bo && a.state.daysLate !== b.state.daysLate) {
        return b.state.daysLate - a.state.daysLate;
      }
      return byKey(a.due, b.due, 1);
    },
  }[mode];
  if (!compare) return list;

  rows.sort((a, b) => compare(a, b) || a.index - b.index);
  return rows.map((r) => r.task);
};

/**
 * Which columns the ledger reads.
 *
 *   amount    the column keyed `amount`, else the first NUMBER column in
 *             currency format. Never a payments or formula column — those are
 *             money too, and picking one would make Billed the sum of what
 *             was received, or of a formula over it.
 *   payments  the first payments column: the receipts against each invoice.
 *   due       whichever date column plays the due-date ROLE (see
 *             `columnRoles.js`), else the one keyed `due`. Never "the first
 *             date column": billing has two, and picking `issued` would make
 *             every invoice overdue the day after it was raised.
 *   owner     the column playing the assignee role.
 *   issued    by KEY, because it dates the exchange rate and no role says
 *             "issued".
 *   client    the first `client` column — a pick of one of the workspace's
 *             client boards, or a typed name (see `clientOf`) — else, on a
 *             board made before that type existed, the first `connect_boards`
 *             column. By TYPE, never by key or name: who an invoice is for is
 *             what a client column means, whatever the board calls it.
 */
export const ledgerColumns = (board) => {
  const all = Array.isArray(board?.columns) ? board.columns.filter(Boolean) : [];
  const isMoneyNumber = (c) => c.type === 'number' && c.settings?.format === 'currency';
  const dateByKey = (key) => all.find((c) => c.key === key && c.type === 'date') || null;
  return {
    primary: all.find((c) => c.isPrimary) || null,
    amount:
      all.find((c) => c.key === 'amount' && isMoneyNumber(c)) ||
      all.find(isMoneyNumber) ||
      null,
    payments: all.find((c) => c.type === 'payments') || null,
    file: all.find((c) => c.type === 'file') || null,
    client:
      all.find((c) => c.type === 'client') ||
      all.find((c) => c.type === 'connect_boards') ||
      null,
    due: roleColumn(board, 'dueDate') || dateByKey('due'),
    owner: roleColumn(board, 'assignee'),
    issued: dateByKey('issued'),
  };
};

/**
 * Who an invoice is for, as `{ boardId, name }`, or null.
 *
 * Reads a `client`-type cell, whose value is `{ boardId, name }`:
 *
 *   boardId  the workspace CLIENT board it points at (a client board IS one
 *            client), or null for a name typed by hand because that client has
 *            no portal board;
 *   name     a snapshot of the client's display name, which the server rewrites
 *            from the board on every write — so a reader who cannot open that
 *            board still sees who the invoice is for.
 *
 * Tolerant of what a cell may hold on the way to that shape: an id that is an
 * object (`{ _id }`) or not a string, surrounding whitespace, and a bare string
 * (read as a typed name). Null when there is no client column, when it is a
 * legacy `connect_boards` column (its value is a list of linked ROWS, not a
 * client — the view renders that cell itself), or when both halves are empty —
 * so a filter or an export can treat null as "no client" and nothing else.
 */
export const clientOf = (task, cols) => {
  const col = cols?.client;
  if (!col || col.type !== 'client') return null;
  const raw = columnValue(task, col);
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { boardId: null, name } : null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;

  const rawId = raw.boardId && typeof raw.boardId === 'object' ? raw.boardId._id : raw.boardId;
  const boardId =
    rawId === null || rawId === undefined || String(rawId).trim() === '' ? null : String(rawId).trim();
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!boardId && !name) return null;
  return { boardId, name };
};

/** Has anybody actually been told about this row? */
export const notified = (task) => {
  const people = Array.isArray(task?.notifiedUsers) ? task.notifiedUsers : [];
  return { people, at: task?.notifiedAt || null, told: people.length > 0 };
};

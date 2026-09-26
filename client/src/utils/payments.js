/**
 * A PAYMENTS CELL — the money that has come in against one row.
 *
 * The value is a LIST of receipts, not a running total:
 *
 *   [{ id, amount, date: 'YYYY-MM-DD', method, note, by, at }]
 *
 * A single "Paid" number cannot say when it was paid or in how many parts, and
 * an invoice settled in three instalments is the normal case, not the edge.
 * Keeping each receipt means the total is DERIVED (so it can never drift from
 * the receipts it claims to sum), a mistaken entry can be removed on its own,
 * and the activity log can say "recorded a payment of CA$500" rather than
 * "Paid changed from 1,000 to 1,500".
 *
 * Wherever the column is treated as a number — summaries, formulas, mirrors,
 * sorting — its value is `paymentsTotal`. The server normalises what it
 * stores (ids, trimmed strings, date order, a 500-entry cap), so these
 * helpers only read defensively; they do not re-validate.
 */

/**
 * Every receipt in a cell, as an array — never null.
 *
 * Tolerates what a cell can actually hold before the server has normalised it:
 * nothing at all, a stray non-array, or holes left by a half-applied edit.
 */
export const paymentsOf = (value) =>
  Array.isArray(value) ? value.filter((p) => p && typeof p === 'object') : [];

/**
 * What the receipts add up to. 0 for an empty cell.
 *
 * Zero rather than null on purpose: "Outstanding = Amount − Paid" must read the
 * full amount on an invoice nobody has paid yet, and a null here would make
 * that formula blank until the first payment arrived.
 */
export const paymentsTotal = (value) =>
  paymentsOf(value).reduce((sum, p) => {
    const n = typeof p.amount === 'string' ? Number(p.amount) : p.amount;
    return typeof n === 'number' && Number.isFinite(n) ? sum + n : sum;
  }, 0);

/**
 * A new receipt's id: 12 hex characters, the same shape the server mints.
 *
 * Client-side so an entry can be keyed, edited or removed before the round trip
 * returns; the server keeps an id it is given. `crypto.getRandomValues` where
 * the browser has it (all of them), `Math.random` only so a test runner
 * without Web Crypto can still build one.
 */
const newPaymentId = () => {
  const bytes = new Uint8Array(6);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * One receipt, ready to append to a cell's list — already in the shape the
 * server stores (method ≤ 40 characters, note ≤ 200), so the row the person
 * sees before the save lands is the row they see after it.
 */
export const makePayment = ({ amount, date, method = '', note = '', by = null }) => ({
  id: newPaymentId(),
  amount: typeof amount === 'string' ? Number(amount) : amount,
  date,
  method: typeof method === 'string' ? method.trim().slice(0, 40) : '',
  note: typeof note === 'string' ? note.trim().slice(0, 200) : '',
  by: by || null,
  at: new Date().toISOString(),
});

/**
 * Today as the reader's LOCAL calendar day.
 *
 * Never `toISOString().slice(0, 10)`: in India that is yesterday until 05:30,
 * and a payment recorded first thing in the morning would be dated the day
 * before it arrived.
 */
export const todayKey = (now = new Date()) => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/**
 * `dayKey` moved `n` calendar days, or null for a key that is not a date.
 *
 * Done in UTC on a bare date so no daylight-saving change can land the result
 * on the wrong day; the input and output carry no zone, so neither should the
 * arithmetic in between.
 */
export const addDaysKey = (dayKey, n) => {
  const match = typeof dayKey === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey) : null;
  if (!match) return null;
  const step = Number(n) || 0;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + step));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};

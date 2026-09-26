/**
 * READING A FLEXIBLE COLUMN'S VALUE OFF A TASK.
 *
 * One line of code, in one place, because getting it wrong is silent and the
 * wrong version shipped.
 *
 * ---- TWO TRAPS, AND BOTH HAVE BITTEN --------------------------------------
 *
 * 1. THE KEY IS THE COLUMN'S `_id`, NOT ITS `key`.
 *
 *    `applyColumnValues` on the server builds `columnsById` from
 *    `board.columns.map(c => [c._id.toString(), c])` and writes
 *    `task.columnValues.set(cid, …)`. So the map is keyed by the column's
 *    ObjectId. A column's `key` ('amount', 'value') is its STABLE NAME across
 *    boards seeded from the same template — useful for finding the column, and
 *    never a key into this map.
 *
 *    `columnSummary.js` read `columnValues[column.key]` and therefore found
 *    `undefined` on every row of every board. Sums came out as 0, `filled` as
 *    0, `empty` as "all of them" — so a Billing board with six invoices on it
 *    totalled ₹0 in the group header and the table footer, and looked like a
 *    board whose numbers had not been typed in yet.
 *
 * 2. IT IS A `Map` SOMETIMES AND A PLAIN OBJECT THE REST OF THE TIME.
 *
 *    `Task.columnValues` is `{ type: Map }`. A `.lean()` read hands the client
 *    a plain object; a hydrated document hands back a real Map, on which
 *    `obj[key]` is always `undefined`. `DataGrid` already handled both — this
 *    is that check, lifted out so there is one copy rather than one per reader.
 *
 * A formula column has NO stored value at all, and a payments column stores a
 * list of receipts rather than a number. `columnValue` returns what is STORED —
 * `undefined` for a formula — which is correct for a raw read. Anything that
 * wants the column AS A NUMBER (a sum, a formula input, a sort) asks
 * `numericValue` instead, which knows how each type becomes one.
 */

import { evaluateFormula, formulaReferences } from './formula.js';
import { paymentsTotal } from './payments.js';

/**
 * One task's value for one column, or `undefined`.
 *
 * @param {Object|null} task     a task, lean or hydrated
 * @param {Object|string} column the column, or its `_id`
 * @returns {*} the stored value, or undefined when unset
 */
export const columnValue = (task, column) => {
  const values = task?.columnValues;
  if (!values || !column) return undefined;
  // Accept the column itself or a bare id, so callers holding one or the other
  // do not each invent their own way of narrowing it.
  const id = (typeof column === 'object' ? column._id : column);
  if (id === null || id === undefined) return undefined;
  const cid = id.toString();
  return typeof values.get === 'function' ? values.get(cid) : values[cid];
};

/**
 * Every row's value for one column, in row order.
 *
 * Includes the empty ones: whether a blank cell counts as zero, as nothing, or
 * as the whole point is the caller's decision — an "empty receipts" count needs
 * the blanks that a sum must throw away.
 *
 * @param {Object[]} rows
 * @param {Object} column
 * @returns {Array}
 */
export const columnValuesOf = (rows, column) =>
  (Array.isArray(rows) ? rows : []).map((r) => columnValue(r, column));

/** A stored number (or numeric string) as a number, or null when empty. */
const toNumber = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * A mirror's cached value arrives in one of two shapes: bare (after the task
 * list's `embedMirrorValues`) or still in its cache wrapper. Same unwrap as
 * `MirrorCell`'s.
 */
const unwrapMirror = (raw) =>
  raw && typeof raw === 'object' && raw.__mirror === true ? raw.value : raw;

/**
 * The shared walk behind `numericValue` and `formulaValue`.
 *
 * `seen` holds the formula columns already on the stack. A formula may read
 * another formula ("Margin = column.remaining / column.allocated"), and the
 * server only refuses a column that references ITSELF — so A → B → A can still
 * be saved, and without this guard it would recurse until the stack blew and
 * took the whole grid down with it. A cycle computes as null, like any other
 * formula with a missing input.
 */
const numericOf = (task, column, columns, seen) => {
  if (!column) return null;
  switch (column.type) {
    case 'number':
    case 'rating':
      return toNumber(columnValue(task, column));
    case 'formula':
      return formulaOf(task, column, columns, seen);
    case 'payments':
      return paymentsTotal(columnValue(task, column));
    case 'mirror': {
      // Numeric only. A mirror of a text column ("first" client name) is not
      // a number, and a numeric-LOOKING string from one is still text.
      const v = unwrapMirror(columnValue(task, column));
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
    default:
      return null;
  }
};

const formulaOf = (task, column, columns, seen) => {
  const expression = column?.settings?.expression;
  if (typeof expression !== 'string' || !expression.trim()) return null;

  const id = String(column._id ?? column.key);
  if (seen.has(id)) return null;
  const nextSeen = new Set(seen).add(id);

  // Only the columns the expression actually names are computed — a board with
  // twenty columns and a two-term formula reads two cells, not twenty.
  const all = Array.isArray(columns) ? columns : [];
  const valuesByKey = {};
  for (const key of formulaReferences(expression)) {
    const ref = all.find((c) => c && c.key === key);
    valuesByKey[key] = ref ? numericOf(task, ref, all, nextSeen) : null;
  }
  return evaluateFormula(expression, valuesByKey);
};

/**
 * A formula column's value on one task, or null.
 *
 * `columns` is the board's column list: the expression refers to its inputs by
 * `column.<key>`, so it needs the siblings to resolve them. Without it every
 * reference is missing and the answer is null, the same as an empty input.
 *
 * @param {Object} task
 * @param {Object} column   the formula column
 * @param {Object[]} columns the board's columns
 * @returns {number|null}
 */
export const formulaValue = (task, column, columns) =>
  formulaOf(task, column, columns, new Set());

/**
 * One task's value for one column AS A NUMBER, or null when it has none.
 *
 *   number / rating → the stored number
 *   formula         → `formulaValue`
 *   payments        → the receipts' total (0 when none — see `paymentsTotal`)
 *   mirror          → the mirrored number, when it is one
 *   anything else   → null
 *
 * What every summary, formula input and numeric sort should read, so a
 * "Remaining" formula and a "Paid" payments column total like any number
 * column rather than as blanks.
 *
 * @param {Object} task
 * @param {Object} column
 * @param {Object[]} [columns] the board's columns — needed for formulas
 * @returns {number|null}
 */
export const numericValue = (task, column, columns) =>
  numericOf(task, column, columns, new Set());

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
 * A formula column has NO stored value at all: it is computed at render by
 * `FormulaCell`. This returns `undefined` for one, which is correct and is why
 * summing a formula column needs its own path rather than a fix here.
 */

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

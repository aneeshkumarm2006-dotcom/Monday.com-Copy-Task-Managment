/**
 * A FORMULA COLUMN'S VALUE, computed in the browser.
 *
 * A formula column stores nothing. The server's `evaluateFormula`
 * (`server/src/utils/columnTypes.js`) defines the grammar, but nothing on the
 * server ever runs it for a task read — so `FormulaCell` used to wait for a
 * value that never arrived and a "Remaining" column read "—" on every row.
 * Every input is already on the client, so it is computed here, at render.
 *
 * ---- The grammar is the server's, exactly ----------------------------------
 *
 * `column.<key>` references, numbers, + - * /, parentheses and whitespace —
 * nothing else. References are substituted FIRST and the whitelist is checked
 * on the result, so no identifier, call, property access or string can survive
 * into the `Function` body. Keep the two copies identical: a formula the server
 * accepts on save must compute here, and one it rejects must not.
 *
 * The one deliberate difference is failure: the server throws (it is
 * validating a save), this returns null (it is painting a cell). A broken
 * expression renders as an empty cell rather than taking out the grid.
 */

const REFERENCE = /column\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
const WHITELIST = /^[\d\s+\-*/().]+$/;

/**
 * The expression's value over `valuesByKey` (column key → number), or null.
 *
 * Null when the expression is empty or invalid, when ANY referenced cell is
 * empty or non-numeric (a total over a missing input is not a total), or when
 * the result is not a finite number — division by zero included.
 */
export const evaluateFormula = (expression, valuesByKey) => {
  if (typeof expression !== 'string' || !expression.trim()) return null;

  let usedNull = false;
  const substituted = expression.replace(REFERENCE, (_match, key) => {
    const raw = valuesByKey ? valuesByKey[key] : undefined;
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (raw == null || raw === '' || typeof n !== 'number' || Number.isNaN(n)) {
      usedNull = true;
      return '0';
    }
    return String(n);
  });

  // Checked BEFORE the empty-input bail-out, as on the server, so an invalid
  // expression is invalid whether or not its inputs happen to be filled in.
  if (!WHITELIST.test(substituted)) return null;
  if (usedNull) return null;

  try {
    // Safe only because of the whitelist above: by this point the string can
    // hold nothing but digits, operators, parentheses and whitespace.
    const result = Function(`"use strict"; return (${substituted});`)();
    return typeof result === 'number' && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
};

/**
 * The column keys an expression references, in order, without duplicates.
 *
 * What lets a caller compute only the inputs a formula actually reads, and
 * notice a reference to itself before recursing into it.
 */
export const formulaReferences = (expression) => {
  if (typeof expression !== 'string') return [];
  const keys = [];
  for (const m of expression.matchAll(REFERENCE)) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
};

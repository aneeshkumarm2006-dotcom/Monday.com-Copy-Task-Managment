import { cellWrapperStyle } from './cellShared';
import useMoney from '../../../hooks/useMoney';
import { formulaValue } from '../../../utils/columnValues';

/**
 * FormulaCell — read-only, and computed HERE, at render.
 *
 * A formula column stores nothing, and nothing on the server evaluates it for a
 * task read — so the `value` a grid hands this cell is null. Given the board's
 * `columns`, the cell computes its own value from the task's sibling cells with
 * the client port of the server's grammar (`utils/formula.js`), which is why an
 * edit to "Spent" updates "Remaining" on the same render rather than never.
 * A non-null `value` still wins, for a caller that already computed one.
 *
 * Formatted through the column's own settings: a formula over currency columns
 * is currency too, and `remaining` reading as a bare number beside two ₹
 * columns is the cell that makes people distrust the board. A formula that is
 * NOT currency-formatted (a ratio, a count) gets no symbol.
 *
 * `on` and `currency` mean what they mean on `NumberCell`: the record's day
 * for the rate, and the board's currency for a column with no code.
 */
const FormulaCell = ({ value, column, task = null, columns = null, on = null, currency = null }) => {
  const money = useMoney();
  const computed =
    (value === null || value === undefined || value === '') && task && Array.isArray(columns)
      ? formulaValue(task, column, columns)
      : value;
  const shown =
    computed === null || computed === undefined || computed === ''
      ? ''
      : money.column(computed, column?.settings, on, currency);

  return (
    <div style={{ ...cellWrapperStyle, justifyContent: 'flex-end', color: 'var(--color-text-secondary)' }}>
      {shown === '' ? (
        <span style={{ color: 'var(--color-text-muted)' }}>—</span>
      ) : (
        <span>{shown}</span>
      )}
    </div>
  );
};

export default FormulaCell;

import { cellWrapperStyle } from './cellShared';
import useMoney from '../../../hooks/useMoney';

/**
 * FormulaCell — read-only. The server computes the value when the task is
 * loaded; if the value isn't present we show "—". v1 doesn't recompute
 * client-side; the next refetch picks up changes.
 *
 * Formatted through the column's own settings: a formula over currency columns
 * is currency too, and `remaining` reading as a bare number beside two ₹
 * columns is the cell that makes people distrust the board.
 */
const FormulaCell = ({ value, column }) => {
  const money = useMoney();
  return (
  <div style={{ ...cellWrapperStyle, justifyContent: 'flex-end', color: 'var(--color-text-secondary)' }}>
    {value == null || value === '' ? (
      <span style={{ color: 'var(--color-text-muted)' }}>—</span>
    ) : (
      <span>{money.column(value, column?.settings)}</span>
    )}
  </div>
  );
};

export default FormulaCell;

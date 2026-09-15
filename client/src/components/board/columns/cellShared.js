/**
 * Shared utilities for the F1 cell renderers.
 *
 * Each cell receives `{ value, column, task, readOnly, onChange }`:
 *   - value     : current cell value (shape varies by type)
 *   - column    : the column subdoc (with type + settings)
 *   - task      : the parent task (for context — most cells ignore it)
 *   - readOnly  : view mode; never call onChange
 *   - onChange  : (newValue) => void — store handles validation + API call
 */

export const cellWrapperStyle = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  height: '100%',
  padding: '4px 8px',
  fontSize: 13,
  fontFamily: 'inherit',
  color: 'var(--color-text-primary)',
  minHeight: 32,
};

export const cellInputStyle = {
  width: '100%',
  height: '100%',
  padding: '4px 8px',
  fontSize: 13,
  fontFamily: 'inherit',
  color: 'var(--color-text-primary)',
  background: 'transparent',
  border: '1px solid transparent',
  outline: 'none',
  borderRadius: 'var(--radius-sm)',
};

export const focusedInputStyle = {
  ...cellInputStyle,
  border: '1px solid var(--color-accent)',
  background: 'var(--color-bg-elevated)',
};

export const optionSorted = (options) => {
  if (!Array.isArray(options)) return [];
  return options.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
};

export const findOption = (options, id) =>
  options && id != null
    ? options.find((o) => o.id != null && o.id.toString() === id.toString())
    : null;

/**
 * The options somebody may still CHOOSE, as opposed to the ones a cell may
 * still have to RENDER.
 *
 * A retired option (`archived: true`) is one that was removed from a column's
 * vocabulary without throwing away the rows that already held it — see the
 * goal-column options section in `server/src/controllers/goalColumnController.js`.
 * So a picker is built from this, while the chip beside it is still looked up
 * in the FULL list with `findOption`: otherwise retiring a tag would blank
 * every cell carrying it, which is precisely what retiring exists to avoid.
 *
 * Task columns never set the flag, so this is a no-op for them.
 */
export const pickableOptions = (options) =>
  optionSorted(options).filter((o) => !o.archived);

export const formatDate = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
};

export const formatDateInput = (value) => {
  // For <input type="date"> — accepts YYYY-MM-DD.
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

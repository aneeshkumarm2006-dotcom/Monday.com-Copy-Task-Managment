/**
 * Shared utilities for the F1 cell renderers.
 *
 * Each cell receives `{ value, column, task, readOnly, onChange }`:
 *   - value     : current cell value (shape varies by type)
 *   - column    : the column subdoc (with type + settings)
 *   - task      : the parent task (for context — most cells ignore it)
 *   - readOnly  : view mode; never call onChange
 *   - onChange  : (newValue) => void — store handles validation + API call
 *
 * The board Table (`DataGrid`) also passes, and any cell may ignore:
 *   - columns   : the board's columns — what a formula needs to compute
 *   - currency  : the BOARD's currency, for a money column with no code
 *   - on        : the row's day for a converted figure's rate (the ledger's
 *                 issued date), or null for the latest rate
 *   - canManage : the viewer may change column settings (`column.manage`) —
 *                 lets a cell offer "Set up" instead of a dead end
 *
 * Other hosts (the goals grid) pass only the first five, so every extra is
 * optional and a cell must render sensibly without it.
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A stored date as the calendar day somebody picked, e.g. "Mar 1, 2026".
 *
 * ---- Why not `toISOString().slice(0, 10)` or `toLocaleDateString()` --------
 *
 * A date cell stores the LOCAL midnight of the picked day, serialised as UTC —
 * in India, 1 March is "2026-02-28T18:30:00.000Z". Slicing that (what this
 * used to do) read every IST date one day early. `toLocaleDateString()` gets
 * the day right but prints "3/1/2026", which is 1 March in one browser and
 * 3 January in the next — on an invoice's due date, that ambiguity is the
 * whole question. So: local parts, month spelled out.
 *
 * A bare 'YYYY-MM-DD' (a payment's date) carries no zone and IS the day, so it
 * is read from its parts — parsing it would make it UTC midnight and shift it
 * back a day everywhere west of Greenwich.
 */
export const formatDate = (value) => {
  if (!value) return '';
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) {
      const month = MONTHS[Number(m[2]) - 1];
      return month ? `${month} ${Number(m[3])}, ${m[1]}` : '';
    }
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};

/**
 * The board a row belongs to, as an id string — `task.board` arrives populated
 * on some reads and as a bare id on others. Null for a personal task.
 */
export const boardIdOf = (task) => {
  const b = task?.board;
  if (!b) return null;
  return String(typeof b === 'object' ? b._id ?? '' : b) || null;
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

import { useEffect, useRef, useState } from 'react';
import { focusedInputStyle, cellWrapperStyle, formatDateInput, formatDate } from './cellShared';
import { dateInputToISO } from '../../../utils/dateUtils';

/**
 * DateCell — a calendar day, shown as "Mar 1, 2026" and edited with the
 * browser's own date input.
 *
 * Shown with the month spelled out rather than `toLocaleDateString()`: an
 * invoice's issued and due dates are the dates people argue about, and
 * "3/1/2026" is 1 March in one browser and 3 January in the next (see
 * `formatDate` in cellShared).
 *
 * Stored as the LOCAL midnight of the picked day (`dateInputToISO`), the same
 * shape every other date on a board is stored in, so the table, the task panel
 * and the ledger read one convention.
 */
const DateCell = ({ value, readOnly, onChange, column }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatDateInput(value));
  const ref = useRef(null);

  // A new value from outside (a refetch, the panel's edit) resets the draft.
  // Adjusted during render — React's pattern for state that follows a prop —
  // rather than in an effect, which costs an extra render per row.
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    setDraft(formatDateInput(value));
  }

  useEffect(() => {
    if (editing && ref.current) ref.current.focus();
  }, [editing]);

  const commit = () => {
    if (draft === '') {
      if (value) onChange?.(null);
    } else {
      const iso = dateInputToISO(draft);
      if (draft !== formatDateInput(value)) onChange?.(iso);
    }
    setEditing(false);
  };

  const shown = formatDate(value);

  if (readOnly || !editing) {
    if (readOnly) {
      return (
        <div style={cellWrapperStyle}>
          <span>{shown}</span>
        </div>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`${column?.name || 'Date'}: ${shown || 'not set'} — edit`}
        className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)] focus-visible:outline-offset-[-2px]"
        style={{
          ...cellWrapperStyle,
          background: 'transparent',
          border: 'none',
          textAlign: 'left',
          cursor: 'text',
        }}
      >
        <span style={{ whiteSpace: 'nowrap' }}>{shown}</span>
      </button>
    );
  }

  return (
    <input
      ref={ref}
      type="date"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(formatDateInput(value));
          setEditing(false);
        }
      }}
      aria-label={column?.name || 'Date'}
      style={focusedInputStyle}
    />
  );
};

export default DateCell;

import { useEffect, useRef, useState } from 'react';
import { focusedInputStyle, cellWrapperStyle } from './cellShared';
import { formatNumber } from '../../../utils/numberFormat';

const NumberCell = ({ value, column, readOnly, onChange }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const ref = useRef(null);

  useEffect(() => setDraft(value == null ? '' : String(value)), [value]);
  useEffect(() => {
    if (editing && ref.current) ref.current.focus();
  }, [editing]);

  const commit = () => {
    if (draft === '') {
      if (value != null) onChange?.(null);
    } else {
      const n = Number(draft);
      if (!Number.isNaN(n) && n !== value) onChange?.(n);
    }
    setEditing(false);
  };

  const min = column?.settings?.min;
  const max = column?.settings?.max;

  if (readOnly || !editing) {
    return (
      <div
        style={{ ...cellWrapperStyle, justifyContent: 'flex-end', cursor: readOnly ? 'default' : 'text' }}
        onClick={() => !readOnly && setEditing(true)}
      >
        {/* Formatted for READING; the input below still edits the raw number,
            because typing into "₹1,80,000" is nobody's idea of a number field. */}
        <span>{formatNumber(value, column?.settings)}</span>
      </div>
    );
  }

  return (
    <input
      ref={ref}
      type="number"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(value == null ? '' : String(value));
          setEditing(false);
        }
      }}
      min={min}
      max={max}
      style={{ ...focusedInputStyle, textAlign: 'right' }}
    />
  );
};

export default NumberCell;

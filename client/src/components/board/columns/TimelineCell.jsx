import { useEffect, useRef, useState } from 'react';
import { cellInputStyle, cellWrapperStyle, formatDateInput } from './cellShared';
import { dateInputToISO } from '../../../utils/dateUtils';

/**
 * TimelineCell — a span between two dates. Renders both inputs inline.
 */
const TimelineCell = ({ value, readOnly, onChange }) => {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(formatDateInput(value?.start));
  const [end, setEnd] = useState(formatDateInput(value?.end));
  const startRef = useRef(null);

  useEffect(() => {
    setStart(formatDateInput(value?.start));
    setEnd(formatDateInput(value?.end));
  }, [value]);
  useEffect(() => {
    if (editing && startRef.current) startRef.current.focus();
  }, [editing]);

  const commit = () => {
    const next = {};
    if (start) next.start = dateInputToISO(start);
    if (end) next.end = dateInputToISO(end);
    const payload = Object.keys(next).length ? next : null;
    const prev = value || null;
    if (JSON.stringify(payload) !== JSON.stringify(prev)) onChange?.(payload);
    setEditing(false);
  };

  if (readOnly || !editing) {
    const label =
      value?.start && value?.end
        ? `${new Date(value.start).toLocaleDateString()} → ${new Date(value.end).toLocaleDateString()}`
        : value?.start
        ? new Date(value.start).toLocaleDateString()
        : '';
    return (
      <div
        style={{ ...cellWrapperStyle, cursor: readOnly ? 'default' : 'text' }}
        onClick={() => !readOnly && setEditing(true)}
      >
        <span>{label}</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 4, padding: 4 }}>
      <input
        ref={startRef}
        type="date"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        onBlur={commit}
        style={{ ...cellInputStyle, border: '1px solid var(--color-border)' }}
      />
      <input
        type="date"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        onBlur={commit}
        style={{ ...cellInputStyle, border: '1px solid var(--color-border)' }}
      />
    </div>
  );
};

export default TimelineCell;

import { useEffect, useRef, useState } from 'react';
import { focusedInputStyle, cellWrapperStyle } from './cellShared';
import useMoney from '../../../hooks/useMoney';
import { currencyByCode } from '../../../utils/money';

const NumberCell = ({ value, column, readOnly, onChange }) => {
  const money = useMoney();
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
        <span>{money.column(value, column?.settings)}</span>
      </div>
    );
  }

  /**
   * WHICH CURRENCY YOU ARE TYPING IN.
   *
   * Editing always happens in the column's OWN currency, never the reader's.
   * Typing 1044 while reading in dollars and having it stored as ₹99,617 would
   * make the written figure a rate-dependent approximation of what somebody
   * meant — and re-opening it tomorrow would round-trip through another rate.
   *
   * So the symbol prefix is not decoration: when the cell READS as "$1,044" and
   * EDITS as rupees, the field has to say so. The converted hint beside it is
   * what makes that bearable rather than jarring.
   */
  const isMoney = column?.settings?.format === 'currency';
  const source = column?.settings?.currency;
  const symbol = isMoney ? currencyByCode(source)?.symbol || source || '' : '';
  const hint =
    isMoney && money.active && draft !== ''
      ? money.column(Number(draft), column?.settings)
      : '';

  if (isMoney) {
    return (
      <div style={{ ...cellWrapperStyle, justifyContent: 'flex-end', gap: 4 }}>
        {symbol ? (
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{symbol}</span>
        ) : null}
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
          style={{ ...focusedInputStyle, textAlign: 'right', flex: 1, minWidth: 0 }}
        />
        {hint ? (
          <span
            style={{ fontSize: 10, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}
            title="What that comes to in the currency you are reading in"
          >
            {hint}
          </span>
        ) : null}
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

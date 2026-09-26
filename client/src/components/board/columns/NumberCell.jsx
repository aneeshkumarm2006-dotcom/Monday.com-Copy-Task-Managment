import { useEffect, useRef, useState } from 'react';
import { focusedInputStyle, cellWrapperStyle } from './cellShared';
import useMoney from '../../../hooks/useMoney';
import { currencyByCode, formatIn } from '../../../utils/money';

/**
 * NumberCell — a number column's cell, and the goal rows' too.
 *
 * Optional props beyond the registry's `{ value, column, readOnly, onChange }`:
 *
 *   on        the record's day ('YYYY-MM-DD' or a Date), so a converted figure
 *             uses the rate in force THAT day rather than the newest one — the
 *             Ledger dates by the issued column, and a Table cell showing the
 *             same invoice should agree with it.
 *   currency  the unit for a currency column that carries no code of its own —
 *             pass the board's currency. Without it the workspace's applies.
 *
 * Only a `format: 'currency'` column is money. A plain or percent column never
 * shows a symbol and never converts — that is `useMoney().column`'s rule, and
 * the edit prefix below follows the same test.
 */
const NumberCell = ({ value, column, readOnly, onChange, on = null, currency = null }) => {
  const money = useMoney();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const ref = useRef(null);

  // A new value from outside (a refetch, another tab's edit) resets the draft.
  // Adjusted during render rather than in an effect — React's own pattern for
  // state that follows a prop, which skips the extra render an effect costs.
  //
  // `Object.is`, not `!==`: NaN !== NaN, so a stored NaN would set state on
  // every render and React would abort with "Too many re-renders". A value is
  // only "new" when it is a different value, and NaN is the same NaN.
  const [seenValue, setSeenValue] = useState(value);
  if (!Object.is(value, seenValue)) {
    setSeenValue(value);
    setDraft(value == null ? '' : String(value));
  }

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

  const settings = column?.settings || {};
  const min = settings.min;
  const max = settings.max;

  const isMoney = settings.format === 'currency';
  /**
   * The unit this column is STORED in — its own code, else the board's, else
   * the workspace's. The same chain `money.column` resolves, spelled out here
   * because the edit prefix and the as-entered tooltip need the code itself,
   * not a formatted string.
   */
  const source = isMoney ? settings.currency || currency || money.baseCurrency || null : null;

  if (readOnly || !editing) {
    const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    const shown = money.column(value, settings, on, currency);
    /**
     * A converted figure carries what was actually typed, on hover. Once per
     * surface is the rule for SAYING a figure was converted (see
     * `useMoney().surfaceNote`), but "what did we enter for this one?" is a
     * per-row question, and a tooltip answers it without cluttering a column
     * that has to scan.
     */
    const converted =
      isMoney && money.active && typeof numeric === 'number' && Number.isFinite(numeric)
        ? money.resolve(numeric, source, on).converted
        : false;
    const title = converted
      ? `Entered as ${formatIn(numeric, source, { decimals: settings.decimals ?? 'auto' })}`
      : undefined;

    return (
      <div
        style={{ ...cellWrapperStyle, justifyContent: 'flex-end', cursor: readOnly ? 'default' : 'text' }}
        onClick={() => !readOnly && setEditing(true)}
        title={title}
      >
        {/* Formatted for READING; the input below still edits the raw number,
            because typing into "₹1,80,000" is nobody's idea of a number field. */}
        <span>{shown}</span>
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
  const symbol = isMoney ? currencyByCode(source)?.symbol || source || '' : '';
  const hint =
    isMoney && money.active && draft !== ''
      ? money.column(Number(draft), settings, on, currency)
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
          aria-label={source ? `${column?.name || 'Amount'}, in ${source}` : undefined}
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

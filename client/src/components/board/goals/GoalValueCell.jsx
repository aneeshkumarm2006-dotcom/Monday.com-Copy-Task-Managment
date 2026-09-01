import { useEffect, useRef, useState } from 'react';
import { formatGoalValue, RATING_CHOICES } from '../../../utils/goalDisplay';
import Dropdown from '../../ui/Dropdown';
import DatePickerPopover from '../../ui/DatePickerPopover';

/**
 * The editor for a goal's built-in numeric fields — baseline, target and the
 * all-important "where did you land".
 *
 * Purpose-built rather than reusing `columns/NumberCell`, for three reasons that
 * only apply here: it renders a unit suffix (4,200 vs 4,200% vs ₹4,200), it is
 * polymorphic on the goal's type (a boolean shows Yes/No, a rating shows its
 * three rungs, a deadline shows a date), and it has to display the
 * required-but-empty state that blocks the month from closing.
 *
 * The interaction idiom is copied deliberately from `columns/TextCell`, so
 * editing a goal feels the same as editing a task: a div until clicked, then an
 * input; commit on blur or Enter, and only if the value actually changed;
 * Escape reverts.
 */
const GoalValueCell = ({
  value,
  goal,
  kind = 'number', // 'number' | 'boolean' | 'rating' | 'date'
  readOnly = false,
  required = false,
  placeholder = '—',
  align = 'right',
  onChange,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const isEmpty = value === null || value === undefined || value === '';
  const flagged = required && isEmpty;

  const commit = () => {
    setEditing(false);
    if (kind === 'date') {
      const next = draft || null;
      if (next !== (value ?? null)) onChange?.(next);
      return;
    }
    // Trimmed, because `Number(' ')` is 0 — an all-whitespace draft must read as
    // "nothing typed", never as a reported result of zero.
    const typed = draft.trim();
    if (typed === '') {
      if (!isEmpty) {
        if (required) {
          // Clearing a value the month is already waiting on is refused here,
          // in the UI. The server does NOT reject it — un-reporting a mistake
          // has to stay possible — so this is a guard rail on the one screen
          // where wiping a number is almost always a slip, not an intention.
          setError('This one is required — clear it and the month can’t be closed.');
          return;
        }
        onChange?.(null);
      }
      return;
    }
    const num = Number(typed);
    if (!Number.isFinite(num)) {
      setError('That needs to be a number.');
      return;
    }
    if (num !== value) onChange?.(num);
  };

  const startEdit = () => {
    if (readOnly) return;
    setError(null);
    setDraft(isEmpty ? '' : String(value));
    setEditing(true);
  };

  // --- Non-numeric kinds render as pickers, not text inputs -----------------

  if (kind === 'boolean') {
    const yes = value === 1 || value === true;
    return (
      <div className="flex items-center gap-1">
        {[
          { v: 1, label: 'Yes' },
          { v: 0, label: 'No' },
        ].map((opt) => {
          const active = !isEmpty && (yes ? opt.v === 1 : opt.v === 0);
          return (
            <button
              key={opt.label}
              type="button"
              disabled={readOnly}
              onClick={() => onChange?.(value === opt.v ? null : opt.v)}
              className="font-body transition-colors duration-100"
              style={{
                fontSize: 12,
                padding: '2px 10px',
                borderRadius: 'var(--radius-full)',
                border: `1px solid ${active ? 'transparent' : 'var(--color-border)'}`,
                background: active
                  ? (opt.v === 1 ? 'var(--color-status-done-bg)' : 'var(--color-status-stuck-bg)')
                  : 'transparent',
                color: active
                  ? (opt.v === 1 ? 'var(--color-status-done)' : 'var(--color-status-stuck)')
                  : 'var(--color-text-secondary)',
                cursor: readOnly ? 'default' : 'pointer',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (kind === 'rating') {
    // `size="sm"` because this sits in a grid row, not a form. The value goes
    // back out as a NUMBER — the dropdown carries strings, and a rating stored
    // as '50' would miss `isNum` in the scorer and read as untracked.
    return (
      <Dropdown
        size="sm"
        value={isEmpty ? '' : String(value)}
        disabled={readOnly}
        options={[
          { value: '', label: 'Not rated' },
          ...RATING_CHOICES.map((c) => ({ value: String(c.value), label: c.label })),
        ]}
        onChange={(next) => onChange?.(next === '' ? null : Number(next))}
        ariaLabel="Rating"
      />
    );
  }

  if (kind === 'date') {
    // `actualDayKey` is stored as a raw 'YYYY-MM-DD' and the picker speaks the
    // same, so there is no conversion here — deliberately, since introducing
    // one is how a day key drifts by one on either side of UTC midnight.
    return (
      <DatePickerPopover
        variant="inline"
        value={value || ''}
        disabled={readOnly}
        onChange={(next) => onChange?.(next || null)}
      />
    );
  }

  // --- Numeric --------------------------------------------------------------

  if (editing) {
    return (
      <div className="w-full">
        <input
          ref={inputRef}
          type="number"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setEditing(false); setError(null); }
          }}
          className="w-full font-body"
          style={{
            fontSize: 13,
            padding: '3px 6px',
            textAlign: align,
            border: `1.5px solid ${error ? 'var(--color-status-stuck)' : 'var(--color-accent)'}`,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg-surface)',
            color: 'var(--color-text-primary)',
            outline: 'none',
          }}
        />
        {error && (
          <p className="font-body mt-0.5" style={{ fontSize: 11, color: 'var(--color-status-stuck)' }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      role={readOnly ? undefined : 'button'}
      tabIndex={readOnly ? undefined : 0}
      onClick={startEdit}
      onKeyDown={(e) => {
        if (readOnly) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); }
      }}
      title={flagged ? 'This is required before the month can be closed' : undefined}
      className="w-full font-body truncate"
      style={{
        fontSize: 13,
        padding: '3px 6px',
        textAlign: align,
        borderRadius: 'var(--radius-sm)',
        border: flagged ? '1.5px solid var(--color-status-stuck)' : '1.5px solid transparent',
        background: flagged ? 'var(--color-status-stuck-bg)' : 'transparent',
        color: isEmpty ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
        cursor: readOnly ? 'default' : 'text',
        minHeight: 26,
      }}
    >
      {isEmpty ? placeholder : formatGoalValue(value, goal)}
    </div>
  );
};

export default GoalValueCell;

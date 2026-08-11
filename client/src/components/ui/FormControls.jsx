/**
 * Shared form primitives for config modals.
 *
 * These were originally defined privately inside AutomationsModal; they're
 * extracted here so every rule-builder in the app renders the same segmented
 * control, weekday chips, select and toggle from a single source of truth. The
 * Trackers modal is the second consumer, and a second private copy would have
 * drifted the way six copies of loadBoardContext once did.
 *
 * AutomationsModal is deliberately NOT repointed at these yet — that is a
 * behaviour-neutral refactor of a 2,000-line file and belongs in its own change,
 * not bundled into a feature. The bodies below are copied verbatim from it, so
 * the swap is a delete-and-import when someone gets to it.
 *
 * Named exports only, matching FilterControls.jsx.
 */

/** Sun-first, matching JS getDay() and the server's `weekdays: [0..6]`. */
const WEEKDAY_CHIPS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

export const SegmentedControl = ({ options, value, onChange, disabled }) => (
  <div
    className="inline-flex flex-wrap"
    style={{
      border: '1.5px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      padding: 2,
      background: 'var(--color-bg-input)',
    }}
  >
    {options.map((opt) => {
      const selected = opt.value === value;
      return (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className="font-body"
          style={{
            fontSize: 13,
            fontWeight: selected ? 600 : 500,
            padding: '6px 14px',
            borderRadius: 'var(--radius-sm)',
            background: selected ? 'var(--color-accent)' : 'transparent',
            color: selected ? '#FFFFFF' : 'var(--color-text-secondary)',
            border: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'background 150ms ease, color 150ms ease',
          }}
        >
          {opt.label}
        </button>
      );
    })}
  </div>
);

export const WeekdayChips = ({ value, onChange, disabled, chips = WEEKDAY_CHIPS }) => {
  const set = new Set(value || []);
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => {
        const selected = set.has(c.value);
        return (
          <button
            key={c.value}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => {
              const next = new Set(set);
              if (next.has(c.value)) next.delete(c.value);
              else next.add(c.value);
              onChange(Array.from(next).sort((a, b) => a - b));
            }}
            className="font-body"
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '4px 10px',
              borderRadius: 'var(--radius-full)',
              border: selected
                ? '1.5px solid var(--color-accent)'
                : '1.5px solid var(--color-border)',
              background: selected ? 'var(--color-accent-light)' : 'transparent',
              color: selected ? 'var(--color-accent-text)' : 'var(--color-text-secondary)',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
};

export const SelectField = ({ label, value, onChange, options, disabled, listId }) => (
  <div>
    {label && (
      <label
        className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {label}
      </label>
    )}
    <select
      value={value}
      onChange={onChange}
      disabled={disabled}
      list={listId}
      className="w-full font-body"
      style={{
        height: 38,
        padding: '0 10px',
        borderRadius: 'var(--radius-md)',
        border: '1.5px solid var(--color-border)',
        background: 'var(--color-bg-input)',
        color: 'var(--color-text-primary)',
        fontSize: 14,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  </div>
);

export const Toggle = ({ checked, onChange, disabled, label }) => (
  <label
    className="inline-flex items-center gap-2 select-none"
    style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
  >
    <span
      style={{
        position: 'relative',
        width: 36,
        height: 20,
        flexShrink: 0,
        borderRadius: 999,
        background: checked ? 'var(--color-accent)' : 'var(--color-border-strong)',
        transition: 'background 150ms ease',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#FFFFFF',
          transition: 'left 150ms ease',
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        }}
      />
    </span>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="sr-only"
    />
    {label && (
      <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
        {label}
      </span>
    )}
  </label>
);

/** A small labelled number input, for "every N days" and "how many per period". */
export const NumberField = ({ value, onChange, min = 1, max = 99, disabled, suffix, ariaLabel }) => (
  <span className="inline-flex items-center gap-2">
    <input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => {
        const next = parseInt(e.target.value, 10);
        onChange(Number.isNaN(next) ? '' : Math.max(min, Math.min(max, next)));
      }}
      className="font-body"
      style={{
        width: 64,
        height: 38,
        padding: '0 10px',
        borderRadius: 'var(--radius-md)',
        border: '1.5px solid var(--color-border)',
        background: 'var(--color-bg-input)',
        color: 'var(--color-text-primary)',
        fontSize: 14,
        opacity: disabled ? 0.6 : 1,
      }}
    />
    {suffix && (
      <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
        {suffix}
      </span>
    )}
  </span>
);

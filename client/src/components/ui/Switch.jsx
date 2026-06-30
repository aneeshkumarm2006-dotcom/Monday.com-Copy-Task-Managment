/**
 * Accessible on/off switch styled with the app's accent token. Controlled:
 * pass `checked` + `onChange(next)`.
 */
const Switch = ({ checked, onChange, disabled = false, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => !disabled && onChange(!checked)}
    className="relative inline-flex items-center shrink-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      width: 36,
      height: 20,
      borderRadius: 9999,
      background: checked
        ? 'var(--color-accent)'
        : 'var(--color-border-strong)',
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}
  >
    <span
      aria-hidden="true"
      className="absolute bg-white transition-transform"
      style={{
        width: 16,
        height: 16,
        borderRadius: 9999,
        top: 2,
        left: 2,
        transform: checked ? 'translateX(16px)' : 'translateX(0)',
        boxShadow: 'var(--shadow-sm)',
      }}
    />
  </button>
);

export default Switch;

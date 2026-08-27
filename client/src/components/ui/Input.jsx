import { forwardRef, useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Input — styled text input matching Macan design system (Section 6.5).
 * Supports an optional label, helper/error text, and disabled state.
 *
 * Props: label, placeholder, type, value, onChange, disabled, error, ...rest
 */

/**
 * `masked` renders a secret WITHOUT ever using `type="password"`.
 *
 * That is the whole point: Chrome (and every other browser's password manager)
 * decides whether to offer "save this password?" by looking for a password-typed
 * field in the submitted form. `autocomplete="off"` does not suppress that — it
 * is a hint browsers deliberately ignore for the save prompt. So a vault
 * password typed into a real password field ends up copied into Google Password
 * Manager, which is a second, unencrypted store of the one secret that is
 * supposed to exist only in the user's head. Masking with CSS instead leaves the
 * field a plain text input, and the prompt never fires.
 *
 * Firefox only learned `-webkit-text-security` in 132, and an unmasked secret is
 * worse than a save prompt, so anything without support falls back to a real
 * password field. Toggling reveal still works either way.
 */
const SUPPORTS_TEXT_SECURITY =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  (CSS.supports('-webkit-text-security', 'disc') ||
    CSS.supports('text-security', 'disc'));

// Password managers that ignore autocomplete still honour their own opt-outs.
const IGNORE_MANAGERS = {
  'data-lpignore': 'true', // LastPass
  'data-1p-ignore': '', // 1Password
  'data-bwignore': 'true', // Bitwarden
  'data-form-type': 'other', // Dashlane
};

const Input = forwardRef(function Input(
  {
    label,
    placeholder,
    type = 'text',
    value,
    onChange,
    disabled = false,
    error,
    helperText,
    className = '',
    id: idProp,
    required = false,
    multiline = false,
    rows = 4,
    masked = false,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const id = idProp || reactId;
  const [revealed, setRevealed] = useState(false);

  const isMasked = masked && !multiline;
  const hidden = isMasked && !revealed;

  const baseFieldClasses = [
    'w-full font-body text-[14px] text-[color:var(--color-text-primary)]',
    'bg-[color:var(--color-bg-input)]',
    'transition-[border-color,box-shadow,background-color] duration-150 ease-in-out',
    'placeholder:text-[color:var(--color-text-muted)]',
    'focus:outline-none focus:bg-white',
    'focus:border-[color:var(--color-accent)]',
    'focus:shadow-[0_0_0_3px_rgba(37,99,235,0.12)]',
    'disabled:opacity-60 disabled:cursor-not-allowed',
    multiline ? 'py-3 resize-y min-h-[80px]' : 'h-[44px] md:h-[38px]',
    'px-3',
    isMasked ? 'pr-11' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const fieldStyle = {
    border: error
      ? '1.5px solid var(--color-status-stuck)'
      : '1.5px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
  };

  if (isMasked) {
    // A revealed secret in a proportional font invites `l`/`I`/`1` and `0`/`O`
    // misreadings — the same reason SecretField switches font on reveal.
    if (revealed) {
      fieldStyle.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    } else if (SUPPORTS_TEXT_SECURITY) {
      fieldStyle.WebkitTextSecurity = 'disc';
      fieldStyle.textSecurity = 'disc';
      fieldStyle.letterSpacing = '0.08em';
    }
  }

  const maskedProps = isMasked
    ? {
        // Never `password` while we can mask in CSS — see the note above.
        type: SUPPORTS_TEXT_SECURITY ? 'text' : hidden ? 'password' : 'text',
        autoComplete: 'off',
        autoCorrect: 'off',
        autoCapitalize: 'off',
        spellCheck: false,
        ...IGNORE_MANAGERS,
      }
    : { type };

  const field = (
    <input
      ref={ref}
      id={id}
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      disabled={disabled}
      required={required}
      className={baseFieldClasses}
      style={fieldStyle}
      {...maskedProps}
      {...rest}
    />
  );

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={id}
          className="block mb-2 font-body font-medium text-[color:var(--color-text-secondary)] text-xs uppercase tracking-wide"
        >
          {label}
          {required && (
            <span className="text-[color:var(--color-status-stuck)] ml-1">*</span>
          )}
        </label>
      )}

      {multiline ? (
        <textarea
          ref={ref}
          id={id}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          rows={rows}
          required={required}
          className={baseFieldClasses}
          style={fieldStyle}
          {...rest}
        />
      ) : isMasked ? (
        <div className="relative">
          {field}
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            disabled={disabled}
            tabIndex={-1}
            aria-label={revealed ? 'Hide' : 'Show'}
            title={revealed ? 'Hide' : 'Show'}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)] disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ width: 28, height: 28, color: 'var(--color-text-secondary)' }}
          >
            {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      ) : (
        field
      )}

      {error ? (
        <p className="mt-1.5 text-xs font-body text-[color:var(--color-status-stuck)]">
          {error}
        </p>
      ) : helperText ? (
        <p className="mt-1.5 text-xs font-body text-[color:var(--color-text-muted)]">
          {helperText}
        </p>
      ) : null}
    </div>
  );
});

export default Input;

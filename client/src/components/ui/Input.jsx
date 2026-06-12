import { forwardRef, useId } from 'react';

/**
 * Input — styled text input matching Macan design system (Section 6.5).
 * Supports an optional label, helper/error text, and disabled state.
 *
 * Props: label, placeholder, type, value, onChange, disabled, error, ...rest
 */

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
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const id = idProp || reactId;

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
      ) : (
        <input
          ref={ref}
          id={id}
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          required={required}
          className={baseFieldClasses}
          style={fieldStyle}
          {...rest}
        />
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

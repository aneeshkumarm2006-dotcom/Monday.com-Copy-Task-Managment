import { forwardRef } from 'react';

/**
 * Button — reusable button component matching Macan design system.
 * Variants: primary (blue fill) | secondary (outlined) | ghost (text) | danger (red fill)
 * Sizes:    sm (32px) | default (38px) | lg (44px)
 *
 * See Macan_Design.md Section 6.3.
 */

const SIZE_STYLES = {
  sm:      { height: 32, padding: '0 12px', fontSize: 13 },
  default: { height: 38, padding: '0 18px', fontSize: 14 },
  lg:      { height: 44, padding: '0 22px', fontSize: 15 },
};

const VARIANT_STYLES = {
  primary: {
    background: 'var(--color-accent)',
    color: '#FFFFFF',
    border: 'none',
    fontWeight: 600,
  },
  secondary: {
    background: 'transparent',
    color: 'var(--color-text-primary)',
    border: '1.5px solid var(--color-border-strong)',
    fontWeight: 500,
  },
  ghost: {
    background: 'transparent',
    color: 'var(--color-accent)',
    border: 'none',
    fontWeight: 600,
  },
  danger: {
    background: '#DC2626',
    color: '#FFFFFF',
    border: 'none',
    fontWeight: 600,
  },
};

const hoverClassByVariant = {
  primary: 'hover:bg-accent-hover',
  secondary: 'hover:bg-[color:var(--color-bg-subtle)]',
  ghost: 'hover:bg-[color:var(--color-accent-light)]',
  danger: 'hover:bg-[#B91C1C]',
};

const Button = forwardRef(function Button(
  {
    variant = 'primary',
    size = 'default',
    icon: Icon,
    iconPosition = 'left',
    children,
    className = '',
    disabled = false,
    type = 'button',
    onClick,
    ...rest
  },
  ref,
) {
  const sizeStyles = SIZE_STYLES[size] || SIZE_STYLES.default;
  const variantStyles = VARIANT_STYLES[variant] || VARIANT_STYLES.primary;
  const hoverClass = hoverClassByVariant[variant] || '';

  // Ghost uses smaller padding + slightly smaller radius per Design Section 6.3
  const radius =
    variant === 'ghost' ? 'var(--radius-sm)' : 'var(--radius-md)';

  const ghostOverride =
    variant === 'ghost'
      ? { height: size === 'sm' ? 28 : 32, padding: '0 12px' }
      : {};

  // Mobile tap target: bump non-compact buttons to ≥44px tall below md so they
  // meet the 44px touch guideline. Desktop (md+) resets to the design's exact
  // height. Compact `sm` and `ghost` buttons stay dense by design.
  const tapTargetClass =
    variant !== 'ghost' && size !== 'sm' ? 'min-h-[44px] md:min-h-0' : '';

  return (
    <button
      ref={ref}
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={[
        'inline-flex items-center justify-center gap-2 font-body whitespace-nowrap select-none',
        'transition-colors duration-150 ease-in-out',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        !disabled && hoverClass,
        tapTargetClass,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        ...sizeStyles,
        ...variantStyles,
        ...ghostOverride,
        borderRadius: radius,
        cursor: disabled ? 'not-allowed' : 'pointer',
        lineHeight: 1,
      }}
      {...rest}
    >
      {Icon && iconPosition === 'left' && <Icon size={16} aria-hidden="true" />}
      {children}
      {Icon && iconPosition === 'right' && <Icon size={16} aria-hidden="true" />}
    </button>
  );
});

export default Button;

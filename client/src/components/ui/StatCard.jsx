import { useEffect, useRef, useState } from 'react';

/**
 * StatCard — solid-colored dashboard card with an animated count-up number.
 * See Macan_Design.md Section 6.2.
 *
 * Props: icon (Lucide component), label, value (number), subLabel, color
 *   color: 'blue' | 'green' | 'orange' | 'purple' | 'red' | raw CSS color
 */

const COLOR_VARS = {
  blue: 'var(--color-card-blue)',
  green: 'var(--color-card-green)',
  orange: 'var(--color-card-orange)',
  purple: 'var(--color-card-purple)',
  red: '#DC2626',
};

const ANIMATION_DURATION_MS = 800;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

const useCountUp = (target, durationMs = ANIMATION_DURATION_MS) => {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef(null);
  const startRef = useRef(null);

  useEffect(() => {
    const numeric = typeof target === 'number' ? target : Number(target);
    if (!Number.isFinite(numeric)) {
      setDisplay(target);
      return undefined;
    }

    startRef.current = null;
    cancelAnimationFrame(rafRef.current);

    const step = (timestamp) => {
      if (startRef.current === null) startRef.current = timestamp;
      const elapsed = timestamp - startRef.current;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = easeOutCubic(progress);
      setDisplay(Math.round(eased * numeric));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    };

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, durationMs]);

  return display;
};

const StatCard = ({
  icon: Icon,
  label,
  value,
  subLabel,
  color = 'blue',
  suffix,
  className = '',
}) => {
  const background = COLOR_VARS[color] || color;
  const numeric = typeof value === 'number' ? value : Number(value);
  const isNumeric = Number.isFinite(numeric);
  const animated = useCountUp(isNumeric ? numeric : 0);

  return (
    <div
      className={[
        'relative overflow-hidden w-full',
        'transition-transform duration-150 ease-in-out',
        // Slightly tighter padding on phones; desktop keeps 20px/24px.
        'p-4 sm:px-6 sm:py-5',
        className,
      ].join(' ')}
      style={{
        background,
        borderRadius: 'var(--radius-lg)',
        minHeight: 120,
        color: '#FFFFFF',
      }}
    >
      {/* Decorative circle — 150px, 12% white opacity, top-right */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute"
        style={{
          width: 150,
          height: 150,
          top: -40,
          right: -40,
          borderRadius: '9999px',
          background: 'rgba(255, 255, 255, 0.12)',
        }}
      />

      <div className="relative z-10 flex items-start justify-between">
        {Icon && (
          <Icon
            size={22}
            color="#FFFFFF"
            strokeWidth={2}
            aria-hidden="true"
          />
        )}
      </div>

      <div className="relative z-10 mt-1">
        <p
          className="font-body font-medium uppercase"
          style={{
            fontSize: 12,
            letterSpacing: '0.04em',
            color: 'rgba(255,255,255,0.8)',
          }}
        >
          {label}
        </p>
        <p
          className="font-display font-extrabold leading-none mt-2 text-[28px] sm:text-[36px]"
          style={{ color: '#FFFFFF' }}
        >
          {isNumeric ? animated : value}
          {suffix ? <span className="ml-0.5">{suffix}</span> : null}
        </p>
        {subLabel && (
          <p
            className="font-body mt-1.5"
            style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}
          >
            {subLabel}
          </p>
        )}
      </div>
    </div>
  );
};

export default StatCard;

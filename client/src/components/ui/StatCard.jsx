import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * StatCard — solid-colored dashboard card with an animated count-up number.
 * See Macan_Design.md Section 6.2.
 *
 * Props: icon (Lucide component), label, value (number), subLabel, color
 *   color: 'blue' | 'green' | 'orange' | 'purple' | 'red' | raw CSS color
 */

const COLOR_VARS = {
  blue: 'var(--color-card-blue-grad)',
  green: 'var(--color-card-green-grad)',
  orange: 'var(--color-card-orange-grad)',
  purple: 'var(--color-card-purple-grad)',
};

/** The flat fallbacks, for a caller passing a raw colour rather than a key. */
const FLAT_VARS = {
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
  // One line of context under the number. `subHighlight` renders first, in a
  // translucent pill — the delta or the part that changes ("+34", "20 yours").
  // A bare total is a trophy; a total with a delta is news.
  subHighlight,
  subLabel,
  color = 'blue',
  suffix,
  className = '',
  onClick,
}) => {
  const background = COLOR_VARS[color] || FLAT_VARS[color] || color;
  const numeric = typeof value === 'number' ? value : Number(value);
  const isNumeric = Number.isFinite(numeric);
  const animated = useCountUp(isNumeric ? numeric : 0);

  const clickable = typeof onClick === 'function';
  const handleKeyDown = (e) => {
    if (!clickable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(e);
    }
  };

  return (
    <div
      className={[
        'relative overflow-hidden w-full',
        'transition-transform duration-150 ease-in-out',
        // Slightly tighter padding on phones; desktop keeps 20px/24px.
        'p-4 sm:px-6 sm:py-5',
        clickable
          ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70'
          : '',
        className,
      ].join(' ')}
      style={{
        background,
        borderRadius: 'var(--radius-lg)',
        minHeight: 120,
        color: '#FFFFFF',
      }}
      onClick={clickable ? onClick : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `${label}: ${value}. View details` : undefined}
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
        {/* The icon sits in a soft translucent tile rather than floating, so
            all four cards start their content on the same baseline. */}
        {Icon && (
          <span
            className="inline-flex items-center justify-center shrink-0"
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              background: 'rgba(255, 255, 255, 0.18)',
            }}
          >
            <Icon size={17} color="#FFFFFF" strokeWidth={2.2} aria-hidden="true" />
          </span>
        )}
        {clickable && (
          <ChevronRight
            size={16}
            strokeWidth={2.5}
            aria-hidden="true"
            style={{ color: 'rgba(255,255,255,0.6)' }}
          />
        )}
      </div>

      <div className="relative z-10 mt-1">
        <p
          className="font-body font-semibold uppercase truncate"
          style={{
            fontSize: 11,
            letterSpacing: '0.07em',
            color: 'rgba(255,255,255,0.78)',
          }}
        >
          {label}
        </p>
        <p
          className="font-display font-extrabold leading-none mt-1 text-[28px] sm:text-[34px] tabular-nums"
          style={{ color: '#FFFFFF', letterSpacing: '-0.03em' }}
        >
          {isNumeric ? animated.toLocaleString() : value}
          {suffix ? (
            <span className="ml-0.5 text-[20px] font-bold">{suffix}</span>
          ) : null}
        </p>
        {(subHighlight || subLabel) && (
          <p
            className="font-body mt-1.5 flex items-center gap-1.5 truncate"
            style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.72)' }}
          >
            {subHighlight && (
              <span
                className="font-semibold shrink-0"
                style={{
                  fontSize: 10.5,
                  background: 'rgba(255,255,255,0.2)',
                  borderRadius: 5,
                  padding: '1px 6px',
                }}
              >
                {subHighlight}
              </span>
            )}
            {subLabel && <span className="truncate">{subLabel}</span>}
          </p>
        )}
      </div>
    </div>
  );
};

export default StatCard;

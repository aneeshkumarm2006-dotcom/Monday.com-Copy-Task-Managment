import { outcomeOf } from '../../../utils/goalDisplay';

/**
 * The percentage-of-the-gap-closed bar on a goal row.
 *
 * A div, not a charting library. Same construction as the group-header progress
 * bar in `TaskGroupHeader`, which is the house pattern for exactly this.
 *
 * `pct` is the server's clamped 0–100. `rawPct` may exceed it when a goal was
 * beaten; the bar still fills to 100 and the badge beside it carries the
 * over-delivery, because a bar that overflows its track reads as a rendering
 * bug rather than as good news.
 */
const GoalProgressBar = ({ pct, state, rawPct, height = 6 }) => {
  const meta = outcomeOf(state);
  const filled = typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : 0;
  const label =
    typeof pct === 'number'
      ? `${meta.label} — ${rawPct != null && rawPct !== pct ? `${rawPct}%` : `${pct}%`}`
      : 'Not reported yet';

  return (
    <div
      role="progressbar"
      aria-valuenow={typeof pct === 'number' ? pct : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      title={label}
      style={{
        height,
        width: '100%',
        minWidth: 48,
        background: 'var(--color-border)',
        borderRadius: 'var(--radius-full)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${filled}%`,
          height: '100%',
          background: meta.color,
          borderRadius: 'var(--radius-full)',
          transition: 'width 200ms ease-out',
        }}
      />
    </div>
  );
};

export default GoalProgressBar;

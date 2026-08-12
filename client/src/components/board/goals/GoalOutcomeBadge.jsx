import { outcomeOf } from '../../../utils/goalDisplay';

/**
 * Missed / Partial / Achieved / Exceeded, as a pill.
 *
 * "Exceeded" shows the real uncapped figure — beating a target by 50% is worth
 * seeing, even though the score itself is capped at 100 so one runaway goal
 * cannot paper over three failures in the month's average.
 */
const GoalOutcomeBadge = ({ state, rawPct }) => {
  const meta = outcomeOf(state);
  const showRaw = state === 'exceeded' && typeof rawPct === 'number';

  return (
    <span
      className="inline-flex items-center font-body shrink-0 whitespace-nowrap"
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: '2px 8px',
        borderRadius: 'var(--radius-full)',
        background: meta.bg,
        color: meta.color,
      }}
    >
      {showRaw ? `${meta.label} · ${Math.round(rawPct)}%` : meta.label}
    </span>
  );
};

export default GoalOutcomeBadge;

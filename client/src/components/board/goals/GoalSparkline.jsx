import { formatGoalValue } from '../../../utils/goalDisplay';

/**
 * A goal's own actual values over the last few months.
 *
 * Inline SVG, not recharts: at 60x18 with no axes, no tooltip and no legend
 * there is nothing a charting library would add, and a ResponsiveContainer in a
 * table cell forces a layout measurement on every row.
 *
 * Renders NOTHING below two points. A single-point line is a lie — it draws a
 * flat trend from data that has no trend in it.
 *
 * Goals are matched across months by name within their group, so renaming a
 * goal starts a new series. That is a known limit rather than a bug: without a
 * stable identity carried forward there is nothing else to join on.
 */
const GoalSparkline = ({ history = [], goal, width = 60, height = 18 }) => {
  const points = history.filter((h) => typeof h.actual === 'number');
  if (points.length < 2) return null;

  const values = points.map((p) => p.actual);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;

  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (width - pad * 2);
    // Inverted: SVG y grows downward, and a bigger number should sit higher.
    const y = height - pad - ((p.actual - min) / span) * (height - pad * 2);
    return [x, y];
  });

  const last = coords[coords.length - 1];
  const title = points
    .slice()
    .reverse()
    .map((p) => `${p.monthKey}: ${formatGoalValue(p.actual, goal)}`)
    .join(' · ');

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`Recent values — ${title}`}
      className="shrink-0"
    >
      <title>{title}</title>
      <polyline
        fill="none"
        stroke="var(--color-text-muted)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={coords.map(([x, y]) => `${x},${y}`).join(' ')}
      />
      <circle cx={last[0]} cy={last[1]} r="2" fill="var(--color-accent)" />
    </svg>
  );
};

export default GoalSparkline;

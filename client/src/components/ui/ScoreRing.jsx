/**
 * A score as a donut.
 *
 * Hand-rolled SVG rather than recharts' RadialBarChart: that needs a
 * ResponsiveContainer, which needs a measured parent, and renders a whole chart
 * tree with legend and tooltip infrastructure — none of which survives being a
 * 28px element inside a table row. A donut is two circles and an arc.
 *
 * SVG presentation attributes resolve CSS custom properties, so the colour comes
 * straight from a token with no JS lookup.
 */
const bandColor = (pct) => {
  if (pct === null || pct === undefined) return 'var(--color-text-muted)';
  if (pct >= 100) return 'var(--color-status-done)';
  if (pct >= 50) return 'var(--color-status-working)';
  return 'var(--color-status-stuck)';
};

const ScoreRing = ({ pct, size = 44, stroke = 4, label }) => {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const has = typeof pct === 'number';
  const offset = has ? circumference * (1 - Math.min(100, Math.max(0, pct)) / 100) : circumference;
  const color = bandColor(has ? pct : null);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label || (has ? `Score ${pct} out of 100` : 'No score yet')}
      className="shrink-0"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--color-border)"
        strokeWidth={stroke}
      />
      {has && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          // Start the arc at twelve o'clock rather than three.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 300ms ease-out' }}
        />
      )}
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fill={has ? 'var(--color-text-primary)' : 'var(--color-text-muted)'}
        style={{
          fontSize: size * 0.3,
          fontWeight: 700,
          fontFamily: 'var(--font-display), sans-serif',
        }}
      >
        {has ? Math.round(pct) : '—'}
      </text>
    </svg>
  );
};

export default ScoreRing;

import { useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { formatMonthKey } from '../../../utils/monthKeys';

/**
 * Each group's monthly score over the last 6–12 months.
 *
 * This is the ONE visual here that earns a charting library: multiple series,
 * real axes, a hover crosshair, a tooltip, and responsive width. The row bars,
 * rings and sparklines are all hand-rolled SVG or divs, because recharts brings
 * nothing to a 60x18 box.
 *
 * Recharts was already a dependency but imported by no file in the app, so this
 * is the first chart in the codebase. It is lazy-loaded by the Goals tab so that
 * standard boards — and tracker boards on other tabs — never pay for it.
 *
 * Series colours come from the SAME cycle the board uses for group dots, so a
 * group's dot on the Board tab, its ring on this tab and its line here are one
 * colour.
 */
const SERIES_COLORS = [
  'var(--color-card-blue)',
  'var(--color-card-green)',
  'var(--color-card-orange)',
  'var(--color-card-purple)',
];

const GoalTrendChart = ({ trend, months, onChangeMonths }) => {
  // Recharts wants one flat object per x-point with a key per series.
  const data = useMemo(() => {
    if (!trend?.months) return [];
    return trend.months.map((monthKey, i) => {
      const row = { monthKey, label: formatMonthKey(monthKey).split(' ')[0] };
      for (const g of trend.groups || []) {
        row[g._id] = g.points[i]?.score ?? null;
      }
      return row;
    });
  }, [trend]);

  const groups = trend?.groups || [];
  const hasAnyPoint = groups.some((g) => g.points.some((p) => p.score !== null));

  return (
    <div
      className="p-4"
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3
          className="font-body font-medium"
          style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}
        >
          Score over time
        </h3>
        <div className="flex gap-1">
          {[6, 12].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onChangeMonths(m)}
              className="font-body"
              style={{
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 'var(--radius-full)',
                background: months === m ? 'var(--color-accent-light)' : 'transparent',
                color: months === m ? 'var(--color-accent-text)' : 'var(--color-text-secondary)',
                border: months === m ? 'none' : '1px solid var(--color-border)',
              }}
            >
              {m} months
            </button>
          ))}
        </div>
      </div>

      {!hasAnyPoint ? (
        <p
          className="font-body py-6 text-center"
          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
        >
          Once a couple of months have been scored, their trend shows up here.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="label"
              stroke="var(--color-text-muted)"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              domain={[0, 100]}
              stroke="var(--color-text-muted)"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={34}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-md)',
                fontSize: 12,
              }}
              formatter={(v) => (v === null ? '—' : `${v}%`)}
            />
            <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
            {groups.map((g, i) => (
              <Line
                key={g._id}
                type="monotone"
                dataKey={g._id}
                name={g.name}
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                // A month with no goals must show a GAP, not a straight line
                // implying the score held steady through it.
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
};

export default GoalTrendChart;

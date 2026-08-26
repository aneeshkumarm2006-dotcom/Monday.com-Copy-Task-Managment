import { useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { formatDay } from '../../../../utils/connectorFormat';

/**
 * One keyword's rank over every week we have stored.
 *
 * ---- This chart cannot be drawn from the provider --------------------------
 *
 * `project_position_info` returns exactly two points per keyword —
 * `old_position` and `new_position` — and there is no `keywords[].history` and
 * no tool in the manifest that exposes the "See Trend" view the product shows in
 * its own UI. The only series the API returns at all is the project-AGGREGATE
 * mean. So every point below came out of a week we polled and kept, and the
 * line simply does not exist anywhere else. That is why `ConnectorSnapshot` is
 * append-only and why a project that disappears at the provider is flagged
 * rather than deleted.
 *
 * ---- The two things a rank chart must get right ----------------------------
 *
 * THE AXIS IS INVERTED. Rank 1 is the best result and belongs at the TOP. A
 * default axis draws a domain climbing from #40 to #3 as a line falling off a
 * cliff, which is the exact opposite of what happened.
 *
 * A GAP IS NOT A ZERO. A week where the keyword did not rank in the top 100 is a
 * real answer, and it is plotted as a break in the line rather than as position
 * 0 — which would draw it as the best rank ever achieved — or as position 100,
 * which would invent a measurement nobody made. `connectNulls` is deliberately
 * off for the same reason: joining across the gap would imply we know what
 * happened in between.
 *
 * Lazy-loaded by the tab. Recharts is ~95KB and is the only charting library in
 * the app; a board sitting on any other tab must not pay for it. Same treatment
 * as `goals/GoalTrendChart.jsx`, which is the only other consumer.
 */
const KeywordTrendChart = ({ history }) => {
  // `|| []` is a fresh array each render; memoised so the mapping below is not
  // redone on every parent re-render.
  const points = useMemo(() => history?.points || [], [history]);

  const data = useMemo(
    () =>
      points.map((p) => ({
        periodKey: p.periodKey,
        label: formatDay(p.periodKey).replace(/ \d{4}$/, ''),
        // `null` breaks the line. See the header — this is the whole point.
        position: typeof p.position === 'number' ? p.position : null,
        ranked: p.ranked,
      })),
    [points]
  );

  const ranked = data.filter((d) => d.position !== null);
  const best = ranked.length ? Math.min(...ranked.map((d) => d.position)) : 1;
  const worst = ranked.length ? Math.max(...ranked.map((d) => d.position)) : 10;

  return (
    <div className="px-4 py-4" style={{ borderTop: '1px solid var(--color-border)' }}>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h4
          className="font-body font-medium truncate"
          style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
        >
          “{history.keyword}”
        </h4>
        <p
          className="font-body shrink-0"
          style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
        >
          {points.length} stored reading{points.length === 1 ? '' : 's'}
        </p>
      </div>

      {ranked.length < 2 ? (
        <p
          className="font-body"
          style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
        >
          {points.length === 0
            ? 'No readings stored for this keyword yet.'
            : 'Only one reading so far — a line needs two. Ubersuggest collects rankings weekly, and this chart is built from what we have kept since the connector was switched on. There is no way to backfill it: the API returns two points per keyword and no history.'}
        </p>
      ) : (
        <div style={{ width: '100%', height: 200 }}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
                stroke="var(--color-border)"
              />
              <YAxis
                // INVERTED. Rank 1 at the top; see the header.
                reversed
                domain={[Math.max(1, best - 2), worst + 2]}
                allowDecimals={false}
                tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
                stroke="var(--color-border)"
              />
              <Tooltip
                formatter={(value) => [value === null ? 'Not in top 100' : `#${value}`, 'Rank']}
                labelFormatter={(label, payload) =>
                  formatDay(payload?.[0]?.payload?.periodKey) || label
                }
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 8,
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-bg-surface)',
                }}
              />
              <Line
                type="monotone"
                dataKey="position"
                stroke="var(--color-accent)"
                strokeWidth={2}
                dot={{ r: 3 }}
                // Off on purpose: bridging a week the domain did not rank would
                // draw a measurement nobody made.
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {points.some((p) => p.position === null) && (
        <p
          className="font-body mt-2"
          style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
        >
          A break in the line is a week this keyword did not rank in the top 100.
          That is an answer from Ubersuggest, not missing data.
        </p>
      )}
    </div>
  );
};

export default KeywordTrendChart;

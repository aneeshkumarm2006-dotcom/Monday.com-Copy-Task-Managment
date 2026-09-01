import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatDay } from '../../../../utils/connectorFormat';

/**
 * The two rank charts, in one lazily-loaded module.
 *
 * ---- Why it is lazy ---------------------------------------------------------
 *
 * Recharts is ~95 KB and it is the only charting library in the app. A board
 * sitting on the Board, Goals or Delivery tab must not download it, and neither
 * must somebody who opened this tab to read the Usage screen. Same treatment as
 * `goals/GoalTrendChart.jsx` and `connector/KeywordTrendChart.jsx`, which are
 * the only other consumers.
 *
 * ---- The two things a rank chart must get right ----------------------------
 *
 * THE AXIS IS INVERTED. Rank 1 is the best result and belongs at the TOP. A
 * default axis draws a domain climbing from #40 to #3 as a line falling off a
 * cliff — the exact opposite of what happened, rendered beautifully, on a chart
 * somebody is about to send to a client.
 *
 * A GAP IS NOT A ZERO. A week the domain did not rank inside the depth we bought
 * is a real answer, and it is drawn as a BREAK in the line — never as position 0
 * (which would read as the best rank ever achieved) and never as 100 (which
 * would invent a measurement nobody made). `connectNulls={false}` is the same
 * decision: joining across the gap implies we know what happened in between, and
 * we do not.
 *
 * ---- Why one module with a mode rather than two components -----------------
 *
 * Because the cost being managed is the IMPORT, not the component. Two lazy
 * modules from one library is two chunks that each pull recharts, or one shared
 * chunk plus the bookkeeping to arrange it. One module, one chunk, one decision.
 */

/** Shared axis and grid styling, so the two charts cannot drift apart. */
const axisProps = {
  tick: { fontSize: 11, fill: 'var(--color-text-muted)' },
  stroke: 'var(--color-border)',
};

const tooltipStyle = {
  fontSize: 12,
  borderRadius: 8,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-surface)',
};

/** A short axis label: "24 Aug" rather than "24 Aug 2026". */
const shortDay = (periodKey) => formatDay(periodKey).replace(/ \d{4}$/, '');

/**
 * One keyword's rank across every reading we have stored.
 *
 * This series does not exist anywhere else and cannot be backfilled. The
 * provider is a stateless billing API — it answers "where does this rank right
 * now" and remembers nothing — so every point below is a week we paid for and
 * kept. That is why `ConnectorSnapshot` is append-only and why a site that stops
 * being collected keeps its history.
 */
const KeywordChart = ({ history }) => {
  const points = useMemo(() => history?.points || [], [history]);

  const data = useMemo(
    () =>
      points.map((p) => ({
        periodKey: p.periodKey,
        label: shortDay(p.periodKey),
        // `null` breaks the line. See the header — this is the whole point.
        rank: typeof p.position === 'number' ? p.position : null,
        ranked: p.ranked,
      })),
    [points]
  );

  const ranked = data.filter((d) => d.rank !== null);
  const best = ranked.length ? Math.min(...ranked.map((d) => d.rank)) : 1;
  const worst = ranked.length ? Math.max(...ranked.map((d) => d.rank)) : 10;

  if (ranked.length < 2) {
    return (
      <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
        {points.length === 0
          ? 'No readings stored for this keyword yet.'
          : 'Only one reading so far — a line needs two. There is no way to backfill this: the provider answers where a keyword ranks right now and keeps no history, so the chart is built entirely from the collections we have kept.'}
      </p>
    );
  }

  return (
    <>
      <div style={{ width: '100%', height: 220 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -18 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis
              // INVERTED. Rank 1 at the top; see the header.
              reversed
              domain={[Math.max(1, best - 2), worst + 2]}
              allowDecimals={false}
              {...axisProps}
            />
            <Tooltip
              formatter={(value) => [value === null ? 'Not ranking' : `#${value}`, 'Rank']}
              labelFormatter={(labelText, payload) =>
                formatDay(payload?.[0]?.payload?.periodKey) || labelText
              }
              contentStyle={tooltipStyle}
            />
            <Line
              type="monotone"
              dataKey="rank"
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
      {points.some((p) => typeof p.position !== 'number') && (
        <p
          className="font-body mt-2"
          style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
        >
          A break in the line is a collection where this keyword did not rank
          inside the results we bought. That is an answer, not missing data.
        </p>
      )}
    </>
  );
};

/**
 * The site's average position, across every stored collection.
 *
 * The average is over the RANKING keywords only, and it is `null` for a
 * collection where none ranked. Averaging an unranked keyword in as 0 or as 101
 * both produce a number that moves for reasons nobody can explain, and a
 * "0.0 average position" on a client report is worse than a gap because it looks
 * like an answer.
 */
/**
 * The average position a stored collection reports — whoever computed it.
 *
 * Two providers answer this in two shapes and NEITHER is going to be renamed.
 * One puts a single `totals.averageRank` on the snapshot, computed over the
 * keywords that ranked. The other returns no aggregate at all on the totals and
 * instead ships `average_positions` — its OWN running series, of which the last
 * point is the reading for that collection.
 *
 * The two are not the same number and the difference is documented rather than
 * smoothed over: the second provider counts a keyword outside the top 100 as
 * +100 in its mean, so it cannot be reproduced from the ranks in its own table
 * and moves when a keyword leaves the measured depth. It is still the number
 * that provider publishes, and charting it beats charting nothing — but a line
 * mixing the two would be meaningless, which is fine here because one series is
 * one project on one provider.
 *
 * `typeof` rather than `??` throughout, for the reason stated everywhere else a
 * rank is read: a legitimate null is an answer, not an absent field.
 */
const averageOf = (point) => {
  const totals = point?.totals || {};
  if (typeof totals.averageRank === 'number') return totals.averageRank;

  const series = Array.isArray(point?.averagePositions) ? point.averagePositions : [];
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (typeof series[i]?.value === 'number') return series[i].value;
  }
  return null;
};

const TrendChart = ({ trend }) => {
  const data = useMemo(
    () =>
      (trend || []).map((point) => {
        const totals = point.totals || {};
        return {
          periodKey: point.periodKey,
          label: shortDay(point.periodKey),
          averageRank: averageOf(point),
          // Two providers spell this differently on the same shape; both mean
          // "how many of the tracked keywords ranked at all".
          ranking:
            typeof totals.ranked === 'number'
              ? totals.ranked
              : typeof totals.ranking === 'number'
                ? totals.ranking
                : null,
          top10: typeof totals.top10 === 'number' ? totals.top10 : null,
        };
      }),
    [trend]
  );

  const withAverage = data.filter((d) => d.averageRank !== null);
  if (withAverage.length < 2) {
    return (
      <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
        A trend needs two collections. This one fills in as the schedule runs.
      </p>
    );
  }

  const best = Math.min(...withAverage.map((d) => d.averageRank));
  const worst = Math.max(...withAverage.map((d) => d.averageRank));

  return (
    <div style={{ width: '100%', height: 220 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -18 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis
            // Inverted for the same reason the keyword chart is: an average
            // position improving from 24 to 11 must go UP.
            reversed
            domain={[Math.max(1, Math.floor(best) - 2), Math.ceil(worst) + 2]}
            {...axisProps}
          />
          <Tooltip
            formatter={(value) => [
              value === null ? 'Nothing ranked' : `#${value}`,
              'Average position',
            ]}
            labelFormatter={(labelText, payload) =>
              formatDay(payload?.[0]?.payload?.periodKey) || labelText
            }
            contentStyle={tooltipStyle}
          />
          <Line
            type="monotone"
            dataKey="averageRank"
            stroke="var(--color-accent)"
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

/**
 * @param {Object} props
 * @param {'keyword'|'trend'} props.mode
 * @param {Object} [props.history] - `{keyword, points[]}` for `keyword`
 * @param {Array} [props.trend]    - the compacted series for `trend`
 */
const RankChart = ({ mode, history, trend }) =>
  mode === 'keyword' ? <KeywordChart history={history} /> : <TrendChart trend={trend} />;

export default RankChart;

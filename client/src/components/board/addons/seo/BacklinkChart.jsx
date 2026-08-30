import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatDay, formatNumber } from '../../../../utils/connectorFormat';

/**
 * The two backlink charts, in one lazily-loaded module.
 *
 * Same treatment as `RankChart` and for the same reason: recharts is ~95 KB and
 * is the only charting library in the app, so a board sitting on the Board,
 * Goals or Delivery tab must not download it — and neither must somebody who
 * opened this tab to read the Usage screen. One module with a mode, so the two
 * charts are one chunk rather than two that each pull the library.
 *
 * ---- What a backlink chart must get right, and it is NOT the rank rules -----
 *
 * `RankChart` inverts its axis, because rank 1 is the best result and belongs at
 * the top. NEITHER CHART HERE IS INVERTED, and copying that would be the
 * plausible mistake: more backlinks is more, so up is up. A count axis drawn
 * upside down would render two years of link building as a collapse.
 *
 * What DOES carry over is the gap rule. A month the index has no reading for is
 * a BREAK in the line — `connectNulls={false}` — never a zero, which would read
 * as "every link disappeared and came back". The merge in
 * `backlinksNormalise.aggregateTimeseries` is what produces those honest holes:
 * the levels call and the flows call are bucketed on the same window but do not
 * always answer the same months, and they are merged on the day key rather than
 * zipped by index precisely so a missing bucket stays missing instead of
 * shifting the whole series by one month.
 */

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

/** A short axis label: "Aug 26" rather than "31 Aug 2026". */
const shortMonth = (day) => formatDay(day).replace(/^\d+ /, '').replace(/(\d{2})(\d{2})$/, '$2');

/**
 * The level series: how many links and referring domains there are, month by
 * month.
 */
const GrowthChart = ({ points }) => {
  const data = useMemo(
    () =>
      (points || []).map((p) => ({
        date: p.date,
        label: shortMonth(p.date),
        // `null` breaks the line. A month with no reading is not a month at zero.
        backlinks: p.backlinks,
        referringDomains: p.referringDomains,
      })),
    [points]
  );

  const measured = data.filter((d) => typeof d.backlinks === 'number');
  if (measured.length < 2) {
    return (
      <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
        A growth line needs two months of readings. This fills in as the index is
        collected.
      </p>
    );
  }

  return (
    <div style={{ width: '100%', height: 220 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="label" {...axisProps} />
          {/* NOT reversed. More links is more; see the header. */}
          <YAxis {...axisProps} tickFormatter={(v) => formatNumber(v, { compact: true })} />
          <Tooltip
            formatter={(value, name) => [
              formatNumber(value),
              name === 'backlinks' ? 'Backlinks' : 'Referring domains',
            ]}
            labelFormatter={(labelText, payload) =>
              formatDay(payload?.[0]?.payload?.date) || labelText
            }
            contentStyle={tooltipStyle}
          />
          <Line
            type="monotone"
            dataKey="backlinks"
            stroke="var(--color-accent)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="referringDomains"
            stroke="var(--color-text-muted)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

/**
 * The flow series: what arrived and what left, each month.
 *
 * ---- Why losses are drawn below the line -----------------------------------
 *
 * Because a stacked pair of positive bars answers "how much churn was there",
 * and the question somebody opens this panel with is "did we go forwards".
 * Mirrored around zero, a month that gained 900 and lost 850 looks like the
 * standstill it was, and the same two numbers stacked upwards look like a
 * banner month.
 *
 * The negation happens HERE and not in `backlinkRows.js`, because a CSV column
 * headed "lost backlinks" carrying -600 is a spreadsheet nobody can sum.
 */
const FlowChart = ({ points }) => {
  const data = useMemo(
    () =>
      (points || []).map((p) => ({
        date: p.date,
        label: shortMonth(p.date),
        newBacklinks: p.newBacklinks,
        lostBacklinks: typeof p.lostBacklinks === 'number' ? -p.lostBacklinks : null,
      })),
    [points]
  );

  const measured = data.filter(
    (d) => typeof d.newBacklinks === 'number' || typeof d.lostBacklinks === 'number'
  );
  if (!measured.length) {
    return (
      <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
        No new or lost links have been collected for this window yet.
      </p>
    );
  }

  return (
    <div style={{ width: '100%', height: 200 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -8 }} stackOffset="sign">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis
            {...axisProps}
            tickFormatter={(v) => formatNumber(Math.abs(v), { compact: true })}
          />
          <ReferenceLine y={0} stroke="var(--color-border-strong)" />
          <Tooltip
            formatter={(value, name) => [
              formatNumber(Math.abs(value)),
              name === 'newBacklinks' ? 'New links' : 'Lost links',
            ]}
            labelFormatter={(labelText, payload) =>
              formatDay(payload?.[0]?.payload?.date) || labelText
            }
            contentStyle={tooltipStyle}
          />
          <Bar dataKey="newBacklinks" fill="var(--color-card-green)" isAnimationActive={false} />
          <Bar dataKey="lostBacklinks" fill="#DC2626" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

const BacklinkChart = ({ mode, points }) =>
  mode === 'flows' ? <FlowChart points={points} /> : <GrowthChart points={points} />;

export default BacklinkChart;

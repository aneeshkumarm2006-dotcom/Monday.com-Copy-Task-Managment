import { AlertTriangle, CheckCircle2, Percent, TrendingDown } from 'lucide-react';
import StatCard from '../../ui/StatCard';

/**
 * The four tiles. Summed across every enabled tracker on the board, because the
 * question they answer is "how are we doing" not "how is this one rule doing" —
 * per-tracker numbers live in each section header.
 *
 * "At risk" is a miss COUNT rather than a percentage: a client with three missed
 * days is a conversation regardless of how long the window happens to be.
 */

const bucketOf = (missed) => (missed === 0 ? 'onTrack' : missed <= 2 ? 'slipping' : 'atRisk');

const rollUpBoard = (trackers = []) => {
  // A client is only as healthy as its worst tracker, so buckets are computed
  // per group across all trackers rather than summed per tracker — otherwise one
  // client appears in two buckets at once and the tiles do not add up.
  const missesByGroup = new Map();
  let met = 0;
  let required = 0;

  for (const tracker of trackers) {
    if (!tracker.enabled) continue;
    for (const row of tracker.rows || []) {
      const key = String(row.groupId);
      missesByGroup.set(key, (missesByGroup.get(key) || 0) + row.summary.missed);
      met += row.summary.met;
      required += row.summary.required;
    }
  }

  const buckets = { onTrack: 0, slipping: 0, atRisk: 0 };
  for (const missed of missesByGroup.values()) buckets[bucketOf(missed)] += 1;

  return {
    ...buckets,
    clientCount: missesByGroup.size,
    keptPct: required > 0 ? Math.round((met / required) * 100) : null,
    met,
    required,
  };
};

const DeliverySummary = ({ trackers }) => {
  const s = rollUpBoard(trackers);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <StatCard
        icon={CheckCircle2}
        color="green"
        label="On track"
        value={s.onTrack}
        subLabel="no misses in the window"
      />
      <StatCard
        icon={TrendingDown}
        color="orange"
        label="Slipping"
        value={s.slipping}
        subLabel="1–2 misses"
      />
      <StatCard
        icon={AlertTriangle}
        color="red"
        label="At risk"
        value={s.atRisk}
        subLabel="3 or more misses"
      />
      <StatCard
        icon={Percent}
        color="blue"
        label="Commitments kept"
        value={s.keptPct === null ? '—' : s.keptPct}
        suffix={s.keptPct === null ? '' : '%'}
        subLabel={
          s.required > 0 ? `${s.met} of ${s.required} periods` : 'nothing scored yet'
        }
      />
    </div>
  );
};

export default DeliverySummary;

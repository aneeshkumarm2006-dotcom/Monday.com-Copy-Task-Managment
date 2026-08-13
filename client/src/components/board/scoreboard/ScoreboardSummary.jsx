import { Users, Target, TrendingDown, Percent } from 'lucide-react';
import StatCard from '../../ui/StatCard';

/**
 * The four tiles, straight off the server's `totals`.
 *
 * `goalPct` here is scoreBoard() over EVERY group on the board, so it is the
 * same number the Goals tab shows for the same month. It is deliberately NOT a
 * mean of the people's scores — that is a mean of means, and it only coincides
 * when everyone happens to own the same number of groups.
 */
const ScoreboardSummary = ({ totals, monthLabel }) => {
  const goals = totals?.goalPct;
  const delivery = totals?.delivery || null;
  const achieved = totals?.counts?.achieved ?? 0;
  const exceeded = totals?.counts?.exceeded ?? 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <StatCard
        icon={Percent}
        color="blue"
        label="Board score"
        value={typeof goals === 'number' ? goals : '—'}
        suffix={typeof goals === 'number' ? '%' : ''}
        subLabel={
          totals?.totalGoals
            ? `across ${totals.groupsTotal} groups in ${monthLabel || 'this month'}`
            : 'no goals set for this month'
        }
      />
      <StatCard
        icon={Target}
        color="green"
        label="Goals achieved"
        value={achieved + exceeded}
        subLabel={
          exceeded > 0 ? `${achieved} achieved, ${exceeded} exceeded` : 'hit their target'
        }
      />
      <StatCard
        icon={TrendingDown}
        color="red"
        label="Missed deliveries"
        // A withheld delivery half shows a dash, never a zero: "nothing was
        // missed" and "you may not see this" are different facts.
        value={delivery ? delivery.missed : '—'}
        subLabel={
          delivery
            ? (delivery.required ? `of ${delivery.required} commitments` : 'nothing due yet')
            : 'you cannot see delivery on this board'
        }
      />
      <StatCard
        icon={Users}
        color="purple"
        label="People"
        value={totals?.peopleCount ?? 0}
        subLabel={
          totals?.groupsWithoutOwner
            ? `${totals.groupsWithoutOwner} group${totals.groupsWithoutOwner === 1 ? '' : 's'} unassigned`
            : 'every group has an owner'
        }
      />
    </div>
  );
};

export default ScoreboardSummary;

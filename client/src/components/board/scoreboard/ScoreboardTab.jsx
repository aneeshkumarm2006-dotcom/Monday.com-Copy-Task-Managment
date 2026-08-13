import { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, Info } from 'lucide-react';
import EmptyState from '../../ui/EmptyState';
import Spinner from '../../ui/Spinner';
import ScoreboardSummary from './ScoreboardSummary';
import PersonRow from './PersonRow';
import MissedLeaders from './MissedLeaders';
import * as scoreboardService from '../../../services/scoreboardService';
import { sortPeople, availableSorts } from '../../../utils/scoreboardSort';
import useTaskStore from '../../../store/taskStore';

/**
 * People — one month of a tracker board, per person.
 *
 * Architecture follows its two siblings, GoalsTab and DeliveryTab: NO Zustand
 * slice, because nothing outside this tab needs these rows. Component state plus
 * a debounced quiet refetch on the existing SSE `board.changed` signal.
 *
 * A 403/404 renders as an EmptyState carrying the server's own sentence rather
 * than a toast — "you cannot see this" is information, not an error.
 *
 * Everything on screen is computed server-side. This file sorts and lays out; it
 * does not add up a single number, which is what keeps a person's score and the
 * Goals tab's score the same arithmetic.
 */
const ScoreboardTab = ({ boardId, monthKey, monthLabel, onOpenGroup }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState('score');
  const [expanded, setExpanded] = useState(() => new Set());

  const boardRefreshSignal = useTaskStore((s) => s.boardRefreshSignal);
  const boardRefreshTarget = useTaskStore((s) => s.boardRefreshTarget);

  const fetchScoreboard = useCallback(
    async ({ quiet = false } = {}) => {
      if (!boardId || !monthKey) return;
      if (!quiet) setLoading(true);
      try {
        setData(await scoreboardService.getScoreboard(boardId, monthKey));
        setError(null);
      } catch (err) {
        setError(
          err?.response?.data?.error || 'Could not load the scoreboard for this month.'
        );
      } finally {
        setLoading(false);
      }
    },
    [boardId, monthKey]
  );

  useEffect(() => { fetchScoreboard(); }, [fetchScoreboard]);

  // Debounced, same shape and same reason as the sibling tabs: five quick edits
  // must not fire five refetches.
  useEffect(() => {
    if (boardRefreshTarget !== boardId) return undefined;
    const t = setTimeout(() => fetchScoreboard({ quiet: true }), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRefreshSignal]);

  const hasDelivery = !!data?.sections?.delivery;
  const sorts = useMemo(() => availableSorts(hasDelivery), [hasDelivery]);
  const sorted = useMemo(() => sortPeople(data?.people || [], sortKey), [data, sortKey]);

  const toggle = (id) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center" style={{ padding: '64px 0' }}>
        <Spinner />
      </div>
    );
  }

  if (error) {
    return <EmptyState icon={Users} title="People" description={error} />;
  }

  if (!data) return null;

  const nobody = sorted.length === 0 && !data.unassigned;

  return (
    <div className="flex flex-col gap-4">
      {/* The month is still running, so these are a progress report and not a
          result. Without this line a screenshot taken on the 3rd reads as a
          verdict on the month. */}
      {data.partialMonth && (
        <div
          className="flex items-start gap-2.5"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--color-bg-subtle)',
            padding: '10px 14px',
          }}
        >
          <Info size={15} color="var(--color-text-muted)" aria-hidden="true" className="mt-0.5 shrink-0" />
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-secondary, var(--color-text-muted))' }}>
            <strong>{monthLabel || 'This month'} is still running.</strong>{' '}
            {data.totals?.totalGoals
              ? `${data.totals.totalGoals - (data.totals.counts?.untracked || 0)} of ${data.totals.totalGoals} goals reported so far`
              : 'No goals reported yet'}
            {data.range ? `, delivery counted to ${data.range.toDayKey}.` : '.'}
          </p>
        </div>
      )}

      {/* Without productivity.view_others the server returns only the caller's
          own row. Saying so is what stops a one-row table reading as a bug. */}
      {data.scope === 'self' && (
        <div
          className="flex items-start gap-2.5"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--color-bg-subtle)',
            padding: '10px 14px',
          }}
        >
          <Info size={15} color="var(--color-text-muted)" aria-hidden="true" className="mt-0.5 shrink-0" />
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-secondary, var(--color-text-muted))' }}>
            Showing your own results. Seeing everyone needs the “See other
            people’s productivity” permission.
          </p>
        </div>
      )}

      <ScoreboardSummary totals={data.totals} monthLabel={monthLabel} />

      {nobody ? (
        <EmptyState
          icon={Users}
          title="No groups yet"
          description="Once this board has groups with owners, their goals and delivery roll up here."
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="font-display font-bold" style={{ fontSize: 15 }}>
              {monthLabel || data.monthKey}
            </h3>
            <label className="flex items-center gap-2">
              <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                Sort by
              </span>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value)}
                className="font-body"
                style={{
                  fontSize: 12.5,
                  padding: '5px 8px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-surface, #FFFFFF)',
                  color: 'var(--color-text-primary)',
                }}
              >
                {sorts.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-2">
            {sorted.map((p) => (
              <PersonRow
                key={p.user?._id}
                person={p}
                // The rank is always the server's standing by score, never the
                // row's position under whatever sort is applied — otherwise the
                // badge would mean something different on every sort.
                rank={p.rank}
                hasDelivery={hasDelivery}
                expanded={expanded.has(p.user?._id)}
                onToggle={() => toggle(p.user?._id)}
                onOpenGroup={onOpenGroup}
              />
            ))}

            {/* Always last, and never sorted. "Nobody owns these three clients"
                is the most actionable line on the page, and it is a gap in
                coverage rather than a person who did badly. */}
            {data.unassigned && (
              <PersonRow
                person={data.unassigned}
                rank={null}
                isUnassigned
                hasDelivery={hasDelivery}
                expanded={expanded.has('unassigned')}
                onToggle={() => toggle('unassigned')}
                onOpenGroup={onOpenGroup}
              />
            )}
          </div>

          {hasDelivery && (
            <MissedLeaders
              people={data.people}
              unassigned={data.unassigned}
              monthLabel={monthLabel}
            />
          )}
        </>
      )}

      <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
        {/* Task.group is the CURRENT group, so moving a task between clients
            rewrites an old cell. A past month is therefore recomputed, not
            recalled — saying "computed now" is the honest framing. */}
        Computed now from this board’s live data
        {data.range ? ` · delivery ${data.range.fromDayKey} to ${data.range.toDayKey}` : ''}
        {data.timezone ? ` · ${data.timezone}` : ''}
      </p>
    </div>
  );
};

export default ScoreboardTab;

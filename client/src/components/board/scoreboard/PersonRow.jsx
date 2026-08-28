import { ChevronDown, ChevronRight, Users } from 'lucide-react';
import Avatar from '../../ui/Avatar';
import ScoreRing from '../../ui/ScoreRing';
import PersonGroups from './PersonGroups';
import { OUTCOME_META } from '../../../utils/goalDisplay';

/** The outcome chips, in the order the Goals tab uses them. */
const CHIPS = ['exceeded', 'achieved', 'partial', 'missed'];

const Chip = ({ state, count }) => {
  const meta = OUTCOME_META[state];
  if (!meta || !count) return null;
  return (
    <span
      className="inline-flex items-center font-body shrink-0"
      title={`${count} ${meta.label.toLowerCase()}`}
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 'var(--radius-full)',
        background: meta.bg,
        color: meta.color,
      }}
    >
      {count} {meta.label.toLowerCase()}
    </span>
  );
};

/**
 * One person, one month.
 *
 * Two things this row will not do, both deliberate:
 *
 *   It never shows a bare score. `reported / totalGoals` sits next to it always,
 *   because scoreGroup correctly EXCLUDES goals nobody has reported yet — so one
 *   goal filled in on the 3rd reads as 100% until you see it was 1 of 8. That is
 *   the same reasoning GoalsSummaryStrip carries for the board number.
 *
 *   It never shows a bare miss count. Someone owning eight groups accrues eight
 *   times the periods and tops a raw `missed` list by construction, so the count
 *   always travels with `of N` and the kept rate.
 */
const PersonRow = ({ person, rank, hasDelivery, expanded, onToggle, onOpenGroup, isUnassigned }) => {
  const { user, goals, delivery, evidence, flags } = person;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-surface, #FFFFFF)',
        overflow: 'hidden',
        // The Unassigned row is structural, not a competitor — muted so it reads
        // as a gap in coverage rather than as somebody performing badly.
        opacity: isUnassigned ? 0.85 : 1,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 text-left"
        style={{ padding: '12px 16px' }}
      >
        <Chevron size={16} color="var(--color-text-muted)" aria-hidden="true" className="shrink-0" />

        <span
          className="font-display font-bold tabular-nums shrink-0 hidden sm:inline"
          style={{ width: 22, fontSize: 13, color: 'var(--color-text-muted)' }}
        >
          {rank ?? ''}
        </span>

        {isUnassigned ? (
          <span
            className="flex items-center justify-center shrink-0"
            style={{
              width: 32, height: 32, borderRadius: 9999,
              border: '1px dashed var(--color-border)',
            }}
          >
            <Users size={15} color="var(--color-text-muted)" aria-hidden="true" />
          </span>
        ) : (
          <Avatar user={user} size={32} />
        )}

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span
              className="font-body font-semibold truncate"
              style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
            >
              {isUnassigned ? 'Unassigned' : user?.name}
            </span>
            {person.inOrg === false && (
              <span
                className="font-body shrink-0"
                style={{ fontSize: 10, color: 'var(--color-text-muted)' }}
              >
                former member
              </span>
            )}
            {flags?.tookOverThisMonth && !isUnassigned && (
              <span
                className="font-body shrink-0 hidden md:inline"
                title="Newly took over at least one of these groups this month"
                style={{ fontSize: 10, color: 'var(--color-text-muted)' }}
              >
                new this month
              </span>
            )}
          </span>
          <span
            className="font-body block truncate"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {person.groupCount} group{person.groupCount === 1 ? '' : 's'}
            {' · '}
            {goals.totalGoals
              ? `${goals.reported} of ${goals.totalGoals} goals reported`
              : 'no goals set'}
          </span>
        </span>

        <span className="hidden lg:flex items-center gap-1.5 shrink-0">
          {CHIPS.map((s) => <Chip key={s} state={s} count={goals.counts?.[s]} />)}
        </span>

        {hasDelivery && (
          <span className="shrink-0 text-right hidden sm:block" style={{ minWidth: 96 }}>
            <span
              className="font-display font-bold tabular-nums block"
              style={{
                fontSize: 15,
                color: delivery?.missed > 0
                  ? 'var(--color-status-stuck)'
                  : 'var(--color-text-muted)',
              }}
            >
              {delivery ? delivery.missed : '—'}
            </span>
            <span className="font-body block" style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>
              {delivery?.required
                ? `missed of ${delivery.required}`
                : 'nothing due'}
            </span>
          </span>
        )}

        {hasDelivery && (
          <span className="shrink-0 text-right hidden xl:block" style={{ minWidth: 72 }}>
            <span className="font-display font-bold tabular-nums block" style={{ fontSize: 15 }}>
              {typeof delivery?.keptPct === 'number' ? `${delivery.keptPct}%` : '—'}
            </span>
            <span className="font-body block" style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>
              kept
            </span>
          </span>
        )}

        {/*
          Coverage, not effort: how much of the finished work in the groups
          this person OWNED was connected to a goal. Orphans are the ones
          nobody said anything about — not a score, a to-do list for month end.
        */}
        {evidence && evidence.done > 0 && (
          <span className="shrink-0 text-right hidden xl:block" style={{ minWidth: 88 }}>
            <span
              className="font-display font-bold tabular-nums block"
              style={{
                fontSize: 15,
                color: evidence.orphaned > 0
                  ? 'var(--color-status-working)'
                  : 'var(--color-text-primary)',
              }}
            >
              {evidence.attributed}
            </span>
            <span className="font-body block" style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>
              {`of ${evidence.done} attached`}
            </span>
          </span>
        )}

        <ScoreRing
          pct={goals.pct}
          size={44}
          label={
            typeof goals.pct === 'number'
              ? `Goal score ${goals.pct} out of 100`
              : 'No goals reported yet'
          }
        />
      </button>

      {expanded && (
        <PersonGroups
          groups={person.groups}
          hasDelivery={hasDelivery}
          hasEvidence={!!evidence}
          onOpenGroup={onOpenGroup}
        />
      )}
    </div>
  );
};

export default PersonRow;

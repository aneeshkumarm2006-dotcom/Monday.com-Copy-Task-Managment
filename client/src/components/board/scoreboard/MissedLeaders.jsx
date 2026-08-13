import Avatar from '../../ui/Avatar';

/**
 * "Most missed deliveries" — a permanent panel, not a sort option.
 *
 * The ask was two questions at once: who achieved the most goals, and who is
 * most overdue. The table answers the first (it is ranked by score, because a
 * leaderboard whose top row means "worst" reads as a shaming board and gets
 * switched off). This panel answers the second, on the same screen, so neither
 * half is a click away.
 *
 * The bars are absolute misses because that is the question. The LABEL is always
 * "n of N", because absolute misses alone would rank workload: someone owning
 * eight groups accrues eight times the periods.
 *
 * `missed` here is the delivery meaning of overdue — a commitment whose grace
 * window closed with no qualifying evidence. Periods that are simply not due yet
 * are excluded upstream and never count against anyone.
 */
const MissedLeaders = ({ people = [], unassigned = null, monthLabel }) => {
  const rows = [...people, ...(unassigned ? [unassigned] : [])]
    .filter((p) => (p.delivery?.missed || 0) > 0)
    .sort((a, b) => b.delivery.missed - a.delivery.missed);

  if (rows.length === 0) {
    return (
      <div
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--color-surface, #FFFFFF)',
          padding: '16px 20px',
        }}
      >
        <h3 className="font-display font-bold" style={{ fontSize: 14 }}>
          Most missed deliveries
        </h3>
        <p className="font-body mt-1" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
          Nothing was missed in {monthLabel || 'this month'}.
        </p>
      </div>
    );
  }

  const worst = rows[0].delivery.missed;

  return (
    <div
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-surface, #FFFFFF)',
        padding: '16px 20px',
      }}
    >
      <h3 className="font-display font-bold" style={{ fontSize: 14 }}>
        Most missed deliveries
      </h3>
      <p className="font-body mt-0.5 mb-3" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
        Commitments whose grace window closed with nothing posted, in {monthLabel || 'this month'}.
      </p>

      <ul className="flex flex-col gap-2.5">
        {rows.map((p) => {
          const id = p.user?._id || 'unassigned';
          const pctOfWorst = Math.round((p.delivery.missed / worst) * 100);
          return (
            <li key={id} className="flex items-center gap-3">
              <span className="shrink-0">
                {p.user ? (
                  <Avatar user={p.user} size={24} />
                ) : (
                  <span
                    style={{
                      display: 'block', width: 24, height: 24, borderRadius: 9999,
                      border: '1px dashed var(--color-border)',
                    }}
                  />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span
                    className="font-body truncate"
                    style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}
                  >
                    {p.user?.name || 'Unassigned'}
                  </span>
                  <span
                    className="font-body tabular-nums shrink-0"
                    style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                  >
                    {p.delivery.missed} of {p.delivery.required}
                  </span>
                </span>
                <span
                  className="block mt-1"
                  style={{
                    height: 6,
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--color-bg-subtle)',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    className="block h-full"
                    style={{
                      width: `${pctOfWorst}%`,
                      background: 'var(--color-status-stuck)',
                      borderRadius: 'var(--radius-full)',
                      transition: 'width 300ms ease-out',
                    }}
                  />
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default MissedLeaders;

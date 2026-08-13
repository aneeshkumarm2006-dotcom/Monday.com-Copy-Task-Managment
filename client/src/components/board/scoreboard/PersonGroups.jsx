/**
 * The drill-down under a person's row: which groups those numbers came from.
 *
 * Its whole job is to make the row auditable rather than something you have to
 * take on trust. A leaderboard whose numbers cannot be traced back to specific
 * clients is a number people argue with; one that can be expanded is a number
 * people act on.
 */
const PersonGroups = ({ groups = [], hasDelivery, onOpenGroup }) => {
  if (groups.length === 0) return null;

  return (
    <div
      className="overflow-x-auto"
      style={{
        borderTop: '1px solid var(--color-border)',
        background: 'var(--color-bg-subtle)',
      }}
    >
      <table className="w-full" style={{ minWidth: 420, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Group', 'Goal score', ...(hasDelivery ? ['Missed'] : [])].map((h, i) => (
              <th
                key={h}
                scope="col"
                className="font-body font-medium uppercase"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.05em',
                  color: 'var(--color-text-muted)',
                  textAlign: i === 0 ? 'left' : 'right',
                  padding: '8px 16px',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g._id}>
              <td style={{ padding: '6px 16px' }}>
                {onOpenGroup ? (
                  <button
                    type="button"
                    onClick={() => onOpenGroup(g._id)}
                    className="font-body text-left hover:underline"
                    style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                  >
                    {g.name}
                  </button>
                ) : (
                  <span className="font-body" style={{ fontSize: 13 }}>{g.name}</span>
                )}
              </td>
              <td
                className="font-body tabular-nums"
                style={{
                  fontSize: 13, padding: '6px 16px', textAlign: 'right',
                  color: typeof g.goalPct === 'number'
                    ? 'var(--color-text-primary)'
                    : 'var(--color-text-muted)',
                }}
              >
                {typeof g.goalPct === 'number'
                  ? `${g.goalPct}%`
                  : (g.goalState === 'pending' ? 'not reported' : 'no goals')}
              </td>
              {hasDelivery && (
                <td
                  className="font-body tabular-nums"
                  style={{
                    fontSize: 13, padding: '6px 16px', textAlign: 'right',
                    color: g.missed > 0
                      ? 'var(--color-status-stuck)'
                      : 'var(--color-text-muted)',
                  }}
                >
                  {/* Always beside the denominator. A bare "4 missed" invites a
                      comparison between someone with 4 of 12 and someone with
                      4 of 200. */}
                  {g.required ? `${g.missed} of ${g.required}` : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default PersonGroups;

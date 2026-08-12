/**
 * "Here is where your tasks would land" — the histogram shown before converting
 * a board to the monthly type.
 *
 * Shared by the board header's Convert modal and the edit-board form, so the
 * two cannot drift into describing the same operation differently. The numbers
 * come from a real server-side dry run, not an estimate.
 */
const MonthSplitPreview = ({ preview, compact = false }) => {
  const months = preview?.months || [];
  if (months.length === 0) return null;
  const busiest = months.reduce((max, m) => Math.max(max, m.count), 0) || 1;

  return (
    <div>
      <p
        className="font-body font-medium mb-2"
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--color-text-secondary)',
        }}
      >
        {preview.total} task{preview.total === 1 ? '' : 's'} →
      </p>
      <div className="flex flex-col gap-1.5">
        {months.map((m) => (
          <div key={m.monthKey} className="flex items-center gap-3">
            <span
              className="font-body shrink-0 truncate"
              style={{
                fontSize: 12,
                width: compact ? 92 : 110,
                color: 'var(--color-text-primary)',
              }}
            >
              {m.label}
            </span>
            <div
              className="flex-1"
              style={{
                height: 8,
                background: 'var(--color-border)',
                borderRadius: 'var(--radius-full)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.max(2, (m.count / busiest) * 100)}%`,
                  height: '100%',
                  background: 'var(--color-accent)',
                }}
              />
            </div>
            <span
              className="font-body shrink-0 text-right"
              style={{ fontSize: 12, width: 40, color: 'var(--color-text-secondary)' }}
            >
              {m.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default MonthSplitPreview;

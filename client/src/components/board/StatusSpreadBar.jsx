/**
 * STATUS SPREAD BAR — one strip, every status in the group.
 *
 * Replaces the done-only progress bar in the group header. That bar answered
 * "how much is finished"; this one answers "where is everything", which is the
 * question you act on.
 *
 * Falls back to the old bar when `segments` is empty, so a caller that has not
 * been taught to compute a spread still renders exactly what it used to.
 *
 * Segment widths come from `statusSpread`, which uses largest-remainder
 * rounding so they sum to EXACTLY 100 — three equal statuses naively rounded
 * give 33+33+33 and leave a hairline of track showing at the end of the bar.
 */
const StatusSpreadBar = ({
  segments = [],
  total = 0,
  doneCount = 0,
  width = 110,
  height = 6,
}) => {
  const donePct = total === 0 ? 0 : Math.round((doneCount / total) * 100);

  // Nothing to say. An empty group gets an empty track rather than a bar that
  // implies 0% of something.
  if (total === 0) {
    return (
      <div
        aria-hidden="true"
        style={{
          width,
          height,
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-border)',
        }}
      />
    );
  }

  if (segments.length === 0) {
    return (
      <div
        role="progressbar"
        aria-valuenow={donePct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${doneCount} of ${total} done`}
        title={`${doneCount} of ${total} done`}
        style={{
          width,
          height,
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-border)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${donePct}%`,
            height: '100%',
            background: donePct === 100 ? 'var(--color-status-done)' : 'var(--color-accent)',
            transition: 'width 200ms ease-out',
          }}
        />
      </div>
    );
  }

  // "3 Done · 2 Working on it · 1 Stuck" — the whole bar in one tooltip, and
  // the same string is the accessible name, because a row of coloured
  // rectangles says nothing to a screen reader.
  const label = segments.map((s) => `${s.count} ${s.name}`).join(' · ');

  return (
    <div
      role="img"
      aria-label={`${label}. ${donePct}% done.`}
      title={label}
      className="flex"
      style={{
        width,
        height,
        borderRadius: 'var(--radius-full)',
        background: 'var(--color-border)',
        overflow: 'hidden',
      }}
    >
      {segments.map((s) => (
        <span
          key={s.id}
          aria-hidden="true"
          style={{
            width: `${s.pct}%`,
            // A status holding a single row of forty still has to be visible,
            // and 2.5% of 110px is under 3px. `minWidth` cannot break the sum
            // because the track clips and the segments are already flex items.
            minWidth: s.count > 0 ? 3 : 0,
            height: '100%',
            background: s.color,
            transition: 'width 200ms ease-out',
          }}
        />
      ))}
    </div>
  );
};

export default StatusSpreadBar;

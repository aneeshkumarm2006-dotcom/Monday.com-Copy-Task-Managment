import { AlertTriangle } from 'lucide-react';

/**
 * The persistent nag on a past month that never got its final numbers.
 *
 * Deliberately a banner rather than a lock. The user chose enforcement by
 * notification and visible flag, not by refusing to show the month: a score
 * that is incomplete should say so loudly and still be readable, because the
 * person who can fix it is often not the person looking at it.
 *
 * Only rendered for a month that is genuinely OVER — the current month having
 * blank results is just the middle of the month, not a failure.
 */
const UnclosedMonthBanner = ({ monthLabel, missingCount, onJumpToFirst }) => (
  <div
    className="flex items-start gap-3 p-3"
    style={{
      background: 'var(--color-status-working-bg)',
      border: '1px solid var(--color-status-working)',
      borderRadius: 'var(--radius-md)',
    }}
  >
    <AlertTriangle
      size={16}
      color="var(--color-status-working)"
      aria-hidden="true"
      className="shrink-0 mt-0.5"
    />
    <div className="flex-1 min-w-0">
      <p
        className="font-body font-medium"
        style={{ fontSize: 13, color: 'var(--color-status-working)' }}
      >
        {monthLabel} isn’t closed yet
      </p>
      <p
        className="font-body"
        style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
      >
        {missingCount} goal{missingCount === 1 ? ' is' : 's are'} still waiting on final
        numbers. Until they’re in, this month’s score is incomplete.
      </p>
    </div>
    {onJumpToFirst && (
      <button
        type="button"
        onClick={onJumpToFirst}
        className="font-body shrink-0 whitespace-nowrap"
        style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-status-working)' }}
      >
        Show me →
      </button>
    )}
  </div>
);

export default UnclosedMonthBanner;

import ScoreRing from '../../ui/ScoreRing';
import { OUTCOME_META } from '../../../utils/goalDisplay';

/**
 * The board-wide roll-up above the group sections.
 *
 * Ships `scoredCount` alongside the score deliberately. A weighted mean over
 * however many goals have been reported so far is easy to misread as final, and
 * "12 of 18 reported" is the sentence that stops someone screenshotting a
 * half-filled month into a client email.
 */
const TILES = ['achieved', 'exceeded', 'partial', 'missed'];

const GoalsSummaryStrip = ({ summary, monthLabel }) => {
  if (!summary) return null;
  const counts = summary.counts || {};
  const reported = summary.totalGoals - (counts.untracked || 0);

  // Two different sentences, and they were being told as one. A group holding
  // unreported goals is waiting on somebody; a group with no goals at all is
  // not — and on a board where most groups have never set any up, "24 groups
  // not counted yet" reads as twenty-four teams being late.
  const groupsEmpty = summary.groupsEmpty || 0;
  const groupsAwaiting = Math.max(
    0,
    (summary.groupsTotal || 0) - groupsEmpty - (summary.groupsScored || 0)
  );
  const plural = (n) => (n === 1 ? '' : 's');

  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center gap-4 p-4"
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      <div className="flex items-center gap-3 shrink-0">
        <ScoreRing pct={summary.pct} size={64} stroke={6} label={`Board score for ${monthLabel}`} />
        <div>
          <p
            className="font-body font-medium"
            style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}
          >
            Board score
          </p>
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {summary.totalGoals === 0
              ? 'No goals yet'
              : `${reported} of ${summary.totalGoals} goal${summary.totalGoals === 1 ? '' : 's'} reported`}
          </p>
          {groupsAwaiting > 0 && (
            <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {groupsAwaiting} group{plural(groupsAwaiting)} still to report
            </p>
          )}
          {groupsEmpty > 0 && (
            <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {groupsEmpty} group{plural(groupsEmpty)} {groupsEmpty === 1 ? 'has' : 'have'} no goals yet
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 flex-1">
        {TILES.map((key) => {
          const meta = OUTCOME_META[key];
          return (
            <div
              key={key}
              className="px-3 py-2"
              style={{ background: meta.bg, borderRadius: 'var(--radius-md)' }}
            >
              <p
                className="font-display font-bold"
                style={{ fontSize: 20, lineHeight: 1.1, color: meta.color }}
              >
                {counts[key] || 0}
              </p>
              <p
                className="font-body"
                style={{ fontSize: 11, color: meta.color, opacity: 0.9 }}
              >
                {meta.label}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default GoalsSummaryStrip;

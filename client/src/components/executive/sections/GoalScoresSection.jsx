import SectionFrame from '../SectionFrame';
import ScoreRing from '../../ui/ScoreRing';
import GoalsSummaryStrip from '../../board/goals/GoalsSummaryStrip';
import { formatMonthKey } from '../../../utils/monthKeys';

/**
 * GoalScoresSection — one board's goal roll-up for one month.
 *
 * Payload (`executiveHome.runGoalScores`):
 *   { boardId, boardName, monthKey, timezone, partialMonth,
 *     groups: [{ _id, name, summary }],   // summary = scoreGroup(...)
 *     summary }                           // summary = scoreBoard(...)
 *
 * ---- NOTHING HERE IS A NUMBER THIS FILE WORKED OUT ------------------------
 *
 * Every percentage and every count came off `utils/goalTypes.js` on the server,
 * which is the only scorer in the codebase and the reason the Goals tab and
 * this tile cannot disagree about a client. The same rule the composer states
 * for itself applies one layer up: if you find yourself dividing something here,
 * the number you want is already on the payload.
 *
 * `GoalsSummaryStrip` is fed the board summary UNCHANGED. It is the same
 * component the Goals tab draws above its group sections, so the roll-up an
 * executive glances at on the home page is pixel-for-pixel the one they will
 * see after clicking through — which is what stops "did the number change or
 * did the screen?" from ever being a question.
 *
 * ---- THE PER-GROUP ROWS ---------------------------------------------------
 *
 * `ScoreRing` and nothing else, because it is the app's ONE score colour scale
 * (>=100 done, >=50 working, else stuck, null muted) and a second one invented
 * here would mean amber meaning two things on one screen. It also draws `null`
 * as an empty ring rather than a zero, which is the distinction `scoreGroup`
 * goes out of its way to preserve: a client with no goals set is not a client
 * scoring nothing.
 *
 * Rows stay in the board's own group order rather than being sorted worst-first.
 * Sorting by score would make the tile better at triage and worse at everything
 * else — the row a person is looking for would move every month, and the order
 * would disagree with the Goals tab they open next.
 */

/**
 * The one line under a group's name.
 *
 * "3 of 5 reported" rather than a percentage repeated in words: the ring beside
 * it already carries the score, and the number that is NOT on the ring is how
 * much of the month has actually been filled in. A score of 62 over two
 * reported goals out of eight is a different conversation from 62 over eight.
 */
const reportedLine = (summary) => {
  const total = summary?.totalCount || 0;
  if (total === 0) return 'No goals yet';
  const reported = summary?.scoredCount || 0;
  return `${reported} of ${total} reported`;
};

const GoalScoresSection = ({ section }) => {
  const data = section?.data || {};
  const monthLabel = formatMonthKey(data.monthKey) || '';

  // The board name and the month, which together are the only context the
  // numbers need. `partialMonth` is the server's own flag and says the month is
  // still running — the same caveat the People scoreboard prints, and the
  // licence for a low score to be read as "so far" rather than as a verdict.
  const subtitle = [
    data.boardName,
    monthLabel,
    data.partialMonth ? 'month in progress' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <SectionFrame
      section={section}
      title="Goal scores"
      subtitle={subtitle || undefined}
      // The composer ships `data` alongside `empty` precisely so this can name
      // the month it found nothing in. "No goals" and "no goals IN SEPTEMBER"
      // are different pieces of news on a board that had plenty in August.
      emptyMessage={
        monthLabel ? `No goals were set for ${monthLabel}.` : 'No goals set for this month.'
      }
    >
      {() => (
        <div className="flex flex-col gap-4">
          <GoalsSummaryStrip summary={data.summary} monthLabel={monthLabel} />

          {(data.groups || []).length > 0 && (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 list-none p-0 m-0">
              {data.groups.map((group) => (
                <li
                  key={group._id}
                  className="flex items-center gap-3 min-w-0"
                  style={{
                    background: 'var(--color-bg-subtle)',
                    borderRadius: 'var(--radius-md)',
                    padding: '10px 12px',
                  }}
                >
                  <ScoreRing
                    pct={group.summary?.pct ?? null}
                    size={38}
                    stroke={4}
                    label={`${group.name} score for ${monthLabel}`}
                  />
                  <div className="min-w-0">
                    <p
                      className="font-body font-medium truncate"
                      style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                      title={group.name}
                    >
                      {group.name}
                    </p>
                    <p
                      className="font-body truncate"
                      style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                    >
                      {reportedLine(group.summary)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionFrame>
  );
};

export default GoalScoresSection;

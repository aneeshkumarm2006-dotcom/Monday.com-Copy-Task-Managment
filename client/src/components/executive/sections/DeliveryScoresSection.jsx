import SectionFrame from '../SectionFrame';
import DeliverySummary from '../../board/delivery/DeliverySummary';
import { formatMonthKey } from '../../../utils/monthKeys';

/**
 * DeliveryScoresSection — how well one board kept its commitments this month.
 *
 * Payload (`executiveHome.runDeliveryScores`):
 *   { boardId, boardName, monthKey, timezone, partialMonth,
 *     range: { fromDayKey, toDayKey } | null,
 *     trackers: [{ _id, name, enabled, rows: [{ groupId, groupName, summary }], summary }] }
 *
 * ---- THE PAYLOAD WAS SHAPED FOR `DeliverySummary`, SO USE IT --------------
 *
 * `DeliverySummary` is the four-tile roll-up the Delivery tab draws, and it
 * takes exactly `trackers` — an array of `{ enabled, rows: [{ groupId, summary }] }`.
 * The composer strips the per-cell grid off `evaluatePlans`' output and ships
 * the rest unchanged for precisely this reason: the tile and the tab are then
 * the same component reading the same numbers, and "on track / slipping / at
 * risk" cannot come to mean two things in one app.
 *
 * It does its own bucketing (a client is only as healthy as its WORST tracker,
 * so buckets are counted per group across every tracker rather than summed per
 * tracker), and that arithmetic must stay in the one place it already lives.
 * Passing `data.trackers` straight through is what keeps it there.
 *
 * ---- WHY THE WINDOW IS SPELLED OUT UNDERNEATH ----------------------------
 *
 * Delivery is a count of periods over a WINDOW, and the window here is the
 * month clamped to today — so a month still running shows a smaller
 * denominator than the same month will show on the 31st. Without the dates on
 * screen, "14 of 20 periods" looks like a fixed score that happens to be
 * mediocre rather than a running total. The board's Delivery tab has a date
 * range control saying the same thing; this is the one line that stands in for
 * it.
 *
 * The `overCap` case never reaches here: the composer turns a tracker too large
 * to evaluate into `state: 'unavailable'` carrying its own sentence, because on
 * a home page the Delivery tab's 400 would take the other seven sections down
 * with it.
 */

/**
 * The trackers that actually contributed to the tiles above.
 *
 * A disabled tracker yields no rows by design, and listing it beside the ones
 * that did would suggest its rules were part of the score. Named rather than
 * counted because "Daily check-in, Weekly report" tells somebody which promises
 * are being measured, and "2 trackers" tells them nothing.
 */
const activeTrackerNames = (trackers = []) =>
  trackers.filter((t) => t.enabled && (t.rows || []).length > 0).map((t) => t.name);

const DeliveryScoresSection = ({ section }) => {
  const data = section?.data || {};
  const monthLabel = formatMonthKey(data.monthKey) || '';

  const subtitle = [
    data.boardName,
    monthLabel,
    data.partialMonth ? 'month in progress' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const names = activeTrackerNames(data.trackers);

  return (
    <SectionFrame
      section={section}
      title="Delivery"
      subtitle={subtitle || undefined}
      // Two different absences land in `empty` and the sentence covers both
      // without guessing which: a board nobody has set delivery rules on, and a
      // board whose trackers are all switched off or cover no client. Either
      // way there is nothing to have kept, which is not the same as having
      // missed everything — and four confident zeroes would say the latter.
      emptyMessage={
        monthLabel
          ? `No delivery was scored for ${monthLabel}.`
          : 'No delivery has been scored for this month.'
      }
    >
      {() => (
        <div className="flex flex-col gap-3">
          <DeliverySummary trackers={data.trackers} />

          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            {data.range
              ? `${data.range.fromDayKey} to ${data.range.toDayKey}`
              : monthLabel}
            {names.length > 0 ? ` · ${names.join(', ')}` : ''}
          </p>
        </div>
      )}
    </SectionFrame>
  );
};

export default DeliveryScoresSection;

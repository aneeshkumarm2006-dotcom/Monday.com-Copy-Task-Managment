import SectionFrame from '../SectionFrame';
import { BudgetPacingPanel } from '../../board/adsbudget/BudgetBits';
import useMoney from '../../../hooks/useMoney';
import { dayKeyOfMonthKey } from '../../../utils/money';

/**
 * AdsBudgetPacingSection — spend against budget for one board this month.
 *
 * Payload (`executiveHome.runAdsBudgetPacing`):
 *   { boardId, boardName, monthKey, monthLabel, timezone, currency,
 *     window: { totalDays, elapsedDays, remainingDays, elapsedPct },
 *     platformCount,
 *     totals }   // rollUp(platform rows, window) — allocated, spent, usedPct,
 *                // projected, state, label, verdict
 *
 * ---- WHY THIS IS NOT `BudgetOverviewCard` ---------------------------------
 *
 * That card is two panels answering two questions: the month as one number on
 * the left, and how many PLATFORMS sit in each health state on the right. The
 * composer deliberately ships no platform rows — the tile draws a month, not a
 * table — so the right-hand panel would be handed `platforms={[]}` and would
 * print four confident zeroes under "Budget health". "0 Over Budget" is a
 * claim, and it would be a false one on a board with three platforms over
 * budget. An absence rendered as a measurement is the one failure mode a
 * glanceable page cannot afford.
 *
 * ---- SO IT IS THE CARD'S LEFT PANEL, THE SAME ONE ------------------------
 *
 * Literally the same component: `BudgetPacingPanel` in
 * `components/board/adsbudget/BudgetBits.jsx`, which the overview card also
 * renders. This section used to hold a second copy of that panel's markup, and
 * within one phase the two had already drifted — one of them said "this month
 * is over" where the other said "This month is over". A capital letter is the
 * cheap version of that failure; the expensive version is the two surfaces
 * wording a PROJECTION differently, on a page an executive reads figures off
 * and repeats in a meeting.
 *
 * Two props say everything that genuinely differs here. `framed={false}`,
 * because `SectionFrame` has already drawn the card this sits in and a card
 * inside a card is a border nobody asked for; and `note`, the platform count,
 * which the tab does not need because it has the table of platforms directly
 * underneath.
 *
 * Nothing in this file decides what amber means, computes a projection, or
 * formats money: `utils/adsBudgetPacing.js` did the first two, once, on the
 * server, and the shared panel does the third.
 */

const AdsBudgetPacingSection = ({ section }) => {
  const data = section?.data || {};
  const fx = useMoney();
  /**
   * The unit the composer resolved, else the workspace's. Never a literal
   * 'USD': that is what put a dollar sign on a rupee or CAD board's tile
   * whenever its Ads Budget currency had not been chosen.
   */
  const currency = data.currency || fx.baseCurrency || null;
  const subtitle = [data.boardName, data.monthLabel].filter(Boolean).join(' · ');

  /**
   * How many platform rows are behind the number. The tab prints the rows
   * themselves; a tile has room for the count and no more, and without it the
   * figures read as one budget rather than as several added together.
   */
  const platformNote = data.platformCount
    ? `${data.platformCount} platform${data.platformCount === 1 ? '' : 's'}`
    : null;

  /**
   * Converted, and from what — said once on the tile, the same line the board
   * tab prints under its stat cards. Dated by the tile's month, so the tile and
   * the tab quote the same rate for the same month rather than the tile
   * drifting to the latest one.
   */
  const conversion = fx.surfaceNote(currency, dayKeyOfMonthKey(data.monthKey));

  return (
    <SectionFrame
      section={section}
      title="Ads budget"
      subtitle={subtitle || undefined}
      // `unset` — nothing allocated and nothing spent — is the state the roster
      // exists to surface, and on a home tile it is an absence rather than a
      // confident $0 of $0.
      emptyMessage={
        data.monthLabel
          ? `No budgets have been set for ${data.monthLabel}.`
          : 'No budgets have been set for this month.'
      }
    >
      {() => (
        <BudgetPacingPanel
          totals={data.totals || {}}
          window={data.window || null}
          currency={currency}
          monthKey={data.monthKey || null}
          note={[platformNote, conversion].filter(Boolean).join(' · ') || null}
          framed={false}
        />
      )}
    </SectionFrame>
  );
};

export default AdsBudgetPacingSection;

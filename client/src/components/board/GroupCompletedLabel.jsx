import { Check } from 'lucide-react';
import { STATUS_COLORS } from '../../utils/priorityColors';

/**
 * GROUP COMPLETED LABEL — what a finished group says instead of its bar.
 *
 * An all-green spread bar is a fact stated in the one language a status bar
 * has, and it is the one state where the bar has nothing left to tell you:
 * there is no spread. So the board's own words take the slot instead —
 * "ONBOARDING COMPLETED" — and the colour goes from being the whole message to
 * being the reinforcement.
 *
 * The wording is `Board.groupCompletedLabel`, typed once per board. This
 * component never composes it, and in particular never builds it out of the
 * group's name: "BACKLOG COMPLETED" is exactly the sentence that rule exists
 * to prevent.
 *
 * COLOUR IS LOAD-BEARING and the obvious pick fails. `--color-status-done`
 * (#16A34A) on `--color-status-done-bg` is 3.15:1 — under the 4.5:1 that 11px
 * text needs, the same trap TaskGroupHeader already documents for the group
 * name. `deep` (#15803D) on that background is 4.79:1 and clears it. It is
 * also the green `statusSpread` paints the done segment with, so the pill is
 * literally the colour the bar was a frame ago.
 */
const GroupCompletedLabel = ({ label, total = 0 }) => (
  <span
    className="inline-flex items-center gap-1 font-body"
    // Two jobs: the count the bar's tooltip used to carry, and the full
    // wording when the pill is ellipsized inside the fixed-width slot.
    title={total > 0 ? `${label} — all ${total} done` : label}
    style={{
      maxWidth: '100%',
      minWidth: 0,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.02em',
      // Uppercased in CSS, not in the data. The stored string keeps the case
      // it was typed in, which is what a screen reader reads — all-caps in the
      // DOM makes some readers spell short words out letter by letter.
      textTransform: 'uppercase',
      lineHeight: 1.45,
      padding: '3px 9px',
      borderRadius: 'var(--radius-full)',
      background: STATUS_COLORS.done.bg,
      color: STATUS_COLORS.done.deep,
    }}
  >
    <Check size={11} strokeWidth={3} aria-hidden="true" className="shrink-0" />
    <span
      style={{
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  </span>
);

export default GroupCompletedLabel;

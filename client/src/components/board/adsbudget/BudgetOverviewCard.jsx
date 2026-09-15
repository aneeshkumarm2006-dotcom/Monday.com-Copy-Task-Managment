import { useMemo } from 'react';

import { stateMeta } from '../../../utils/adsBudgetDisplay';
import { BudgetPacingPanel } from './BudgetBits';

/**
 * Budget Overview — the card that answers "are we spending this at the right
 * speed", rather than "how much have we spent".
 *
 * ---- Two panels, two different questions -----------------------------------
 *
 * LEFT is the month as one number: how much of the budget is gone, where that
 * lands by month end at the current rate, and whether the calendar agrees.
 * RIGHT is the same month broken down by how many platforms are in each state,
 * which is the "where do I look first" question — a client can be healthy
 * overall and still have one channel a fortnight ahead of itself.
 *
 * ---- The left panel is SHARED, not owned --------------------------------
 *
 * It is `BudgetPacingPanel` in `BudgetBits.jsx`, because the executive home
 * page draws the same block as a tile of its own — only the left half, since
 * the composer ships no platform rows for the health panel to count. Two copies
 * of a panel that quotes money is how one screen comes to word a projection
 * differently from another; that file's header carries the full argument,
 * including why the projection and the pacing verdict are allowed to disagree.
 *
 * Nothing here computes either one. `utils/adsBudgetPacing.js` does, once, on
 * the server.
 */

/** The states the health panel counts, in the order it lists them. */
const HEALTH_ROWS = [
  { key: 'on_track', label: 'On Track' },
  { key: 'ahead', label: 'Needs Attention' },
  { key: 'behind', label: 'Low Spend' },
  { key: 'over', label: 'Over Budget' },
];

const BudgetOverviewCard = ({ totals, window: win, monthLabel, currency, platforms = [] }) => {
  /**
   * How many platforms are in each state.
   *
   * `at_risk` is folded into "Needs Attention" because that is the row's own
   * chip label — splitting them here would list a state the tables never name.
   * Draft, paused and unset rows are counted in none of the four: they are not
   * a health verdict, they are a row nobody has switched on.
   */
  const health = useMemo(() => {
    const counts = { on_track: 0, ahead: 0, behind: 0, over: 0 };
    for (const p of platforms) {
      const key = p.state === 'at_risk' ? 'ahead' : p.state;
      if (key in counts) counts[key] += 1;
    }
    return counts;
  }, [platforms]);

  return (
    <section>
      <header className="mb-3">
        <h3
          className="font-display font-semibold"
          style={{ fontSize: 15, color: 'var(--color-text-primary)' }}
        >
          Budget overview
        </h3>
        <p className="font-body mt-0.5" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
          {monthLabel}
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* ---- The month as one number ------------------------------------ */}
        {/* The class rides on the panel itself rather than on a wrapper: a grid
            child has to be the element the column span is written on, and a div
            in between would collapse the panel to one column. */}
        <BudgetPacingPanel
          totals={totals}
          window={win}
          currency={currency}
          className="lg:col-span-2"
        />

        {/* ---- Where to look first ---------------------------------------- */}
        <div
          style={{
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            padding: '18px 20px',
          }}
        >
          <p
            className="font-body font-medium"
            style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
          >
            Budget health
          </p>
          <p className="font-body mt-0.5" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            Current allocation status
          </p>

          <ul className="mt-4 flex flex-col gap-2.5">
            {HEALTH_ROWS.map((row) => {
              const count = health[row.key];
              const rowMeta = stateMeta(row.key);
              return (
                <li key={row.key} className="flex items-center justify-between gap-3">
                  <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                    {row.label}
                  </span>
                  {/* A zero is muted rather than coloured. "No platforms are
                      over budget" is good news and colouring it red says the
                      opposite at a glance, which is the only speed this panel
                      is read at. */}
                  <span
                    className="font-display font-semibold tabular-nums"
                    style={{
                      fontSize: 14,
                      color: count > 0 ? rowMeta.color : 'var(--color-text-muted)',
                    }}
                  >
                    {count}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
};

export default BudgetOverviewCard;

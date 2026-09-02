import { useMemo } from 'react';

import { formatMoney } from '../../../utils/connectorFormat';
import { formatPct, stateMeta } from '../../../utils/adsBudgetDisplay';
import { BudgetBar } from './BudgetBits';

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
 * ---- Why the projection and the pacing verdict can disagree -----------------
 *
 * They measure different things and the labels say so. "Healthy pacing" is
 * about the drift SO FAR: spend is within 15 points of the fraction of the
 * month that has elapsed. "Over budget by X at this rate" is about the FINISH:
 * a straight-line run rate carried to month end. A month can be inside the band
 * today and still finish over, and the two lines sitting apart in the card —
 * projection top-right, verdict bottom-left — is what keeps that legible rather
 * than contradictory.
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
  const meta = stateMeta(totals.state, totals.label);
  const money = (v) => formatMoney(v, currency);

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

  const overBy =
    typeof totals.projected === 'number' && totals.allocated > 0
      ? totals.projected - totals.allocated
      : null;

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
        <div
          className="lg:col-span-2 flex flex-col gap-4"
          style={{
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            padding: '18px 20px',
          }}
        >
          <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
            <div className="min-w-0">
              <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
                Budget utilized
              </p>
              <p
                className="font-display font-bold mt-1"
                style={{ fontSize: 28, lineHeight: 1.1, color: 'var(--color-text-primary)' }}
              >
                {formatPct(totals.usedPct)}
              </p>
              <p className="font-body mt-1 tabular-nums" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
                {money(totals.spent)} / {money(totals.allocated)}
              </p>
            </div>

            <div className="min-w-0">
              <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
                Projected month-end
              </p>
              <p
                className="font-display font-bold mt-1"
                style={{ fontSize: 28, lineHeight: 1.1, color: 'var(--color-text-primary)' }}
              >
                {totals.projected === null ? '—' : money(totals.projected)}
              </p>
              {/* Green under, amber over — never red. Red is reserved for money
                  ALREADY spent past the budget; this is a forecast, and a
                  forecast painted as a failure stops being read as a forecast. */}
              <p
                className="font-body mt-1"
                style={{
                  fontSize: 12.5,
                  color:
                    overBy === null
                      ? 'var(--color-text-muted)'
                      : overBy > 0
                        ? 'var(--color-status-working)'
                        : 'var(--color-status-done)',
                }}
              >
                {overBy === null
                  ? 'Not enough of the month has run'
                  : overBy > 0
                    ? `Over budget by ${money(overBy)} at this rate`
                    : `Under budget by ${money(Math.abs(overBy))} at this rate`}
              </p>
            </div>
          </div>

          <BudgetBar
            usedPct={totals.usedPct}
            state={totals.state}
            label={totals.label}
            marker={win?.elapsedPct}
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-body font-medium" style={{ fontSize: 13, color: meta.color }}>
              {totals.verdict}
            </span>
            <span className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
              {win && win.remainingDays > 0
                ? `${win.remainingDays} day${win.remainingDays === 1 ? '' : 's'} remaining`
                : 'This month is over'}
            </span>
          </div>
        </div>

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

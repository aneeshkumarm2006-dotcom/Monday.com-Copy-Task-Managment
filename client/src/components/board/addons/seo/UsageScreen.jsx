import { useMemo } from 'react';
import { AlertTriangle, Clock, Hourglass, Share2, Wallet } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import { SkeletonText } from '../../../ui/Skeleton';
import { MiniChip } from '../../../ui/FilterControls';
import { ScrollTable, Stat, StatRow, Td, Th } from '../connector/SectionShell';
import { formatMoney, formatNumber, staleness } from '../../../../utils/connectorFormat';
import { marketLabel } from '../../../../utils/connectorFormat';

/**
 * Usage & spend — what this board's collections cost, and what is still owed.
 *
 * ---- Why this screen exists at all -----------------------------------------
 *
 * The first connector had a quota: finite, shared, and reset by somebody else on
 * a schedule we do not control. This one has a BILL. Money leaves at the moment
 * a collection is ordered, against one account shared by every organisation on
 * it, and the only thing standing between a misconfigured cadence and a real
 * invoice is a cap in our own database. A cap nobody can see is a cap nobody
 * maintains, which is why this screen cannot be switched off per board.
 *
 * ---- The distinction the copy must not blur --------------------------------
 *
 * THERE ARE TWO RUNNERS AND ONLY ONE OF THEM CAN SPEND.
 *
 *   `17 * * * *`     decides what is stale enough to BUY, and buys it.
 *   `*&#47;10 * * * *`   collects results already paid for, behind a transport that
 *                    refuses every endpoint that is not free.
 *
 * So a "last collected" line must never read as "last charged". The money is
 * `costUsd` on a task and the counters on `ConnectorBudget`; the collection time
 * is when WE observed a result and is diagnostics. Both are shown, and they are
 * shown in different places with different words, because merging them would
 * credit the free runner with the spend.
 *
 * ---- Nothing here contacts the provider ------------------------------------
 *
 * Including the balance. `/v3/appendix/user_data` is free and returns the live
 * account balance, and it is the wrong number twice: it is the WHOLE SHARED
 * ACCOUNT across every tenant, and a read endpoint that reaches a third party is
 * one open tab away from being rate-limited.
 */

/** "2026-09" → "Sep 2026". */
const monthLabel = (periodKey) => {
  if (!/^\d{4}-\d{2}$/.test(String(periodKey || ''))) return periodKey || '';
  const [y, m] = periodKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

/**
 * How much of a cap is used, as a bar.
 *
 * The alert threshold is drawn as a notch rather than by recolouring the whole
 * bar at 80%: the bar's job is "how full", and a colour that changes at a
 * configurable point makes two different facts share one channel.
 */
const BudgetBar = ({ budget, alertAtPct }) => {
  if (!budget || !budget.capUsd) return null;
  const pct = Math.min(100, Math.max(0, budget.usedPct ?? 0));
  const over = budget.usedPct !== null && budget.usedPct >= (alertAtPct || 80);

  return (
    <div className="mt-2">
      <div
        style={{
          position: 'relative',
          height: 8,
          borderRadius: 999,
          background: 'var(--color-bg-subtle)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 999,
            background: over ? '#DC2626' : 'var(--color-accent)',
            transition: 'width 200ms ease',
          }}
        />
      </div>
      <div className="flex items-baseline justify-between gap-2 mt-1">
        <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          {formatMoney(budget.committedUsd)} of {formatMoney(budget.capUsd)} committed
        </p>
        <p
          className="font-body"
          style={{
            fontSize: 11.5,
            color: over ? '#DC2626' : 'var(--color-text-muted)',
          }}
        >
          {budget.usedPct === null ? '—' : `${budget.usedPct}%`}
        </p>
      </div>
    </div>
  );
};

/**
 * The cross-tenant cache measurement — phase 11's whole reason for being here.
 *
 * ---- Why a spend screen carries an architecture decision -------------------
 *
 * The plan gates a shared SERP cache on a MEASURED hit rate: "build this only if
 * that number justifies four structural complications". Phase 2 logged the
 * number to stdout, which is not somewhere anybody reads a year later, and logged
 * it only when it was non-zero — so it recorded hits and threw the denominator
 * away, and the denominator is half of a rate.
 *
 * So the number lives here, beside the spend it would be a discount on, next to
 * the threshold it is being compared against, PER KIND. Per kind because
 * `movement` is bought at a tenth of `positions`' depth and saves a tenth per
 * hit; one blended percentage would describe neither.
 *
 * Nothing in this panel names a keyword or another workspace. The count of other
 * tenants is a count; "who" is deliberately not collected, because "is anyone
 * else tracking this keyword" is the competitive intelligence the whole feature
 * is careful about.
 */
const VERDICT = {
  clears: {
    label: 'Clears the bar',
    tone: 'var(--color-card-green)',
    say: 'the saving is worth the four structural complications',
  },
  below: {
    label: 'Below the bar',
    tone: 'var(--color-text-muted)',
    say: 'the saving does not pay for a permanent cross-tenant data path',
  },
  insufficient: {
    label: 'Not enough yet',
    tone: 'var(--color-text-muted)',
    say: 'a rate read off a handful of collections is not a rate',
  },
};

/** A 0-1 fraction as a percentage, or an em dash. NEVER 0 for "unknown". */
const asPct = (rate) =>
  rate === null || rate === undefined ? '—' : `${Math.round(rate * 1000) / 10}%`;

const Panel = ({ title, subtitle, children, actions }) => (
  <section
    style={{
      background: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
    }}
  >
    <header
      className="flex flex-wrap items-start gap-3 px-4 py-3"
      style={{ borderBottom: '1px solid var(--color-border)' }}
    >
      <div className="flex-1 min-w-0">
        <h3
          className="font-body font-medium"
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--color-text-secondary)',
          }}
        >
          {title}
        </h3>
        {subtitle && (
          <p className="font-body mt-1" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
    {children}
  </section>
);

const UsageScreen = ({ usage, loading, data, label }) => {
  const ledger = usage?.ledger || null;
  /** Phase 11: the measurement the cross-tenant cache is gated on. */
  const cache = ledger?.cache || null;

  const maxMonthSpend = useMemo(
    () =>
      Math.max(
        0.000001,
        ...(ledger?.months || []).map((m) => (m.spentUsd || 0) + (m.reservedUsd || 0))
      ),
    [ledger]
  );

  if (loading && !usage) {
    return (
      <div className="flex flex-col gap-3">
        <SkeletonText width="100%" height={90} />
        <SkeletonText width="100%" height={160} />
      </div>
    );
  }

  if (!usage) {
    return (
      <EmptyState
        icon={Wallet}
        title="Spend is not available right now"
        description={`We could not read this board’s ${label} ledger. Nothing has been spent by trying — this screen reads our own database.`}
      />
    );
  }

  const { orgBudget, boardBudget, board, canManage } = usage;

  return (
    <div className="flex flex-col gap-4">
      {ledger?.sandbox && (
        <p
          className="flex items-start gap-2 px-4 py-2.5 font-body"
          style={{
            fontSize: 12.5,
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text-secondary)',
          }}
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            This deployment is pointed at {label}&rsquo;s sandbox, where every
            call is free and the data is not real. Nothing below has cost
            anything, and nothing below is a ranking anybody should report.
          </span>
        </p>
      )}

      {/* ---- The ceilings ---------------------------------------------------- */}
      <Panel
        title="This month"
        subtitle={
          canManage
            ? 'The workspace cap is what actually stops a collection. A board allocation is a share of it, not a second ceiling.'
            : 'What this board is allowed to consume. The workspace cap is only visible to somebody who can manage connectors.'
        }
      >
        <StatRow>
          <Stat
            label="Spent this month"
            // From `DfsTask.costUsd`, summed over the months on screen — money
            // that has actually left, filed under the month it was CHARGED.
            value={formatMoney(ledger?.months?.[0]?.spentUsd ?? 0)}
            sub={`${formatNumber(ledger?.months?.[0]?.tasks ?? 0)} collections ordered`}
          />
          <Stat
            label="In flight"
            value={formatNumber(ledger?.queued ?? 0)}
            sub="bought, not yet delivered"
          />
          <Stat
            label="Board allocation"
            // Null renders as an em dash, and that is the honest answer: no
            // allocation is the normal state and means "bounded by the org cap
            // like everything else", not "zero".
            value={
              board?.allocationUsd === null || board?.allocationUsd === undefined
                ? '—'
                : formatMoney(board.allocationUsd)
            }
            sub={
              board?.allocationUsd
                ? `warn at ${board.alertAtPct}%`
                : 'bounded by the workspace cap'
            }
          />
          <Stat
            label="Cadence"
            value={
              board?.intervalHours ? `${board.intervalHours}h` : 'Default'
            }
            sub={
              board?.intervalHours
                ? 'this board’s override'
                : `${data?.provider?.syncIntervalHours ?? 168}h from the provider`
            }
          />
        </StatRow>

        <div
          className="px-4 py-3 flex flex-wrap gap-6"
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          {canManage && (
            <div className="flex-1" style={{ minWidth: 240 }}>
              <p
                className="font-body font-medium"
                style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}
              >
                Workspace cap
              </p>
              {orgBudget ? (
                <BudgetBar budget={orgBudget} alertAtPct={80} />
              ) : (
                <p
                  className="font-body mt-1"
                  style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                >
                  {/* The row is minted at the first reservation. Reading one
                      into existence here would stamp today's default cap onto a
                      month that has not started spending. */}
                  Nothing has been ordered this month, so no cap has been drawn
                  against yet.
                </p>
              )}
            </div>
          )}

          <div className="flex-1" style={{ minWidth: 240 }}>
            <p
              className="font-body font-medium"
              style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}
            >
              This board&rsquo;s allocation
            </p>
            {boardBudget ? (
              <BudgetBar budget={boardBudget} alertAtPct={board?.alertAtPct} />
            ) : (
              <p
                className="font-body mt-1"
                style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
              >
                No allocation set. This board draws on the workspace cap like
                every other.
              </p>
            )}
          </div>
        </div>
      </Panel>

      {/* ---- The two clocks -------------------------------------------------- */}
      <Panel
        title="The two runners"
        subtitle="One of them can spend money. The other cannot, by construction."
      >
        <ul>
          {(ledger?.runners || []).map((runner) => (
            <li
              key={runner.key}
              className="flex flex-wrap items-start gap-3 px-4 py-3"
              style={{ borderBottom: '1px solid var(--color-border)' }}
            >
              <Clock
                size={15}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
                style={{ color: 'var(--color-text-muted)' }}
              />
              <div className="flex-1 min-w-0">
                <p
                  className="font-body font-medium"
                  style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                >
                  {runner.label}{' '}
                  <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>
                    · {runner.everyLabel}
                  </span>
                </p>
                <p
                  className="font-body mt-0.5"
                  style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                >
                  {runner.blurb}
                </p>
              </div>
              <MiniChip
                bg={runner.spends ? 'var(--color-bg-subtle)' : 'var(--color-bg-subtle)'}
                text={runner.spends ? '#DC2626' : 'var(--color-card-green)'}
              >
                {runner.spends ? 'Can spend' : 'Free'}
              </MiniChip>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-6 px-4 py-3">
          <div>
            <p
              className="font-body"
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--color-text-muted)',
              }}
            >
              Last charged
            </p>
            <p className="font-body mt-0.5" style={{ fontSize: 13 }}>
              {/* `postedAt`, because that is when the money left. */}
              {ledger?.lastPostedAt ? staleness(ledger.lastPostedAt) : '—'}
            </p>
          </div>
          <div>
            <p
              className="font-body"
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--color-text-muted)',
              }}
            >
              Last result observed
            </p>
            <p className="font-body mt-0.5" style={{ fontSize: 13 }}>
              {/* `readyAt`, and it is NOT a charge. Captioned separately for
                  exactly that reason — the runner that produces this timestamp
                  is the one that cannot spend. */}
              {ledger?.lastObservedAt ? staleness(ledger.lastObservedAt) : '—'}
            </p>
          </div>
          <div className="flex-1" />
          <p
            className="font-body self-end"
            style={{ fontSize: 11.5, maxWidth: 420, color: 'var(--color-text-muted)' }}
          >
            &ldquo;Observed&rdquo; is when the free sweep found a finished result,
            not when it was paid for. The two are hours apart and only the first
            one costs anything.
          </p>
        </div>
      </Panel>

      {/* ---- Spend by month -------------------------------------------------- */}
      <Panel
        title="Spend by month"
        subtitle="Filed under the month a collection was ORDERED, because that is when the charge happens."
      >
        {!ledger?.months?.length ? (
          <p
            className="font-body px-4 py-4"
            style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
          >
            Nothing ordered yet.
          </p>
        ) : (
          <ul className="px-4 py-3 flex flex-col gap-2">
            {ledger.months.map((month) => {
              const total = (month.spentUsd || 0) + (month.reservedUsd || 0);
              return (
                <li key={month.periodKey} className="flex items-center gap-3">
                  <span
                    className="font-body shrink-0"
                    style={{ width: 72, fontSize: 12, color: 'var(--color-text-muted)' }}
                  >
                    {monthLabel(month.periodKey)}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      height: 8,
                      borderRadius: 999,
                      background: 'var(--color-bg-subtle)',
                      overflow: 'hidden',
                      display: 'block',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        width: `${Math.round((total / maxMonthSpend) * 100)}%`,
                        height: '100%',
                        borderRadius: 999,
                        background: 'var(--color-accent)',
                      }}
                    />
                  </span>
                  <span
                    className="font-body shrink-0 text-right"
                    style={{ width: 90, fontSize: 12.5 }}
                  >
                    {formatMoney(month.spentUsd)}
                  </span>
                  <span
                    className="font-body shrink-0 text-right"
                    style={{ width: 110, fontSize: 11.5, color: 'var(--color-text-muted)' }}
                  >
                    {month.reservedUsd
                      ? `${formatMoney(month.reservedUsd)} held`
                      : `${formatNumber(month.keywords)} keywords`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {ledger?.byKind?.length > 0 && (
          <ScrollTable maxHeight={200}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th>What was bought</Th>
                  <Th align="right">Collections</Th>
                  <Th align="right">Keywords bought</Th>
                  <Th align="right">Spend</Th>
                </tr>
              </thead>
              <tbody>
                {ledger.byKind.map((row) => {
                  const kind = (data?.provider?.kinds || []).find(
                    (k) => k.key === row.kind
                  );
                  const cadence = (ledger.cadence || []).find((c) => c.key === row.kind);
                  return (
                    <tr key={row.kind}>
                      <Td>
                        {kind?.label || row.kind}
                        {cadence?.depth ? (
                          <span style={{ color: 'var(--color-text-muted)' }}>
                            {' '}
                            · top {cadence.depth}
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right">{formatNumber(row.tasks)}</Td>
                      <Td align="right" muted>
                        {formatNumber(row.keywords)}
                      </Td>
                      <Td align="right">{formatMoney(row.spentUsd)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTable>
        )}
      </Panel>

      {/* ---- In flight ------------------------------------------------------- */}
      <Panel
        title="In flight"
        subtitle="Bought and not yet delivered. These cost nothing further — collecting them is free."
      >
        {!ledger?.inFlight?.length ? (
          <p
            className="font-body px-4 py-4"
            style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
          >
            Nothing is waiting.
            {ledger?.dead > 0 && (
              <>
                {' '}
                {ledger.dead} collection{ledger.dead === 1 ? '' : 's'} {ledger.dead === 1 ? 'was' : 'were'} given up on
                after repeated attempts and will not be bought again automatically.
              </>
            )}
          </p>
        ) : (
          <ScrollTable maxHeight={280}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th>Site</Th>
                  <Th>What</Th>
                  <Th>Market</Th>
                  <Th align="right">Keywords</Th>
                  <Th align="right">Ordered</Th>
                  <Th align="right">Observed</Th>
                </tr>
              </thead>
              <tbody>
                {ledger.inFlight.map((job) => {
                  const kind = (data?.provider?.kinds || []).find(
                    (k) => k.key === job.kind
                  );
                  return (
                    <tr key={`${job.project}-${job.kind}-${job.variant}`}>
                      <Td title={job.projectName}>{job.projectName || '—'}</Td>
                      <Td>{kind?.label || job.kind}</Td>
                      <Td muted>{marketLabel(job.variant)}</Td>
                      <Td align="right">{formatNumber(job.keywords)}</Td>
                      <Td align="right" muted>
                        {job.postedAt ? staleness(job.postedAt) : '—'}
                      </Td>
                      <Td align="right" muted>
                        {/* Blank until the free sweep announces it. Not a
                            failure — results live thirty days and the
                            announcement channel only three. */}
                        {job.observedAt ? staleness(job.observedAt) : 'waiting'}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTable>
        )}

        {ledger?.dead > 0 && ledger?.inFlight?.length > 0 && (
          <p
            className="flex items-start gap-2 px-4 py-2.5 font-body"
            style={{
              fontSize: 12.5,
              borderTop: '1px solid var(--color-border)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <Hourglass size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {ledger.dead} collection{ledger.dead === 1 ? '' : 's'} {ledger.dead === 1 ? 'was' : 'were'} given up on after
              repeated attempts. Nothing further is bought for {ledger.dead === 1 ? 'it' : 'them'} automatically —
              that is what stops a job {label} never answers being re-bought every
              twelve hours forever.
            </span>
          </p>
        )}
      </Panel>

      {/* ---- The cross-tenant cache, and the number it is gated on ---------- */}
      <Panel
        title="Shared search results"
        subtitle={
          cache?.enabled
            ? 'This workspace shares SERP bodies with the other workspaces on the same allowlist. A shared reading costs nothing.'
            : 'Two boards tracking the same keyword in the same market on the same day could be one paid collection. This is measured, and it is switched off.'
        }
        actions={
          <MiniChip
            bg="var(--color-bg-subtle)"
            text={cache?.enabled ? 'var(--color-card-green)' : 'var(--color-text-muted)'}
          >
            {cache?.enabled ? 'On' : 'Off'}
          </MiniChip>
        }
      >
        <StatRow>
          <Stat
            label="Collections it could have served"
            // The all-or-nothing rate: units inside batches that were ENTIRELY
            // available. What a partial cache could reach is a second number,
            // below, so the two design refusals stay visible as choices.
            value={
              cache?.totals?.units
                ? asPct(cache.totals.servableUnits / cache.totals.units)
                : '—'
            }
            sub={`of ${formatNumber(cache?.totals?.units ?? 0)} keywords, last ${cache?.windowDays ?? 28} days`}
          />
          <Stat
            label="Bar to clear"
            value={`${cache?.thresholdPct ?? 20}%`}
            sub={`per kind, over ${formatNumber(cache?.minUnits ?? 1000)}+ keywords`}
          />
          <Stat
            label="Served free"
            // Zero unless somebody switched it on. `servable > 0, served = 0` is
            // the normal reading and means "this would have worked".
            value={formatNumber(cache?.totals?.servedUnits ?? 0)}
            sub={cache?.enabled ? 'keywords collected without buying' : 'the cache is off'}
          />
        </StatRow>

        {!cache?.kinds?.length ? (
          <p
            className="font-body px-4 py-4"
            style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
          >
            Nothing measured yet. The number is taken at the moment a collection
            is ordered, so it starts appearing after this board&rsquo;s first
            purchase.
          </p>
        ) : (
          <ScrollTable maxHeight={220}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th>What was bought</Th>
                  <Th align="right">Keywords asked</Th>
                  <Th align="right">Could have been shared</Th>
                  <Th align="right">Ceiling</Th>
                  <Th align="right">Would have saved</Th>
                  <Th>Verdict</Th>
                </tr>
              </thead>
              <tbody>
                {cache.kinds.map((row) => {
                  const kind = (data?.provider?.kinds || []).find(
                    (k) => k.key === row.kind
                  );
                  const verdict = VERDICT[row.verdict] || VERDICT.insufficient;
                  return (
                    <tr key={row.kind}>
                      <Td>
                        {kind?.label || row.kind}
                        {row.depth ? (
                          <span style={{ color: 'var(--color-text-muted)' }}>
                            {' '}
                            · top {row.depth}
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right" muted>
                        {formatNumber(row.units)}
                      </Td>
                      <Td align="right">{asPct(row.rate)}</Td>
                      <Td align="right" muted title="What a cache that also served partial batches, and claimed a purchase before it was collected, could reach.">
                        {asPct(row.ceilingRate)}
                      </Td>
                      <Td align="right">{formatMoney(row.wouldSaveUsd)}</Td>
                      <Td title={verdict.say}>
                        <span style={{ color: verdict.tone }}>{verdict.label}</span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTable>
        )}

        <p
          className="flex items-start gap-2 px-4 py-2.5 font-body"
          style={{
            fontSize: 12,
            borderTop: '1px solid var(--color-border)',
            color: 'var(--color-text-muted)',
          }}
        >
          <Share2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Measured per kind and never averaged &mdash; a daily check is bought
            ten results deep and saves a tenth of what the weekly census saves
            per keyword, so one blended figure would describe neither. A reading
            is only ever reused on the same UTC day, at the same depth, in the
            same market: anything wider would put a stale ranking on a client
            report. Turning this on is a per-workspace decision about sharing
            data, not a setting &mdash; ask whoever administers the deployment.
          </span>
        </p>
      </Panel>
    </div>
  );
};

export default UsageScreen;

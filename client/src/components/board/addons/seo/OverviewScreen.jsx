import { Suspense, lazy, useMemo } from 'react';
import { Activity, ArrowRight, Hourglass, Search } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import { SkeletonText } from '../../../ui/Skeleton';
import SectionShell, {
  Delta,
  ScrollTable,
  Stat,
  StatRow,
  Td,
} from '../connector/SectionShell';
import {
  formatNumber,
  formatRank,
  movementOf,
  staleness,
  toneColor,
} from '../../../../utils/connectorFormat';
import { rankRowsFrom, summariseRankRows } from '../../../../utils/rankRows';

// ~95 KB, and only this tab and the goals trend use it. See RankChart's header.
const RankChart = lazy(() => import('../connector/RankChart'));

/**
 * Overview — where this site stands, and what moved.
 *
 * ---- What it is for, and what it deliberately is not -----------------------
 *
 * It answers the question somebody opens the tab with: is this client better or
 * worse than last time, and by how much. That is FIVE NUMBERS AND A LIST, not a
 * second copy of the rank table — the table is one click away and has the
 * sorting, filtering and export this screen would only do badly.
 *
 * ---- Every number here is a comparison of two collections ------------------
 *
 * The provider stores no history at all: it answers "where does this rank now"
 * and remembers nothing. So "up 5" is our previous snapshot subtracted from our
 * current one — which is why `previousSnapshots` rides on the read, why the
 * baseline must be a FINISHED reading, and why the whole screen says "since the
 * previous collection" rather than "this week". The two are not the same
 * sentence when a collection is missed.
 *
 * ---- Nulls -----------------------------------------------------------------
 *
 * `formatNumber` and `formatRank` are imported rather than reimplemented, so a
 * missing value renders as an em dash and never as a zero. "This site has no
 * keywords in the top 3" and "we could not read the totals" are opposite facts
 * that look identical as a 0.
 */

/** How many movers each column lists. Enough to be useful, short enough to scan. */
const MOVER_LIMIT = 8;

const MoverList = ({ title, rows, emptyLabel, onSelectKeyword }) => (
  <div className="flex-1 min-w-0">
    <p
      className="font-body px-4 pt-3"
      style={{
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--color-text-muted)',
      }}
    >
      {title}
    </p>
    {rows.length === 0 ? (
      <p
        className="font-body px-4 py-3"
        style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
      >
        {emptyLabel}
      </p>
    ) : (
      <ScrollTable maxHeight={260}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {rows.map((row) => {
              const move = movementOf(row);
              return (
                <tr key={row.keyword}>
                  <Td>
                    <button
                      type="button"
                      onClick={() => onSelectKeyword?.(row.keyword)}
                      className="font-body text-left truncate"
                      style={{
                        maxWidth: 220,
                        fontSize: 13,
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        color: 'var(--color-text-primary)',
                        cursor: onSelectKeyword ? 'pointer' : 'default',
                      }}
                      title={row.keyword}
                    >
                      {row.keyword}
                    </button>
                  </Td>
                  <Td align="right" muted>
                    {typeof row.previousRank === 'number' ? `#${row.previousRank}` : '—'}
                    {' → '}
                    {formatRank(row.rank, row.ranked)}
                  </Td>
                  <Td align="right">
                    <span style={{ color: toneColor(move.tone) }}>
                      {move.arrow}{' '}
                      {typeof row.change === 'number'
                        ? Math.abs(row.change)
                        : move.label}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollTable>
    )}
  </div>
);

const OverviewScreen = ({ data, label, onSelectKeyword, onOpenScreen }) => {
  const snapshot = data?.snapshots?.positions || null;
  const previous = data?.previousSnapshots?.positions || null;
  const movementSnapshot = data?.snapshots?.movement || null;

  const rows = useMemo(() => rankRowsFrom(snapshot, previous), [snapshot, previous]);
  const summary = useMemo(() => summariseRankRows(rows), [rows]);

  /**
   * The previous collection's own summary, for the deltas.
   *
   * Recomputed from its rows rather than read off its stored `totals`, so the
   * two sides of every comparison are counted the same way. A delta between a
   * number we computed and a number the provider computed is a delta that moves
   * when neither did.
   */
  const previousSummary = useMemo(
    () => summariseRankRows(rankRowsFrom(previous)),
    [previous]
  );

  const movers = useMemo(() => {
    const withChange = rows.filter((r) => typeof r.change === 'number' && r.change !== 0);
    const up = [...withChange]
      .filter((r) => r.change > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, MOVER_LIMIT);
    const down = [...withChange]
      .filter((r) => r.change < 0)
      .sort((a, b) => a.change - b.change)
      .slice(0, MOVER_LIMIT);
    // Entering and leaving the measured depth have no number to sort by, so they
    // are appended rather than ranked — and they are the two biggest events that
    // can happen to a keyword, so they are not dropped either.
    const entered = rows.filter((r) => r.movement === 'entered').slice(0, MOVER_LIMIT);
    const lost = rows.filter((r) => r.movement === 'lost').slice(0, MOVER_LIMIT);
    return {
      up: [...up, ...entered].slice(0, MOVER_LIMIT),
      down: [...down, ...lost].slice(0, MOVER_LIMIT),
    };
  }, [rows]);

  const positionsKind = (data?.provider?.kinds || []).find((k) => k.key === 'positions');

  return (
    <div className="flex flex-col gap-4">
      {/* ---- In flight ------------------------------------------------------- */}
      {data.queued > 0 && (
        <p
          className="flex items-start gap-2 px-4 py-2.5 font-body"
          style={{
            fontSize: 12.5,
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text-secondary)',
          }}
        >
          <Hourglass size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {data.queued} collection{data.queued === 1 ? '' : 's'} bought and not
            yet delivered. {label} answers in a few minutes and the results land
            here on their own — nothing needs pressing, and pressing Refresh
            again would not make them arrive sooner.
          </span>
        </p>
      )}

      {/* ---- The five numbers ------------------------------------------------ */}
      <SectionShell
        kind={positionsKind || { label: 'Rank tracking' }}
        snapshot={snapshot}
        icon={Search}
        emptyTitle="Nothing collected yet"
        emptyDescription={
          data.queued > 0
            ? 'The first collection has been ordered and is still running. This fills in on its own.'
            : 'This fills in the next time the schedule runs. Nothing is bought when you open this tab.'
        }
      >
        <StatRow>
          <Stat
            label="Tracked"
            value={formatNumber(summary.tracked)}
            sub={
              summary.unmeasured
                ? `${summary.unmeasured} with no reading`
                : 'keywords on this site'
            }
          />
          <Stat
            label="Ranking"
            value={formatNumber(summary.ranking)}
            sub={<Delta value={summary.ranking - previousSummary.ranking} />}
          />
          <Stat
            label="Top 3"
            value={formatNumber(summary.top3)}
            sub={<Delta value={summary.top3 - previousSummary.top3} />}
          />
          <Stat
            label="Top 10"
            value={formatNumber(summary.top10)}
            sub={<Delta value={summary.top10 - previousSummary.top10} />}
          />
          <Stat
            label="Average position"
            // Null renders as an em dash. A "0.0 average position" would read as
            // the best possible result rather than as "nothing ranked".
            value={summary.averageRank === null ? '—' : `#${summary.averageRank}`}
            sub={
              summary.averageRank === null || previousSummary.averageRank === null ? (
                'over ranking keywords'
              ) : (
                <Delta
                  value={
                    Math.round(
                      (summary.averageRank - previousSummary.averageRank) * 10
                    ) / 10
                  }
                  // Rank is inverted: a smaller average is better.
                  invert
                />
              )
            }
          />
        </StatRow>

        {/* ---- Movers -------------------------------------------------------- */}
        <div
          className="flex flex-wrap"
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          <MoverList
            title="Biggest gains"
            rows={movers.up}
            emptyLabel={
              previous
                ? 'Nothing improved since the previous collection.'
                : 'One collection so far — movement needs two.'
            }
            onSelectKeyword={onSelectKeyword}
          />
          <div style={{ width: 1, background: 'var(--color-border)' }} />
          <MoverList
            title="Biggest losses"
            rows={movers.down}
            emptyLabel={
              previous
                ? 'Nothing declined since the previous collection.'
                : 'One collection so far — movement needs two.'
            }
            onSelectKeyword={onSelectKeyword}
          />
        </div>

        {previous && (
          <p
            className="font-body px-4 py-3"
            style={{
              fontSize: 11.5,
              color: 'var(--color-text-muted)',
              borderTop: '1px solid var(--color-border)',
            }}
          >
            {/* Not "this week". A missed collection makes those two different
                sentences, and the honest one is the one that names what was
                actually compared. */}
            Compared against the collection of {staleness(previous.collectedAt || previous.fetchedAt)}.
          </p>
        )}
      </SectionShell>

      {/* ---- The trend ------------------------------------------------------- */}
      <section
        style={{
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        <header className="px-4 py-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <h3
            className="font-body font-medium"
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--color-text-secondary)',
            }}
          >
            Average position over time
          </h3>
          <p className="font-body mt-1" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {(data.trend || []).length} stored collection
            {(data.trend || []).length === 1 ? '' : 's'} in this market. This
            series exists nowhere else — {label} answers where a keyword ranks
            now and keeps no history of its own.
          </p>
        </header>
        <div className="px-4 py-4">
          {(data.trend || []).length === 0 ? (
            <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
              Nothing stored for this market yet.
            </p>
          ) : (
            <Suspense fallback={<SkeletonText width="100%" height={200} />}>
              <RankChart mode="trend" trend={data.trend} />
            </Suspense>
          )}
        </div>
      </section>

      {/* ---- Daily movement, when the board pays for it ---------------------- */}
      {movementSnapshot && (
        <SectionShell
          kind={
            (data?.provider?.kinds || []).find((k) => k.key === 'movement') || {
              label: 'Daily movement',
            }
          }
          snapshot={movementSnapshot}
          icon={Activity}
          emptyTitle="No daily check yet"
        >
          <StatRow>
            <Stat
              label="Ranking today"
              value={formatNumber(movementSnapshot.data?.totals?.ranked)}
              sub="of the top ten only"
            />
            <Stat
              label="Top 3"
              value={formatNumber(movementSnapshot.data?.totals?.top3)}
            />
            <Stat
              label="Average position"
              value={
                typeof movementSnapshot.data?.totals?.averageRank === 'number'
                  ? `#${movementSnapshot.data.totals.averageRank}`
                  : '—'
              }
              // Said plainly, because the two numbers legitimately disagree: the
              // daily check buys ten results and the weekly census buys a
              // hundred, so a keyword at #40 is "not ranking" here and #40
              // above. Without this line that reads as a bug.
              sub="shallow check — anything past #10 is not measured"
            />
          </StatRow>
        </SectionShell>
      )}

      {!snapshot && data.queued === 0 && (
        <EmptyState
          icon={Search}
          title="Nothing to show yet"
          description="Once a collection completes, this screen fills in on its own."
          actionLabel="Open rank tracking"
          onAction={() => onOpenScreen?.('rank_tracking')}
        />
      )}

      {snapshot && (
        <button
          type="button"
          onClick={() => onOpenScreen?.('rank_tracking')}
          className="inline-flex items-center gap-1.5 font-body self-start"
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-accent)',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
        >
          All {formatNumber(summary.tracked)} keywords
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
};

export default OverviewScreen;

import { Suspense, lazy, useMemo } from 'react';
import { ArrowRight, Search, TrendingUp } from 'lucide-react';

import { SkeletonText } from '../../../ui/Skeleton';
import SectionShell, {
  Delta,
  ScrollTable,
  Stat,
  StatRow,
  Td,
} from './SectionShell';
import {
  formatMoney,
  formatNumber,
  formatRank,
  movementOf,
  staleness,
  toneColor,
} from '../../../../utils/connectorFormat';

// ~95 KB, and the only charting library in the app. A board on any other screen
// must not download it. Same treatment as `KeywordTrendChart` beside it.
const RankChart = lazy(() => import('./RankChart'));

/**
 * Overview — where this site stands, and what moved.
 *
 * ---- Why the kind-driven tab needed one ------------------------------------
 *
 * This tab used to be five stacked sections and no summary, so the question
 * somebody actually opens it with — "is this client better or worse than last
 * week" — was answered by scrolling and doing arithmetic. This screen answers
 * it, and every number on it is one click from the screen that owns it.
 *
 * It is deliberately NOT a second copy of the rank table: five numbers, two
 * short mover lists, one chart, and a strip of headline figures from the other
 * kinds. The table has the filtering and the full column set and is one click
 * away.
 *
 * ---- It collects nothing ----------------------------------------------------
 *
 * Every value here is read out of snapshots the tab already loaded — no extra
 * request, and certainly no provider contact. A kind this board does not collect
 * simply contributes nothing, which is why each headline figure is rendered from
 * its own snapshot rather than from a merged object that would have to encode
 * which kinds exist.
 *
 * ---- Movement is the PROVIDER's, not ours -----------------------------------
 *
 * The rows already carry `movement`, `change` and `previousPosition`, computed
 * by the provider against its own previous week, and the rank table on the next
 * screen renders exactly those. So this screen sorts by the same fields rather
 * than re-deriving movement from our stored snapshots: two answers to "what
 * moved" on two screens of one tab is the kind of disagreement nobody can debug
 * from a screenshot.
 *
 * The STAT deltas are different and are labelled differently — they compare our
 * latest collection against the one before it ("since the previous collection"),
 * because a total has no per-row previous value to read.
 */

/** How many movers each column lists. Enough to be useful, short enough to scan. */
const MOVER_LIMIT = 6;

/**
 * The provider's own project average — the last point of the series it ships.
 *
 * Named every time it is shown, because it is NOT the mean of the rank column on
 * the next screen: the provider counts a keyword outside the top 100 as +100 in
 * this figure, so it cannot be reproduced from the ranks in the table and moves
 * when a keyword leaves the measured depth.
 */
const latestAverage = (snapshot) => {
  const series = snapshot?.data?.averagePositions || [];
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (typeof series[i]?.value === 'number') return series[i].value;
  }
  return null;
};

const MoverList = ({ title, rows, emptyLabel, onSelectKeyword }) => (
  <div className="flex-1 min-w-0" style={{ minWidth: 260 }}>
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
      <ScrollTable maxHeight={240}>
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
                        maxWidth: 200,
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
                    {formatRank(row.previousPosition, row.ranked)}
                    {' → '}
                    {formatRank(row.position, row.ranked)}
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

/**
 * One headline figure from another screen, with the way through to it.
 *
 * A tile is only drawn when its kind produced a reading — an empty tile would
 * claim the board collects something it does not, and the screen that owns the
 * number is in the rail either way.
 */
const Tile = ({ label, value, sub, onOpen }) => (
  <button
    type="button"
    onClick={onOpen}
    className="text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      flex: '1 1 150px',
      minWidth: 150,
      padding: '12px 14px',
      borderRadius: 'var(--radius-lg)',
      border: '1px solid var(--color-border)',
      background: 'var(--color-bg-surface)',
      cursor: onOpen ? 'pointer' : 'default',
    }}
    onMouseEnter={(e) => {
      if (onOpen) e.currentTarget.style.borderColor = 'var(--color-accent)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.borderColor = 'var(--color-border)';
    }}
  >
    <p
      className="font-body"
      style={{
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--color-text-muted)',
      }}
    >
      {label}
    </p>
    <p
      className="font-display font-semibold mt-0.5 truncate"
      style={{ fontSize: 20, color: 'var(--color-text-primary)' }}
    >
      {value}
    </p>
    {sub ? (
      <p
        className="font-body mt-0.5 truncate"
        style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
      >
        {sub}
      </p>
    ) : null}
  </button>
);

const OverviewScreen = ({ data, label, onSelectKeyword, onOpenScreen }) => {
  const snapshot = data?.snapshots?.positions || null;
  const previous = data?.previousSnapshots?.positions || null;

  const rows = useMemo(() => snapshot?.data?.keywords || [], [snapshot]);
  const totals = snapshot?.data?.totals || {};
  const previousTotals = previous?.data?.totals || {};

  const movers = useMemo(() => {
    const withChange = rows.filter(
      (r) => typeof r.change === 'number' && r.change !== 0
    );
    const up = withChange
      .filter((r) => r.change > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, MOVER_LIMIT);
    const down = withChange
      .filter((r) => r.change < 0)
      .sort((a, b) => a.change - b.change)
      .slice(0, MOVER_LIMIT);
    // Entering and leaving the measured depth have no number to sort by — one
    // side of the subtraction is missing — so they are appended rather than
    // ranked. They are also the two biggest events that can happen to a
    // keyword, so they are not dropped either.
    const entered = rows.filter((r) => r.movement === 'entered').slice(0, MOVER_LIMIT);
    const lost = rows.filter((r) => r.movement === 'lost').slice(0, MOVER_LIMIT);
    return {
      up: [...up, ...entered].slice(0, MOVER_LIMIT),
      down: [...down, ...lost].slice(0, MOVER_LIMIT),
    };
  }, [rows]);

  const average = latestAverage(snapshot);
  const previousAverage = latestAverage(previous);

  const positionsKind = (data?.provider?.kinds || []).find((k) => k.key === 'positions');

  const domain = data?.snapshots?.domain_overview?.data || null;
  const backlinks = data?.snapshots?.backlinks?.data || null;
  const audit = data?.snapshots?.site_audit?.data || null;

  const hasTiles = !!(domain || backlinks || audit);

  return (
    <div className="flex flex-col gap-4">
      {/* ---- The five numbers ------------------------------------------------ */}
      <SectionShell
        kind={positionsKind || { label: 'Rank tracking' }}
        snapshot={snapshot}
        icon={Search}
        showTitle={false}
        emptyTitle="Nothing collected yet"
        emptyDescription={`This fills in the next time the connector runs. Nothing is fetched when you open this tab — the quota is shared across the whole workspace, and ${label} collects rankings once a week.`}
      >
        <StatRow>
          <Stat
            label="Tracked"
            value={formatNumber(totals.tracked)}
            sub="keywords on this site"
          />
          <Stat
            label="Ranking"
            value={formatNumber(totals.ranking)}
            sub={
              previous ? (
                <Delta value={totals.ranking - previousTotals.ranking} />
              ) : (
                'in the top 100'
              )
            }
          />
          <Stat
            label="Not ranking"
            value={formatNumber(totals.notRanking)}
            sub={
              previous ? (
                <Delta
                  value={totals.notRanking - previousTotals.notRanking}
                  // More keywords NOT ranking is worse, so this one is the
                  // inverted kind. See `Delta`.
                  invert
                />
              ) : undefined
            }
          />
          <Stat
            label="Improved"
            value={formatNumber(totals.improved)}
            sub={`${formatNumber(totals.declined)} declined`}
          />
          <Stat
            label="Average position"
            // Null renders as an em dash. A "0.0 average position" would read as
            // the best possible result rather than as "nothing ranked".
            value={average === null ? '—' : formatNumber(average)}
            sub={
              average === null || previousAverage === null ? (
                `project average, from ${label}`
              ) : (
                // Rank is inverted: a smaller average is better.
                <Delta
                  value={Math.round((average - previousAverage) * 10) / 10}
                  invert
                />
              )
            }
          />
        </StatRow>

        {totals.pending > 0 && (
          <p
            className="font-body px-4 pb-3"
            style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
          >
            {formatNumber(totals.pending)} keyword
            {totals.pending === 1 ? ' is' : 's are'} still pending their first
            collection. That only happens on a brand-new project and usually
            resolves within the hour — it is not the same as not ranking.
          </p>
        )}

        {/* ---- Movers -------------------------------------------------------- */}
        <div
          className="flex flex-wrap"
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          <MoverList
            title="Biggest gains"
            rows={movers.up}
            emptyLabel="Nothing improved in the last collection."
            onSelectKeyword={onSelectKeyword}
          />
          <div style={{ width: 1, background: 'var(--color-border)' }} />
          <MoverList
            title="Biggest losses"
            rows={movers.down}
            emptyLabel="Nothing declined in the last collection."
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
            {/* Not "last week". A missed collection makes those two different
                sentences, and the honest one names what was actually compared. */}
            Movement above is {label}&rsquo;s own week-on-week figure. The changes
            beside the totals compare this collection against the one of{' '}
            {staleness(previous.collectedAt || previous.fetchedAt)}.
          </p>
        )}
      </SectionShell>

      {/* ---- Headline figures from the other screens ------------------------- */}
      {hasTiles && (
        <div className="flex flex-wrap gap-3">
          {domain && (
            <>
              <Tile
                label="Organic traffic"
                value={formatNumber(domain.organicTraffic, { compact: true })}
                sub="estimated, per month"
                onOpen={() => onOpenScreen?.('domain_overview')}
              />
              <Tile
                label="Traffic value"
                value={formatMoney(domain.trafficValue)}
                sub="estimated ad equivalent"
                onOpen={() => onOpenScreen?.('domain_overview')}
              />
            </>
          )}
          {backlinks && (
            <Tile
              label="Referring domains"
              value={formatNumber(backlinks.referringDomains, { compact: true })}
              // The pair has to be read together: ninety thousand links from
              // eleven domains is one footer link. See `BacklinksSection`.
              sub={`${formatNumber(backlinks.backlinks, { compact: true })} backlinks`}
              onOpen={() => onOpenScreen?.('backlinks')}
            />
          )}
          {audit && (
            <Tile
              label="Health score"
              value={
                audit.healthScore === null || audit.healthScore === undefined
                  ? '—'
                  : formatNumber(audit.healthScore)
              }
              sub={`${formatNumber(audit.totals?.errors)} errors`}
              onOpen={() => onOpenScreen?.('site_audit')}
            />
          )}
        </div>
      )}

      {/* ---- The trend ------------------------------------------------------- */}
      <section
        style={{
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        <header
          className="px-4 py-3"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
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
          <p
            className="font-body mt-1"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            {(data.trend || []).length} stored collection
            {(data.trend || []).length === 1 ? '' : 's'} in this market, over the
            window above. {label}&rsquo;s own project average, which counts a
            keyword outside the top 100 as 100 — so it is not the mean of the
            rank column on the next screen.
          </p>
        </header>
        <div className="px-4 py-4">
          {(data.trend || []).length === 0 ? (
            <p
              className="font-body"
              style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
            >
              Nothing stored for this market in this window.
            </p>
          ) : (
            <Suspense fallback={<SkeletonText width="100%" height={200} />}>
              <RankChart mode="trend" trend={data.trend} />
            </Suspense>
          )}
        </div>
      </section>

      {snapshot && (
        <button
          type="button"
          onClick={() => onOpenScreen?.('positions')}
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
          All {formatNumber(totals.tracked)} keywords
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      )}

      {!snapshot && !hasTiles && (
        <p
          className="flex items-start gap-2 font-body"
          style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
        >
          <TrendingUp size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Nothing has been collected for this site yet. Every screen in the rail
            fills in on its own once the connector runs.
          </span>
        </p>
      )}
    </div>
  );
};

export default OverviewScreen;

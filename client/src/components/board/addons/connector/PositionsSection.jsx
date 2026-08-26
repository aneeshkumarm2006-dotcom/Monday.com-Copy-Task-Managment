import { useMemo, useState } from 'react';
import { LineChart, TrendingUp } from 'lucide-react';
import SectionShell, { ScrollTable, Stat, StatRow, Td, Th } from './SectionShell';
import Input from '../../../ui/Input';
import {
  formatRank,
  isUnranked,
  formatNumber,
  movementOf,
  toneColor,
} from '../../../../utils/connectorFormat';

/**
 * Rank tracking — the section the whole feature was built for.
 *
 * ---- The three-way cell ----------------------------------------------------
 *
 * Every rank here is one of three things and they must never collapse into two:
 * a number, "Not in top 100", or an em dash meaning we have nothing. The
 * provider answers `status: "ok"` with a null position to mean the second, and
 * its own documentation calls that "a final answer … NOT a 'still loading'
 * state". An SEO team looking at a blank column concludes the integration is
 * broken; the truth is that the client is not ranking. `formatRank` is where
 * that lives.
 *
 * ---- The average position is NOT our average -------------------------------
 *
 * `average_positions` is the project-aggregate mean the provider computes, and
 * it counts a keyword outside the top 100 as +100. It therefore cannot be
 * reproduced from the ranks in the table below, and must never be relabelled as
 * if it could. It is shown as the provider's own number, named as a project
 * average.
 */
const PositionsSection = ({
  kind,
  snapshot,
  keywordHistory,
  onSelectKeyword,
  historyChart,
}) => {
  const [query, setQuery] = useState('');

  // Memoised because `|| []` is a fresh array on every render, which would make
  // the sort below re-run on every keystroke in the filter box.
  const rows = useMemo(() => snapshot?.data?.keywords || [], [snapshot]);
  const totals = snapshot?.data?.totals || {};

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? rows.filter((r) => (r.keyword || '').toLowerCase().includes(needle))
      : rows;
    // Ranking keywords first, best rank first; non-ranking after them. Sorting
    // nulls to the top would bury every result the client actually has.
    return [...list].sort((a, b) => {
      const ar = typeof a.position === 'number' ? a.position : Infinity;
      const br = typeof b.position === 'number' ? b.position : Infinity;
      if (ar !== br) return ar - br;
      return (a.keyword || '').localeCompare(b.keyword || '');
    });
  }, [rows, query]);

  const latestAverage = (() => {
    const series = snapshot?.data?.averagePositions || [];
    const last = series[series.length - 1];
    return typeof last?.value === 'number' ? last.value : null;
  })();

  return (
    <SectionShell
      kind={kind}
      snapshot={snapshot}
      icon={TrendingUp}
      emptyTitle="No rankings collected yet"
      emptyDescription="Rankings arrive on the next connector run. Ubersuggest collects them once a week on every plan."
    >
      <StatRow>
        <Stat label="Tracked" value={formatNumber(totals.tracked)} />
        <Stat label="Ranking" value={formatNumber(totals.ranking)} sub="in the top 100" />
        <Stat label="Not ranking" value={formatNumber(totals.notRanking)} />
        <Stat
          label="Improved"
          value={formatNumber(totals.improved)}
          sub={`${formatNumber(totals.declined)} declined`}
        />
        <Stat
          label="Average position"
          value={latestAverage === null ? '—' : formatNumber(latestAverage)}
          // Named every time it is shown. Ubersuggest counts a keyword outside
          // the top 100 as +100 in this mean, so it is not the average of the
          // column below and must not be read as one.
          sub="project average, from Ubersuggest"
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

      {rows.length > 12 && (
        <div className="px-4 pb-3" style={{ maxWidth: 320 }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter keywords…"
            aria-label="Filter tracked keywords"
          />
        </div>
      )}

      <ScrollTable>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <Th>Keyword</Th>
              <Th align="right" width={90}>Rank</Th>
              <Th align="right" width={90}>Previous</Th>
              <Th align="right" width={120}>Movement</Th>
              <Th width={44}><span className="sr-only">History</span></Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const move = movementOf(row);
              const selected =
                keywordHistory?.keyword?.toLowerCase() ===
                (row.keyword || '').toLowerCase();
              return (
                <tr
                  key={`${row.keyword}`}
                  style={{
                    background: selected ? 'var(--color-bg-subtle)' : undefined,
                  }}
                >
                  <Td title={row.url || undefined}>
                    {row.keyword || (
                      <span style={{ color: 'var(--color-text-muted)' }}>
                        (unnamed keyword)
                      </span>
                    )}
                  </Td>
                  <Td
                    align="right"
                    muted={isUnranked(row.position, row.ranked)}
                  >
                    {row.status === 'pending' ? 'Pending' : formatRank(row.position, row.ranked)}
                  </Td>
                  <Td align="right" muted>
                    {formatRank(row.previousPosition, row.ranked)}
                  </Td>
                  <Td align="right">
                    <span style={{ color: toneColor(move.tone) }}>
                      {move.arrow}{' '}
                      {typeof row.change === 'number'
                        ? `${Math.abs(row.change)}`
                        : move.label}
                    </span>
                  </Td>
                  <Td align="right">
                    {row.keyword ? (
                      <button
                        type="button"
                        onClick={() => onSelectKeyword(selected ? '' : row.keyword)}
                        title={
                          selected
                            ? 'Hide this keyword’s history'
                            : 'Show this keyword’s history'
                        }
                        aria-label={`History for ${row.keyword}`}
                        style={{
                          color: selected
                            ? 'var(--color-accent)'
                            : 'var(--color-text-muted)',
                          display: 'inline-flex',
                        }}
                      >
                        <LineChart size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <Td muted>No keyword matches that filter.</Td>
                <Td /><Td /><Td /><Td />
              </tr>
            )}
          </tbody>
        </table>
      </ScrollTable>

      {/* The per-keyword series. This is the part Ubersuggest cannot produce at
          all — its API returns two points per keyword and no history tool — so
          every point below came out of a week we stored ourselves. */}
      {keywordHistory ? historyChart : null}
    </SectionShell>
  );
};

export default PositionsSection;

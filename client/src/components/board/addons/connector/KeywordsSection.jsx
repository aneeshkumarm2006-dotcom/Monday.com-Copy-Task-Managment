import { KeyRound } from 'lucide-react';
import SectionShell, { ScrollTable, Td, Th } from './SectionShell';
import { formatMoney, formatNumber } from '../../../../utils/connectorFormat';

/**
 * Volume, difficulty, CPC and intent for the project's tracked keywords.
 *
 * ---- Why this is the section that fixes the real problem -------------------
 *
 * Every one of these numbers is typed by hand on these boards today, and it
 * shows: on DAVNOOT SEO, 100 of 366 search volumes are literally `0`, two
 * difficulty values are 320 and 480 on a 0–100 scale, and one row has the
 * difficulty and volume pasted the wrong way round. Phase 5 binds these to goal
 * columns; this section is where you can see them before trusting them to.
 *
 * ---- Difficulty is SEO difficulty, and it is labelled as such --------------
 *
 * The provider returns `sd` and `pd` — SEO and PAID difficulty — and the two are
 * trivially confusable. Only `sd` is shown, under a name that says so, because a
 * paid number in a column headed KD is exactly the silent error this feature
 * exists to remove.
 */
const KeywordsSection = ({ kind, snapshot, showTitle = true }) => {
  const rows = snapshot?.data?.keywords || [];
  const truncated = snapshot?.data?.truncated;
  const trackedTotal = snapshot?.data?.trackedTotal;

  return (
    <SectionShell
      kind={kind}
      snapshot={snapshot}
      icon={KeyRound}
      showTitle={showTitle}
      emptyTitle="No keyword metrics yet"
      emptyDescription="These fill in alongside the rankings on the next connector run."
    >
      {truncated ? (
        // Said out loud rather than left to be inferred. A cap nobody can see
        // reads as "we covered everything" — somebody would otherwise conclude
        // the remaining keywords had stopped being tracked.
        <p
          className="font-body px-4 pt-3"
          style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
        >
          Showing the first {formatNumber(rows.length)} of{' '}
          {formatNumber(trackedTotal)} tracked keywords. Each keyword costs a
          report against the shared daily quota, so the run is capped.
        </p>
      ) : null}

      <ScrollTable>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <Th>Keyword</Th>
              <Th align="right" width={110}>Volume</Th>
              <Th align="right" width={110}>SEO difficulty</Th>
              <Th align="right" width={90}>CPC</Th>
              <Th width={130}>Intent</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.keyword}>
                <Td>{row.keyword}</Td>
                {/* A null volume renders as an em dash, never as 0 — the board
                    already carries a hundred hand-typed zeroes that mean
                    "nobody looked it up", and adding more would be worse than
                    showing nothing. */}
                <Td align="right" muted={row.volume === null}>
                  {formatNumber(row.volume)}
                </Td>
                <Td align="right" muted={row.difficulty === null}>
                  {formatNumber(row.difficulty)}
                </Td>
                <Td align="right" muted={row.cpc === null}>
                  {formatMoney(row.cpc)}
                </Td>
                <Td muted={!row.intent}>{row.intent || '—'}</Td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <Td muted>This project has no tracked keywords.</Td>
                <Td /><Td /><Td /><Td />
              </tr>
            )}
          </tbody>
        </table>
      </ScrollTable>
    </SectionShell>
  );
};

export default KeywordsSection;

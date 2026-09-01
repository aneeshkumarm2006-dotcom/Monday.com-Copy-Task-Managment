import { Link2 } from 'lucide-react';
import SectionShell, { ScrollTable, Stat, StatRow, Td, Th } from './SectionShell';
import { formatNumber } from '../../../../utils/connectorFormat';

/**
 * Backlink totals and the anchor-text mix.
 *
 * ---- Why referring domains sits next to total backlinks --------------------
 *
 * They are the pair that has to be read together. Ninety thousand backlinks from
 * eight hundred domains is a normal profile; ninety thousand from eleven is a
 * sitewide footer link and means almost nothing. Showing the headline number
 * alone is the standard way to make a link profile look better than it is.
 *
 * ---- The anchor list is capped upstream ------------------------------------
 *
 * `anchor_texts` is capped at 25 rows by Ubersuggest regardless of what we ask
 * for, so this is the top of the distribution rather than all of it. It is
 * enough to spot the thing anyone is actually looking for here — a profile whose
 * anchors are all exact-match commercial terms.
 */
const BacklinksSection = ({ kind, snapshot, showTitle = true }) => {
  const data = snapshot?.data || {};
  const anchors = data.anchors || [];

  return (
    <SectionShell
      kind={kind}
      snapshot={snapshot}
      icon={Link2}
      showTitle={showTitle}
      emptyTitle="No backlink data yet"
      emptyDescription="This fills in on the next connector run."
    >
      <StatRow>
        <Stat
          label="Backlinks"
          value={formatNumber(data.backlinks, { compact: true })}
        />
        <Stat
          label="Referring domains"
          value={formatNumber(data.referringDomains, { compact: true })}
          // The ratio is the point — see the header.
          sub={
            typeof data.backlinks === 'number' &&
            typeof data.referringDomains === 'number' &&
            data.referringDomains > 0
              ? `${formatNumber(
                  Math.round(data.backlinks / data.referringDomains)
                )} links per domain`
              : undefined
          }
        />
        <Stat label="Domain authority" value={formatNumber(data.domainAuthority)} />
        <Stat
          label="Nofollow"
          value={formatNumber(data.nofollow, { compact: true })}
        />
      </StatRow>

      {anchors.length > 0 && (
        <ScrollTable maxHeight={300}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th>Anchor text</Th>
                <Th align="right" width={110}>Backlinks</Th>
                <Th align="right" width={130}>Referring domains</Th>
              </tr>
            </thead>
            <tbody>
              {anchors.map((anchor) => (
                <tr key={anchor.anchor}>
                  {/* Provider-controlled text, and anchor text is written by
                      whoever linked to the site — rendered as text, never as
                      markup, and clipped rather than allowed to stretch the
                      table. */}
                  <Td title={anchor.anchor}>
                    <span
                      style={{
                        display: 'inline-block',
                        maxWidth: 380,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        verticalAlign: 'bottom',
                      }}
                    >
                      {anchor.anchor || '(empty anchor)'}
                    </span>
                  </Td>
                  <Td align="right">{formatNumber(anchor.backlinks)}</Td>
                  <Td align="right" muted>{formatNumber(anchor.domains)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      )}
    </SectionShell>
  );
};

export default BacklinksSection;

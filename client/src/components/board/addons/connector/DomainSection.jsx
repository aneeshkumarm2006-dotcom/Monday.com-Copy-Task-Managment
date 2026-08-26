import { Globe } from 'lucide-react';
import SectionShell, { Stat, StatRow } from './SectionShell';
import { formatMoney, formatNumber } from '../../../../utils/connectorFormat';

/**
 * Traffic and authority for the project's domain.
 *
 * ---- Estimates, and labelled as estimates ----------------------------------
 *
 * None of these are measurements. Organic traffic and traffic value are
 * Ubersuggest's models of what a domain probably gets and what that would
 * probably cost in ads, and they routinely disagree with Search Console by a
 * wide margin. Showing them without saying so invites somebody to take one into
 * a client meeting as a fact.
 *
 * ---- Why a missing number is an em dash and never a zero -------------------
 *
 * `llms.md` documents this tool's response as "the raw Ubersuggest API payload
 * (fields defined by the backend)" and nothing further, so every field here is
 * read through a list of candidate spellings and any of them can miss. On a
 * number line "this domain gets no organic traffic" and "we could not locate the
 * traffic field" are both 0 and they mean opposite things.
 */
const DomainSection = ({ kind, snapshot }) => {
  const data = snapshot?.data || {};

  return (
    <SectionShell
      kind={kind}
      snapshot={snapshot}
      icon={Globe}
      emptyTitle="No traffic estimate yet"
      emptyDescription="This fills in on the next connector run."
    >
      <StatRow>
        <Stat
          label="Organic traffic"
          value={formatNumber(data.organicTraffic, { compact: true })}
          sub="estimated, per month"
        />
        <Stat
          label="Traffic value"
          value={formatMoney(data.trafficValue)}
          sub="estimated ad spend equivalent"
        />
        <Stat
          label="Organic keywords"
          value={formatNumber(data.organicKeywords, { compact: true })}
          sub="ranking anywhere"
        />
        <Stat label="Domain authority" value={formatNumber(data.domainAuthority)} />
      </StatRow>
    </SectionShell>
  );
};

export default DomainSection;

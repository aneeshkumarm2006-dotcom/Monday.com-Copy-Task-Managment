import { useMemo } from 'react';
import { MapPin } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import { ScrollTable, Stat, StatRow, Td, Th } from '../connector/SectionShell';
import { formatNumber, staleness } from '../../../../utils/connectorFormat';
import { downloadLabsExport } from '../../../../utils/labsExport';
import {
  bucketShare,
  comparability,
  distributionChange,
  isKindCollected,
  profileFrom,
  reviewHeadline,
} from '../../../../utils/localRows';
import { CountChip, LabsFilterBar, NotCollected, Panel, PanelHead } from './LabsBits';

/**
 * Local / GBP — the Google Business Profile behind this site.
 *
 * ---- The one number this screen refuses to lead with -----------------------
 *
 * THE STAR RATING. A business at 4.6 across 800 reviews that takes twenty new
 * one-stars moves to 4.53, which displays as 4.5 both times, and whose
 * month-over-month delta of 0.07 is inside the noise of any normal review flow.
 * The single event a local business most needs to be told about is invisible in
 * the headline it would most likely be reported through.
 *
 * `rating_distribution` is five counts and comes back on the same call, free. So
 * the hero here is the ONE-STAR COUNT and its change; the average is a secondary
 * line, kept because Google shows it and a client will ask why our number
 * differs from theirs.
 *
 * ---- The two lists Google gives away ---------------------------------------
 *
 * `place_topics` is Google's own review-mined themes — its model's summary of
 * what people say this business is about, which is the closest thing to a free
 * content brief anywhere in this API. `people_also_search` is Google naming the
 * competitive set: not our guess and not a SERP-overlap computation, but the
 * businesses Google itself puts beside this one.
 *
 * ---- And the guard, which is about IDENTITY -------------------------------
 *
 * The other guards in this tab ask whether two readings were taken under the
 * same SETTINGS. This one asks whether they are of the same THING: a rebrand, a
 * merged listing or an edited business name can move the query onto a different
 * Google listing, and the new listing's 12 one-stars minus the old one's 40
 * reads as "your one-stars fell by 28". `cid` is the check.
 */

const LocalScreen = ({ data, label }) => {
  const snapshot = data?.snapshots?.business_profile || null;
  const previous = data?.previousSnapshots?.business_profile || null;
  const collected = isKindCollected(data, 'business_profile');

  const profile = useMemo(() => profileFrom(snapshot), [snapshot]);
  const changes = useMemo(
    () => distributionChange(snapshot?.data, previous?.data),
    [snapshot, previous]
  );
  const guard = useMemo(
    () => comparability(snapshot?.data, previous?.data),
    [snapshot, previous]
  );
  const headline = useMemo(() => reviewHeadline(changes), [changes]);

  const runExport = (format) =>
    downloadLabsExport(
      {
        siteName: data.project?.name || data.project?.domain || 'Site',
        domain: data.project?.domain || '',
        variant: snapshot?.variant || data.variant,
        periodKey: snapshot?.periodKey || '',
        collectedAt: snapshot?.collectedAt || null,
        statusType: '',
        rows: changes.map((c) => ({
          ...c,
          share: bucketShare(c.count, profile?.distributionTotal),
        })),
      },
      'localReviews',
      format
    );

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-4">
        {!collected && <NotCollected label={label} what="Business profile" />}
        <EmptyState
          icon={MapPin}
          title="No business profile collected yet"
          description={
            collected
              ? 'Add a business name to this site under Add-ons — a name, or a "cid:" / "place_id:" value copied off the listing. Nothing is collected until one is set, because a fuzzy match on a domain returns whichever business Google thinks is closest.'
              : 'Nothing is being collected for this panel.'
          }
        />
      </div>
    );
  }

  if (!profile?.found) {
    return (
      <div className="flex flex-col gap-4">
        {!collected && <NotCollected label={label} what="Business profile" />}
        <EmptyState
          icon={MapPin}
          title="Google returned no listing"
          description={`Nothing matched "${profile?.query || ''}". Check the name, or use a "cid:" or "place_id:" value copied from the listing itself — a fuzzy name match can return the wrong business, so an empty answer is stored rather than a guess.`}
        />
      </div>
    );
  }

  const oneStar = changes.find((c) => c.stars === 1);

  return (
    <div className="flex flex-col gap-4">
      {!collected && <NotCollected label={label} what="Business profile" />}

      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        {profile.title}
        {profile.address ? ` · ${profile.address}` : ''}
        {profile.claimed === false ? ' · unclaimed listing' : ''} — asked for as
        &ldquo;{profile.query}&rdquo;, collected{' '}
        {snapshot.collectedAt ? staleness(snapshot.collectedAt) : 'at an unknown time'}.
      </p>

      <Panel>
        <StatRow>
          <Stat
            /**
             * THE HERO, and it is a count. See the file header for the
             * arithmetic that puts it here rather than the average.
             */
            label="One-star reviews"
            value={formatNumber(oneStar?.count)}
            sub={
              typeof oneStar?.change === 'number'
                ? `${oneStar.change > 0 ? '+' : ''}${oneStar.change} since the last reading`
                : 'no comparable earlier reading'
            }
          />
          <Stat
            label="Reviews"
            value={formatNumber(profile.ratingVotes, { compact: true })}
            sub={`${formatNumber(profile.distributionTotal, { compact: true })} across the star breakdown`}
          />
          <Stat
            /** Google's own average. Secondary, deliberately. */
            label="Google rating"
            value={
              profile.rating === null
                ? '—'
                : `${profile.rating} / ${profile.ratingMax}`
            }
            sub="Google’s own average — it barely moves"
          />
          <Stat
            label="Photos"
            value={formatNumber(profile.totalPhotos)}
            sub={profile.category || 'on the listing'}
          />
        </StatRow>
      </Panel>

      {headline && (
        <p
          className="font-body px-4 py-3"
          style={{
            fontSize: 13,
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text-primary)',
          }}
        >
          {headline}
        </p>
      )}

      {!guard.ok && guard.reason && (
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          No change is shown against the previous reading: {guard.reason}
        </p>
      )}

      <LabsFilterBar query="" onQuery={() => {}} placeholder="" onExport={runExport} />

      <Panel>
        <PanelHead
          title="Star breakdown"
          sub="the counts, because the average cannot see twenty new one-stars"
        />
        <div className="flex flex-col gap-2 px-4 py-4">
          {changes.map((bucket) => {
            const share = bucketShare(bucket.count, profile.distributionTotal);
            return (
              <div key={bucket.key} className="flex items-center gap-3">
                <span
                  className="font-body"
                  style={{ fontSize: 12.5, minWidth: 62, color: 'var(--color-text-secondary)' }}
                >
                  {bucket.label}
                </span>
                <span
                  style={{
                    flex: 1,
                    height: 8,
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--color-bg-subtle)',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      width: share === null ? 0 : `${Math.max(1, share * 100)}%`,
                      height: '100%',
                      background:
                        bucket.stars <= 2
                          ? 'var(--color-status-stuck)'
                          : 'var(--color-accent)',
                    }}
                  />
                </span>
                <span
                  className="font-body text-right"
                  style={{ fontSize: 12.5, minWidth: 70, color: 'var(--color-text-primary)' }}
                >
                  {formatNumber(bucket.count)}
                </span>
                <span
                  className="font-body text-right"
                  style={{
                    fontSize: 12,
                    minWidth: 54,
                    color:
                      typeof bucket.change !== 'number' || bucket.change === 0
                        ? 'var(--color-text-muted)'
                        : (bucket.change > 0) === (bucket.stars <= 2)
                          ? 'var(--color-status-stuck)'
                          : 'var(--color-status-done)',
                  }}
                >
                  {typeof bucket.change === 'number'
                    ? `${bucket.change > 0 ? '+' : ''}${bucket.change}`
                    : '—'}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <Panel>
          <PanelHead
            title="What the reviews are about"
            sub="Google’s own themes, mined from the reviews"
            right={<CountChip>{profile.placeTopics.length}</CountChip>}
          />
          {profile.placeTopics.length === 0 ? (
            <p
              className="font-body px-4 py-4"
              style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
            >
              Google has attached no themes to this listing.
            </p>
          ) : (
            <ScrollTable maxHeight={260}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <Th align="left">Theme</Th>
                    <Th align="right" width={110}>Mentions</Th>
                  </tr>
                </thead>
                <tbody>
                  {profile.placeTopics.map((topic) => (
                    <tr key={topic.topic}>
                      <Td>{topic.topic}</Td>
                      <Td align="right">{formatNumber(topic.count)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTable>
          )}
        </Panel>

        <Panel>
          <PanelHead
            title="Who Google puts beside this business"
            sub="the competitive set, named by Google rather than guessed"
            right={<CountChip>{profile.peopleAlsoSearch.length}</CountChip>}
          />
          {profile.peopleAlsoSearch.length === 0 ? (
            <p
              className="font-body px-4 py-4"
              style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
            >
              Google lists nothing beside this business.
            </p>
          ) : (
            <ScrollTable maxHeight={260}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <Th align="left">Business</Th>
                    <Th align="right" width={90}>Rating</Th>
                    <Th align="right" width={100}>Reviews</Th>
                  </tr>
                </thead>
                <tbody>
                  {profile.peopleAlsoSearch.map((row) => (
                    <tr key={row.cid || row.title}>
                      <Td>{row.title}</Td>
                      <Td align="right">{formatNumber(row.rating)}</Td>
                      <Td align="right">{formatNumber(row.votes, { compact: true })}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTable>
          )}
        </Panel>
      </div>
    </div>
  );
};

export default LocalScreen;

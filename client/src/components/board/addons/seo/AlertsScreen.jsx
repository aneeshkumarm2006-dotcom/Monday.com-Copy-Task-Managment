import { Link } from 'react-router-dom';
import { BellRing } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import { ScrollTable, Td, Th } from '../connector/SectionShell';
import { formatNumber } from '../../../../utils/connectorFormat';
import { NotCollected, Panel, PanelHead } from './LabsBits';

/**
 * Alerts — what the last reading set off, and what the rules are.
 *
 * ---- Why this is a screen and not only a notification ----------------------
 *
 * The bell is the DELIVERY. It is one line, it is per person, and it is gone
 * once it is read. What a board needs beside it is the standing answer: which
 * rules are armed, what the thresholds are, and what the latest reading actually
 * triggered — so that "why did I get told about this" and, more often, "why was
 * I NOT told about that" are both answerable without reading source.
 *
 * ---- Where the answer comes from, and why it is not computed here ----------
 *
 * From the server, on the payload this tab already fetched. `connectorDataController`
 * calls `connector.alerts.evaluate` over the snapshots it is holding in memory
 * anyway, so there is no extra query — and, the point, no second implementation
 * of a threshold. `services/seoAlertRunner.js` calls the identical function when
 * it decides whether to send a notification, so what this screen shows and what
 * the bell says can never disagree.
 *
 * That is deliberately unlike `comparability`, which exists on both sides
 * because a screen needed it without a round trip. This screen has one.
 *
 * ---- A rule that did NOT fire is a row -------------------------------------
 *
 * With a reason: "nothing this rule reads is being collected", "only one reading
 * exists", "these two readings were bought to different depths", or nothing at
 * all, which means it looked and found nothing. A screen that showed only the
 * alerts that fired would be indistinguishable from a screen where the alerting
 * had silently stopped working.
 */

const toneFor = (row) => {
  if (row.fired) return 'var(--color-status-stuck)';
  if (row.reason) return 'var(--color-text-muted)';
  return 'var(--color-status-done)';
};

const stateLabel = (row) => {
  if (row.fired) return 'Fired';
  if (row.reason) return 'Not checked';
  return 'Nothing to report';
};

/** The thresholds, spelled from the server's own numbers rather than restated. */
const thresholdLine = (rule) => {
  const t = rule?.thresholds || {};
  if ('minDrop' in t) {
    return `A keyword at position ${t.fromBetterThan} or better falling ${t.minDrop} places or more, or leaving the results bought.`;
  }
  if ('minShare' in t) {
    return `Referring domains falling by at least ${Math.round(t.minShare * 100)}% AND by at least ${t.minDomains}.`;
  }
  return '';
};

const AlertsScreen = ({ data, label }) => {
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  const rules = Array.isArray(data?.provider?.alertRules) ? data.provider.alertRules : [];
  const ruleByKey = new Map(rules.map((r) => [r.key, r]));

  if (!rules.length) {
    return (
      <EmptyState
        icon={BellRing}
        title="No alert rules"
        description={`${label} declares no alerts on this version of the app.`}
      />
    );
  }

  const missingKinds = [
    ...new Set(
      alerts
        .filter((a) => /not being collected/i.test(a.reason || ''))
        .map((a) => a.kind)
    ),
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        These are checked against every new reading, an hour after it is collected.
        Nothing on this screen costs anything — the rules read snapshots the other
        screens already paid for. Each person can silence the bell for them under{' '}
        <Link
          to="/settings?tab=notifications"
          className="underline"
          style={{ color: 'var(--color-accent)' }}
        >
          notification preferences
        </Link>{' '}
        (the &ldquo;SEO alerts&rdquo; category), which is separate from these
        board-wide rules.
      </p>

      {missingKinds.map((kind) => (
        <NotCollected key={kind} label={label} what={`The "${kind}" collection`} />
      ))}

      <Panel>
        <PanelHead
          title="What the latest reading set off"
          sub="every rule is listed, whether or not it fired"
        />
        <ScrollTable maxHeight={520}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th align="left" width={170}>Rule</Th>
                <Th align="left" width={140}>State</Th>
                <Th align="left">What it found</Th>
                <Th align="right" width={130}>Reading</Th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((row) => {
                const rule = ruleByKey.get(row.rule) || null;
                return (
                  <tr key={row.rule}>
                    <Td>
                      <div className="flex flex-col">
                        <span>{row.label || rule?.label || row.rule}</span>
                        <span
                          className="font-body"
                          style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                        >
                          from {row.kind}
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <span className="font-body" style={{ fontSize: 12.5, color: toneFor(row) }}>
                        {stateLabel(row)}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className="font-body"
                        style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}
                      >
                        {row.message || row.reason || 'Nothing crossed the threshold.'}
                      </span>
                      {row.detail?.drops?.length ? (
                        <div className="mt-1 flex flex-col gap-0.5">
                          {row.detail.drops.slice(0, 8).map((drop) => (
                            <span
                              key={drop.keyword}
                              className="font-body"
                              style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                            >
                              {drop.keyword}: {drop.from} →{' '}
                              {drop.to === null
                                ? `out of the top ${row.detail.depth ?? '?'}`
                                : drop.to}
                            </span>
                          ))}
                          {row.detail.drops.length > 8 && (
                            <span
                              className="font-body"
                              style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                            >
                              and {formatNumber(row.detail.drops.length - 8)} more
                            </span>
                          )}
                        </div>
                      ) : null}
                    </Td>
                    <Td align="right">
                      <div className="flex flex-col">
                        <span>{row.periodKey || '—'}</span>
                        {row.previousPeriodKey && (
                          <span
                            className="font-body"
                            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                          >
                            vs {row.previousPeriodKey}
                          </span>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollTable>
      </Panel>

      <Panel>
        <PanelHead
          title="The thresholds"
          sub="the server's own numbers, not a restatement of them"
        />
        <div className="flex flex-col">
          {rules.map((rule) => (
            <div
              key={rule.key}
              className="px-4 py-3"
              style={{ borderTop: '1px solid var(--color-border)' }}
            >
              <p
                className="font-display font-semibold"
                style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
              >
                {rule.label}
              </p>
              <p
                className="font-body mt-0.5"
                style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}
              >
                {rule.blurb}
              </p>
              <p
                className="font-body mt-1"
                style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
              >
                {thresholdLine(rule)}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        Every alert is checked against the same comparability rules the screens use:
        two readings taken at different depths, over different link sets, or from
        crawls of different sizes are never subtracted. An alert that fired because
        a setting changed would be worse than no alert, because somebody would act
        on it.
      </p>
    </div>
  );
};

export default AlertsScreen;

import { ChevronLeft, Download, Plus } from 'lucide-react';

import { formatMoney } from '../../../utils/connectorFormat';
import { formatPct } from '../../../utils/adsBudgetDisplay';
import BudgetOverviewCard from './BudgetOverviewCard';
import BudgetTable from './BudgetTable';
import BudgetActivityTable from './BudgetActivityTable';
import { BudgetStat, MiniButton, Section } from './BudgetBits';

/**
 * One client's month.
 *
 * The order is the brief's, and it is an argument rather than a layout:
 * budget → spend → remaining → pacing → allocation → campaigns → activity.
 * Somebody opening this should know the financial state in the first two
 * seconds and only then start reading tables.
 */
const ClientBudgetScreen = ({
  data,
  activity,
  activityError,
  onBack,
  onAddPlatform,
  onAddCampaign,
  onEdit,
  onDelete,
  onCommitSpend,
  onExportActivity,
  // Resolved by the tab: the board page's answer until the server's arrives.
  canTrack,
  canManage,
}) => {
  const currency = data.currency || 'USD';
  const money = (v) => formatMoney(v, currency);
  const { totals, window: win } = data;

  // Every campaign across every platform, flattened for the second table. The
  // Campaign budget tracker is one table spanning the channels, not one per
  // platform — the question it answers is "which campaign needs looking at",
  // which is not a per-channel question.
  const campaigns = data.platforms.flatMap((p) => p.campaigns).concat(data.orphans || []);

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-center gap-3">
        <MiniButton icon={ChevronLeft} onClick={onBack}>
          All clients
        </MiniButton>
        <h2
          className="font-display font-semibold min-w-0 truncate"
          style={{ fontSize: 17, color: 'var(--color-text-primary)' }}
        >
          {data.group.name}
        </h2>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4">
        <BudgetStat
          label="Monthly Budget"
          value={money(totals.allocated)}
          sub="Planned advertising budget"
        />
        <BudgetStat
          label="Total Spend"
          value={money(totals.spent)}
          sub={
            totals.usedPct === null
              ? 'Nothing budgeted yet'
              : `${formatPct(totals.usedPct)} of total budget used`
          }
        />
        <BudgetStat
          label="Remaining Budget"
          value={money(totals.remaining)}
          sub="Available to allocate"
        />
        <BudgetStat
          label="Daily Average Spend"
          value={totals.dailyAverage === null ? '—' : money(Math.round(totals.dailyAverage))}
          sub="Based on current campaign activity"
        />
      </div>

      <BudgetOverviewCard
        totals={totals}
        window={win}
        monthLabel={data.monthLabel}
        currency={currency}
        platforms={data.platforms}
      />

      <Section
        title="Platform budgets"
        description="Allocate and monitor spend by advertising platform."
        actions={
          canManage ? (
            <MiniButton icon={Plus} onClick={onAddPlatform}>
              Platform
            </MiniButton>
          ) : null
        }
      >
        <BudgetTable
          rows={data.platforms}
          level="platform"
          currency={currency}
          canTrack={canTrack}
          canManage={canManage}
          onCommitSpend={onCommitSpend}
          onEdit={onEdit}
          onDelete={onDelete}
          onAdd={onAddPlatform}
          emptyLabel={`No advertising budget set for ${data.group.name} in ${data.monthLabel}.`}
          emptyAction="Add the first platform"
        />
      </Section>

      <Section
        title="Campaign budget tracker"
        description="Every campaign belongs to a platform, keeping the structure universal across ad networks."
        actions={
          canManage ? (
            <MiniButton
              icon={Plus}
              onClick={() => onAddCampaign(data.platforms[0])}
              disabled={data.platforms.length === 0}
              title={
                data.platforms.length === 0
                  ? 'Add a platform first — a campaign belongs to one'
                  : undefined
              }
            >
              Campaign
            </MiniButton>
          ) : null
        }
      >
        <BudgetTable
          rows={campaigns}
          level="campaign"
          currency={currency}
          canTrack={canTrack}
          canManage={canManage}
          onCommitSpend={onCommitSpend}
          onEdit={onEdit}
          onDelete={onDelete}
          onAdd={() => onAddCampaign(data.platforms[0])}
          emptyLabel={
            data.platforms.length === 0
              ? 'Campaigns sit inside a platform. Add a platform budget first.'
              : 'No campaigns broken out yet. A platform budget works on its own — campaigns are for when you want the detail.'
          }
          emptyAction={data.platforms.length > 0 ? 'Add the first campaign' : undefined}
        />
      </Section>

      <Section
        title="Budget activity"
        description="Recent changes to allocations and advertising spend, written as budgets and spend are edited."
        actions={
          /* The ledger exports on its own, not with the budget tables. It is a
             different shape of sheet — one row per movement rather than one per
             budget — and the question it answers ("where did the month's money
             go") is not the one the tables answer. */
          <span className="inline-flex items-center gap-1">
            <MiniButton icon={Download} onClick={() => onExportActivity('csv')} title="Export the ledger as CSV">
              CSV
            </MiniButton>
            <MiniButton icon={Download} onClick={() => onExportActivity('pdf')} title="Export the ledger as PDF">
              PDF
            </MiniButton>
          </span>
        }
      >
        <BudgetActivityTable items={activity} currency={currency} error={activityError} />
      </Section>
    </div>
  );
};

export default ClientBudgetScreen;

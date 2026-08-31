import { History } from 'lucide-react';

import Avatar from '../../ui/Avatar';
import { ScrollTable, Th, Td } from '../addons/connector/SectionShell';
import { formatMoney } from '../../../utils/connectorFormat';
import { amountColor, ledgerRows, signedAmount } from '../../../utils/adsBudgetDisplay';
import { SectionEmpty } from './BudgetBits';

/**
 * Budget Activity — a lightweight ledger of what moved, and who moved it.
 *
 * ---- Nobody types these in -------------------------------------------------
 *
 * Every line here is a row EDIT, read back as a money movement. That is what
 * lets the tables above carry editable Budget and Spend fields without anybody
 * also hand-entering a matching ledger line, and it is why correcting a typo
 * moves the ledger rather than adding a second entry contradicting the first.
 *
 * The rules live in `utils/adsBudgetDisplay.js` and are unit-tested, because
 * the sign convention is the sort of thing that is easy to get backwards and
 * impossible to spot by looking: spend RISING is money leaving, even though its
 * delta is positive.
 */

/** "Aug 03", from an ISO instant. The month view means the year is redundant. */
const shortDay = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
};

const BudgetActivityTable = ({ items, currency, error }) => {
  // A failed ledger read is shown here and nowhere else. It must never blank
  // the budget tables above it, which is why this panel has its own request and
  // its own error — the rule GoalsTab states for its connector reads.
  if (error) {
    return (
      <SectionEmpty icon={History}>
        {error}
      </SectionEmpty>
    );
  }

  const rows = ledgerRows(items);

  if (rows.length === 0) {
    return (
      <SectionEmpty icon={History}>
        Nothing has moved this month yet. Budget changes and spend appear here as they happen.
      </SectionEmpty>
    );
  }

  return (
    <ScrollTable maxHeight={360}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <Th width={80}>Date</Th>
            <Th>Platform</Th>
            <Th>Activity</Th>
            <Th align="right">Amount</Th>
            <Th>User</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row._id}>
              <Td muted>{shortDay(row.createdAt)}</Td>
              <Td>
                <span className="font-body">{row.platform || '—'}</span>
                {/* A campaign's own name, under its platform. The ledger is
                    read down the Amount column, so the second line stays
                    subordinate rather than becoming its own column. */}
                {row.isCampaign && row.name && row.name !== row.platform ? (
                  <span
                    className="font-body block truncate"
                    style={{ fontSize: 11, color: 'var(--color-text-muted)', maxWidth: 200 }}
                    title={row.name}
                  >
                    {row.name}
                  </span>
                ) : null}
              </Td>
              <Td muted>{row.activity}</Td>
              <Td align="right">
                <span
                  className="font-body font-medium tabular-nums"
                  style={{ color: amountColor(row) }}
                >
                  {signedAmount(row, (n) => formatMoney(n, currency))}
                </span>
              </Td>
              <Td>
                {row.actor ? (
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <Avatar user={row.actor} size={20} />
                    <span className="font-body truncate" style={{ maxWidth: 140 }}>
                      {row.actor.name}
                    </span>
                  </span>
                ) : (
                  <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollTable>
  );
};

export default BudgetActivityTable;

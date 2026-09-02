import { ChevronRight, Wallet } from 'lucide-react';

import { ScrollTable, Th, Td } from '../addons/connector/SectionShell';
import { formatMoney } from '../../../utils/connectorFormat';
import { formatPct } from '../../../utils/adsBudgetDisplay';
import { BudgetBar, BudgetStat, Section, SectionEmpty, StatusText } from './BudgetBits';

/**
 * One client as a card — the phone rendering of the roster row. The table's
 * eight columns collapse to the three facts a phone glance needs: who, the
 * verdict, and the pacing bar (spend fill vs. the today tick). Everything
 * else lives one tap away on the client screen.
 */
const ClientCard = ({ client, money, elapsedPct, onOpen }) => {
  const blank = client.state === 'unset';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left transition-colors duration-100 active:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '14px 16px',
        cursor: 'pointer',
      }}
    >
      <span className="flex items-center gap-2">
        <span
          className="font-body font-semibold flex-1 min-w-0 truncate"
          style={{ fontSize: 14.5, color: 'var(--color-text-primary)' }}
        >
          {client.name}
        </span>
        <StatusText state={client.state} label={client.label} title={client.verdict} />
        <ChevronRight size={15} color="var(--color-text-muted)" aria-hidden="true" />
      </span>

      {blank ? (
        <span
          className="font-body block mt-1"
          style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
        >
          {client.platformCount === 0
            ? 'No platforms yet — open to add the first budget.'
            : `${client.platformCount} platform${client.platformCount === 1 ? '' : 's'}, nothing budgeted.`}
        </span>
      ) : (
        <>
          <span
            className="font-body block mt-1 tabular-nums"
            style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
          >
            {money(client.spent)} of {money(client.allocated)} · {formatPct(client.usedPct)} used
          </span>
          <span className="block mt-2.5">
            <BudgetBar
              usedPct={client.usedPct}
              state={client.state}
              label={client.label}
              height={6}
              marker={elapsedPct}
            />
          </span>
        </>
      )}
    </button>
  );
};

/**
 * The roster — every client on this board, one row each, for the selected month.
 *
 * ---- Why this is the tab's first screen and not the dashboard --------------
 *
 * A tracker board carries one client per GROUP, two dozen of them. A single
 * flat budget dashboard could only ever describe one of them, and stacking two
 * dozen dashboards on one page is a page nobody can find anything on. So the
 * money is answered twice, at two altitudes: this screen says which clients
 * need looking at, and the arrow opens the one that does.
 *
 * It is deliberately the SAME furniture as the client screen — the same four
 * stat cards, the same table treatment, the same status wording — so moving
 * between the two altitudes does not mean learning a second page.
 *
 * ---- Clients with no budget are LISTED ------------------------------------
 *
 * With em dashes and a "Not set up" status, rather than being filtered out. In
 * the first week of a month that is most of this screen's value: "who has
 * nobody looking after them yet" is a question a roster of only the clients
 * already set up can never answer.
 */
const ClientRosterScreen = ({ data, onOpenClient }) => {
  const currency = data.currency || 'USD';
  const money = (v) => formatMoney(v, currency);
  const { totals, window: win } = data;

  return (
    <div className="flex flex-col gap-7">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4">
        <BudgetStat
          label="Monthly Budget"
          value={money(totals.allocated)}
          sub="Planned across every client"
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
          sub={
            win && win.elapsedDays > 0
              ? `Across ${win.elapsedDays} day${win.elapsedDays === 1 ? '' : 's'} so far`
              : 'This month has not started'
          }
        />
      </div>

      <Section
        title="Clients"
        description="Budget, spend and pacing for every client on this board. Open one to manage its platforms and campaigns."
      >
        {data.clients.length === 0 ? (
          <SectionEmpty icon={Wallet}>
            This board has no groups yet, so there is nobody to budget for.
          </SectionEmpty>
        ) : (
          <>
          {/* Phones: cards. The eight-column table can only offer a phone a
              sideways scroll, and a roster you have to pan across is a roster
              nobody reads in the morning. */}
          <div className="md:hidden flex flex-col gap-2.5 p-3">
            {data.clients.map((client) => (
              <ClientCard
                key={client._id}
                client={client}
                money={money}
                elapsedPct={win?.elapsedPct}
                onOpen={() => onOpenClient(client)}
              />
            ))}
          </div>

          <div className="hidden md:block">
          <ScrollTable maxHeight={600}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th>Client</Th>
                  <Th align="right">Budget</Th>
                  <Th align="right">Spend</Th>
                  <Th align="right">Remaining</Th>
                  <Th align="right">Used</Th>
                  <Th>Status</Th>
                  <Th align="right">Daily Avg.</Th>
                  <Th width={40}>
                    <span className="sr-only">Open</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {data.clients.map((client) => {
                  // A client nobody has budgeted for shows em dashes rather than
                  // zeros. "$0" and "nobody has set this client up" look
                  // identical as a number and are opposite facts.
                  const blank = client.state === 'unset';
                  return (
                    <tr
                      key={client._id}
                      onClick={() => onOpenClient(client)}
                      className="cursor-pointer transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
                    >
                      <Td>
                        <span className="font-body font-medium">{client.name}</span>
                        <span
                          className="font-body block"
                          style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
                        >
                          {client.platformCount === 0
                            ? 'No platforms'
                            : `${client.platformCount} platform${client.platformCount === 1 ? '' : 's'}`}
                        </span>
                      </Td>
                      <Td align="right">{blank ? '—' : money(client.allocated)}</Td>
                      <Td align="right">{blank ? '—' : money(client.spent)}</Td>
                      <Td align="right">
                        {blank ? (
                          '—'
                        ) : (
                          <span
                            style={{
                              color:
                                client.remaining < 0
                                  ? 'var(--color-status-stuck)'
                                  : 'var(--color-text-primary)',
                            }}
                          >
                            {money(client.remaining)}
                          </span>
                        )}
                      </Td>
                      <Td align="right" muted>
                        {formatPct(client.usedPct)}
                      </Td>
                      <Td>
                        <StatusText state={client.state} label={client.label} title={client.verdict} />
                      </Td>
                      <Td align="right" muted>
                        {/* `blank`, not `=== null`: a client with nothing set
                            up has a daily average of a real 0, and "$0 a day"
                            beside four em dashes reads as a measured rate
                            rather than as the absence of one. */}
                        {blank || client.dailyAverage === null
                          ? '—'
                          : money(Math.round(client.dailyAverage))}
                      </Td>
                      <Td align="right">
                        {/* A real button inside the clickable row, so the
                            drill-in is reachable by keyboard — a row that only
                            responds to a click is a row screen-reader users
                            cannot open. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenClient(client);
                          }}
                          aria-label={`Open the ads budget for ${client.name}`}
                          className="inline-flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 'var(--radius-sm)',
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--color-text-muted)',
                            cursor: 'pointer',
                          }}
                        >
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTable>
          </div>
          </>
        )}
      </Section>
    </div>
  );
};

export default ClientRosterScreen;

import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { ScrollTable, Th, Td } from '../addons/connector/SectionShell';
import { formatMoney } from '../../../utils/connectorFormat';
import { formatPct } from '../../../utils/adsBudgetDisplay';
import { PlatformMark, SectionEmpty, StatusText } from './BudgetBits';

/**
 * One budget table. Serves BOTH levels — platforms and campaigns.
 *
 * ---- Why one component and not two -----------------------------------------
 *
 * The two tables differ by three columns and nothing else: a platform row leads
 * with a platform mark and ends with its daily average, a campaign row leads
 * with a campaign name and names its platform and type. Everything that matters
 * — the money, the status, the inline spend edit, the row actions — is
 * identical, and it is the part that will keep changing. Two components would
 * be two places to keep that in step, and they would drift.
 *
 * ---- No progress bars in here ----------------------------------------------
 *
 * There is one bar on this page and it is in Budget Overview. A bar in every
 * row of a six-number table is texture, not information: the Used column
 * already carries the figure, and twenty small bars stacked down a page read as
 * a pattern rather than as twenty separate facts. The design draws it this way
 * and it is right.
 *
 * ---- The inline spend cell -------------------------------------------------
 *
 * Spend is the ONE field editable straight from the table, because it is the
 * field that changes weekly and the only one somebody on the `contribute` rung
 * may touch. Everything else opens the modal. That split is not a UI whim: it
 * mirrors the capability split exactly, so a contributor never meets a control
 * that will 403 them.
 */

const EDIT_WIDTH = 96;

/**
 * Spend: formatted until you click it, a number field while you type.
 *
 * A raw `<input type="number">` sitting permanently in the column shows `4850`
 * in a row where every other money cell shows `$8,000`. That reads as a
 * different kind of value rather than as an editable one — and the currency,
 * which is the whole reason the board carries a setting for it, disappears from
 * the one column people look at most.
 *
 * So the resting state is text and the editing state is a field. The swap is
 * what lets the number be formatted AND editable in place; a formatter applied
 * to a live input would fight the person typing into it.
 */
const SpendCell = ({ row, canTrack, currency, onCommit }) => {
  const [editing, setEditing] = useState(false);

  if (!canTrack) return <>{formatMoney(row.spent, currency)}</>;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Spend for ${row.name || row.platform}. Click to edit.`}
        className="font-body tabular-nums text-right transition-colors duration-100 hover:bg-[color:var(--color-bg-input)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          width: EDIT_WIDTH,
          height: 26,
          padding: '0 6px',
          fontSize: 13,
          border: '1px solid transparent',
          borderRadius: 'var(--radius-sm)',
          background: 'transparent',
          color: 'var(--color-text-primary)',
          cursor: 'text',
        }}
      >
        {formatMoney(row.spent, currency)}
      </button>
    );
  }

  return (
    <input
      type="number"
      min="0"
      step="0.01"
      inputMode="decimal"
      autoFocus
      defaultValue={row.spent}
      aria-label={`Spend for ${row.name || row.platform}`}
      /**
       * `defaultValue` plus a commit on blur, NOT a controlled value.
       *
       * A controlled input re-rendered from the server's answer fights the
       * person typing in it: the quiet SSE refetch lands mid-keystroke and
       * replaces "48" with "4850" under the cursor. Uncontrolled means the
       * field is the person's until they leave it, and `key` on the cell is
       * what resets it when the underlying value genuinely changes.
       */
      onBlur={(e) => {
        const next = e.target.value === '' ? 0 : Number(e.target.value);
        setEditing(false);
        if (!Number.isFinite(next) || next < 0) return;
        if (next === row.spent) return;
        onCommit(row, next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          // Reset before blurring, so the blur handler sees the old value and
          // commits nothing. Escape has to mean "forget it", not "save it".
          e.currentTarget.value = row.spent;
          e.currentTarget.blur();
        }
      }}
      className="font-body tabular-nums text-right focus:outline-none focus:bg-white focus:border-[color:var(--color-accent)]"
      style={{
        width: EDIT_WIDTH,
        height: 26,
        padding: '0 6px',
        fontSize: 13,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-bg-input)',
        color: 'var(--color-text-primary)',
      }}
    />
  );
};

/** One icon button in the row-actions cluster. */
const ActionButton = ({ icon: Icon, label, title, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={label}
    className="inline-flex items-center justify-center transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      width: 26,
      height: 26,
      borderRadius: 'var(--radius-sm)',
      border: 'none',
      background: 'transparent',
      color: 'var(--color-text-muted)',
      cursor: 'pointer',
    }}
  >
    {Icon ? <Icon size={14} aria-hidden="true" /> : null}
  </button>
);

/**
 * Row actions, out of the way until the row is hovered or focused.
 *
 * The design draws no actions column at all, and it is right that two icons per
 * row is clutter in a table people read by scanning numbers. But the buttons
 * have to exist, so on a pointer device they fade in with the row's hover wash
 * and on touch — where there is no hover and nothing to reveal them — they stay
 * visible. `group-focus-within` is what keeps them reachable by keyboard.
 */
const RowActions = ({ row, onEdit, onDelete }) => (
  <span className="inline-flex items-center gap-1 transition-opacity duration-100 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
    <ActionButton
      icon={Pencil}
      label={`Edit ${row.name || row.platform}`}
      title="Edit this budget"
      onClick={() => onEdit(row)}
    />
    <ActionButton
      icon={Trash2}
      label={`Delete ${row.name || row.platform}`}
      title="Delete this budget"
      onClick={() => onDelete(row)}
    />
  </span>
);

const BudgetTable = ({
  rows,
  level, // 'platform' | 'campaign'
  currency,
  canTrack,
  canManage,
  onCommitSpend,
  onEdit,
  onDelete,
  onAdd,
  emptyLabel,
  emptyAction,
}) => {
  const isCampaign = level === 'campaign';
  const money = (v) => formatMoney(v, currency);

  if (rows.length === 0) {
    return (
      <SectionEmpty
        icon={Plus}
        actionLabel={canManage && emptyAction ? emptyAction : undefined}
        onAction={canManage && emptyAction ? onAdd : undefined}
      >
        {emptyLabel}
      </SectionEmpty>
    );
  }

  return (
    <ScrollTable maxHeight={520}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <Th>{isCampaign ? 'Campaign' : 'Platform'}</Th>
            {isCampaign ? <Th>Platform</Th> : null}
            {/* "Type" rather than "Objective": it is the word the design uses,
                and every network names this differently anyway — the field is
                free text for exactly that reason. */}
            {isCampaign ? <Th>Type</Th> : null}
            <Th align="right">Budget</Th>
            <Th align="right">{isCampaign ? 'Spent' : 'Spend'}</Th>
            <Th align="right">Remaining</Th>
            <Th align="right">Used</Th>
            <Th>Status</Th>
            {!isCampaign ? <Th align="right">Daily Avg.</Th> : null}
            {canManage ? (
              <Th width={72} align="right">
                <span className="sr-only">Actions</span>
              </Th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row._id}
              className="group transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
            >
              <Td>
                <span className="flex items-center gap-2.5 min-w-0">
                  {!isCampaign ? <PlatformMark name={row.platform} /> : null}
                  <span className="font-body font-medium truncate" title={row.name || row.platform}>
                    {isCampaign ? row.name || 'Untitled campaign' : row.platform}
                  </span>
                </span>
              </Td>
              {isCampaign ? <Td muted>{row.platform || '—'}</Td> : null}
              {isCampaign ? <Td muted>{row.objective || '—'}</Td> : null}
              <Td align="right">{money(row.allocated)}</Td>
              <Td align="right">
                {/* `key` on the cell is what makes an uncontrolled field pick up
                    a value changed elsewhere — by someone else's edit arriving
                    over SSE, or by this row's own modal. */}
                <SpendCell
                  key={`${row._id}:${row.spent}`}
                  row={row}
                  canTrack={canTrack}
                  currency={currency}
                  onCommit={onCommitSpend}
                />
              </Td>
              <Td align="right">
                {/* Remaining is the one money column that carries a colour, and
                    only when it has gone negative — at which point it is the
                    single most important number on the row. */}
                <span
                  style={{
                    color: row.remaining < 0 ? 'var(--color-status-stuck)' : 'var(--color-text-primary)',
                  }}
                >
                  {money(row.remaining)}
                </span>
              </Td>
              <Td align="right" muted>
                {formatPct(row.usedPct)}
              </Td>
              <Td>
                <StatusText state={row.state} label={row.label} title={row.verdict} />
              </Td>
              {!isCampaign ? (
                <Td align="right" muted>
                  {/* Rounded to whole units. A daily average is a RATE derived
                      from a division, not an amount anybody paid — "$57.14 a
                      day" claims a precision the number does not have, and the
                      cents make it the odd one out in a column of round
                      figures. */}
                  {row.dailyAverage === null ? '—' : money(Math.round(row.dailyAverage))}
                </Td>
              ) : null}
              {canManage ? (
                <Td align="right">
                  <RowActions row={row} onEdit={onEdit} onDelete={onDelete} />
                </Td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollTable>
  );
};

export default BudgetTable;

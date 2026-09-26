import { useMemo, useState } from 'react';
import { cellWrapperStyle, optionSorted, pickableOptions, findOption } from './cellShared';
import { getColorPair } from '../../../utils/priorityColors';
import OptionMenu from '../../ui/OptionMenu';

/**
 * StatusCell — renders the selected option as a coloured chip. Clicking
 * opens a menu listing every option somebody may still choose.
 *
 * TWO lists, deliberately. The chip is looked up in EVERY option the column
 * has; the menu is built only from the pickable ones. That is what lets a
 * vocabulary shrink without erasing history — a retired choice keeps rendering
 * on the rows that already hold it (marked as retired, so nobody wonders why
 * they cannot find it in the list) and is simply no longer offered. Clearing
 * the cell is still reachable, which is how a row leaves a retired choice
 * behind.
 *
 * The menu is `ui/OptionMenu` — a portal at `position: fixed` — not a panel
 * absolutely positioned inside the cell. In the Table the cell sits in the
 * grid's `overflow-x: auto` wrapper inside an `overflow: hidden` group card,
 * so on a group of one or two rows the old panel was cut off at the grid's
 * bottom edge and the choices below it could not be picked (the same failure
 * DataGrid's own header comment describes for the column menu).
 */
const StatusCell = ({ value, column, readOnly, onChange }) => {
  const [anchor, setAnchor] = useState(null);
  const options = optionSorted(column?.settings?.options);
  const selected = findOption(options, value);
  const selectedRetired = !!selected?.archived;

  const menuOptions = useMemo(
    () =>
      pickableOptions(column?.settings?.options).map((o) => ({
        value: String(o.id),
        label: o.label,
        palette: getColorPair(o.color),
      })),
    [column?.settings?.options]
  );

  const chip = (label, color) => {
    const pair = getColorPair(color);
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '3px 10px',
          fontSize: 12,
          fontWeight: 500,
          color: pair.text,
          background: pair.bg,
          borderRadius: 'var(--radius-full)',
        }}
      >
        {label}
      </span>
    );
  };

  const close = () => setAnchor(null);

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div
        style={{ ...cellWrapperStyle, cursor: readOnly ? 'default' : 'pointer' }}
        onClick={(e) => {
          if (readOnly) return;
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
        aria-haspopup={readOnly ? undefined : 'listbox'}
        aria-expanded={readOnly ? undefined : !!anchor}
      >
        {selected ? (
          <span
            title={selectedRetired ? `${selected.label} — retired, so it can no longer be chosen` : undefined}
            style={selectedRetired ? { opacity: 0.6, textDecoration: 'line-through' } : undefined}
          >
            {chip(selected.label, selected.color)}
          </span>
        ) : (
          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
        )}
      </div>
      {anchor && !readOnly && (
        // A SIBLING of the trigger, never its child: React bubbles a click in
        // the portal to its React parents, and the trigger's toggle would shut
        // the menu the click came from.
        <OptionMenu
          anchorEl={anchor}
          options={menuOptions}
          value={value != null && value !== '' ? String(value) : null}
          onSelect={(v) => onChange?.(v)}
          onClose={close}
          layout="rows"
          width={220}
          emptyText="No choices left to pick."
          footer={
            value
              ? {
                  label: 'Clear',
                  onClick: () => {
                    onChange?.(null);
                    close();
                  },
                }
              : null
          }
          ariaLabel={column?.name || 'Choices'}
        />
      )}
    </div>
  );
};

export default StatusCell;

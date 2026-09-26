import { useMemo, useState } from 'react';
import { cellWrapperStyle, optionSorted, pickableOptions } from './cellShared';
import { getColorPair } from '../../../utils/priorityColors';
import OptionMenu from '../../ui/OptionMenu';

/**
 * TagsCell — multi-select over `settings.options`. Renders each selected tag
 * as a coloured chip; clicking opens a checklist menu.
 *
 * Like StatusCell it keeps TWO lists: the chips are drawn from every option the
 * column has, the checklist only from the pickable ones. A retired tag
 * therefore stays visible (and removable) on the rows already carrying it
 * without being offered to anybody new — see `pickableOptions`.
 *
 * The checklist is `ui/OptionMenu` with `multiple` (a portal at
 * `position: fixed`), for the reason StatusCell's header gives: an absolutely
 * positioned panel inside the Table's scroll wrapper was cut off on a short
 * group.
 */
const TagsCell = ({ value, column, readOnly, onChange }) => {
  const [anchor, setAnchor] = useState(null);
  const options = optionSorted(column?.settings?.options);
  const pickable = pickableOptions(column?.settings?.options);
  const selected = Array.isArray(value) ? value.map((v) => v.toString()) : [];
  // A retired tag still on this row gets its own checklist entry, so the only
  // way to take it off is not "clear the whole cell".
  const retiredSelected = options.filter(
    (o) => o.archived && selected.includes(o.id.toString())
  );

  const menuOptions = useMemo(
    () =>
      [...pickable, ...retiredSelected].map((o) => ({
        value: o.id.toString(),
        // The menu renders a plain label; a retired one says so in words.
        label: o.archived ? `${o.label} (retired)` : o.label,
        palette: getColorPair(o.color),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [column?.settings?.options, selected.join(',')]
  );

  const toggle = (id) => {
    const set = new Set(selected);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange?.(Array.from(set));
  };

  const chip = (label, color) => {
    const pair = getColorPair(color);
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '2px 8px',
          fontSize: 11,
          fontWeight: 500,
          color: pair.text,
          background: pair.bg,
          borderRadius: 'var(--radius-full)',
          marginRight: 4,
        }}
      >
        {label}
      </span>
    );
  };

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div
        style={{ ...cellWrapperStyle, flexWrap: 'wrap', gap: 4, cursor: readOnly ? 'default' : 'pointer' }}
        onClick={(e) => {
          if (readOnly) return;
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
        aria-haspopup={readOnly ? undefined : 'listbox'}
        aria-expanded={readOnly ? undefined : !!anchor}
      >
        {selected.length === 0 ? (
          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
        ) : (
          selected.map((id) => {
            const opt = options.find((o) => o.id.toString() === id);
            if (!opt) return null;
            return (
              <span
                key={id}
                title={opt.archived ? `${opt.label} — retired, so it can no longer be chosen` : undefined}
                style={opt.archived ? { opacity: 0.6, textDecoration: 'line-through' } : undefined}
              >
                {chip(opt.label, opt.color)}
              </span>
            );
          })
        )}
      </div>
      {anchor && !readOnly && (
        // A sibling of the trigger — see StatusCell.
        <OptionMenu
          anchorEl={anchor}
          options={menuOptions}
          selectedValues={selected}
          multiple
          onSelect={(v) => toggle(String(v))}
          onClose={() => setAnchor(null)}
          layout="rows"
          width={236}
          emptyText="No tags to pick."
          ariaLabel={column?.name || 'Tags'}
        />
      )}
    </div>
  );
};

export default TagsCell;

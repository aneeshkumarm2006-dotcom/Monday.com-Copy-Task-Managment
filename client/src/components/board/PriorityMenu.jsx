import { useMemo } from 'react';
import OptionMenu from '../ui/OptionMenu';
import { PRIORITY_COLORS } from '../../utils/priorityColors';

/**
 * PriorityMenu — critical through low.
 *
 * Rows rather than colour blocks, and each option renders in the `tint` form:
 * pale ground, deep text, a full-strength left edge. Four of them stacked read
 * as a SCALE, which is what priority is — and it keeps the menu from competing
 * with the status picker beside it, where the blocks are the point.
 *
 * A thin adapter over `ui/OptionMenu`. Props are unchanged.
 */
const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];

const PriorityMenu = ({ anchorEl, value, onSelect, onClose }) => {
  const options = useMemo(
    () =>
      PRIORITY_ORDER.map((key) => ({
        value: key,
        label: PRIORITY_COLORS[key].label,
        palette: PRIORITY_COLORS[key],
      })),
    []
  );

  return (
    <OptionMenu
      anchorEl={anchorEl}
      title="Priority"
      options={options}
      value={value || null}
      onSelect={(v) => onSelect?.(v)}
      onClose={onClose}
      layout="rows"
      chipVariant="edge"
      width={190}
      ariaLabel="Priority"
    />
  );
};

export default PriorityMenu;

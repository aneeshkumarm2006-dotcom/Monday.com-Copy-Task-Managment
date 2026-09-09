import { useMemo } from 'react';
import { Settings } from 'lucide-react';
import OptionMenu from '../ui/OptionMenu';
import { STATUS_COLORS, getColorPair } from '../../utils/priorityColors';

/**
 * StatusMenu — the board's status chooser.
 *
 * Renders as COLOUR BLOCKS: each option is painted the way the cell will be
 * painted once you pick it, so choosing is recognising rather than reading.
 * That is the monday.com idea and it only works because the same `chipStyle`
 * paints both, from the same palette.
 *
 * A thin adapter over `ui/OptionMenu` — see that file for why there is only one
 * dropdown now. Props are unchanged.
 */
const StatusMenu = ({ anchorEl, board, value, onSelect, onEditChips, onClose }) => {
  const options = useMemo(() => {
    const statuses = Array.isArray(board?.statuses) ? board.statuses : [];
    if (statuses.length > 0) {
      return [...statuses]
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((s) => ({
          value: s._id?.toString() ?? String(s._id),
          label: s.name,
          palette: getColorPair(s.color),
        }));
    }
    // Personal tasks have no board to read statuses from, and legacy board rows
    // may still carry the enum string. Both fall back to the four built-ins.
    return ['not_started', 'working_on_it', 'done', 'stuck'].map((key) => ({
      value: key,
      label: STATUS_COLORS[key].label,
      palette: STATUS_COLORS[key],
    }));
  }, [board]);

  return (
    <OptionMenu
      anchorEl={anchorEl}
      title="Status"
      options={options}
      value={value == null ? null : value.toString()}
      onSelect={(v) => onSelect?.(v)}
      onClose={onClose}
      layout="blocks"
      width={214}
      footer={onEditChips ? { label: 'Edit statuses', icon: Settings, onClick: onEditChips } : null}
      ariaLabel="Status"
    />
  );
};

export default StatusMenu;

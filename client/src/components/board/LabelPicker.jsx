import { useMemo } from 'react';
import { Settings } from 'lucide-react';
import OptionMenu from '../ui/OptionMenu';
import { getColorPair } from '../../utils/priorityColors';

/**
 * LabelPicker — the board's label and group-tag chooser.
 *
 * Now a thin adapter over `ui/OptionMenu`. It used to carry its own copy of
 * anchored positioning, viewport-flip, click-outside and Escape handling, as
 * did `StatusMenu` and `PriorityMenu` — three implementations of one behaviour,
 * already drifting, none of which supported the keyboard.
 *
 * What this file still owns is the two things that are genuinely about labels:
 * turning the board's chips into options with their palettes attached, and
 * knowing that labels are MULTI-SELECT, which the old menu never showed. The
 * shell now renders a checkbox per row, counts the selection in its header,
 * grows a filter past eight labels, and stays open while you toggle — so
 * putting three labels on a row is one visit instead of three.
 *
 * Props are unchanged, so every existing call site keeps working.
 */
const LabelPicker = ({
  anchorEl,
  board,
  chips,
  selectedIds = [],
  onToggle,
  onEditChips,
  editLabel = 'Edit Labels',
  emptyLabel = 'No labels yet',
  onClose,
}) => {
  const options = useMemo(() => {
    const list = Array.isArray(chips) ? chips : board?.labels;
    if (!Array.isArray(list)) return [];
    return [...list]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((chip) => ({
        value: chip._id?.toString() ?? String(chip._id),
        label: chip.name,
        // Derived from the CHIP'S OWN colour, not looked up in `board.labels`.
        // This picker also serves group tags, which do not live there — a
        // lookup would hand every one of them the grey fallback and quietly
        // strip the colours somebody chose.
        palette: getColorPair(chip.color),
        disabled: !onToggle,
      }));
  }, [board, chips, onToggle]);

  const selected = useMemo(
    () => (selectedIds || []).map((id) => id.toString()),
    [selectedIds]
  );

  return (
    <OptionMenu
      anchorEl={anchorEl}
      title={options.length === 0 ? emptyLabel : 'Labels'}
      options={options}
      selectedValues={selected}
      multiple
      // Labels toggle, so the handler needs to know which WAY. `OptionMenu`'s
      // second argument is the option, not a checked flag — deriving it here
      // from the selection we were handed is what makes an unchecked label
      // turn ON rather than be filtered out of a list it was never in.
      onSelect={(v) => onToggle?.(v, !selected.includes(String(v)))}
      onClose={onClose}
      layout="rows"
      chipVariant="tag"
      footer={onEditChips ? { label: editLabel, icon: Settings, onClick: onEditChips } : null}
      ariaLabel="Labels"
    />
  );
};

export default LabelPicker;

import { useMemo, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Dropdown from '../ui/Dropdown';
import { findMonth } from '../../utils/monthKeys';

/**
 * Refile one or many tasks into a different month.
 *
 * A modal rather than a submenu inside `TaskActionsMenu`: that menu is a
 * fixed-width popover sized to its longest label and clamped to the viewport,
 * and nesting a scrollable list of every month the board has ever had inside it
 * would fight both constraints.
 *
 * States the consequence in a sentence before confirming, because the row is
 * about to disappear from the view the user is looking at — a task that
 * silently vanishes reads as a bug even when it is exactly what was asked for.
 */
const MoveToMonthModal = ({
  open,
  onClose,
  onConfirm,
  months = [],
  currentMonthKey,
  taskNames = [],
  saving = false,
}) => {
  // `null` means "the user has not picked yet", which is distinct from any real
  // month key, so the default below applies until they choose. There is no
  // reset effect because the caller only mounts this while it is open —
  // unmounting clears the selection for free, and syncing state from props in
  // an effect would cause the cascading render eslint rightly complains about.
  const [picked, setPicked] = useState(null);

  // Default to the next month — overwhelmingly the reason anyone opens this,
  // since the usual case is work that slipped and needs pushing forward.
  const defaultTarget = useMemo(() => {
    const ordered = months.map((m) => m.key).sort();
    const idx = ordered.indexOf(currentMonthKey);
    return ordered[idx + 1] || ordered[idx - 1] || '';
  }, [months, currentMonthKey]);

  const target = picked ?? defaultTarget;

  const options = useMemo(
    () =>
      months
        .filter((m) => m.key !== currentMonthKey)
        .map((m) => ({ value: m.key, label: m.label })),
    [months, currentMonthKey]
  );

  const count = taskNames.length;
  const targetLabel = findMonth(months, target)?.label || 'another month';
  const fromLabel = findMonth(months, currentMonthKey)?.label || 'this month';

  const subject =
    count === 1
      ? `“${taskNames[0]}”`
      : `${count} tasks`;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={count === 1 ? 'Move to month' : `Move ${count} tasks to month`}
      maxWidth={440}
    >
      <div className="flex flex-col gap-4">
        <Dropdown
          label="Move to"
          value={target}
          options={options}
          onChange={setPicked}
          placeholder="Pick a month"
        />

        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
        >
          {subject} will move out of {fromLabel} and into {targetLabel}. It stays in
          the same group, keeps its status, and nothing else changes — you just
          won’t see it here until you switch months.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(target)}
            disabled={!target || saving}
          >
            {saving ? 'Moving…' : `Move to ${targetLabel}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default MoveToMonthModal;

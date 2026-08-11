import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, BadgeCheck, Check, MinusCircle, Undo2, X } from 'lucide-react';

import Button from '../../ui/Button';
import DriveLinkChip from '../DriveLinkChip';
import { isDriveUrl } from '../../../utils/driveLinks';
import { cellStateMeta, requirementMeta } from '../../../utils/deliveryTrackers';
import useDropdownPosition from '../../../utils/useDropdownPosition';

/**
 * The drill-down. This ships in v1, not later, and the reason is worth stating:
 * every matching rule in a tracker is a heuristic, and a heuristic you cannot
 * inspect is one people quietly stop believing. A red cell must be able to say
 * "no task matched, and 1 was excluded by the rule 'Report'" — otherwise the
 * grid is just a wall of squares somebody argues with.
 *
 * A portal popover rather than a modal (too heavy for a 520-target grid) and
 * rather than navigation (you would lose your place in the grid).
 */

const POPOVER_WIDTH = 300;

// Module scope on purpose. useDropdownPosition memoises its recompute on
// (triggerRef, menuHeight), so a fresh object here every render would invalidate
// that callback, re-run its layout effect, setRect a new object, and re-render —
// an infinite loop that blanks the page. Same reason the anchor below is a real
// useRef rather than an inline `{ current: anchorEl }`.
const POSITION_OPTIONS = { menuHeight: 300 };

const RequirementRow = ({ type, satisfied }) => {
  const meta = requirementMeta(type);
  if (!meta) return null;
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center shrink-0"
        style={{ width: 16, height: 16, marginTop: 1 }}
      >
        {satisfied ? (
          <Check size={14} strokeWidth={3} color="var(--color-status-done)" />
        ) : (
          <X size={14} strokeWidth={3} color="var(--color-status-stuck)" />
        )}
      </span>
      <span
        className="font-body"
        style={{
          fontSize: 12.5,
          color: satisfied ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        }}
      >
        {meta.label}
      </span>
    </li>
  );
};

const DeliveryCellPopover = ({
  anchorEl,
  tracker,
  period,
  row,
  cell,
  canManage,
  onClose,
  onConfirm,
  onExcuse,
  onClearEntry,
  onOpenTask,
}) => {
  // A stable ref object whose .current we point at the clicked cell. The hook
  // reads .current inside its effect, so assigning during render is fine and
  // keeps the ref identity — and therefore the memoised recompute — constant.
  const anchorRef = useRef(null);
  anchorRef.current = anchorEl;
  const { top, left, openUpward } = useDropdownPosition(anchorRef, !!anchorEl, POSITION_OPTIONS);

  const [mode, setMode] = useState(null); // null | 'confirm' | 'excuse'
  const [link, setLink] = useState(cell?.entry?.link || '');
  const [note, setNote] = useState(cell?.entry?.note || '');
  const [busy, setBusy] = useState(false);
  const panelRef = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      if (anchorEl?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchorEl?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onClose]);

  if (!anchorEl || !cell) return null;

  const meta = cellStateMeta(cell.s);
  const requirements = tracker.requirements || [];
  const metSet = new Set(cell.met || []);
  const targetCount = tracker.targetCount || 1;

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const labelStyle = {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--color-text-secondary)',
  };

  const fieldStyle = {
    width: '100%',
    height: 32,
    padding: '0 8px',
    borderRadius: 'var(--radius-sm)',
    border: '1.5px solid var(--color-border)',
    background: 'var(--color-bg-input)',
    color: 'var(--color-text-primary)',
    fontSize: 12.5,
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`${row.groupName} — ${period.ariaLabel}`}
      className="font-body"
      style={{
        position: 'fixed',
        top: openUpward ? undefined : top,
        bottom: openUpward ? window.innerHeight - top + 8 : undefined,
        left: Math.max(8, Math.min(left, window.innerWidth - POPOVER_WIDTH - 8)),
        width: POPOVER_WIDTH,
        zIndex: 60,
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--color-border)' }}>
        <p
          className="font-display font-semibold truncate"
          style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
        >
          {row.groupName}
        </p>
        <p style={{ fontSize: 11.5, color: 'var(--color-text-muted)', marginTop: 2 }}>
          {period.ariaLabel} · {tracker.name}
        </p>
        <p
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            marginTop: 6,
            color: cell.s === 'met' ? 'var(--color-status-done)'
              : cell.s === 'missed' ? 'var(--color-status-stuck)'
                : 'var(--color-text-secondary)',
          }}
        >
          {meta.label}
          {targetCount > 1 && cell.s !== 'off' && ` — ${cell.n} of ${targetCount}`}
        </p>
      </div>

      <div style={{ padding: '12px 14px', maxHeight: 240, overflowY: 'auto' }}>
        <ul className="flex flex-col gap-2">
          {requirements.map((type) => (
            <RequirementRow key={type} type={type} satisfied={metSet.has(type)} />
          ))}
        </ul>

        {cell.tasks?.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            {cell.tasks.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onOpenTask?.(t.id)}
                className="w-full flex items-center gap-1.5 text-left transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                style={{
                  padding: '5px 6px',
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                }}
              >
                <span
                  className="flex-1 min-w-0 truncate"
                  style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
                >
                  {t.name}
                </span>
                <ArrowUpRight size={12} color="var(--color-text-muted)" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        {/* The line that turns an unexplained red square into a fixable one. */}
        {cell.matched === 0 && cell.excluded > 0 && (
          <p style={{ fontSize: 11.5, color: 'var(--color-text-muted)', marginTop: 10 }}>
            {cell.excluded} task{cell.excluded === 1 ? ' was' : 's were'} excluded by the rule
            {' '}“{tracker.match?.excludeNameContains}”.
          </p>
        )}
        {cell.matched === 0 && cell.excluded === 0 && cell.s === 'missed' && (
          <p style={{ fontSize: 11.5, color: 'var(--color-text-muted)', marginTop: 10 }}>
            No task was created for this client in this period.
          </p>
        )}

        {cell.entry && (
          <div
            className="mt-3"
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg-subtle)',
            }}
          >
            <p style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
              {cell.entry.state === 'excused' ? 'Excused' : 'Confirmed'}
              {cell.entry.by?.name ? ` by ${cell.entry.by.name}` : ''}
            </p>
            {cell.entry.note && (
              <p style={{ fontSize: 11.5, color: 'var(--color-text-muted)', marginTop: 3 }}>
                {cell.entry.note}
              </p>
            )}
            {cell.entry.link && (
              <div className="mt-2">
                {isDriveUrl(cell.entry.link) ? (
                  <DriveLinkChip url={cell.entry.link} />
                ) : (
                  <a
                    href={cell.entry.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 11.5, color: 'var(--color-accent)' }}
                  >
                    {cell.entry.link}
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {mode && (
          <div className="mt-3 flex flex-col gap-2">
            {mode === 'confirm' && (
              <div>
                <label style={labelStyle} htmlFor="tracker-entry-link">
                  Link (optional)
                </label>
                <input
                  id="tracker-entry-link"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="Paste the document link"
                  className="mt-1"
                  style={fieldStyle}
                />
              </div>
            )}
            <div>
              <label style={labelStyle} htmlFor="tracker-entry-note">
                {mode === 'excuse' ? 'Reason' : 'Note (optional)'}
              </label>
              <input
                id="tracker-entry-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={mode === 'excuse' ? 'Client on hold' : 'Sent by email'}
                className="mt-1"
                style={fieldStyle}
              />
            </div>
          </div>
        )}
      </div>

      {canManage && (
        <div
          className="flex items-center gap-2 flex-wrap"
          style={{ padding: '10px 14px', borderTop: '1px solid var(--color-border)' }}
        >
          {mode ? (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || (mode === 'excuse' && !note.trim())}
                onClick={() =>
                  run(() =>
                    (mode === 'confirm'
                      ? onConfirm({ link: link.trim(), note: note.trim() })
                      : onExcuse({ note: note.trim() })))}
              >
                {busy ? 'Saving…' : mode === 'confirm' ? 'Confirm' : 'Excuse'}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setMode(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {cell.entry ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Undo2}
                  disabled={busy}
                  onClick={() => run(onClearEntry)}
                >
                  Undo
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                icon={BadgeCheck}
                disabled={busy}
                onClick={() => setMode('confirm')}
              >
                Confirm
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={MinusCircle}
                disabled={busy}
                onClick={() => setMode('excuse')}
              >
                Excuse
              </Button>
            </>
          )}
        </div>
      )}
    </div>,
    document.body
  );
};

export default DeliveryCellPopover;

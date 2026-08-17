import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Undo2 } from 'lucide-react';

import Button from '../../ui/Button';
import { DAY_OFF_TAGS, dayOffTagMeta } from '../../../utils/deliveryTrackers';
import useDropdownPosition from '../../../utils/useDropdownPosition';

/**
 * Mark one calendar day as not owed — the thing that turns a column of red
 * squares nobody deserved into a row of quiet dots with a reason attached.
 *
 * It hangs off the grid's own date header rather than living in tracker
 * settings, because the moment you want it is the moment you are looking at the
 * red column. Two clicks from noticing to fixed.
 *
 * Deliberately NOT the same popover as the cell drill-down: that one is about
 * one client's period and offers Confirm / Excuse. This is about the whole day,
 * for every client this tracker covers, and saying so in the heading is what
 * stops the two being confused.
 */

const POPOVER_WIDTH = 268;

// Module scope — see the note in DeliveryCellPopover: a fresh object each render
// invalidates useDropdownPosition's memo and loops.
const POSITION_OPTIONS = { menuHeight: 260 };

const DayOffPopover = ({
  anchorEl,
  tracker,
  period,
  dayOff = null,
  onClose,
  onSave,
  onRemove,
}) => {
  const anchorRef = useRef(null);
  anchorRef.current = anchorEl;
  const { top, left, openUpward } = useDropdownPosition(anchorRef, !!anchorEl, POSITION_OPTIONS);

  const [tag, setTag] = useState(dayOff?.tag || 'holiday');
  const [label, setLabel] = useState(dayOff?.label || '');
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

  if (!anchorEl || !period) return null;

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Day off — ${period.ariaLabel}`}
      className="font-body"
      style={{
        position: 'fixed',
        top: openUpward ? undefined : top,
        bottom: openUpward ? window.innerHeight - top + 8 : undefined,
        left: Math.max(8, Math.min(left, window.innerWidth - POPOVER_WIDTH - 8)),
        width: POPOVER_WIDTH,
        maxWidth: 'calc(100vw - 16px)',
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
          className="font-display font-semibold"
          style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
        >
          {period.ariaLabel}
        </p>
        {/* The sentence that keeps this from being mistaken for Excuse. */}
        <p style={{ fontSize: 11.5, color: 'var(--color-text-muted)', marginTop: 2 }}>
          {dayOff
            ? `Marked off for every client on “${tracker.name}”.`
            : `Nothing is owed on a day off — no client on “${tracker.name}” is marked missed.`}
        </p>
      </div>

      <div style={{ padding: '12px 14px' }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--color-text-secondary)',
          }}
        >
          Reason
        </span>

        <div className="flex flex-wrap gap-1.5 mt-2" role="radiogroup" aria-label="Reason">
          {DAY_OFF_TAGS.map((t) => {
            const Icon = t.icon;
            const active = tag === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTag(t.value)}
                className="inline-flex items-center gap-1.5 transition-colors duration-150"
                style={{
                  padding: '5px 9px',
                  borderRadius: 999,
                  fontSize: 11.5,
                  fontWeight: active ? 600 : 500,
                  border: `1.5px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  background: active ? 'var(--color-accent-light)' : 'transparent',
                  color: active ? 'var(--color-accent-text)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                <Icon size={12} aria-hidden="true" />
                {t.label}
              </button>
            );
          })}
        </div>

        <label
          htmlFor="day-off-label"
          className="block mt-3"
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--color-text-secondary)',
          }}
        >
          Label (optional)
        </label>
        <input
          id="day-off-label"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={dayOffTagMeta(tag).placeholder}
          className="mt-1"
          style={{
            width: '100%',
            height: 32,
            padding: '0 8px',
            borderRadius: 'var(--radius-sm)',
            border: '1.5px solid var(--color-border)',
            background: 'var(--color-bg-input)',
            color: 'var(--color-text-primary)',
            fontSize: 12.5,
          }}
        />

        {/* Said plainly, because it is the one surprising rule: a client who
            worked anyway keeps its tick. */}
        <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8 }}>
          Anyone who did the work anyway keeps their tick.
        </p>
      </div>

      <div
        className="flex items-center gap-2 flex-wrap"
        style={{ padding: '10px 14px', borderTop: '1px solid var(--color-border)' }}
      >
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => run(() => onSave({ tag, label: label.trim() }))}
        >
          {busy ? 'Saving…' : dayOff ? 'Update' : 'Mark day off'}
        </Button>
        {dayOff && (
          <Button variant="secondary" size="sm" icon={Undo2} disabled={busy} onClick={() => run(onRemove)}>
            Undo
          </Button>
        )}
        {!dayOff && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        )}
      </div>
    </div>,
    document.body
  );
};

export default DayOffPopover;

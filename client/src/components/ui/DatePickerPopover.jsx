import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import useOrgStore from '../../store/orgStore';
import {
  toDayKey,
  getDaysInMonth,
  getFirstDayOfMonth,
  holidayIndex,
  describeHoliday,
} from '../../utils/orgHolidays';

const DAYS   = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const formatShortDisplay = (date) => {
  if (!date) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const parseDate = (value) => {
  if (!value) return null;
  const d = new Date(value + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
};

// The picker and the holiday calendar must agree on what day a cell is, so both
// go through the one helper. Local time, deliberately — see orgHolidays.js.
const toValue = toDayKey;

const formatDisplay = (date) => {
  if (!date) return null;
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
};

const NAV_BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 'var(--radius-sm)',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  cursor: 'pointer',
  color: 'var(--color-text-secondary)',
  padding: 0,
  transition: 'background 120ms',
};

/**
 * DatePickerPopover — custom calendar picker that renders via a React portal
 * so it's never clipped by a table's overflow.
 *
 * Props:
 *   value       — "YYYY-MM-DD" string or empty string
 *   onChange    — (newValue: string) => void   (empty string = cleared)
 *   placeholder — shown when no date is selected
 *   disabled    — disables the trigger
 */
const DatePickerPopover = ({
  value = '',
  onChange,
  placeholder = 'Pick a date',
  disabled = false,
  variant = 'form',
  overdue = false,
}) => {
  const selected = parseDate(value);
  const today    = new Date();

  const [open, setOpen] = useState(false);
  const [viewYear,  setViewYear]  = useState(() => selected?.getFullYear()  ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(() => selected?.getMonth()      ?? today.getMonth());
  const [pos, setPos] = useState({ top: 0, left: 0, up: false });

  const triggerRef = useRef(null);
  const popRef     = useRef(null);

  const handleOpen = (e) => {
    e?.stopPropagation();
    if (disabled) return;
    if (selected) {
      setViewYear(selected.getFullYear());
      setViewMonth(selected.getMonth());
    } else {
      setViewYear(today.getFullYear());
      setViewMonth(today.getMonth());
    }
    setOpen((prev) => !prev);
  };

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Position popover relative to trigger
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const compute = () => {
      const r  = triggerRef.current.getBoundingClientRect();
      const ph = popRef.current?.offsetHeight || 290;
      const up = window.innerHeight - r.bottom < ph + 8 && r.top > ph + 8;
      setPos({
        top:  up ? Math.max(8, r.top - ph - 6) : r.bottom + 6,
        left: Math.max(8, Math.min(r.left, window.innerWidth - 252)),
        up,
      });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  };

  const selectDay = (day) => {
    onChange?.(toValue(new Date(viewYear, viewMonth, day)));
    setOpen(false);
  };
  const clearDate = () => { onChange?.(''); setOpen(false); };
  const selectToday = () => { onChange?.(toValue(today)); setOpen(false); };

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay    = getFirstDayOfMonth(viewYear, viewMonth);
  const todayVal    = toValue(today);

  // Company holidays, marked but never blocked: assigning work on a holiday is
  // a legitimate thing to do on purpose, and the picker only has to make sure
  // it is not done by accident. Read straight from the store rather than
  // threaded as a prop — this component has dozens of call sites.
  const holidays   = useOrgStore((s) => s.holidays);
  const holidayMap = useMemo(() => holidayIndex(holidays), [holidays]);
  const selVal      = value || '';

  return (
    <>
      {/* Trigger */}
      {variant === 'inline' ? (
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={handleOpen}
          className="flex items-center font-body"
          style={{
            background: 'transparent',
            border: 'none',
            padding: '2px 4px',
            margin: '0 -4px',
            borderRadius: 'var(--radius-sm)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: 13,
            fontWeight: selected ? (overdue ? 600 : 500) : 400,
            color: selected
              ? overdue ? 'var(--color-status-stuck)' : 'var(--color-text-primary)'
              : 'var(--color-text-muted)',
          }}
        >
          {selected ? (
            formatShortDisplay(selected)
          ) : (
            <Calendar size={15} aria-hidden="true" style={{ opacity: 0.5 }} />
          )}
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={handleOpen}
          className="w-full flex items-center gap-2 font-body text-[13px]"
          style={{
            height: 32,
            padding: '0 10px',
            border: open
              ? '1.5px solid var(--color-accent)'
              : '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: '#fff',
            color: selected ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
            boxShadow: open ? '0 0 0 3px rgba(37,99,235,0.12)' : 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'border-color 150ms, box-shadow 150ms',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <Calendar size={13} aria-hidden="true"
            style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {selected ? formatDisplay(selected) : placeholder}
          </span>
        </button>
      )}

      {/* Popover */}
      {open && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label="Date picker"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            zIndex: 200,
            width: 244,
            background: '#fff',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-md)',
            padding: '14px 12px 10px',
            animation: pos.up
              ? 'dp-enter-up 150ms ease-out'
              : 'dp-enter 150ms ease-out',
          }}
        >
          {/* Month + Year header */}
          <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
            <button
              type="button"
              onClick={prevMonth}
              aria-label="Previous month"
              className="hover:bg-[color:var(--color-bg-subtle)]"
              style={NAV_BTN}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>

            <span
              className="font-body font-semibold"
              style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
            >
              {MONTHS[viewMonth]} {viewYear}
            </span>

            <button
              type="button"
              onClick={nextMonth}
              aria-label="Next month"
              className="hover:bg-[color:var(--color-bg-subtle)]"
              style={NAV_BTN}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>

          {/* Day-of-week headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            marginBottom: 4,
          }}>
            {DAYS.map((d) => (
              <div
                key={d}
                className="font-body"
                style={{
                  textAlign: 'center',
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--color-text-muted)',
                  padding: '2px 0',
                }}
              >
                {d}
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
            {/* Empty cells before first day */}
            {Array.from({ length: firstDay }, (_, i) => (
              <div key={`e-${i}`} />
            ))}

            {/* Day cells */}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const day    = i + 1;
              const dayVal = toValue(new Date(viewYear, viewMonth, day));
              const isSel  = dayVal === selVal;
              const isTod  = dayVal === todayVal;
              const holiday = holidayMap.get(dayVal) || null;
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => selectDay(day)}
                  title={holiday ? describeHoliday(holiday) : undefined}
                  className="font-body font-medium hover:opacity-80"
                  style={{
                    position: 'relative',
                    height: 30,
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12,
                    border: isTod && !isSel ? '1.5px solid var(--color-accent)' : 'none',
                    cursor: 'pointer',
                    background: isSel
                      ? 'var(--color-accent)'
                      : isTod
                        ? 'rgba(37,99,235,0.07)'
                        : 'transparent',
                    color: isSel
                      ? '#fff'
                      : isTod
                        ? 'var(--color-accent)'
                        : 'var(--color-text-primary)',
                    fontWeight: isSel || isTod ? 700 : 400,
                    transition: 'background 100ms',
                  }}
                >
                  {day}
                  {holiday && (
                    <span
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        left: '50%',
                        bottom: 3,
                        transform: 'translateX(-50%)',
                        width: 3,
                        height: 3,
                        borderRadius: '50%',
                        background: isSel ? '#fff' : 'var(--color-text-muted)',
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Footer: Clear + Today */}
          <div
            className="flex items-center justify-between"
            style={{
              marginTop: 10,
              paddingTop: 8,
              borderTop: '1px solid var(--color-border)',
            }}
          >
            <button
              type="button"
              onClick={clearDate}
              className="font-body hover:text-[color:var(--color-text-primary)]"
              style={{
                fontSize: 12,
                color: 'var(--color-text-muted)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '3px 6px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={selectToday}
              className="font-body font-semibold hover:opacity-80"
              style={{
                fontSize: 12,
                color: 'var(--color-accent)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '3px 6px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Today
            </button>
          </div>
        </div>,
        document.body
      )}

      <style>{`
        @keyframes dp-enter {
          from { opacity: 0; transform: translateY(-5px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes dp-enter-up {
          from { opacity: 0; transform: translateY(5px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
};

export default DatePickerPopover;

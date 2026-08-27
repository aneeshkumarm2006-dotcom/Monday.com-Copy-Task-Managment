import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  TreePalm,
  Trash2,
  Loader2,
} from 'lucide-react';
import useOrgStore from '../../store/orgStore';
import useToastStore from '../../store/toastStore';
import {
  MONTH_ABBR,
  WEEKDAY_ABBR,
  getDaysInMonth,
  getFirstDayOfMonth,
  makeDayKey,
  toDayKey,
  holidaysInYear,
  formatDayKey,
  sameDayInYear,
} from '../../utils/orgHolidays';

const NAV_BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg-surface)',
  border: '1px solid var(--color-border)',
  cursor: 'pointer',
  color: 'var(--color-text-secondary)',
  padding: 0,
};

const GHOST_BTN = {
  height: 28,
  padding: '0 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-surface)',
  color: 'var(--color-text-secondary)',
  fontSize: 12.5,
  fontWeight: 500,
  cursor: 'pointer',
};

/**
 * One month. Deliberately dumb — it holds no state and does no date maths of
 * its own beyond the shared helpers, so the twelve of them cannot disagree
 * about which day a cell is.
 */
const MonthGrid = ({ year, monthIndex, label, markedSet, todayKey, onToggle }) => {
  const days = getDaysInMonth(year, monthIndex);
  const lead = getFirstDayOfMonth(year, monthIndex);

  return (
    <div
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: '8px 8px 10px',
        background: 'var(--color-bg-surface)',
      }}
    >
      <p
        className="font-display font-semibold text-[color:var(--color-text-primary)]"
        style={{ fontSize: 12.5, marginBottom: 6, paddingLeft: 2 }}
      >
        {label}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
        {WEEKDAY_ABBR.map((d, i) => (
          <div
            key={`${d}-${i}`}
            aria-hidden="true"
            className="font-body text-center text-[color:var(--color-text-muted)]"
            style={{ fontSize: 9.5, padding: '2px 0' }}
          >
            {d[0]}
          </div>
        ))}

        {Array.from({ length: lead }, (_, i) => (
          <div key={`lead-${i}`} />
        ))}

        {Array.from({ length: days }, (_, i) => {
          const day = i + 1;
          const dayKey = makeDayKey(year, monthIndex, day);
          const isMarked = markedSet.has(dayKey);
          const isToday = dayKey === todayKey;

          return (
            <button
              key={day}
              type="button"
              onClick={() => onToggle(dayKey)}
              aria-pressed={isMarked}
              aria-label={`${day} ${label} ${year}${isMarked ? ', holiday' : ''}`}
              className="font-body hover:opacity-80"
              style={{
                height: 22,
                borderRadius: 'var(--radius-sm)',
                fontSize: 10.5,
                border: isToday && !isMarked ? '1px solid var(--color-accent)' : 'none',
                cursor: 'pointer',
                background: isMarked ? 'var(--color-accent)' : 'transparent',
                color: isMarked ? '#fff' : 'var(--color-text-primary)',
                fontWeight: isMarked ? 700 : 400,
                transition: 'background 100ms',
                padding: 0,
              }}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Company holidays — the workspace calendar, a whole year at a time.
 *
 * WHY A YEAR GRID rather than a list with a date picker: holidays get entered
 * once a year off a printed list, and twelve months on screen is the only
 * layout where you can see that October has nothing in it yet. Clicking a day
 * toggles it; the name is typed in the list below.
 *
 * Names flush on blur rather than behind a save button, matching EditChipsModal.
 * Toggling a day saves immediately — it IS the whole edit — so there is never a
 * dirty state to lose.
 *
 * Years are independent. Most holidays outside a few fixed civil dates move
 * every year, so nothing repeats automatically; the copy button seeds next year
 * from this one for the ones that do.
 */
const HolidaysTab = () => {
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const holidays = useOrgStore((s) => s.holidays);
  const fetchHolidays = useOrgStore((s) => s.fetchHolidays);
  const saveHolidaysForYear = useOrgStore((s) => s.saveHolidays);
  const setHoliday = useOrgStore((s) => s.setHoliday);
  const deleteHoliday = useOrgStore((s) => s.deleteHoliday);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  const orgId = currentOrg?._id || null;

  const [year, setYear] = useState(() => new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Name drafts, keyed by day. Buffered so typing does not fire a request per
  // keystroke; flushed on blur and on Enter.
  const [drafts, setDrafts] = useState({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    setLoading(true);
    fetchHolidays(orgId).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, fetchHolidays]);

  const marked = useMemo(() => holidaysInYear(holidays, year), [holidays, year]);
  const markedSet = useMemo(() => new Set(marked.map((h) => h.date)), [marked]);
  const todayKey = toDayKey(new Date());

  const nameFor = (dayKey) => {
    if (drafts[dayKey] !== undefined) return drafts[dayKey];
    return marked.find((h) => h.date === dayKey)?.name || '';
  };

  const dropDraft = (dayKey) =>
    setDrafts((d) => {
      const { [dayKey]: _drop, ...rest } = d;
      return rest;
    });

  const guard = async (fn, failure) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toastError(err?.response?.data?.error || failure);
    } finally {
      setBusy(false);
    }
  };

  const toggleDay = (dayKey) => {
    if (!orgId) return;
    if (markedSet.has(dayKey)) {
      dropDraft(dayKey);
      guard(
        () => deleteHoliday(orgId, dayKey),
        'Could not remove that day. Please try again.'
      );
    } else {
      guard(
        () => setHoliday(orgId, dayKey, ''),
        'Could not mark that day. Please try again.'
      );
    }
  };

  /** Persist a name draft, but only when it actually changed. */
  const flushName = (dayKey) => {
    const draft = draftsRef.current[dayKey];
    if (draft === undefined) return;
    const saved = marked.find((h) => h.date === dayKey)?.name || '';
    dropDraft(dayKey);
    if (draft.trim() === saved) return;
    guard(
      () => setHoliday(orgId, dayKey, draft.trim()),
      'Could not save that name. Please try again.'
    );
  };

  /**
   * Seed the next year from this one.
   *
   * Only fills dates not already marked there, so pressing it twice is harmless
   * and it never overwrites a name somebody typed. 29 February has nowhere to
   * land in a non-leap year and gets reported rather than nudged onto the 28th.
   */
  const copyToNextYear = () => {
    const target = year + 1;
    const already = holidaysInYear(holidays, target);
    const existing = new Set(already.map((h) => h.date));
    const carried = [];
    let dropped = 0;

    for (const h of marked) {
      const date = sameDayInYear(h.date, target);
      if (!date) {
        dropped += 1;
        continue;
      }
      if (existing.has(date)) continue;
      carried.push({ date, name: h.name });
    }

    if (carried.length === 0) {
      toastError(`Nothing new to copy into ${target}.`);
      return;
    }

    const next = [
      ...already.map((h) => ({ date: h.date, name: h.name })),
      ...carried,
    ];

    guard(async () => {
      await saveHolidaysForYear(orgId, String(target), next);
      setYear(target);
      toastSuccess(
        `Copied ${carried.length} ${carried.length === 1 ? 'day' : 'days'} into ${target}`
          + (dropped ? ` — ${dropped} had no matching date.` : '.')
      );
    }, 'Could not copy the year. Please try again.');
  };

  const clearYear = () => {
    guard(async () => {
      await saveHolidaysForYear(orgId, String(year), []);
      setDrafts({});
      toastSuccess(`Cleared every holiday in ${year}.`);
    }, 'Could not clear the year. Please try again.');
  };

  return (
    <div>
      <header className="mb-5">
        <h1
          className="font-display font-bold text-[color:var(--color-text-primary)]"
          style={{ fontSize: 22 }}
        >
          Holidays
        </h1>
        <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mt-1">
          Days the office is closed. Nothing is owed on a holiday, so tracker
          columns go grey instead of red, the calendar shades the day, and every
          date picker marks it. Applies to the whole workspace.
        </p>
      </header>

      {/* Year bar */}
      <div
        className="flex items-center justify-between gap-3 flex-wrap"
        style={{
          padding: '10px 12px',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-bg-subtle)',
          marginBottom: 16,
        }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setYear((y) => y - 1)}
            aria-label={`Show ${year - 1}`}
            style={NAV_BTN}
          >
            <ChevronLeft size={15} />
          </button>
          <span
            className="font-display font-bold text-[color:var(--color-text-primary)] text-center"
            style={{ fontSize: 17, minWidth: 62 }}
          >
            {year}
          </span>
          <button
            type="button"
            onClick={() => setYear((y) => y + 1)}
            aria-label={`Show ${year + 1}`}
            style={NAV_BTN}
          >
            <ChevronRight size={15} />
          </button>

          <span
            className="font-body text-[12.5px] text-[color:var(--color-text-muted)]"
            style={{ marginLeft: 6 }}
          >
            {marked.length === 0 ? 'No holidays marked' : `${marked.length} marked`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {busy && (
            <Loader2
              size={14}
              className="animate-spin"
              style={{ color: 'var(--color-text-muted)' }}
              aria-label="Saving"
            />
          )}
          <button
            type="button"
            onClick={copyToNextYear}
            disabled={busy || marked.length === 0}
            className="flex items-center gap-1.5 font-body"
            style={{ ...GHOST_BTN, opacity: marked.length === 0 ? 0.5 : 1 }}
          >
            <CopyPlus size={14} />
            Copy to {year + 1}
          </button>
          <button
            type="button"
            onClick={clearYear}
            disabled={busy || marked.length === 0}
            className="font-body"
            style={{ ...GHOST_BTN, opacity: marked.length === 0 ? 0.5 : 1 }}
          >
            Clear {year}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="font-body text-[13px] text-[color:var(--color-text-muted)]">
          Loading…
        </p>
      ) : (
        <>
          {/* The twelve months */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))',
              gap: 14,
            }}
          >
            {MONTH_ABBR.map((label, monthIndex) => (
              <MonthGrid
                key={label}
                year={year}
                monthIndex={monthIndex}
                label={label}
                markedSet={markedSet}
                todayKey={todayKey}
                onToggle={toggleDay}
              />
            ))}
          </div>

          {/* The list, where names are typed */}
          <section style={{ marginTop: 26 }}>
            <h3
              className="font-display font-semibold text-[color:var(--color-text-primary)]"
              style={{ fontSize: 15, marginBottom: 8 }}
            >
              Marked days
            </h3>

            {marked.length === 0 ? (
              <p className="font-body text-[13px] text-[color:var(--color-text-muted)]">
                Click a day above to mark it. Names are optional — an unnamed day
                still counts.
              </p>
            ) : (
              <div
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                }}
              >
                {marked.map((h, i) => (
                  <div
                    key={h.date}
                    className="flex items-center gap-3 px-3"
                    style={{
                      height: 44,
                      borderTop: i === 0 ? 'none' : '1px solid var(--color-border)',
                    }}
                  >
                    <TreePalm
                      size={15}
                      aria-hidden="true"
                      style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}
                    />
                    <span
                      className="font-body text-[13px] text-[color:var(--color-text-primary)] shrink-0"
                      style={{ width: 92 }}
                    >
                      {formatDayKey(h.date)}
                    </span>
                    <input
                      value={nameFor(h.date)}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [h.date]: e.target.value }))
                      }
                      onBlur={() => flushName(h.date)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') {
                          dropDraft(h.date);
                          e.currentTarget.blur();
                        }
                      }}
                      maxLength={60}
                      placeholder="Name this day (optional)"
                      aria-label={`Name for ${formatDayKey(h.date)}`}
                      className="flex-1 min-w-0 font-body text-[13px] bg-transparent"
                      style={{
                        border: 'none',
                        outline: 'none',
                        color: 'var(--color-text-primary)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => toggleDay(h.date)}
                      aria-label={`Remove ${formatDayKey(h.date)}`}
                      className="shrink-0 flex items-center justify-center"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 'var(--radius-sm)',
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--color-text-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default HolidaysTab;

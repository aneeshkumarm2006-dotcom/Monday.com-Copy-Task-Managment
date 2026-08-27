/**
 * react-big-calendar theming overrides to match the Macan design system.
 *
 * Rendered once next to any `.macan-calendar-wrap` calendar instance. Shared
 * by CalendarPage and the My Work calendar tab so the styling lives in a
 * single place.
 */
const CalendarThemeStyles = () => (
  <style>{`
    .macan-calendar-wrap .rbc-calendar {
      font-family: 'DM Sans', sans-serif;
      color: var(--color-text-primary);
    }
    .macan-calendar-wrap .rbc-month-view,
    .macan-calendar-wrap .rbc-time-view {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: var(--color-bg-surface);
    }
    .macan-calendar-wrap .rbc-header {
      background: var(--color-bg-subtle);
      text-transform: uppercase;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      color: var(--color-text-secondary);
      padding: 10px 8px;
      border-bottom: 1px solid var(--color-border);
      border-left: 1px solid var(--color-border);
    }
    .macan-calendar-wrap .rbc-header:first-child {
      border-left: none;
    }
    .macan-calendar-wrap .rbc-month-row {
      border-top: 1px solid var(--color-border);
      min-height: 100px;
      overflow: visible;
    }
    .macan-calendar-wrap .rbc-day-bg {
      border-left: 1px solid var(--color-border);
      background: var(--color-bg-surface);
    }
    .macan-calendar-wrap .rbc-day-bg:first-child {
      border-left: none;
    }
    .macan-calendar-wrap .rbc-off-range-bg {
      background: var(--color-bg-base);
    }
    .macan-calendar-wrap .rbc-off-range {
      color: var(--color-text-muted);
    }
    .macan-calendar-wrap .rbc-today {
      background: var(--color-accent-light);
    }
    /*
     * A company holiday. Applied through react-big-calendar's dayPropGetter —
     * see utils/orgHolidays.js for the reasoning and utils/calendarEvents.js
     * for the getter itself.
     *
     * A tint plus a corner label rather than a coloured block: the grid already
     * spends its colour budget on priority pills, and a fifth strong hue behind
     * them would read as another task state. The custom property --holiday-name
     * is set inline by the getter, so one CSS rule serves every holiday.
     */
    .macan-calendar-wrap .rbc-day-bg.macan-holiday {
      background: repeating-linear-gradient(
        135deg,
        var(--color-bg-subtle),
        var(--color-bg-subtle) 6px,
        var(--color-bg-surface) 6px,
        var(--color-bg-surface) 12px
      );
      position: relative;
    }
    .macan-calendar-wrap .rbc-day-bg.macan-holiday.rbc-today {
      background: var(--color-accent-light);
      box-shadow: inset 0 0 0 1px var(--color-border);
    }
    .macan-calendar-wrap .rbc-day-bg.macan-holiday::after {
      content: var(--holiday-name, 'Holiday');
      position: absolute;
      left: 6px;
      bottom: 4px;
      max-width: calc(100% - 12px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--color-text-muted);
      pointer-events: none;
    }
    /* Week and day views have no day-bg, so tint the column instead. */
    .macan-calendar-wrap .rbc-day-slot.macan-holiday,
    .macan-calendar-wrap .rbc-time-column.macan-holiday {
      background: var(--color-bg-subtle);
    }
    .macan-calendar-wrap .rbc-date-cell {
      text-align: right;
      padding: 6px 8px;
      font-size: 12px;
      color: var(--color-text-secondary);
    }
    .macan-calendar-wrap .rbc-date-cell.rbc-now > button,
    .macan-calendar-wrap .rbc-date-cell.rbc-now > a {
      color: var(--color-accent);
      font-weight: 700;
    }
    .macan-calendar-wrap .rbc-date-cell > button,
    .macan-calendar-wrap .rbc-date-cell > a {
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: 0;
    }
    .macan-calendar-wrap .rbc-event {
      padding: 1px 6px !important;
      margin-top: 1px !important;
      margin-bottom: 1px !important;
    }
    .macan-calendar-wrap .rbc-event:focus {
      outline: 2px solid var(--color-accent);
      outline-offset: 1px;
    }
    .macan-calendar-wrap .rbc-show-more {
      font-size: 11px;
      font-weight: 500;
      color: var(--color-accent);
      background: transparent;
      padding: 2px 6px;
    }
    .macan-calendar-wrap .rbc-show-more:hover {
      color: var(--color-accent-hover);
    }
    .macan-calendar-wrap .rbc-time-header-content,
    .macan-calendar-wrap .rbc-time-content {
      border-left: 1px solid var(--color-border);
    }
    .macan-calendar-wrap .rbc-time-slot,
    .macan-calendar-wrap .rbc-timeslot-group {
      border-color: var(--color-border);
    }
    .macan-calendar-wrap .rbc-time-view .rbc-label {
      font-size: 11px;
      color: var(--color-text-muted);
    }
    .macan-calendar-wrap .rbc-allday-cell {
      min-height: 40px;
    }
    .macan-calendar-wrap .rbc-row-segment {
      padding: 0 2px;
    }

    /* === RESPONSIVE (mobile ≤767px) ===
       Shrinks the month grid so it fits a phone viewport: shorter rows,
       tighter header/date padding, smaller event text. Desktop is untouched
       — these rules only apply below the md breakpoint. */
    @media (max-width: 767px) {
      .macan-calendar-wrap .rbc-month-row {
        min-height: 64px;
      }
      .macan-calendar-wrap .rbc-header {
        padding: 8px 4px;
        font-size: 10px;
        letter-spacing: 0.03em;
      }
      .macan-calendar-wrap .rbc-date-cell {
        padding: 4px 5px;
        font-size: 11px;
      }
      .macan-calendar-wrap .rbc-event {
        font-size: 11px;
        padding: 1px 4px !important;
      }
      .macan-calendar-wrap .rbc-show-more {
        font-size: 10px;
        padding: 2px 4px;
      }
      .macan-calendar-wrap .rbc-time-view .rbc-label {
        font-size: 10px;
      }
    }
  `}</style>
);

export default CalendarThemeStyles;

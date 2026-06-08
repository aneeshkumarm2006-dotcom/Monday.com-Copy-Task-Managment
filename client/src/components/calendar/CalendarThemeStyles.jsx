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
  `}</style>
);

export default CalendarThemeStyles;

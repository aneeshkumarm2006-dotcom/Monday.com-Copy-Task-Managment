/**
 * Shared helpers for rendering tasks in a react-big-calendar grid.
 *
 * Used by the org-wide CalendarPage and the per-user calendar in the My Work
 * page so both stay visually consistent.
 */
import { getPriorityColor } from './priorityColors';
import { toDayKey, describeHoliday } from './orgHolidays';
import { isStatusDone } from './statusUtils';

// Canonical "done" green from globals.css → --color-status-done.
export const DONE_GREEN = '#16A34A';

// A task is a subitem when it points at a parent. The calendar endpoints
// populate `parent` with `{ _id, name }`, but a bare ObjectId works too.
export const isSubtask = (task) => Boolean(task && task.parent);

// Convert a #rrggbb / #rgb hex to an rgba() string at the given alpha so we
// can tint a pill background from the same priority color.
const hexToRgba = (hex, alpha) => {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * Map a task to a react-big-calendar event. `start`/`end` are set to the
 * same date (due date) so it renders as a single-day event. Subtasks get a
 * "↳" prefix so they read as children at a glance.
 */
export const taskToEvent = (task) => {
  const due = task.dueDate ? new Date(task.dueDate) : null;
  return {
    title: isSubtask(task) ? `↳ ${task.name}` : task.name,
    start: due,
    end: due,
    allDay: true,
    resource: task,
  };
};

/**
 * Style an event pill in the calendar grid using the task's priority color.
 * Completed tasks render green regardless of priority — a quick visual cue
 * that the work for that day is already finished.
 *
 * Main tasks render as a solid filled pill; subtasks render as a lighter
 * "ghost" pill (tinted background, colored text, accent left border) so the
 * two are easy to tell apart. react-big-calendar calls this for every event.
 */
export const eventPropGetter = (event) => {
  const task = event.resource || {};
  const done = isStatusDone(task.board, task.status);
  const solid = done
    ? DONE_GREEN
    : getPriorityColor(task.priority || 'low').solid;

  const base = {
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 11,
    fontWeight: 500,
    fontFamily: 'DM Sans, sans-serif',
    height: 22,
    lineHeight: '20px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  if (isSubtask(task)) {
    return {
      style: {
        ...base,
        backgroundColor: hexToRgba(solid, 0.16),
        color: solid,
        border: 'none',
        borderLeft: `3px solid ${solid}`,
        borderRadius: '0 4px 4px 0',
        fontWeight: 600,
      },
    };
  }

  return {
    style: {
      ...base,
      backgroundColor: solid,
      borderColor: solid,
      color: '#FFFFFF',
      border: 'none',
    },
  };
};
/**
 * Shade the company holidays in a react-big-calendar grid.
 *
 * `dayPropGetter` is the library's per-day-cell hook, the sibling of the
 * `eventPropGetter` above, and it was unused until holidays needed it. Pass the
 * Map from `holidayIndex()` and hand the result straight to `<Calendar>`:
 *
 *   dayPropGetter={holidayDayPropGetter(index)}
 *
 * The holiday NAME travels as a CSS custom property rather than as markup,
 * because react-big-calendar only lets this hook return className and style —
 * there is no slot for a child node. CalendarThemeStyles reads it in a ::after.
 *
 * Returns a stable empty object when there are no holidays, so calendars in a
 * workspace that has none pay nothing.
 */
export const holidayDayPropGetter = (holidayIndexMap) => {
  if (!holidayIndexMap || holidayIndexMap.size === 0) return undefined;

  return (date) => {
    const holiday = holidayIndexMap.get(toDayKey(date));
    if (!holiday) return {};

    return {
      className: 'macan-holiday',
      style: {
        // CSS content: needs a quoted string, and a name containing a quote
        // would otherwise break out of the declaration.
        '--holiday-name': JSON.stringify(holiday.name || 'Holiday'),
      },
      title: describeHoliday(holiday),
    };
  };
};


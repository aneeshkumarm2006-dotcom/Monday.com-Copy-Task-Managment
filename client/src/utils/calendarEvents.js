/**
 * Shared helpers for rendering tasks in a react-big-calendar grid.
 *
 * Used by the org-wide CalendarPage and the per-user calendar in the My Work
 * page so both stay visually consistent.
 */
import { getPriorityColor } from './priorityColors';
import { isStatusDone } from './statusUtils';

// Canonical "done" green from globals.css → --color-status-done.
export const DONE_GREEN = '#16A34A';

/**
 * Map a task to a react-big-calendar event. `start`/`end` are set to the
 * same date (due date) so it renders as a single-day event.
 */
export const taskToEvent = (task) => {
  const due = task.dueDate ? new Date(task.dueDate) : null;
  return {
    title: task.name,
    start: due,
    end: due,
    allDay: true,
    resource: task,
  };
};

/**
 * Style an event pill in the calendar grid using the task's priority color.
 * Completed tasks render green regardless of priority — a quick visual cue
 * that the work for that day is already finished. react-big-calendar calls
 * this for every event instance.
 */
export const eventPropGetter = (event) => {
  const task = event.resource || {};
  const done = isStatusDone(task.board, task.status);
  const solid = done
    ? DONE_GREEN
    : getPriorityColor(task.priority || 'low').solid;
  return {
    style: {
      backgroundColor: solid,
      borderColor: solid,
      color: '#FFFFFF',
      border: 'none',
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
    },
  };
};

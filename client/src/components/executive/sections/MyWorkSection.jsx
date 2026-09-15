import { Link } from 'react-router-dom';

import SectionFrame from '../SectionFrame';
import Chip from '../../ui/Chip';
import { buildTaskLink } from '../../../utils/taskLink';
import { formatShortDate, isOverdue } from '../../../utils/dateUtils';
import { isStatusDone } from '../../../utils/statusUtils';

/**
 * MyWorkSection — the reader's own open work, from the same query My Work runs.
 *
 * Payload (`executiveHome.runMyWork`):
 *   { due, limit, timezone, todayDayKey, tasks }
 *
 * `tasks` are full task documents with `board` (name, statuses, labels),
 * `group`, `parent` and the two people refs populated — the same four populates
 * `getMyTasks` does, with the same field lists, so a row here and a row on My
 * Work are the same row.
 *
 * ---- WHY THE ROWS ARE LINKS AND NOT BUTTONS ------------------------------
 *
 * Everything on this page is read-only (the home page composes, it does not
 * mutate), so a row's only job is to be a way IN. My Work opens a detail panel
 * on click; that panel edits, and reproducing it here would put a write surface
 * on a page whose entire contract is that it has none. A link to the row on its
 * own board is the honest version of the same gesture.
 *
 * ---- WHY THE LINK IS BUILT BY `taskLink.js` AND THEN TRIMMED -------------
 *
 * There is exactly ONE link format that reaches a task — `highlightTask`, plus
 * `highlightParent` for a subitem, plus `month` — and `utils/taskLink.js` is
 * where it is spelled. `month` is the half that gets forgotten when somebody
 * hand-rolls the query string, and forgetting it on a TRACKER board means
 * landing on a board that genuinely does not contain the row: a tracker board
 * loads one month at a time, so an August task opened in September is not
 * hidden, it is not there.
 *
 * ---- WHY "OVERDUE" IS TWO QUESTIONS, NOT ONE -----------------------------
 *
 * A past due date is only late if the work is not finished. Every other row
 * renderer in this app pairs `isOverdue(task.dueDate)` with a done check —
 * `TaskRow.jsx` and `TaskCardList.jsx` both do, and `utils/statusUtils.js`
 * `isStatusDone` is the one function that answers it — because a status is an
 * ObjectId into THAT BOARD's `statuses`, so "is this done" cannot be asked
 * without the board. The legacy enum ('done') is the fallback the same helper
 * applies for a personal task, which has no board at all.
 *
 * Asking only half of it here would paint a finished task bold red on the one
 * page whose entire job is to be glanced at, and the person glancing would go
 * and chase work that is already delivered.
 *
 * `buildTaskLink` returns an ABSOLUTE url, because its callers put it on the
 * clipboard. `<Link to>` needs an in-app path, so the origin is trimmed off
 * here rather than a second builder being written. A personal task lives on no
 * board and correctly yields null; those rows render without a link.
 */

/** The heading's second line, per `config.due`. */
const DUE_LABELS = {
  all: 'Everything assigned to you',
  today: 'Due today',
  week: 'Due this week',
  overdue: 'Overdue',
};

/** What to say when the query came back with nothing, per `config.due`. */
const EMPTY_MESSAGES = {
  all: 'Nothing is assigned to you right now.',
  today: 'Nothing is due today.',
  week: 'Nothing is due this week.',
  overdue: 'Nothing is overdue.',
};

/**
 * The in-app path to a task's row on its board, or null when there is none.
 * See the header for why this borrows the clipboard builder and trims it.
 */
const taskPath = (task) => {
  // `tab: null` opens no detail panel — the link highlights and scrolls to the
  // row, which is what "show me this" means from a dashboard.
  const href = buildTaskLink(task, { tab: null });
  if (!href) return null;
  if (href.startsWith('/')) return href;
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}`;
  } catch {
    // An origin we cannot parse is not worth a broken route. The section's own
    // "Open My Work" link still reaches every one of these rows.
    return null;
  }
};

const TaskRow = ({ task, first }) => {
  const to = taskPath(task);
  // Two questions, both of them required — see the header. `task.board` is the
  // populated board this row came from, and it is what makes the status id
  // resolvable; a personal task passes null and falls through to the legacy
  // enum, exactly as it does on My Work.
  const late = isOverdue(task.dueDate) && !isStatusDone(task.board, task.status);

  const body = (
    <div className="flex items-start justify-between gap-3 min-w-0">
      <div className="min-w-0 flex-1">
        <p
          className="font-body font-medium truncate"
          style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
          title={task.name}
        >
          {task.name}
        </p>
        <p
          className="font-body truncate mt-0.5"
          style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
        >
          {/* Board and group, which is where this row lives. A personal task has
              neither, and the line simply does not render for it. */}
          {[task.board?.name, task.group?.name].filter(Boolean).join(' · ')}
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {task.dueDate && (
          <span
            className="font-body whitespace-nowrap"
            style={{
              fontSize: 11.5,
              // Red for a date already past on work that is not done yet,
              // muted otherwise. One word of colour on the row, spent on the
              // only thing that is urgent.
              color: late ? 'var(--color-status-stuck)' : 'var(--color-text-muted)',
              fontWeight: late ? 600 : 400,
            }}
          >
            {formatShortDate(task.dueDate)}
          </span>
        )}
        {/* `board` is passed so the status id resolves against ITS OWN board's
            palette: a status is an ObjectId into `board.statuses`, and the same
            id means nothing on another board. Without it the chip falls back to
            the legacy enum palette, which is right for a personal task and
            wrong for every other row. */}
        <Chip type="status" value={task.status} board={task.board} />
      </div>
    </div>
  );

  const padding = { padding: '10px 16px' };

  return (
    // Dividers BETWEEN rows, so the first one does not sit a pixel under
    // `PanelHead`'s own bottom border and print it twice.
    <li style={first ? undefined : { borderTop: '1px solid var(--color-border)' }}>
      {to ? (
        <Link
          to={to}
          className="block transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
          style={padding}
        >
          {body}
        </Link>
      ) : (
        <div style={padding}>{body}</div>
      )}
    </li>
  );
};

const MyWorkSection = ({ section }) => {
  const data = section?.data || {};
  const due = section?.config?.due || 'all';
  const tasks = data.tasks || [];

  return (
    <SectionFrame
      section={section}
      title="My work"
      subtitle={DUE_LABELS[due] || DUE_LABELS.all}
      emptyMessage={EMPTY_MESSAGES[due] || EMPTY_MESSAGES.all}
      // Full-bleed, so the row dividers meet the panel's own edges rather than
      // stopping short of them in a padded box.
      flush
    >
      {() => (
        <ul className="list-none p-0 m-0">
          {tasks.map((task, i) => (
            <TaskRow key={task._id} task={task} first={i === 0} />
          ))}
        </ul>
      )}
    </SectionFrame>
  );
};

export default MyWorkSection;

/**
 * Build the shareable in-app link to a single task — what the copy-link button
 * in the task detail panel puts on the clipboard.
 *
 * This deliberately produces the SAME shape as the deep link notification
 * emails already use (`server/src/utils/taskDeepLink.js`), because
 * BoardDetailPage only knows how to land on a task one way: `highlightTask`
 * (glow + scroll to the row), `highlightParent` (expand the parent first, for a
 * subitem), `openTab` (open the detail panel on that tab). A second, private
 * link format would be a second thing to keep working.
 *
 * `month` is the one addition. A tracker board only ever has one month's rows
 * loaded, so a link to an August task opened while September is selected lands
 * on a board that genuinely does not contain it — the row is not hidden, it is
 * not there. Carrying the task's own month makes the recipient's board show the
 * month the sender was looking at.
 *
 * Returns null when there is nothing shareable: a personal task lives on no
 * board, so no URL can reach it for anyone else.
 *
 * @param {Object} task            - task doc (needs _id and board; parent/monthKey optional)
 * @param {Object} [opts]
 * @param {string|null} [opts.tab] - detail-panel tab to open (null = row only, no panel)
 * @param {string} [opts.origin]   - override for `window.location.origin`
 * @returns {string|null} absolute URL
 */
export const buildTaskLink = (task, { tab = 'updates', origin } = {}) => {
  if (!task || task.isPersonal) return null;

  const taskId = task._id;
  const boardId = task.board?._id || task.board || task.boardId || null;
  if (!taskId || !boardId) return null;

  const params = new URLSearchParams();
  params.set('highlightTask', String(taskId));

  const parentId = task.parent?._id || task.parent;
  if (parentId) params.set('highlightParent', String(parentId));

  if (tab) params.set('openTab', tab);
  if (task.monthKey) params.set('month', task.monthKey);

  const base =
    origin || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/boards/${boardId}?${params.toString()}`;
};

/**
 * Build the shareable links for a LIST of tasks — what the bulk-action bar's
 * "Copy links" button puts on the clipboard, one URL per line.
 *
 * Deliberately the same `buildTaskLink` per row, so a link copied from a
 * selection of twenty is byte-identical to the one the detail panel's copy
 * button hands out for the same task. Rows with nothing shareable (a personal
 * task) are dropped rather than emitting a blank line, so the caller can say
 * how many links it actually copied.
 *
 * @param {Object[]} tasks
 * @param {Object} [opts] - forwarded to buildTaskLink (tab / origin)
 * @returns {string[]} absolute URLs, in the order the tasks were given
 */
export const buildTaskLinks = (tasks, opts = {}) =>
  (Array.isArray(tasks) ? tasks : [])
    .map((task) => buildTaskLink(task, opts))
    .filter(Boolean);

export default buildTaskLink;

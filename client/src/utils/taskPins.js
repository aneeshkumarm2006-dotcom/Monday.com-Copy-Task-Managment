/**
 * Task pinning — floats a task to the top of its own group.
 *
 * Two independent pins, unioned:
 *   - team    → `task.pinned` on the server, everyone on the board sees it
 *   - personal → task ids in localStorage, private to this browser
 *
 * Neither one writes `Task.order`. Pinning is applied at render time only,
 * which is what lets an unpin drop the row straight back into its real slot
 * with no stored "original position" to keep in sync. Same contract as the
 * "completed groups last" sort in BoardDetailPage.
 */

/**
 * localStorage key prefix for the personal ("pin for me only") pins.
 * The board id is appended so each board keeps its own set.
 */
export const PERSONAL_PIN_KEY = 'board:pinnedTasks:';

/**
 * Read this board's personal pins. Returns an empty Set on any storage or
 * parse failure (private mode, quota, hand-edited value).
 */
export const loadPersonalPins = (boardId) => {
  if (!boardId) return new Set();
  try {
    const raw = localStorage.getItem(PERSONAL_PIN_KEY + boardId);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
};

/**
 * Persist this board's personal pins. Ids for tasks that were later deleted
 * are harmless — nothing reads the set except a lookup against a live task.
 */
export const savePersonalPins = (boardId, pins) => {
  if (!boardId) return;
  try {
    localStorage.setItem(
      PERSONAL_PIN_KEY + boardId,
      JSON.stringify(Array.from(pins))
    );
  } catch {
    /* ignore storage failures (private mode, quota) */
  }
};

/**
 * The union rule, in one place: a task floats if the team pinned it OR this
 * user pinned it. There is deliberately no way to personally un-float a team
 * pin — one fewer state per task per user.
 */
export const isTaskPinned = (task, personalPins) =>
  task?.pinned === true || (!!task && !!personalPins?.has?.(task._id));

/**
 * Stable partition into [pinned…, unpinned…]. Each tier keeps the relative
 * order it arrived in, so the underlying `order` still decides everything
 * within a tier.
 *
 * Returns the original array when nothing is pinned, so unpinned boards skip
 * the work and referential equality is preserved for downstream memos.
 */
export const sortPinnedFirst = (tasks, personalPins) => {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks;
  const pinned = [];
  const rest = [];
  for (const t of tasks) {
    if (isTaskPinned(t, personalPins)) pinned.push(t);
    else rest.push(t);
  }
  if (pinned.length === 0) return tasks;
  return pinned.concat(rest);
};

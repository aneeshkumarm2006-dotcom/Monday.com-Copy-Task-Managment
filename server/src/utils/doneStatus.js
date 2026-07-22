/**
 * The "done" rung of a board is the status subdoc whose `key === 'done'` — a
 * stable handle preserved across renames (see Board.js statusSchema). A board
 * could in principle carry more than one, so this returns a list. Legacy,
 * pre-flexible-columns tasks may still store the raw string `'done'`, so callers
 * that query Task.status should also match the string 'done' alongside these ids.
 *
 * Extracted so the portal issues endpoint and the resolved-email hook don't add
 * yet another copy of the `s.key === 'done'` filter that already lives in
 * boardController / analyticsController / productivityController.
 *
 * @param {{ statuses?: Array<{ _id: any, key?: string }> }} board
 * @returns {Array} array of status `_id`s
 */
const doneStatusIdsForBoard = (board) => {
  if (!board || !Array.isArray(board.statuses)) return [];
  return board.statuses.filter((s) => s && s.key === 'done').map((s) => s._id);
};

/**
 * Is a given task-status value a "done" status for this board? Accepts either an
 * ObjectId (board task) or the legacy string 'done' (pre-migration task).
 *
 * @param {object} board
 * @param {*} statusValue  the task's `status` field
 * @returns {boolean}
 */
const isResolvedStatus = (board, statusValue) => {
  if (statusValue === 'done') return true;
  if (statusValue == null) return false;
  const doneIds = doneStatusIdsForBoard(board).map((id) => String(id));
  return doneIds.includes(String(statusValue));
};

module.exports = { doneStatusIdsForBoard, isResolvedStatus };

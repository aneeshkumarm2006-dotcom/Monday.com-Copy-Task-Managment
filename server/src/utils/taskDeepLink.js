/**
 * Build the deep link an email's "View Task" button points to.
 *
 * Historically these emails linked to `/boards/<id>` only, dropping the reader on
 * the board with no idea which row to open. BoardDetailPage understands three
 * query params — `highlightTask` (glow + scroll to the row), `highlightParent`
 * (expand the parent group first, for a subitem), and `openTab` (open the detail
 * panel on that tab) — so we hand it all three and it lands exactly on the task.
 *
 * @param {Object} task            - the Task doc (needs _id, board, optional parent)
 * @param {Object} [opts]
 * @param {string} [opts.tab]      - detail-panel tab to open (e.g. 'updates')
 * @param {string} [opts.boardId]  - explicit board id when task.board isn't loaded
 * @returns {string} absolute URL
 */
const buildTaskDeepLink = (task, { tab, boardId: boardIdOverride } = {}) => {
  const base = process.env.CLIENT_URL || 'http://localhost:5173';
  const boardId =
    task?.board?.toString?.() ||
    task?.board ||
    boardIdOverride?.toString?.() ||
    boardIdOverride;
  const taskId = task?._id?.toString?.() || task?._id;
  if (!boardId) return base;
  if (!taskId) return `${base}/boards/${boardId}`;

  const params = new URLSearchParams();
  params.set('highlightTask', String(taskId));
  const parent = task?.parent;
  if (parent) {
    params.set('highlightParent', parent.toString?.() || String(parent));
  }
  if (tab) params.set('openTab', tab);

  return `${base}/boards/${boardId}?${params.toString()}`;
};

module.exports = { buildTaskDeepLink };

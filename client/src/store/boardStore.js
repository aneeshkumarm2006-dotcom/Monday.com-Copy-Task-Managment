import { create } from 'zustand';
import * as boardService from '../services/boardService';
import * as columnService from '../services/columnService';
import * as taskService from '../services/taskService';
import * as linkService from '../services/linkService';

/**
 * Merge new `labels` / `statuses` / `columns` into the board record
 * in-place. Returns a new boards array reference so React notices the change.
 */
const replaceBoardChips = (boards, boardId, key, list) =>
  boards.map((b) =>
    b._id === boardId ? { ...b, [key]: list } : b
  );

const useBoardStore = create((set, get) => ({
  boards: [],
  loading: false,
  error: null,

  fetchBoards: async (orgId) => {
    if (!orgId) return [];
    set({ loading: true, error: null });
    try {
      const boards = await boardService.getBoards(orgId);
      set({ boards, loading: false });
      return boards;
    } catch (err) {
      set({ loading: false, error: err });
      throw err;
    }
  },

  createBoard: async (payload) => {
    const board = await boardService.createBoard(payload);
    set((s) => ({ boards: [board, ...s.boards] }));
    return board;
  },

  updateBoard: async (id, payload) => {
    const board = await boardService.updateBoard(id, payload);
    set((s) => ({
      boards: s.boards.map((b) => (b._id === id ? board : b)),
    }));
    return board;
  },

  deleteBoard: async (id) => {
    await boardService.deleteBoard(id);
    set((s) => ({ boards: s.boards.filter((b) => b._id !== id) }));
  },

  /**
   * Optimistic reorder of the boards list for an organisation. Reverts to
   * the prior order if the API call fails so the UI can't drift out of
   * sync with the server.
   */
  reorderBoards: async (organisation, orderedIds) => {
    const prev = get().boards;
    const byId = new Map(prev.map((b) => [b._id, b]));
    const next = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    // Append any boards not in orderedIds (defensive) to preserve them.
    for (const b of prev) {
      if (!orderedIds.includes(b._id)) next.push(b);
    }
    set({ boards: next });
    try {
      const boards = await boardService.reorderBoards(organisation, orderedIds);
      set({ boards });
      return boards;
    } catch (err) {
      set({ boards: prev });
      throw err;
    }
  },

  /**
   * Set a member's access level on a private board ('read' | 'edit' | 'none'),
   * optionally flipping their full-access flag (owner-only, server-enforced).
   * Allowed for the owner and for full-access members. Replaces the board in
   * the cache with the updated copy so `memberAccess` (and the permissions
   * derived from it) stay in sync.
   */
  setBoardAccess: async (boardId, userId, level, canManage) => {
    const { board } = await boardService.setBoardAccess(
      boardId,
      userId,
      level,
      canManage
    );
    set((s) => ({
      boards: s.boards.map((b) => (b._id === boardId ? board : b)),
    }));
    return board;
  },

  // Local-only helpers
  addBoardLocal: (board) =>
    set((s) => ({ boards: [board, ...s.boards] })),

  updateBoardLocal: (board) =>
    set((s) => ({
      boards: s.boards.map((b) => (b._id === board._id ? board : b)),
    })),

  removeBoardLocal: (id) =>
    set((s) => ({ boards: s.boards.filter((b) => b._id !== id) })),

  clearBoards: () => set({ boards: [], error: null }),

  // --- Labels --------------------------------------------------------------

  addLabel: async (boardId, payload) => {
    const labels = await boardService.addLabel(boardId, payload);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'labels', labels) }));
    return labels;
  },

  updateLabel: async (boardId, labelId, payload) => {
    const labels = await boardService.updateLabel(boardId, labelId, payload);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'labels', labels) }));
    return labels;
  },

  deleteLabel: async (boardId, labelId) => {
    const labels = await boardService.deleteLabel(boardId, labelId);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'labels', labels) }));
    return labels;
  },

  reorderLabels: async (boardId, orderedIds) => {
    const labels = await boardService.reorderLabels(boardId, orderedIds);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'labels', labels) }));
    return labels;
  },

  // --- Statuses ------------------------------------------------------------

  addStatus: async (boardId, payload) => {
    const statuses = await boardService.addStatus(boardId, payload);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'statuses', statuses) }));
    return statuses;
  },

  updateStatusChip: async (boardId, statusId, payload) => {
    const statuses = await boardService.updateStatus(boardId, statusId, payload);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'statuses', statuses) }));
    return statuses;
  },

  deleteStatus: async (boardId, statusId) => {
    const statuses = await boardService.deleteStatus(boardId, statusId);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'statuses', statuses) }));
    return statuses;
  },

  reorderStatuses: async (boardId, orderedIds) => {
    const statuses = await boardService.reorderStatuses(boardId, orderedIds);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'statuses', statuses) }));
    return statuses;
  },

  // --- Columns (flexible-columns engine, F1) -------------------------------

  /**
   * Refresh `board.columns` from the server. Use after a column CRUD action
   * if the optimistic update + API response shape doesn't match what the
   * server returned (e.g. order normalisation).
   */
  fetchColumns: async (boardId) => {
    const columns = await columnService.listColumns(boardId);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'columns', columns) }));
    return columns;
  },

  addColumn: async (boardId, payload) => {
    const { columns } = await columnService.addColumn(boardId, payload);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'columns', columns) }));
    return columns;
  },

  updateColumn: async (boardId, columnId, payload) => {
    const { columns } = await columnService.updateColumn(boardId, columnId, payload);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'columns', columns) }));
    return columns;
  },

  reorderColumns: async (boardId, order) => {
    // Optimistic: reorder local columns immediately so the grid header
    // doesn't jitter on slow networks. Revert on error.
    const prev = get().boards.find((b) => b._id === boardId)?.columns || [];
    const indexById = new Map(order.map((id, i) => [id, i]));
    const next = prev
      .slice()
      .sort((a, b) =>
        (indexById.get(a._id) ?? Infinity) - (indexById.get(b._id) ?? Infinity)
      );
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'columns', next) }));
    try {
      const columns = await columnService.reorderColumns(boardId, order);
      set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'columns', columns) }));
      return columns;
    } catch (err) {
      set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'columns', prev) }));
      throw err;
    }
  },

  deleteColumn: async (boardId, columnId) => {
    const columns = await columnService.deleteColumn(boardId, columnId);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'columns', columns) }));
    return columns;
  },

  /**
   * setColumnValue — write a single cell. Calls `PUT /api/tasks/:id` with
   * `{ columnValues: { [columnId]: value } }`. Callers update their local
   * task cache separately via taskStore.updateTask(...) after this resolves.
   *
   * Returns the populated task so the caller can refresh its row.
   */
  setColumnValue: async (taskId, columnId, value) => {
    const task = await taskService.updateTask(taskId, {
      columnValues: { [columnId]: value },
    });
    return task;
  },

  // --- Cross-board connectivity (F2) ---------------------------------------

  /**
   * Boards a connect_boards column on `boardId` may target. Returns
   * `[{ board, workspace }]` (board.columns included for source pickers).
   */
  fetchConnectable: async (boardId) => {
    const connectable = await linkService.getConnectableBoards(boardId);
    return connectable;
  },

  /**
   * linkTask — add a link on a task's connect_boards column. Returns the
   * server's `{ value, links }`; the caller updates its local task cache.
   */
  linkTask: async (taskId, columnId, target) => {
    const result = await linkService.linkTask(taskId, columnId, target);
    return result;
  },

  /**
   * unlinkTask — remove a link by target task id. Returns `{ value, links }`.
   */
  unlinkTask: async (taskId, columnId, targetTaskId) => {
    const result = await linkService.unlinkTask(taskId, columnId, targetTaskId);
    return result;
  },

  /**
   * mirrorValue — fetch a task's computed mirror value for a column. Async
   * (the value is computed server-side from the linked rows).
   */
  mirrorValue: async (taskId, columnId) => {
    const value = await linkService.getMirror(taskId, columnId);
    return value;
  },

  // Helpers
  getBoardById: (id) => get().boards.find((b) => b._id === id) || null,
}));

export default useBoardStore;

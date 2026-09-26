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

/**
 * Board ids whose cached document is known to be behind the server.
 *
 * Module-level, like the roster promises below: nothing renders from it, and a
 * set() per `board.changed` ping would re-render every board consumer for no
 * visible change. A fetch of the board (one, or the whole list) clears it.
 *
 * Why it exists: the board page reuses the cached board when one is in the
 * store, and only the board OPEN at the time of a `board.changed` ping refetches
 * itself. A workspace currency change relabels every following board at once,
 * so without this a person who then opened a second board saw its old symbol
 * over its new unit until a reload. The open board reads it too: a burst of
 * pings can overwrite its refresh target before the page runs, and its stale
 * mark is what still tells it to refetch (BoardDetailPage).
 */
const staleBoardIds = new Set();

/**
 * Fold a column write's reply — `{ columns, currency? }` — into the cached board.
 *
 * `currency` rides along because a column write can move the BOARD's unit: the
 * server's `reconcileMoneyUnits` re-stamps `board.currency` when the column
 * that set it is relabelled or switched out of money. Taking only `columns`
 * left the chip and the ledger strip reading the old unit until a reload.
 * On a board that follows the workspace it may be null — that null is the
 * answer and is merged.
 *
 * Merged only when the reply carries the key at all. A reply without it (an
 * endpoint that does not report the unit) says nothing about the board's
 * currency, which is not the same as saying it is null.
 */
const mergeColumnsReply = (boards, boardId, data) => {
  let next = boards;
  if (Array.isArray(data?.columns)) next = replaceBoardChips(next, boardId, 'columns', data.columns);
  if (data && typeof data === 'object' && 'currency' in data) {
    next = replaceBoardChips(next, boardId, 'currency', data.currency ?? null);
  }
  return next;
};

/**
 * boardId -> the in-flight roster request, so concurrent callers share one.
 *
 * Deliberately module-level rather than store state: a DataGrid can mount fifty
 * `person` cells in the same tick and every one of them asks for the roster on
 * its first effect. `boardMembersLoaded` cannot dedupe those — it is only set
 * once the response lands, by which time all fifty requests are already out. A
 * promise keyed here is what collapses them into one. Promises are not state and
 * nothing renders from them, so keeping them out of the store avoids a set()
 * per request.
 */
const inFlightBoardMembers = new Map();

const useBoardStore = create((set, get) => ({
  boards: [],
  loading: false,
  error: null,

  /**
   * boardId -> the people who may be ASSIGNED work on that board.
   *
   * Separate from `useOrgStore.members` on purpose, and not a filtered view of
   * it: who can read a private board is the AND of an org role and a board
   * grant, which only the server resolves (see utils/permissions.js). The client
   * asks rather than derives — deriving it here is exactly the drift the
   * two-layer model exists to remove.
   *
   * Cached per board and shared by every picker on the page, so opening a board
   * costs one request no matter how many pickers it renders. `boardMembersLoaded`
   * marks a board as fetched so an empty roster is not mistaken for a pending one
   * and re-requested forever.
   */
  boardMembers: {},
  boardMembersLoaded: {},

  fetchBoards: async (orgId) => {
    if (!orgId) return [];
    set({ loading: true, error: null });
    try {
      const boards = await boardService.getBoards(orgId);
      for (const b of boards || []) staleBoardIds.delete(String(b._id));
      set({ boards, loading: false });
      return boards;
    } catch (err) {
      set({ loading: false, error: err });
      throw err;
    }
  },

  /**
   * Fetch ONE board by id and fold it into `boards`.
   *
   * For deep links: the list is per-workspace, so a board in any other
   * workspace is simply absent from it and `getBoardById` returns null
   * forever. This asks for the board itself. It merges rather than replaces,
   * because the list for the current workspace is still wanted — the board
   * being viewed is an addition to it, not a substitute.
   */
  fetchBoard: async (boardId) => {
    const board = await boardService.getBoard(boardId);
    staleBoardIds.delete(String(board?._id || boardId));
    set((s) => ({
      boards: s.boards.some((b) => b._id === board._id)
        ? s.boards.map((b) => (b._id === board._id ? board : b))
        : [...s.boards, board],
    }));
    return board;
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
    // The grant that just changed IS the thing the board's pickers list, so the
    // cached roster is stale the moment this resolves. Refresh it rather than
    // only invalidating: the Share modal is usually open over a board whose
    // pickers are already mounted and will not re-request on their own.
    get()
      .fetchBoardMembers(boardId, { force: true })
      .catch(() => {});
    return board;
  },

  /**
   * Hand the board to another member. The server returns the board with the
   * CALLER's permissions re-resolved — after this the caller is usually no longer
   * the owner, so caching the response is what makes the Share modal and the
   * board header stop offering owner-only controls.
   */
  transferBoardOwnership: async (boardId, userId) => {
    const { board } = await boardService.transferBoardOwnership(boardId, userId);
    set((s) => ({
      boards: s.boards.map((b) => (b._id === boardId ? board : b)),
    }));
    // Ownership rewrites `memberAccess` (the outgoing owner gains a grant, the
    // incoming one loses theirs), and memberAccess IS what the board's pickers
    // list — same reasoning as setBoardAccess.
    get()
      .fetchBoardMembers(boardId, { force: true })
      .catch(() => {});
    return board;
  },

  // Local-only helpers
  /** Set (a File) or clear (null) a board's logo; patches the cached board. */
  setBoardLogo: async (boardId, file) => {
    const logo = file
      ? await boardService.uploadBoardLogo(boardId, file)
      : await boardService.removeBoardLogo(boardId);
    set((s) => ({
      boards: s.boards.map((b) => (b._id === boardId ? { ...b, logo } : b)),
    }));
    return logo;
  },

  addBoardLocal: (board) =>
    set((s) => ({ boards: [board, ...s.boards] })),

  updateBoardLocal: (board) =>
    set((s) => ({
      boards: s.boards.map((b) => (b._id === board._id ? board : b)),
    })),

  removeBoardLocal: (id) =>
    set((s) => ({ boards: s.boards.filter((b) => b._id !== id) })),

  clearBoards: () => {
    inFlightBoardMembers.clear();
    staleBoardIds.clear();
    set({ boards: [], error: null, boardMembers: {}, boardMembersLoaded: {} });
  },

  // --- Board roster --------------------------------------------------------

  /**
   * Load (once) the roster of people assignable on `boardId`.
   *
   * `force` re-fetches — access can change under a board while it is open (the
   * owner grants or revokes someone in the Share modal), and the pickers should
   * follow.
   */
  fetchBoardMembers: async (boardId, { force = false } = {}) => {
    if (!boardId) return [];
    const key = String(boardId);

    if (force) inFlightBoardMembers.delete(key);
    else if (get().boardMembersLoaded[key]) return get().boardMembers[key] || [];

    const existing = inFlightBoardMembers.get(key);
    if (existing) return existing;

    const request = boardService
      .getBoardMembers(key)
      .then((members) => {
        set((s) => ({
          boardMembers: { ...s.boardMembers, [key]: members },
          boardMembersLoaded: { ...s.boardMembersLoaded, [key]: true },
        }));
        return members;
      })
      .finally(() => {
        // Clear on failure too, or one dropped request would pin the rejection
        // forever and every later caller would re-throw it without retrying.
        if (inFlightBoardMembers.get(key) === request) {
          inFlightBoardMembers.delete(key);
        }
      });

    inFlightBoardMembers.set(key, request);
    return request;
  },

  /**
   * Drop a board's cached roster so the next read re-fetches it. Called after a
   * grant changes, where the roster the pickers are showing is now stale.
   */
  invalidateBoardMembers: (boardId) =>
    set((s) => {
      if (!boardId) return {};
      const key = String(boardId);
      inFlightBoardMembers.delete(key);
      const loaded = { ...s.boardMembersLoaded };
      delete loaded[key];
      return { boardMembersLoaded: loaded };
    }),

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

  // --- Group tags (extra feature) ------------------------------------------
  // The board-level catalog. Which tags a given GROUP carries lives on the group
  // itself, in taskStore — this is only the vocabulary.

  addGroupTag: async (boardId, payload) => {
    const groupTags = await boardService.addGroupTag(boardId, payload);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'groupTags', groupTags) }));
    return groupTags;
  },

  updateGroupTag: async (boardId, tagId, payload) => {
    const groupTags = await boardService.updateGroupTag(boardId, tagId, payload);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'groupTags', groupTags) }));
    return groupTags;
  },

  deleteGroupTag: async (boardId, tagId) => {
    const groupTags = await boardService.deleteGroupTag(boardId, tagId);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'groupTags', groupTags) }));
    return groupTags;
  },

  reorderGroupTags: async (boardId, orderedIds) => {
    const groupTags = await boardService.reorderGroupTags(boardId, orderedIds);
    set((s) => ({ boards: replaceBoardChips(s.boards, boardId, 'groupTags', groupTags) }));
    return groupTags;
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
    const data = await columnService.addColumn(boardId, payload);
    set((s) => ({ boards: mergeColumnsReply(s.boards, boardId, data) }));
    return data?.columns;
  },

  /**
   * PATCH one column. The reply is `{ column, columns, currency }` — the board's
   * unit comes back too, because relabelling a money column can move it (see
   * `mergeColumnsReply`). Returns the columns, as it always has.
   */
  updateColumn: async (boardId, columnId, payload) => {
    const data = await columnService.updateColumn(boardId, columnId, payload);
    set((s) => ({ boards: mergeColumnsReply(s.boards, boardId, data) }));
    return data?.columns;
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

  /**
   * Relabel the board's money — `board.currency` and every currency column —
   * in one request. Not optimistic: the server decides which columns are money
   * and stamps them, so the cached columns are replaced from its answer rather
   * than guessed at here.
   *
   * `currency` null means FOLLOW the workspace: the server stores null and
   * relabels to the workspace's current base. The reply's `board.currency` is
   * then null, and that null is merged — it is the answer, not a missing one.
   *
   * Returns `{ board, following, effective }`. The last two are derived from
   * `board` when a server does not send them, so a caller can always read them.
   */
  setBoardCurrency: async (boardId, currency) => {
    const data = await boardService.setBoardCurrency(boardId, currency ?? null);
    const board = data?.board || null;
    if (board) {
      set((s) => {
        let boards = s.boards;
        if ('currency' in board) {
          boards = replaceBoardChips(boards, boardId, 'currency', board.currency ?? null);
        }
        if (Array.isArray(board.columns)) {
          boards = replaceBoardChips(boards, boardId, 'columns', board.columns);
        }
        return { boards };
      });
      // What this reply carried IS the fresh copy of this board.
      staleBoardIds.delete(String(boardId));
    }
    const following =
      typeof data?.following === 'boolean' ? data.following : !(board?.currency);
    return {
      board,
      following,
      effective: data?.effective || board?.currency || null,
    };
  },

  /**
   * Note that boards changed on the server while this tab was not looking at
   * them — a `board.changed` ping for a board that is not open, or the boards a
   * workspace currency change relabelled. Nothing is fetched here: the board
   * page asks `takeBoardStale` when it opens one, and refetches only then, so a
   * workspace with forty boards does not cost forty requests nobody reads.
   */
  markBoardsStale: (ids) => {
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      if (id) staleBoardIds.add(String(id));
    }
  },

  /** Was this board marked stale? Clears the mark — the caller refetches. */
  takeBoardStale: (boardId) => {
    const key = String(boardId || '');
    if (!key || !staleBoardIds.has(key)) return false;
    staleBoardIds.delete(key);
    return true;
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

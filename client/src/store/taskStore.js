import { create } from 'zustand';
import * as taskService from '../services/taskService';
import * as noteService from '../services/noteService';

/**
 * Merge a single-task server response over the task we already have, keeping
 * the client-side list annotations (`updatesCount`, `hasSubitems`) that
 * single-task endpoints don't return. Falls back to the incoming value when
 * the previous task didn't carry one either.
 */
const mergeServerTask = (prev, next) => {
  if (!prev) return next;
  return {
    ...next,
    updatesCount:
      next.updatesCount !== undefined ? next.updatesCount : prev.updatesCount,
    hasSubitems:
      next.hasSubitems !== undefined ? next.hasSubitems : prev.hasSubitems,
  };
};

/**
 * useTaskStore — tracks tasks (and their groups) for the board detail view.
 *
 * Tasks are keyed by their group id in `tasksByGroup` so each group's table
 * can read its slice independently without re-rendering the whole board.
 */
const useTaskStore = create((set, get) => ({
  groups: [],
  tasksByGroup: {},   // { [groupId]: Task[] }
  subitemsByParent: {}, // { [parentTaskId]: Task[] }
  notesByGroup: {},      // { [groupId]: Note[] }  — loaded lazily when a panel opens
  notesCountByGroup: {}, // { [groupId]: number }  — loaded eagerly for header badges
  loading: false,
  error: null,
  // Bumped when a realtime "board.changed" SSE frame arrives so the board view
  // can refetch; `boardRefreshTarget` names which board changed.
  boardRefreshSignal: 0,
  boardRefreshTarget: null,

  /**
   * Fetch all groups for a board, then fetch all tasks for the board and
   * bucket them by group id. A single /api/tasks?board=:id call avoids the
   * N+1 per-group roundtrip.
   */
  fetchBoardData: async (boardId) => {
    if (!boardId) return;
    set({ loading: true, error: null });
    try {
      const [groups, tasks, noteCounts] = await Promise.all([
        taskService.getGroups(boardId),
        taskService.getTasks(boardId),
        // Cheap per-group note counts for the header badges. Non-essential —
        // don't let a counts hiccup break the whole board load.
        noteService.getNoteCounts(boardId).catch(() => ({})),
      ]);

      const tasksByGroup = {};
      for (const g of groups) tasksByGroup[g._id] = [];
      for (const t of tasks) {
        const gid = t.group;
        if (!gid) continue;
        if (!tasksByGroup[gid]) tasksByGroup[gid] = [];
        tasksByGroup[gid].push(t);
      }

      set({ groups, tasksByGroup, notesCountByGroup: noteCounts, loading: false });
    } catch (err) {
      set({ loading: false, error: err });
      throw err;
    }
  },

  /**
   * Quietly refetch just the board's tasks and re-bucket by group WITHOUT
   * toggling `loading` (so a realtime/background refresh doesn't blank the
   * board). Groups are left as-is — used after an out-of-band change such as an
   * automation reordering a group.
   */
  refreshBoardTasks: async (boardId) => {
    if (!boardId) return;
    try {
      const tasks = await taskService.getTasks(boardId);
      set((s) => {
        const tasksByGroup = {};
        for (const g of s.groups) tasksByGroup[g._id] = [];
        for (const t of tasks) {
          const gid = t.group;
          if (!gid) continue;
          if (!tasksByGroup[gid]) tasksByGroup[gid] = [];
          tasksByGroup[gid].push(t);
        }
        return { tasksByGroup };
      });
    } catch {
      // Background refresh — stay silent; the next full load reconciles.
    }
  },

  /**
   * Record a realtime board.changed ping (from the notification SSE). The board
   * view watches `boardRefreshSignal` and refetches when the target matches.
   */
  signalBoardRefresh: (boardId) =>
    set((s) => ({
      boardRefreshSignal: s.boardRefreshSignal + 1,
      boardRefreshTarget: boardId,
    })),

  /**
   * Replace the tasks for a single group (used after inline edits/refetches).
   */
  setGroupTasks: (groupId, tasks) =>
    set((s) => ({
      tasksByGroup: { ...s.tasksByGroup, [groupId]: tasks },
    })),

  /**
   * Append a task to its group bucket.
   */
  addTask: (task) =>
    set((s) => {
      const gid = task.group;
      if (!gid) return s;
      const existing = s.tasksByGroup[gid] || [];
      return {
        tasksByGroup: { ...s.tasksByGroup, [gid]: [...existing, task] },
      };
    }),

  /**
   * Replace a task in place. Subitems (tasks with a `parent`) land in the
   * `subitemsByParent` cache; top-level tasks land in their group bucket.
   *
   * Single-task server responses (e.g. PUT /api/tasks/:id) don't carry the
   * client-side annotations `updatesCount`/`hasSubitems` (those are added only
   * on the list endpoints), so we preserve the previous values when the
   * incoming task omits them — otherwise an inline edit would wipe the row's
   * updates badge and subitem chevron.
   */
  updateTask: (task) =>
    set((s) => {
      const replace = (t) => (t._id === task._id ? mergeServerTask(t, task) : t);
      const parentId = task?.parent ? task.parent.toString() : null;
      if (parentId) {
        const list = s.subitemsByParent[parentId] || [];
        return {
          subitemsByParent: {
            ...s.subitemsByParent,
            [parentId]: list.map(replace),
          },
        };
      }
      const gid = task.group;
      if (!gid) return s;
      const existing = s.tasksByGroup[gid] || [];
      return {
        tasksByGroup: {
          ...s.tasksByGroup,
          [gid]: existing.map(replace),
        },
      };
    }),

  /**
   * Set the updates count for a single task (top-level or subitem). Used by
   * the task detail panel to keep the row badge live as updates are posted.
   */
  setUpdatesCount: (taskId, count) =>
    set((s) => {
      let changed = false;
      const bump = (t) => {
        if (t._id === taskId && t.updatesCount !== count) {
          changed = true;
          return { ...t, updatesCount: count };
        }
        return t;
      };
      const nextGroups = {};
      for (const [gid, list] of Object.entries(s.tasksByGroup)) {
        nextGroups[gid] = (list || []).map(bump);
      }
      const nextSubitems = {};
      for (const [pid, list] of Object.entries(s.subitemsByParent)) {
        nextSubitems[pid] = (list || []).map(bump);
      }
      if (!changed) return s;
      return { tasksByGroup: nextGroups, subitemsByParent: nextSubitems };
    }),

  /**
   * Remove a task by id from any group bucket it currently lives in. Also
   * sweeps `subitemsByParent` so that:
   *   - if `id` is a subitem itself, it disappears from its parent's bucket
   *   - if `id` is a top-level task, its cached subitem list is dropped
   *     (since the server cascades the actual rows)
   *
   * If removing the subitem leaves its parent with zero remaining children,
   * the parent's `hasSubitems` flag is flipped to false so the board view
   * collapses the expand chevron.
   */
  deleteTask: (id) =>
    set((s) => {
      const nextGroups = { ...s.tasksByGroup };
      for (const [gid, list] of Object.entries(s.tasksByGroup)) {
        nextGroups[gid] = list.filter((t) => t._id !== id);
      }
      const nextSubitems = {};
      const parentsThatLostLastChild = new Set();
      for (const [pid, list] of Object.entries(s.subitemsByParent)) {
        if (pid === id) continue; // drop the deleted task's own child cache
        const filtered = (list || []).filter((t) => t._id !== id);
        if (filtered.length === 0 && (list || []).length > 0) {
          parentsThatLostLastChild.add(pid);
        }
        nextSubitems[pid] = filtered;
      }
      if (parentsThatLostLastChild.size > 0) {
        for (const [gid, list] of Object.entries(nextGroups)) {
          nextGroups[gid] = list.map((t) =>
            parentsThatLostLastChild.has(t._id) && t.hasSubitems
              ? { ...t, hasSubitems: false }
              : t
          );
        }
      }
      return { tasksByGroup: nextGroups, subitemsByParent: nextSubitems };
    }),

  addGroup: (group) =>
    set((s) => ({
      groups: [...s.groups, group],
      tasksByGroup: { ...s.tasksByGroup, [group._id]: [] },
    })),

  updateGroupLocal: (group) =>
    set((s) => ({
      groups: s.groups.map((g) => (g._id === group._id ? group : g)),
    })),

  removeGroup: (groupId) =>
    set((s) => {
      const nextGroups = s.groups.filter((g) => g._id !== groupId);
      const { [groupId]: _removed, ...rest } = s.tasksByGroup;
      const { [groupId]: _notes, ...restNotes } = s.notesByGroup;
      const { [groupId]: _count, ...restCounts } = s.notesCountByGroup;
      return {
        groups: nextGroups,
        tasksByGroup: rest,
        notesByGroup: restNotes,
        notesCountByGroup: restCounts,
      };
    }),

  clear: () =>
    set({
      groups: [],
      tasksByGroup: {},
      subitemsByParent: {},
      notesByGroup: {},
      notesCountByGroup: {},
      error: null,
    }),

  // ---- Group notes ---------------------------------------------------------
  // Notes are loaded lazily when a group's notes panel opens; only per-group
  // counts are loaded eagerly (fetchBoardData) for the header badges.

  fetchNotes: async (groupId) => {
    const notes = await noteService.getNotes(groupId);
    set((s) => ({
      notesByGroup: { ...s.notesByGroup, [groupId]: notes },
      notesCountByGroup: { ...s.notesCountByGroup, [groupId]: notes.length },
    }));
    return notes;
  },

  addNoteLocal: (groupId, note) =>
    set((s) => {
      const existing = s.notesByGroup[groupId] || [];
      return {
        notesByGroup: { ...s.notesByGroup, [groupId]: [note, ...existing] },
        notesCountByGroup: {
          ...s.notesCountByGroup,
          [groupId]: (s.notesCountByGroup[groupId] || 0) + 1,
        },
      };
    }),

  updateNoteLocal: (groupId, note) =>
    set((s) => {
      const existing = s.notesByGroup[groupId] || [];
      return {
        notesByGroup: {
          ...s.notesByGroup,
          [groupId]: existing.map((n) => (n._id === note._id ? note : n)),
        },
      };
    }),

  removeNote: (groupId, noteId) =>
    set((s) => {
      const existing = s.notesByGroup[groupId] || [];
      return {
        notesByGroup: {
          ...s.notesByGroup,
          [groupId]: existing.filter((n) => n._id !== noteId),
        },
        notesCountByGroup: {
          ...s.notesCountByGroup,
          [groupId]: Math.max(0, (s.notesCountByGroup[groupId] || 0) - 1),
        },
      };
    }),

  setNoteCounts: (counts) => set({ notesCountByGroup: counts || {} }),

  /**
   * Add a checklist item. Optimistically refreshes the task by re-saving the
   * server response into the matching group bucket.
   */
  addChecklistItem: async (taskId, text) => {
    const updated = await taskService.addChecklistItem(taskId, text);
    get().updateTask(updated);
    return updated;
  },

  /**
   * Toggle an item's done state and/or rename it.
   */
  updateChecklistItem: async (taskId, itemId, patch) => {
    const updated = await taskService.updateChecklistItem(taskId, itemId, patch);
    get().updateTask(updated);
    return updated;
  },

  /**
   * Toggle convenience helper used by the row badge + editor checkbox.
   */
  toggleChecklistItem: async (taskId, itemId, done) =>
    get().updateChecklistItem(taskId, itemId, { done }),

  /**
   * Rename convenience helper, debounced from the editor input.
   */
  renameChecklistItem: async (taskId, itemId, text) =>
    get().updateChecklistItem(taskId, itemId, { text }),

  deleteChecklistItem: async (taskId, itemId) => {
    const updated = await taskService.deleteChecklistItem(taskId, itemId);
    get().updateTask(updated);
    return updated;
  },

  reorderChecklist: async (taskId, orderedIds) => {
    const updated = await taskService.reorderChecklist(taskId, orderedIds);
    get().updateTask(updated);
    return updated;
  },

  /**
   * Optimistically rename a group. Reverts on API failure — the server rejects
   * a name that collides with another group on the board (409), so the header
   * must be able to snap back to the old name.
   *
   * The optimistic step patch-merges (`{...g, name}`) rather than going through
   * `updateGroupLocal`, which replaces the group wholesale — we only have the
   * new name here, not a full doc. The server's doc reconciles it on success.
   */
  renameGroup: async (groupId, name) => {
    const prev = get().groups;
    set({
      groups: prev.map((g) => (g._id === groupId ? { ...g, name } : g)),
    });
    try {
      const group = await taskService.updateGroup(groupId, { name });
      if (group) get().updateGroupLocal(group);
      return group;
    } catch (err) {
      set({ groups: prev });
      throw err;
    }
  },

  /**
   * Optimistically set a group's tags (extra feature). Same shape as
   * `renameGroup`: patch-merge, then reconcile with the server's doc.
   *
   * `tags` is the FULL desired list, not a delta — the server replaces the array
   * and drops any id missing from the board's catalog, so a tag someone else
   * deleted mid-edit silently falls away instead of failing the whole save.
   */
  setGroupTags: async (groupId, tags) => {
    const prev = get().groups;
    set({
      groups: prev.map((g) => (g._id === groupId ? { ...g, tags } : g)),
    });
    try {
      const group = await taskService.updateGroup(groupId, { tags });
      if (group) get().updateGroupLocal(group);
      return group;
    } catch (err) {
      set({ groups: prev });
      throw err;
    }
  },

  /**
   * Drop a deleted group tag from every cached group. The server already
   * $pulled it board-wide; this keeps the local copies from carrying an id that
   * no longer resolves, which would otherwise linger until the next board fetch.
   */
  detachGroupTag: (tagId) =>
    set((s) => {
      const target = tagId?.toString();
      return {
        groups: s.groups.map((g) =>
          (g.tags || []).some((t) => t?.toString() === target)
            ? { ...g, tags: g.tags.filter((t) => t?.toString() !== target) }
            : g
        ),
      };
    }),

  /**
   * Optimistically reorder groups on the board. Reverts on API failure.
   */
  reorderGroups: async (boardId, orderedIds) => {
    const prev = get().groups;
    const byId = new Map(prev.map((g) => [g._id, g]));
    const next = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    for (const g of prev) {
      if (!orderedIds.includes(g._id)) next.push(g);
    }
    set({ groups: next });
    try {
      const groups = await taskService.reorderGroups(boardId, orderedIds);
      set({ groups });
      return groups;
    } catch (err) {
      set({ groups: prev });
      throw err;
    }
  },

  /**
   * Optimistically reorder tasks within a single target group. `orderedIds`
   * is the full desired order of `targetGroupId` after the drop. If a task
   * came from a different group, this also removes it from its previous
   * bucket. Reverts on API failure.
   */
  reorderTasks: async (targetGroupId, orderedIds) => {
    const prev = get().tasksByGroup;
    // Build a lookup of every top-level task we currently know about so we
    // can re-bucket cross-group moves.
    const allById = new Map();
    for (const list of Object.values(prev)) {
      for (const t of list || []) allById.set(t._id, t);
    }
    const movedIds = new Set(orderedIds);
    const nextBuckets = {};
    for (const [gid, list] of Object.entries(prev)) {
      if (gid === targetGroupId) continue;
      nextBuckets[gid] = (list || []).filter((t) => !movedIds.has(t._id));
    }
    nextBuckets[targetGroupId] = orderedIds
      .map((id) => {
        const existing = allById.get(id);
        return existing ? { ...existing, group: targetGroupId } : null;
      })
      .filter(Boolean);
    set({ tasksByGroup: nextBuckets });
    try {
      const data = await taskService.reorderTasks(targetGroupId, orderedIds);
      const serverTasks = Array.isArray(data?.tasks) ? data.tasks : null;
      if (serverTasks) {
        set((s) => ({
          tasksByGroup: { ...s.tasksByGroup, [targetGroupId]: serverTasks },
        }));
      }
      return data;
    } catch (err) {
      set({ tasksByGroup: prev });
      throw err;
    }
  },

  // ---- Subitems ---------------------------------------------------------

  /**
   * Fetch subitems for a parent task and cache them under
   * `subitemsByParent[parentId]`. Called when CommentPanel opens.
   */
  fetchSubitems: async (parentId) => {
    if (!parentId) return [];
    const list = await taskService.getSubitems(parentId);
    set((s) => ({
      subitemsByParent: { ...s.subitemsByParent, [parentId]: list || [] },
    }));
    return list || [];
  },

  /**
   * Create a subitem under `parentId`. Payload omits board/group — both are
   * inherited from the parent. The server validates and applies them.
   */
  addSubitem: async (parentId, data) => {
    if (!parentId) throw new Error('parentId is required');
    // Find the parent task in any group bucket so we can inherit board/group.
    let parent = null;
    for (const list of Object.values(get().tasksByGroup)) {
      const match = (list || []).find((t) => t._id === parentId);
      if (match) {
        parent = match;
        break;
      }
    }
    // Fallback: search subitem caches (so nested-open works even though we
    // don't currently support multi-level nesting on the server).
    if (!parent) {
      for (const list of Object.values(get().subitemsByParent)) {
        const match = (list || []).find((t) => t._id === parentId);
        if (match) {
          parent = match;
          break;
        }
      }
    }
    const payload = {
      ...data,
      parent: parentId,
      board: data?.board || parent?.board,
      group: data?.group || parent?.group,
    };
    const created = await taskService.createTask(payload);
    set((s) => {
      // Flip the parent's `hasSubitems` to true if it isn't already so the
      // board view's expand chevron shows immediately.
      const nextTasksByGroup = { ...s.tasksByGroup };
      for (const [gid, list] of Object.entries(s.tasksByGroup)) {
        if (!Array.isArray(list)) continue;
        let changed = false;
        const nextList = list.map((t) => {
          if (t._id === parentId && !t.hasSubitems) {
            changed = true;
            return { ...t, hasSubitems: true };
          }
          return t;
        });
        if (changed) nextTasksByGroup[gid] = nextList;
      }
      return {
        tasksByGroup: nextTasksByGroup,
        subitemsByParent: {
          ...s.subitemsByParent,
          [parentId]: [...(s.subitemsByParent[parentId] || []), created],
        },
      };
    });
    return created;
  },

  /**
   * Replace a subitem in its parent bucket (used after PUT /api/tasks/:id).
   * Falls back to walking every bucket so callers don't have to know which
   * parent the subitem belongs to.
   */
  updateSubitem: (task) =>
    set((s) => {
      const parentId = task?.parent ? task.parent.toString() : null;
      if (!parentId) return s;
      const list = s.subitemsByParent[parentId] || [];
      return {
        subitemsByParent: {
          ...s.subitemsByParent,
          [parentId]: list.map((t) =>
            t._id === task._id ? mergeServerTask(t, task) : t
          ),
        },
      };
    }),

  /**
   * Remove a subitem from every parent bucket it may live in.
   */
  deleteSubitem: (subitemId) =>
    set((s) => {
      const next = {};
      for (const [pid, list] of Object.entries(s.subitemsByParent)) {
        next[pid] = (list || []).filter((t) => t._id !== subitemId);
      }
      return { subitemsByParent: next };
    }),

  // Helpers
  getTasksForGroup: (groupId) => get().tasksByGroup[groupId] || [],
  getSubitemsForTask: (parentId) => get().subitemsByParent[parentId] || [],
}));

export default useTaskStore;

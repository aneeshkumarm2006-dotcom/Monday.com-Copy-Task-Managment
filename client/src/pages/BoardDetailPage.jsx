import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ChevronRight,
  Lock,
  Globe,
  Plus,
  Settings as SettingsIcon,
  Zap,
  GripVertical,
  SearchX,
  UserPlus,
  ArrowDownUp,
  Download,
  CalendarCheck,
  LayoutList,
  Target,
  CalendarRange,
  Users,
} from 'lucide-react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import PageWrapper from '../components/layout/PageWrapper';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonTaskGroup } from '../components/ui/Skeleton';
import TaskGroupHeader from '../components/board/TaskGroupHeader';
import TaskTable from '../components/board/TaskTable';
import { InlineAssigneeMenu } from '../components/board/AssigneePicker';
import DataGrid from '../components/board/DataGrid';
import SortableItem from '../components/dnd/SortableItem';
import StatusMenu from '../components/board/StatusMenu';
import PriorityMenu from '../components/board/PriorityMenu';
import TaskActionsMenu from '../components/board/TaskActionsMenu';
import CommentPanel from '../components/board/CommentPanel';
import GroupNotesPanel from '../components/board/GroupNotesPanel';
import ClientPortalModal from '../components/board/ClientPortalModal';
import ClientSignInMethodField from '../components/board/ClientSignInMethodField';
import AutomationsModal from '../components/board/AutomationsModal';
import ExportActivityModal from '../components/board/ExportActivityModal';
import LabelPicker from '../components/board/LabelPicker';
import EditChipsModal from '../components/board/EditChipsModal';
import BulkActionBar from '../components/board/BulkActionBar';
import BoardFilterBar from '../components/board/BoardFilterBar';
import BoardAccessModal from '../components/board/BoardAccessModal';
import DeliveryTab from '../components/board/delivery/DeliveryTab';
import BoardTypePill from '../components/board/BoardTypePill';
import ConvertToTrackerModal from '../components/board/ConvertToTrackerModal';
import BoardTimezoneModal from '../components/board/BoardTimezoneModal';
import GoalsTab from '../components/board/goals/GoalsTab';
import ScoreboardTab from '../components/board/scoreboard/ScoreboardTab';
import MonthSelector from '../components/board/MonthSelector';
import MoveToMonthModal from '../components/board/MoveToMonthModal';
import useBoardMonths from '../hooks/useBoardMonths';
import { moveTasksToMonth } from '../services/monthService';
import { findMonth, formatMonthKey } from '../utils/monthKeys';
import TrackersModal from '../components/board/delivery/TrackersModal';
import useAuthStore from '../store/authStore';
import useOrgStore from '../store/orgStore';
import useBoardStore from '../store/boardStore';
import useTaskStore from '../store/taskStore';
import useNotificationStore from '../store/notificationStore';
import useToastStore from '../store/toastStore';
import usePermissions, { useBoardPermissions } from '../hooks/usePermissions';
import * as taskService from '../services/taskService';
import { formatDate, dateInputToISO } from '../utils/dateUtils';
import {
  EMPTY_FILTERS,
  hasActiveFilters,
  taskMatchesFilters,
} from '../utils/taskFilters';
import { isStatusDone } from '../utils/statusUtils';
import {
  loadPersonalPins,
  savePersonalPins,
  isTaskPinned,
  sortPinnedFirst,
} from '../utils/taskPins';

/**
 * Group color cycle — reuses the stat-card palette so groups are visually
 * distinct within a board.
 */
const GROUP_DOT_CYCLE = [
  'var(--color-card-blue)',
  'var(--color-card-green)',
  'var(--color-card-orange)',
  'var(--color-card-purple)',
];

/**
 * localStorage key prefix for the per-board "completed groups last" view sort.
 * The full board id is appended so each board remembers its own choice.
 */
const GROUP_SORT_KEY = 'board:groupSortCompletedLast:';

/**
 * Board views. `board` is the default and renders exactly what this page always
 * rendered; `delivery` swaps the filter bar and group list for the tracker grid,
 * and `goals` for the monthly goals tables.
 *
 * The tab bar only appears when there is more than one view to choose from, so
 * a standard or client board — where Delivery and Goals both belong to the
 * tracker board type and are therefore hidden — sees the page exactly as it was
 * before any of this existed.
 *
 * Each tab carries its own `visible` predicate rather than the bar keying off
 * one of them: with two optional tabs, gating the whole bar on Delivery alone
 * would strand Goals for anyone who had Delivery hidden.
 */
const VIEW_TABS = [
  { value: 'board', label: 'Board', icon: LayoutList, visible: () => true },
  {
    value: 'delivery',
    label: 'Delivery',
    icon: CalendarCheck,
    visible: (g) => g.canViewDelivery,
  },
  { value: 'goals', label: 'Goals', icon: Target, visible: (g) => g.canViewGoals },
  // People spans BOTH goals and delivery — who owns which group, and how their
  // groups scored — so it belongs inside neither of the two tabs above.
  { value: 'people', label: 'People', icon: Users, visible: (g) => g.canViewScoreboard },
];

const BoardDetailPage = () => {
  const { id: boardId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // Org-wide capabilities. Board-scoped ones come off `board.permissions` below —
  // they are two different questions, and conflating them was the old model's bug.
  const { can: canOrg } = usePermissions();
  const currentUser = useAuthStore((s) => s.user);

  const currentOrg = useOrgStore((s) => s.currentOrg);
  const members = useOrgStore((s) => s.members);
  const fetchMembers = useOrgStore((s) => s.fetchMembers);
  const boards = useBoardStore((s) => s.boards);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);
  const getBoardById = useBoardStore((s) => s.getBoardById);

  const groups = useTaskStore((s) => s.groups);
  const tasksByGroup = useTaskStore((s) => s.tasksByGroup);
  const notesCountByGroup = useTaskStore((s) => s.notesCountByGroup);
  const loading = useTaskStore((s) => s.loading);
  const fetchBoardData = useTaskStore((s) => s.fetchBoardData);
  const clearTasks = useTaskStore((s) => s.clear);
  const addTaskLocal = useTaskStore((s) => s.addTask);
  const setGroupTasksLocal = useTaskStore((s) => s.setGroupTasks);
  const updateTaskLocal = useTaskStore((s) => s.updateTask);
  const setUpdatesCount = useTaskStore((s) => s.setUpdatesCount);
  const deleteTaskLocal = useTaskStore((s) => s.deleteTask);
  const addGroupLocal = useTaskStore((s) => s.addGroup);
  const removeGroupLocal = useTaskStore((s) => s.removeGroup);
  const renameGroupAction = useTaskStore((s) => s.renameGroup);
  const setGroupTagsAction = useTaskStore((s) => s.setGroupTags);
  const setGroupOwnerAction = useTaskStore((s) => s.setGroupOwner);
  const reorderGroupsAction = useTaskStore((s) => s.reorderGroups);
  const reorderTasksAction = useTaskStore((s) => s.reorderTasks);
  const boardRefreshSignal = useTaskStore((s) => s.boardRefreshSignal);
  const boardRefreshTarget = useTaskStore((s) => s.boardRefreshTarget);
  const refreshBoardTasks = useTaskStore((s) => s.refreshBoardTasks);
  const refreshBoardGroups = useTaskStore((s) => s.refreshBoardGroups);
  const refreshNotifications = useNotificationStore((s) => s.fetchNotifications);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);
  const toastInfo = useToastStore((s) => s.info);

  // Collapse state, keyed by group id
  const [collapsed, setCollapsed] = useState(() => new Set());
  // Track whether we've applied the initial collapse for the current board so
  // we don't re-collapse groups the user has manually opened.
  const initialCollapseApplied = useRef(false);

  // Reset the guard whenever the board changes
  useEffect(() => {
    initialCollapseApplied.current = false;
  }, [boardId]);

  // Load the remembered "completed groups last" choice for this board.
  useEffect(() => {
    if (!boardId) return;
    try {
      setSortCompletedLast(localStorage.getItem(GROUP_SORT_KEY + boardId) === '1');
    } catch {
      setSortCompletedLast(false);
    }
  }, [boardId]);

  // Load this board's personal ("pin for me only") task pins.
  useEffect(() => {
    setPersonalPins(loadPersonalPins(boardId));
  }, [boardId]);

  // Flip the group sort and persist the new value for this board.
  const toggleGroupSort = () =>
    setSortCompletedLast((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(GROUP_SORT_KEY + boardId, next ? '1' : '0');
      } catch {
        /* ignore storage failures (private mode, quota) */
      }
      return next;
    });

  // Collapse all groups on first load — gives the clean "categories only" view
  useEffect(() => {
    if (groups.length === 0 || initialCollapseApplied.current) return;
    initialCollapseApplied.current = true;
    setCollapsed(new Set(groups.map((g) => g._id)));
  }, [groups]);

  // Which group (if any) is currently creating a new task inline
  const [creatingInGroup, setCreatingInGroup] = useState(null);
  // Key counter per group — increment after each save to reset the inline creation row
  const [newTaskKeysByGroup, setNewTaskKeysByGroup] = useState({});
  // Task currently being edited inline
  const [editingTaskId, setEditingTaskId] = useState(null);
  // Status chip menu state
  const [statusMenu, setStatusMenu] = useState(null); // { task, anchor }
  // Priority chip menu state
  const [priorityMenu, setPriorityMenu] = useState(null); // { task, anchor }
  // Owner picker popover state
  const [ownerMenu, setOwnerMenu] = useState(null); // { task, anchor }
  // Labels picker popover state
  const [labelMenu, setLabelMenu] = useState(null); // { task, anchor }
  // Group tags picker popover state (extra feature)
  const [groupTagMenu, setGroupTagMenu] = useState(null); // { groupId, anchor }
  // Group owner picker popover state (tracker boards). Distinct from
  // `ownerMenu` above, which is a TASK's assignees.
  const [groupOwnerMenu, setGroupOwnerMenu] = useState(null); // { groupId, anchor }
  // Edit-chips modal — `kind` is 'labels' | 'statuses' | 'groupTags'
  const [editChipsModal, setEditChipsModal] = useState(null);
  // Row actions menu state
  const [actionsMenu, setActionsMenu] = useState(null); // { task, anchor }
  // Delete confirmation
  const [taskPendingDelete, setTaskPendingDelete] = useState(null);
  // Comment panel — stack of task IDs the user has drilled into. Bottom of
  // the stack is the original task they clicked from the board; subitems
  // pushed via "Open subitem" land on top. The visible task is always the
  // last entry. The whole stack clears when the panel closes.
  const [selectedTaskStack, setSelectedTaskStack] = useState([]);
  // Group whose notes panel is open (group id), or null.
  const [notesGroupId, setNotesGroupId] = useState(null);
  const subitemsByParent = useTaskStore((s) => s.subitemsByParent);
  // New-group modal state
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  // Client-board only: the invited client's email, collected in the same step so
  // the link is minted and emailed the moment the group exists.
  const [newGroupClientEmail, setNewGroupClientEmail] = useState('');
  // How the invited client signs in: 'google' or 'password'. Only sent when an
  // email was entered.
  const [newGroupClientAuth, setNewGroupClientAuth] = useState('google');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupModalError, setGroupModalError] = useState(null);
  // Delete-group confirmation state
  const [groupPendingDelete, setGroupPendingDelete] = useState(null);
  const [deletingGroup, setDeletingGroup] = useState(false);
  // Automations modal
  const [automationsOpen, setAutomationsOpen] = useState(false);
  // Board access ("Share") modal — creator-only
  const [accessModalOpen, setAccessModalOpen] = useState(false);
  // Activity export modal — opt-in feature, see canExportActivity below
  const [exportOpen, setExportOpen] = useState(false);
  const [trackersOpen, setTrackersOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [timezoneOpen, setTimezoneOpen] = useState(false);

  // --- Filtering ---------------------------------------------------------
  // Filter bar at the top of the board narrows the visible tasks by name,
  // status, priority, label, due date, and assignee. See utils/taskFilters.js.
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  // --- Group sort ("completed last") -------------------------------------
  // View-only toggle that pushes fully-done (green) groups to the bottom and
  // floats groups with remaining work to the top. Never touches the persisted
  // TaskGroup.order — it's applied only to the render order. Remembered per
  // board in localStorage.
  const [sortCompletedLast, setSortCompletedLast] = useState(false);

  // --- Task pins ---------------------------------------------------------
  // "Pin for me only" — task ids this user floated to the top of their group,
  // private to this browser. The team-wide counterpart is `task.pinned` on the
  // server; a task floats if either is set. Neither ever writes `Task.order`,
  // so unpinning drops the row back into its real slot. See utils/taskPins.js.
  const [personalPins, setPersonalPins] = useState(() => new Set());

  // --- Bulk selection ----------------------------------------------------
  // Aggregated across every group on the board so the floating BulkActionBar
  // can act on tasks from multiple groups at once.
  const [selectedTaskIds, setSelectedTaskIds] = useState(() => new Set());
  // Confirmation modal for bulk delete
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Disables the bar while an in-flight bulk mutation is resolving
  const [bulkBusy, setBulkBusy] = useState(false);

  // --- Notification highlight (scroll-to + glow) --------------------------
  const [highlightedTaskId, setHighlightedTaskId] = useState(null);
  // When the highlighted item is a subtask, its parent's id — used to auto-expand
  // the parent row so the subtask row actually renders and can be scrolled to.
  const [highlightedParentId, setHighlightedParentId] = useState(null);
  // Tab the task detail panel should open on when arriving from a notification
  // that carries a tab hint (e.g. reply → 'updates'). null → the panel uses
  // its default tab.
  const [initialPanelTab, setInitialPanelTab] = useState(null);

  const board = getBoardById(boardId) || null;
  const orgId = currentOrg?._id || null;

  // --- Effective board permissions ---------------------------------------
  // The board's permissions come RESOLVED from the server — the two-layer AND
  // (org role && board access) already applied for this user, on this board.
  //
  // This page used to re-implement that resolution: read `memberAccess`, find my
  // grant, check its level, OR in a locally-derived isAdmin. It was a second
  // implementation of the server's rules, free to drift from them, and it could
  // not express the middle rungs at all. Now the server answers once and this
  // reads the answer.
  //
  // Hiding a control is a courtesy, never a control: every capability below is
  // enforced independently on the write path.
  const {
    can: canOnBoard,
    isBoardOwner: isBoardCreator,
    canViewAccess,
    canManageAccess,
  } = useBoardPermissions(board?.permissions);

  // "May I restructure this board" — the old `canEdit` bit, now derived from the
  // capabilities rather than re-guessed.
  const canEdit = canOnBoard('task.edit_any') && canOnBoard('group.manage');

  // Client Portal: may this person put a task in front of the client? Board type
  // and capability, matching the server's `denyPortalShare` exactly — a standard
  // board has no portal to share into, and publishing to an outside party is the
  // `edit` rung's call rather than every contributor's.
  const canSharePortal =
    board?.boardType === 'client' && canOnBoard('task.edit_any');

  // Activity export is TWO conditions, not one. `board.export_activity` says the
  // role permits it; `features.activityExport` says this person switched it on
  // in Settings → Extra features, which is off for everyone until they do. Both
  // are re-checked by the endpoint — this only decides whether to draw a button.
  const canExportActivity =
    canOnBoard('board.export_activity') && !!currentUser?.features?.activityExport;

  // Group tags follow the same two-condition shape. Note this one also hides the
  // CHIPS, not just the button: with the feature off you see the header exactly
  // as it was before group tags existed, even if a teammate has tagged the group.
  const groupTagsOn = !!currentUser?.features?.groupTags;
  const canTagGroups = groupTagsOn && canEdit && canOnBoard('column.manage');

  // The month-partitioned board type. Mutually exclusive with 'client' and
  // 'standard'; the server enforces that, this only decides what to draw.
  const isTrackerBoard = board?.boardType === 'tracker';

  // Delivery is no longer a per-user opt-in feature — it is a surface OF the
  // tracker board type, so it appears for anyone who can read one. The
  // `features.trackers` switch it used to need has been removed entirely.
  const canViewDelivery = isTrackerBoard && canOnBoard('tracker.view');
  const canManageTrackers = canViewDelivery && canOnBoard('tracker.manage');

  // Goals: the same board-type-plus-capability shape. Editing the shared column
  // SCHEMA is an org-admin act rather than a board one, which is why that last
  // one reads `canOrg` — the goal columns are the organisation's reporting
  // vocabulary, not one board owner's preference.
  // Who owns a group. Part of the tracker board type, NOT an opt-in extra
  // feature: group tags can hide from people who never asked for them because a
  // tag is decoration, but hiding who is RESPONSIBLE from the rest of the team
  // would defeat the point. So capability only — the same reasoning that took
  // Delivery out of the extra-features table.
  const canOwnGroups = isTrackerBoard && canOnBoard('group.manage');

  const canViewGoals = isTrackerBoard && canOnBoard('goal.view');
  const canTrackGoals = canViewGoals && canOnBoard('goal.track');
  const canManageGoals = canViewGoals && canOnBoard('goal.manage');
  const canManageGoalColumns = canViewGoals && canOrg('org.manage_settings');

  // The People tab opens for anyone who can read the goals. WHAT it shows then
  // narrows server-side rather than here: without `productivity.view_others` the
  // endpoint returns only your own row, and without `tracker.view` the delivery
  // half is absent. Gating the tab itself on those would hide a page people are
  // allowed to see a version of.
  const canViewScoreboard = canViewGoals;

  // Converting a board changes what it IS, so it answers to the same capability
  // as flipping public/private rather than to an ordinary edit right. Client
  // boards are refused by the server and get no button here.
  const canConvertToTracker =
    board?.boardType === 'standard' && canOnBoard('board.change_visibility');

  // The board-level month. URL is the source of truth; see the hook.
  const {
    monthKey, setMonth, months, selectedMonth, monthsLoading, refreshMonths,
    timezone: monthTimezone,
  } = useBoardMonths(boardId, { enabled: isTrackerBoard });

  // Which tabs exist on this board, resolved once so the bar and the view
  // validation below cannot disagree about it.
  const visibleTabs = useMemo(
    () => VIEW_TABS.filter((t) => t.visible({ canViewDelivery, canViewGoals, canViewScoreboard })),
    [canViewDelivery, canViewGoals, canViewScoreboard]
  );

  // Derived from the URL rather than mirrored into state — two sources of truth
  // for "which view am I on" is the classic bug here, and `?view=delivery` is
  // also the thing worth pasting to a colleague.
  //
  // Validated against `visibleTabs` rather than hardcoding one tab's name, so
  // an unknown value, or `?view=goals` on a standard board, or a board that has
  // not loaded yet, all fall back to the board view instead of rendering a tab
  // that is not there.
  const rawView = searchParams.get('view');
  const view = visibleTabs.some((t) => t.value === rawView) ? rawView : 'board';
  const setView = useCallback(
    (next) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'board') params.delete('view');
      else params.set('view', next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  // The board's tag catalog, keyed by id, for resolving each group's `tags`.
  // Empty unless the feature is on, which is what makes the chips disappear.
  const groupTagsById = useMemo(() => {
    if (!groupTagsOn) return new Map();
    const list = Array.isArray(board?.groupTags) ? board.groupTags : [];
    return new Map(list.map((t) => [t._id.toString(), t]));
  }, [groupTagsOn, board?.groupTags]);

  // Resolve a group's tag ids into chips, dropping any that no longer exist in
  // the catalog — a tag someone else deleted leaves a dangling id until the next
  // fetch, and a missing chip beats a broken one.
  const resolveGroupTags = useCallback(
    (group) =>
      (group?.tags || [])
        .map((id) => groupTagsById.get(id?.toString()))
        .filter(Boolean),
    [groupTagsById]
  );

  // Client Portal boards expose a per-group shareable client link, managed only
  // by board managers. `clientPortalGroup` holds the group whose link modal is open.
  const isClientBoard = board?.boardType === 'client';
  const [clientPortalGroup, setClientPortalGroup] = useState(null);

  // If we navigated directly and the boards list is empty, fetch it so the
  // header can resolve the board metadata.
  useEffect(() => {
    if (!board && orgId && boards.length === 0) {
      fetchBoards(orgId).catch((err) =>
        console.error('Failed to fetch boards:', err)
      );
    }
  }, [board, orgId, boards.length, fetchBoards]);

  // Fetch groups + tasks for this board.
  //
  // On a tracker board this waits for the month to resolve — the task read is
  // month-scoped and the server refuses an unscoped one, so firing before the
  // month list has loaded would just 400.
  const monthReady = !isTrackerBoard || !!monthKey;

  useEffect(() => {
    if (!boardId || !monthReady) return undefined;
    fetchBoardData(boardId, { month: monthKey }).catch((err) => {
      console.error('Failed to load board data:', err);
    });
    return () => {
      clearTasks();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, monthReady]);

  // Changing MONTH is not changing board: refetch quietly rather than through
  // `fetchBoardData`, whose cleanup calls `clearTasks()` and would flash the
  // whole board back to a skeleton on every month switch. Skipped on the first
  // run, which the effect above already covers.
  const loadedMonthRef = useRef(null);
  useEffect(() => {
    if (!boardId || !isTrackerBoard || !monthKey) return;
    if (loadedMonthRef.current === null) {
      loadedMonthRef.current = monthKey;
      return;
    }
    if (loadedMonthRef.current === monthKey) return;
    loadedMonthRef.current = monthKey;
    refreshBoardTasks(boardId, { month: monthKey });
    // Groups too, not just tasks: a group's OWNER is per-month, so refetching
    // only the tasks would leave last month's avatars over this month's rows.
    refreshBoardGroups(boardId, { month: monthKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, boardId, isTrackerBoard]);

  // Reset the month tracker when the board changes, or the next board's first
  // month would look like a switch and double-fetch.
  useEffect(() => {
    loadedMonthRef.current = null;
  }, [boardId]);

  // Realtime: when an automation moves/creates tasks out-of-band, the server
  // pings this board over the notification SSE (bumping boardRefreshSignal).
  // Quietly refetch tasks so the change appears without a manual reload.
  useEffect(() => {
    if (!boardId || boardRefreshTarget !== boardId) return;
    refreshBoardTasks(boardId, { month: monthKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRefreshSignal]);

  // --- Handle highlightGroup, from the People tab's drill-down -------------
  //
  // Deliberately much simpler than highlightTask below: a group always exists in
  // every month, so there is no "not in this month" case to explain and nothing
  // to wait for beyond the groups themselves.
  useEffect(() => {
    const groupId = searchParams.get('highlightGroup');
    if (!groupId || loading || groups.length === 0) return;

    // The row it wants to scroll to is not rendered on the People/Goals/Delivery
    // views, so land on the board first; this effect re-runs once `view` changes.
    if (view !== 'board') {
      setView('board');
      return;
    }

    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(groupId);
      return next;
    });

    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('highlightGroup');
      return next;
    }, { replace: true });

    // After the expand has painted.
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-group-id="${groupId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [searchParams, loading, groups, view, setView, setSearchParams]);

  // --- Handle highlightTask query param from notification click -----------
  useEffect(() => {
    const taskId = searchParams.get('highlightTask');
    if (!taskId || loading || groups.length === 0) return;

    // A notification can land while the Delivery or Goals view is open.
    // Everything below expands a group and scrolls to a row that isn't rendered
    // in those views, so it would silently do nothing — send the user back to
    // the board first.
    if (view !== 'board') {
      setView('board');
      return;
    }


    // Optional tab hint (from a reply notification) — opens the task detail
    // panel on that tab once we confirm the task lives on this board.
    const openTab = searchParams.get('openTab');
    // For a subtask notification the target row lives under a parent, which we
    // must expand (its subtasks aren't in `tasksByGroup`). The parent id rides
    // along on the link so we can find/expand the parent group even before its
    // subitems have been fetched.
    const parentId = searchParams.get('highlightParent');
    // The top-level row we need to reveal: the parent for a subtask, else the
    // task itself.
    const groupTargetId = parentId || taskId;
    let found = false;

    // Find which group contains the (parent) task and ensure it's expanded
    for (const group of groups) {
      const groupTasks = tasksByGroup[group._id] || [];
      if (groupTasks.some((t) => t._id === groupTargetId)) {
        found = true;
        // Expand the group if collapsed
        setCollapsed((prev) => {
          const next = new Set(prev);
          next.delete(group._id);
          return next;
        });
        break;
      }
    }

    // Groups can arrive a render before their tasks. If we haven't found the
    // target AND no group has any tasks yet, the board rows simply aren't loaded
    // — bail WITHOUT clearing the link so this effect re-runs (and finds the
    // group) once tasksByGroup populates. Otherwise we'd expand nothing, land on
    // a fully-collapsed board, and lose the params on refresh.
    const anyTasksLoaded = groups.some((g) => (tasksByGroup[g._id] || []).length > 0);
    if (!found && !anyTasksLoaded) return;

    // On a MONTHLY board that "tasks loaded but not found" test stops meaning
    // "not on this board": only one month is loaded, so a July task opened while
    // August is selected is simply not here. Clearing the params and glowing a
    // row that was never rendered is a silent failure, so say what happened
    // instead. Deep links from notifications carry `?month=` and land correctly;
    // this is the fallback for an older link or a hand-typed one.
    if (!found && isTrackerBoard && monthKey) {
      toastInfo(
        `That task isn’t in ${selectedMonth?.label || 'this month'} — try another month.`
      );
    }

    // Clear the query params so refreshing doesn't re-trigger
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('highlightTask');
      next.delete('highlightParent');
      next.delete('openTab');
      return next;
    }, { replace: true });

    // Set highlight — scroll + auto-remove are handled by separate effects below.
    // The parent id (if any) drives the TaskTable auto-expand so the subtask row
    // mounts and can receive the glow + scroll.
    setHighlightedTaskId(taskId);
    setHighlightedParentId(parentId || null);

    // Open the detail panel on the requested tab (if the task is on this board)
    if (found && openTab) {
      setInitialPanelTab(openTab);
      setSelectedTaskStack([taskId]);
    }
  }, [
    searchParams, loading, groups, tasksByGroup, setSearchParams, view, setView,
    isTrackerBoard, monthKey, selectedMonth, toastInfo,
  ]);

  // --- Auto-remove highlight after animation completes -------------------
  useEffect(() => {
    if (!highlightedTaskId) return;
    const timer = setTimeout(() => {
      setHighlightedTaskId(null);
      setHighlightedParentId(null);
    }, 3000);
    return () => clearTimeout(timer);
  }, [highlightedTaskId]);

  // Fetch org members (used by the assignee picker + Share modal). Anyone who
  // can edit the board needs them; the board creator needs them to share; and on
  // a tracker board the group-owner picker needs them too — `group.manage`
  // without `task.edit_any` is a real combination, and it would otherwise open an
  // empty picker.
  //
  // Deliberately NOT widened any further than that. Everyone else — viewers
  // included — still gets each group's owner populated on the group document
  // itself, so they see the name and avatar without ever receiving the roster.
  useEffect(() => {
    if (!orgId) return;
    if (!canEdit && !isBoardCreator && !canOwnGroups) return;
    fetchMembers(orgId).catch((err) =>
      console.error('Failed to load members:', err)
    );
  }, [orgId, canEdit, isBoardCreator, canOwnGroups, fetchMembers]);

  const totalTaskCount = useMemo(
    () =>
      Object.values(tasksByGroup).reduce(
        (acc, list) => acc + (list?.length || 0),
        0
      ),
    [tasksByGroup]
  );

  // Flattened list of every top-level task — used to derive the assignee
  // option list in the filter bar.
  const allTasks = useMemo(() => {
    const out = [];
    for (const list of Object.values(tasksByGroup)) {
      if (Array.isArray(list)) out.push(...list);
    }
    return out;
  }, [tasksByGroup]);

  const filtersActive = hasActiveFilters(filters);

  // Apply the active filters per group. When nothing is active we hand back
  // the original buckets untouched so unfiltered boards skip the work.
  const filteredTasksByGroup = useMemo(() => {
    if (!filtersActive) return tasksByGroup;
    const now = new Date();
    const out = {};
    for (const [gid, list] of Object.entries(tasksByGroup)) {
      out[gid] = (list || []).filter((t) => taskMatchesFilters(t, filters, now, board));
    }
    return out;
  }, [tasksByGroup, filters, filtersActive, board]);

  // Render order within each group: pinned tasks float to the top, everything
  // else keeps its persisted `order`. Purely a display transform — Task.order
  // is never rewritten, which is exactly what lets an unpin drop the row back
  // into its real slot. Same contract as `orderedGroups` below.
  //
  // This lives here rather than in TaskTable because `groupTasks` (below) is the
  // single feed into BOTH render paths, so flexible-column boards (DataGrid) and
  // the mobile card list inherit the ordering for free.
  const displayTasksByGroup = useMemo(() => {
    const out = {};
    let changed = false;
    for (const [gid, list] of Object.entries(filteredTasksByGroup)) {
      out[gid] = sortPinnedFirst(list, personalPins);
      if (out[gid] !== list) changed = true;
    }
    // Nothing pinned anywhere: hand back the original object so boards without
    // pins skip the re-render entirely.
    return changed ? out : filteredTasksByGroup;
  }, [filteredTasksByGroup, personalPins]);

  const matchedTaskCount = useMemo(
    () =>
      Object.values(filteredTasksByGroup).reduce(
        (acc, list) => acc + (list?.length || 0),
        0
      ),
    [filteredTasksByGroup]
  );

  // Render order for the groups. When "completed last" is off we return the
  // original array untouched (server order). When on, fully-done groups (green
  // progress bar) sink to the bottom and groups with remaining work rise to the
  // top — sorted on the same filtered buckets the progress bars render from, so
  // the ordering always matches the colored bar the user sees. This is purely a
  // display transform; the persisted TaskGroup.order is never changed.
  const orderedGroups = useMemo(() => {
    if (!sortCompletedLast) return groups;
    const meta = groups.map((group, idx) => {
      const list = filteredTasksByGroup[group._id] || [];
      const total = list.length;
      const done = list.filter(
        (t) => t.status != null && isStatusDone(board, t.status)
      ).length;
      return {
        group,
        idx,
        complete: total > 0 && done === total, // green == 100% AND non-empty
        pct: total === 0 ? 0 : done / total,
      };
    });
    meta.sort((a, b) => {
      if (a.complete !== b.complete) return a.complete ? 1 : -1; // done groups last
      if (a.pct !== b.pct) return a.pct - b.pct; // least-done rises highest
      return a.idx - b.idx; // stable: preserve manual order within a tier
    });
    return meta.map((m) => m.group);
  }, [groups, sortCompletedLast, filteredTasksByGroup, board]);

  const orderedGroupIds = useMemo(
    () => orderedGroups.map((g) => g._id),
    [orderedGroups]
  );

  const toggleGroup = (groupId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  // --- Bulk selection callbacks ----------------------------------------
  // The checkboxes in every TaskTable dispatch through these so a single Set
  // tracks selections across all groups.

  const handleToggleSelectTask = useCallback((taskId, checked) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }, []);

  // Header "select all" only applies to its own group's tasks. We OR them
  // into (or remove them from) the global set.
  const handleToggleSelectGroup = useCallback((taskIds, checked) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        for (const id of taskIds) next.add(id);
      } else {
        for (const id of taskIds) next.delete(id);
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedTaskIds(new Set());
  }, []);

  // Auto-prune selection: if a task disappears from the store (deleted by
  // any path — bulk, row action, server push) we drop its id from the set
  // so the floating bar's counter stays accurate.
  useEffect(() => {
    if (selectedTaskIds.size === 0) return;
    const liveIds = new Set();
    for (const list of Object.values(tasksByGroup)) {
      if (!Array.isArray(list)) continue;
      for (const t of list) liveIds.add(t._id);
    }
    let changed = false;
    const next = new Set();
    for (const id of selectedTaskIds) {
      if (liveIds.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelectedTaskIds(next);
  }, [tasksByGroup, selectedTaskIds]);

  const handleOpenTask = (task) => {
    if (!task?._id) return;
    setSelectedTaskStack([task._id]);
  };

  const handleCloseTask = () => {
    setSelectedTaskStack([]);
    setInitialPanelTab(null);
  };

  const handleOpenSubitem = useCallback((subitem) => {
    if (!subitem?._id) return;
    setSelectedTaskStack((prev) => [...prev, subitem._id]);
  }, []);

  const handleBackInStack = useCallback(() => {
    setSelectedTaskStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const selectedTaskId =
    selectedTaskStack.length > 0
      ? selectedTaskStack[selectedTaskStack.length - 1]
      : null;

  // Resolve the selected task from the live store so the panel reflects
  // updates (status change, edit, etc.) while open. Walks `tasksByGroup`
  // (top-level board tasks) and `subitemsByParent` (children) so subitems
  // opened via the recursive stack render correctly.
  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    for (const list of Object.values(tasksByGroup)) {
      if (!Array.isArray(list)) continue;
      const match = list.find((t) => t._id === selectedTaskId);
      if (match) return match;
    }
    for (const list of Object.values(subitemsByParent)) {
      if (!Array.isArray(list)) continue;
      const match = list.find((t) => t._id === selectedTaskId);
      if (match) return match;
    }
    return null;
  }, [selectedTaskId, tasksByGroup, subitemsByParent]);

  // Auto-close the panel (or pop one level) if the selected task disappears
  // (e.g. it or its parent was deleted).
  useEffect(() => {
    if (!selectedTaskId || selectedTask) return;
    // ...but "not in the store" and "deleted" are only the same thing once the
    // store has had the chance to hold it. A deep link to a SUBITEM opens the
    // panel in the same tick that TaskTable is still fetching that parent's
    // children, so popping here would close the panel before it ever rendered.
    // `subitemsByParent[parentId]` existing — even as an empty array — is what
    // proves the fetch landed and the row is genuinely gone.
    if (highlightedParentId && !subitemsByParent[highlightedParentId]) return;
    setSelectedTaskStack((prev) => prev.slice(0, -1));
  }, [selectedTaskId, selectedTask, highlightedParentId, subitemsByParent]);

  // --- Inline creation --------------------------------------------------

  const handleStartCreate = (groupId) => {
    setEditingTaskId(null);
    setCreatingInGroup(groupId);
    // Auto-expand the group if it's collapsed
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(groupId);
      return next;
    });
  };

  const handleSaveNewTask = useCallback(
    async (groupId, payload) => {
      try {
        const created = await taskService.createTask({
          ...payload,
          board: boardId,
          group: groupId,
          // The SELECTED month, not today's — adding a task while looking at
          // July must file it in July. Null on non-tracker boards, where the
          // server ignores it.
          monthKey: monthKey || undefined,
        });
        // When a positioning automation settled the group, the server returns
        // the full ordered list — drop it in so the task renders in its final
        // spot immediately (no bottom-then-top hop). Otherwise append as usual.
        if (created.groupTasks) {
          setGroupTasksLocal(groupId, created.groupTasks);
        } else {
          addTaskLocal(created);
        }
        // Increment the key for this group so the creation row resets
        setNewTaskKeysByGroup((prev) => ({
          ...prev,
          [groupId]: (prev[groupId] || 0) + 1,
        }));
        refreshNotifications(currentOrg?._id);
      } catch (err) {
        console.error('Failed to create task:', err);
        toastError(
          err?.response?.data?.error ||
            'Failed to create task. Please try again.'
        );
        throw err;
      }
    },
    [
      boardId, monthKey, addTaskLocal, setGroupTasksLocal, refreshNotifications,
      toastError, currentOrg?._id,
    ]
  );

  // --- Inline edit ------------------------------------------------------

  const handleStartEdit = (task) => {
    setCreatingInGroup(null);
    setEditingTaskId(task._id);
  };

  const handleSaveEditTask = useCallback(
    async (taskId, payload) => {
      try {
        const updated = await taskService.updateTask(taskId, payload);
        updateTaskLocal(updated);
        setEditingTaskId(null);
        refreshNotifications(currentOrg?._id);
      } catch (err) {
        console.error('Failed to update task:', err);
        if (!err?.response?.data?.field) {
          toastError(
            err?.response?.data?.error ||
              'Failed to update task. Please try again.'
          );
        }
        throw err;
      }
    },
    [updateTaskLocal, refreshNotifications, toastError]
  );

  const handleCancelEdit = () => {
    setCreatingInGroup(null);
    setEditingTaskId(null);
  };

  // --- Inline status change --------------------------------------------

  const canChangeStatus = () => {
    // All org members can change task status
    return !!currentUser;
  };

  const handleStatusClick = (task, event) => {
    if (!canChangeStatus(task)) return;
    const anchor = event?.currentTarget || null;
    setStatusMenu({ task, anchor });
  };

  const handleStatusSelect = async (newStatus) => {
    if (!statusMenu) return;
    const { task } = statusMenu;
    setStatusMenu(null);
    const currentStatusStr = task.status ? task.status.toString() : null;
    const nextStatusStr = newStatus != null ? newStatus.toString() : null;
    if (currentStatusStr === nextStatusStr) return;
    // Optimistic update
    const prev = task;
    updateTaskLocal({ ...task, status: newStatus });
    try {
      const updated = await taskService.updateTask(task._id, {
        status: newStatus,
      });
      updateTaskLocal(updated);
      refreshNotifications();
    } catch (err) {
      console.error('Failed to update status:', err);
      updateTaskLocal(prev);
      toastError(
        err?.response?.data?.error ||
          'Failed to update status. Please try again.'
      );
    }
  };

  // --- Labels picker -----------------------------------------------------

  const handleLabelsClick = (task, event) => {
    if (!currentUser) return;
    const anchor = event?.currentTarget || event?.target || null;
    setLabelMenu({ task, anchor });
  };

  const handleLabelToggle = async (labelId, nextChecked) => {
    if (!labelMenu || !canEdit) return;
    const { task } = labelMenu;
    const current = (task.labels || []).map((id) => id.toString());
    const nextLabels = nextChecked
      ? Array.from(new Set([...current, labelId.toString()]))
      : current.filter((id) => id !== labelId.toString());
    const prev = task;
    updateTaskLocal({ ...task, labels: nextLabels });
    try {
      const updated = await taskService.updateTask(task._id, {
        labels: nextLabels,
      });
      updateTaskLocal(updated);
      // Update the popover's task ref so its checked-state stays in sync.
      setLabelMenu((cur) => (cur ? { ...cur, task: updated } : cur));
    } catch (err) {
      console.error('Failed to update labels:', err);
      updateTaskLocal(prev);
      toastError(
        err?.response?.data?.error ||
          'Failed to update labels. Please try again.'
      );
    }
  };

  // --- Inline priority change ------------------------------------------

  const handlePriorityClick = (task, event) => {
    if (!currentUser) return;
    const anchor = event?.currentTarget || null;
    setPriorityMenu({ task, anchor });
  };

  const handlePrioritySelect = async (newPriority) => {
    if (!priorityMenu) return;
    const { task } = priorityMenu;
    setPriorityMenu(null);
    if (newPriority === task.priority) return;
    const prev = task;
    updateTaskLocal({ ...task, priority: newPriority });
    try {
      const updated = await taskService.updateTask(task._id, {
        priority: newPriority,
      });
      updateTaskLocal(updated);
    } catch (err) {
      console.error('Failed to update priority:', err);
      updateTaskLocal(prev);
      toastError(
        err?.response?.data?.error ||
          'Failed to update priority. Please try again.'
      );
    }
  };

  // --- Inline owner change -----------------------------------------------

  const handleOwnerClick = (task, event) => {
    if (!currentUser) return;
    const anchor = event?.currentTarget || null;
    setOwnerMenu({ task, anchor });
  };

  const handleOwnerChange = async (newAssigneeIds) => {
    if (!ownerMenu) return;
    const { task } = ownerMenu;
    setOwnerMenu((cur) => cur ? { ...cur, task: { ...cur.task, assignedTo: newAssigneeIds } } : cur);
    const prev = task;
    updateTaskLocal({ ...task, assignedTo: newAssigneeIds });
    try {
      const updated = await taskService.updateTask(task._id, { assignedTo: newAssigneeIds });
      updateTaskLocal(updated);
      setOwnerMenu((cur) => cur ? { ...cur, task: updated } : cur);
    } catch (err) {
      console.error('Failed to update assignees:', err);
      updateTaskLocal(prev);
      toastError(err?.response?.data?.error || 'Failed to update assignees. Please try again.');
    }
  };

  // --- Inline due date change -------------------------------------------

  const handleDueDateChange = async (task, newVal) => {
    if (!currentUser) return;
    const nextIso = dateInputToISO(newVal);
    const prev = task;
    updateTaskLocal({ ...task, dueDate: nextIso });
    try {
      const updated = await taskService.updateTask(task._id, { dueDate: nextIso });
      updateTaskLocal(updated);
    } catch (err) {
      console.error('Failed to update due date:', err);
      updateTaskLocal(prev);
      toastError(err?.response?.data?.error || 'Failed to update due date. Please try again.');
    }
  };

  // --- Row actions menu (Edit / Delete) --------------------------------

  const handleActionsClick = (task, event) => {
    if (!canEdit) return;
    const anchor = event?.currentTarget || null;
    setActionsMenu({ task, anchor });
  };

  const handleMenuEdit = () => {
    if (!actionsMenu) return;
    const task = actionsMenu.task;
    setActionsMenu(null);
    handleStartEdit(task);
  };

  const handleMenuDelete = () => {
    if (!actionsMenu) return;
    const task = actionsMenu.task;
    setActionsMenu(null);
    setTaskPendingDelete(task);
  };

  // --- Pinning ----------------------------------------------------------
  // Two independent pins, unioned at render time by utils/taskPins.js. Neither
  // writes `order`, so unpinning restores the row's real position for free.

  // Team pin — persisted on the task, visible to everyone on the board. Same
  // optimistic sandwich as the field mutations above.
  const handleMenuPinTeam = async () => {
    if (!actionsMenu) return;
    const task = actionsMenu.task;
    setActionsMenu(null);
    const next = !task.pinned;
    updateTaskLocal({ ...task, pinned: next });
    try {
      const updated = await taskService.setTaskPinned(task._id, next);
      updateTaskLocal(updated);
    } catch (err) {
      console.error('Failed to pin task:', err);
      updateTaskLocal(task);
      toastError(
        err?.response?.data?.error ||
          `Failed to ${next ? 'pin' : 'unpin'} task. Please try again.`
      );
    }
  };

  // --- Client Portal sharing --------------------------------------------
  // Flipping who can READ a task, so it never runs optimistically the way the
  // pin does: an optimistic "visible to client" chip that the server then
  // refuses would tell the team the client can see something they cannot, and
  // that mistake is only discovered by the client not replying.
  const handleSharePortal = useCallback(
    async (task, next) => {
      try {
        const updated = await taskService.setTaskPortalShared(task._id, next);
        updateTaskLocal(updated);
        toastSuccess(
          next
            ? 'Shared — the client can now see this in their portal.'
            : 'Hidden — this is no longer in the client portal.'
        );
      } catch (err) {
        console.error('Failed to change client visibility:', err);
        toastError(
          err?.response?.data?.error ||
            'Failed to change client visibility. Please try again.'
        );
      }
    },
    [updateTaskLocal, toastSuccess, toastError]
  );

  const handleMenuSharePortal = () => {
    if (!actionsMenu) return;
    const task = actionsMenu.task;
    setActionsMenu(null);
    handleSharePortal(task, !task.portalShared);
  };

  // Personal pin — localStorage only, private to this browser. No network call,
  // so there's nothing to revert.
  const handleMenuPinPersonal = () => {
    if (!actionsMenu) return;
    const taskId = actionsMenu.task._id;
    setActionsMenu(null);
    setPersonalPins((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      savePersonalPins(boardId, next);
      return next;
    });
  };

  const handleConfirmDelete = async () => {
    if (!taskPendingDelete) return;
    const task = taskPendingDelete;
    setTaskPendingDelete(null);
    try {
      await taskService.deleteTask(task._id);
      deleteTaskLocal(task._id);
    } catch (err) {
      console.error('Failed to delete task:', err);
      toastError(
        err?.response?.data?.error ||
          'Failed to delete task. Please try again.'
      );
    }
  };

  // --- Bulk delete ------------------------------------------------------
  // Fire one DELETE per task in parallel. Each success removes from the
  // store immediately so the UI shrinks task-by-task instead of jumping.
  // Failures are toasted but don't abort the rest.

  const handleConfirmBulkDelete = async () => {
    const ids = Array.from(selectedTaskIds);
    if (ids.length === 0) {
      setBulkDeleteOpen(false);
      return;
    }
    setBulkDeleteOpen(false);
    setBulkBusy(true);
    let failed = 0;
    await Promise.all(
      ids.map((id) =>
        taskService
          .deleteTask(id)
          .then(() => deleteTaskLocal(id))
          .catch((err) => {
            failed += 1;
            console.error('Failed to delete task in bulk:', id, err);
          })
      )
    );
    setBulkBusy(false);
    if (failed > 0) {
      toastError(
        failed === ids.length
          ? 'Failed to delete the selected tasks. Please try again.'
          : `Failed to delete ${failed} of ${ids.length} tasks.`
      );
    }
  };

  // --- Bulk move-to-group ----------------------------------------------
  // We piggy-back on the existing /api/tasks/reorder endpoint: it supports
  // cross-group moves when we hand it a target group's full desired order.
  // That keeps the operation atomic on the server side.

  const handleBulkMoveToGroup = async (targetGroupId) => {
    if (!targetGroupId) return;
    const idsToMove = Array.from(selectedTaskIds).filter((id) => {
      // Skip tasks already in the destination so they don't get re-appended
      const list = tasksByGroup[targetGroupId] || [];
      return !list.some((t) => t._id === id);
    });
    if (idsToMove.length === 0) return;
    const targetTasks = tasksByGroup[targetGroupId] || [];
    const nextOrder = [...targetTasks.map((t) => t._id), ...idsToMove];
    setBulkBusy(true);
    try {
      await reorderTasksAction(targetGroupId, nextOrder);
      // Tasks now live in the new group; their ids stay in the store, so
      // selectedTaskIds remains valid and the bar can keep operating on them.
    } catch (err) {
      console.error('Failed to bulk-move tasks:', err);
      toastError('Could not move the selected tasks.');
    } finally {
      setBulkBusy(false);
    }
  };

  // --- Move to month -----------------------------------------------------
  // Serves the row menu (one task) and the bulk bar (many) through one modal
  // and one endpoint, the way "Move to group" already serves both.

  const [monthMoveTargets, setMonthMoveTargets] = useState(null);
  const [monthMoveBusy, setMonthMoveBusy] = useState(false);

  const monthMoveNames = useMemo(() => {
    if (!monthMoveTargets) return [];
    const byId = new Map();
    for (const list of Object.values(tasksByGroup)) {
      for (const t of list) byId.set(t._id, t.name);
    }
    return monthMoveTargets.map((id) => byId.get(id) || 'this task');
  }, [monthMoveTargets, tasksByGroup]);

  const handleConfirmMonthMove = async (targetMonthKey) => {
    if (!monthMoveTargets?.length || !targetMonthKey) return;
    setMonthMoveBusy(true);
    try {
      await moveTasksToMonth(monthMoveTargets, targetMonthKey);
      // The rows have left the month on screen, so drop them from the store
      // rather than refetching the whole board.
      for (const id of monthMoveTargets) deleteTaskLocal(id);
      setSelectedTaskIds((prev) => {
        const next = new Set(prev);
        for (const id of monthMoveTargets) next.delete(id);
        return next;
      });
      const label = findMonth(months, targetMonthKey)?.label || targetMonthKey;
      toastSuccess(
        monthMoveTargets.length === 1
          ? `Moved to ${label}.`
          : `Moved ${monthMoveTargets.length} tasks to ${label}.`
      );
      setMonthMoveTargets(null);
      // Month task counts in the dropdown are now stale.
      refreshMonths();
    } catch (err) {
      console.error('Failed to move tasks to month:', err);
      toastError('Could not move the selected tasks to that month.');
    } finally {
      setMonthMoveBusy(false);
    }
  };

  // --- Bulk assign -------------------------------------------------------

  const handleBulkAssign = async (assigneeIds) => {
    const ids = Array.from(selectedTaskIds);
    if (ids.length === 0 || assigneeIds.length === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        ids.map(async (taskId) => {
          const updated = await taskService.updateTask(taskId, { assignedTo: assigneeIds });
          updateTaskLocal(updated);
        })
      );
    } catch (err) {
      console.error('Failed to bulk assign:', err);
      toastError('Could not assign the selected tasks.');
    } finally {
      setBulkBusy(false);
    }
  };

  // --- New group creation ----------------------------------------------

  const handleOpenGroupModal = () => {
    setNewGroupName('');
    setNewGroupClientEmail('');
    setNewGroupClientAuth('google');
    setGroupModalError(null);
    setCreatingGroup(false);
    setGroupModalOpen(true);
  };

  const handleCloseGroupModal = () => {
    if (creatingGroup) return;
    setGroupModalOpen(false);
  };

  const handleSubmitNewGroup = async (e) => {
    e?.preventDefault?.();
    const trimmed = newGroupName.trim();
    if (!trimmed) {
      setGroupModalError('Group name is required');
      return;
    }
    // On a client board, validate the email if one was entered (it's optional —
    // you can create the link now and share it later).
    const clientEmail = newGroupClientEmail.trim();
    if (isClientBoard && clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      setGroupModalError('Enter a valid client email, or leave it blank to share the link yourself.');
      return;
    }
    try {
      setCreatingGroup(true);
      setGroupModalError(null);
      const payload = { name: trimmed };
      if (isClientBoard && clientEmail) {
        payload.clientEmail = clientEmail;
        payload.clientAuthMethod = newGroupClientAuth;
      }
      const { group: created, inviteSent } = await taskService.createGroup(boardId, payload);
      addGroupLocal(created);
      setGroupModalOpen(false);
      setNewGroupName('');
      setNewGroupClientEmail('');
      if (isClientBoard) {
        // Confirm the invite (createGroup returns whether the email went out) and
        // open the link manager so the link is right there to copy or resend.
        if (inviteSent) {
          toastSuccess(
            newGroupClientAuth === 'password'
              ? `Client group created — password set-up link sent to ${clientEmail}.`
              : `Client group created — invitation sent to ${clientEmail}.`
          );
        } else if (clientEmail) {
          toastError('Group created, but the invitation email could not be sent. Copy the link to share it manually.');
        } else {
          toastSuccess('Client group created — copy the link to share it.');
        }
        setClientPortalGroup(created);
      }
    } catch (err) {
      console.error('Failed to create group:', err);
      setGroupModalError(
        err?.response?.data?.error ||
          'Failed to create group. Please try again.'
      );
    } finally {
      setCreatingGroup(false);
    }
  };

  // --- Group rename -------------------------------------------------------

  /**
   * The store applies the new name optimistically and rolls it back if the API
   * rejects it — most often a 409 because another group on this board already
   * carries that name, whose message we surface verbatim.
   */
  const handleRenameGroup = async (group, name) => {
    try {
      await renameGroupAction(group._id, name);
    } catch (err) {
      console.error('Failed to rename group:', err);
      toastError(
        err?.response?.data?.error ||
          'Failed to rename group. Please try again.'
      );
    }
  };

  // --- Group tags (extra feature) -----------------------------------------

  const handleOpenGroupTags = (group, event) => {
    setGroupTagMenu({ groupId: group._id, anchor: event.currentTarget });
  };

  const handleGroupTagToggle = async (tagId, nextChecked) => {
    if (!groupTagMenu || !canTagGroups) return;
    const group = groups.find((g) => g._id === groupTagMenu.groupId);
    if (!group) return;
    const current = (group.tags || []).map((id) => id.toString());
    const next = nextChecked
      ? Array.from(new Set([...current, tagId.toString()]))
      : current.filter((id) => id !== tagId.toString());
    try {
      // The store patches optimistically and rolls back on failure, so the
      // popover's checked state — which reads straight off `groups` — follows
      // both the optimistic write and the revert without extra bookkeeping.
      await setGroupTagsAction(group._id, next);
    } catch (err) {
      console.error('Failed to update group tags:', err);
      toastError(
        err?.response?.data?.error ||
          'Failed to update group tags. Please try again.'
      );
    }
  };

  // --- Group owner (tracker boards) ---------------------------------------

  const handleOpenGroupOwner = (group, event) => {
    setGroupOwnerMenu({ groupId: group._id, anchor: event.currentTarget });
  };

  /**
   * Set (or clear) who owns a group FROM the month currently on screen.
   *
   * The toast names the month deliberately. Ownership carries forward, so
   * assigning in August also changes September and October if those months were
   * inheriting — correct by construction, and astonishing if nobody says so.
   * The timeline itself is invisible; this sentence and the "carried forward
   * from…" tooltip are the only places the rule is ever stated to the user.
   */
  const handleSetGroupOwner = async (groupId, member) => {
    if (!canOwnGroups || !monthKey) return;
    try {
      await setGroupOwnerAction(groupId, member, monthKey);
      const when = selectedMonth?.label || formatMonthKey(monthKey);
      toastSuccess(
        member
          ? `${member.name} owns this group from ${when} onward.`
          : `Owner cleared from ${when} onward.`
      );
    } catch (err) {
      console.error('Failed to set group owner:', err);
      toastError(
        err?.response?.data?.error ||
          'Failed to set the group owner. Please try again.'
      );
    }
  };

  // --- Group deletion -----------------------------------------------------

  const handleDeleteGroup = (group) => {
    setGroupPendingDelete(group);
  };

  const handleOpenNotes = (group) => setNotesGroupId(group._id);
  const handleCloseNotes = () => setNotesGroupId(null);

  const handleConfirmDeleteGroup = async () => {
    if (!groupPendingDelete) return;
    const group = groupPendingDelete;
    setGroupPendingDelete(null);
    setDeletingGroup(true);
    try {
      await taskService.deleteGroup(group._id);
      removeGroupLocal(group._id);
      // Don't let the notes drawer outlive its group.
      if (notesGroupId === group._id) setNotesGroupId(null);
    } catch (err) {
      console.error('Failed to delete group:', err);
      toastError(
        err?.response?.data?.error ||
          'Failed to delete group. Please try again.'
      );
    } finally {
      setDeletingGroup(false);
    }
  };

  const isPublic = board?.visibility === 'public';
  const VisibilityIcon = isPublic ? Globe : Lock;
  const hasGroups = groups.length > 0;

  // --- Drag-and-drop wiring -------------------------------------------------
  // One DndContext covers BOTH the groups (sortable list) and every group's
  // tasks (each its own SortableContext). Each sortable carries `data` so
  // onDragEnd can branch on type and locate the correct target.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  // DnD is disabled while an inline edit/create row is open in any group so
  // the form controls don't fight with the drag sensors. It's also disabled
  // while filters are active — reordering a filtered subset would write a
  // bogus order back to the full list.
  const dndDisabledGlobal =
    creatingInGroup != null || editingTaskId != null || filtersActive;
  // Group reordering additionally can't happen while the "completed last" sort
  // is active: the displayed order no longer matches the persisted `groups`
  // array, so a drop would write a scrambled order. Task drag within a group is
  // unaffected and keeps using `dndDisabledGlobal`.
  const groupDndDisabled = dndDisabledGlobal || sortCompletedLast;

  const handleBoardDragEnd = (event) => {
    const { active, over } = event;
    if (!over) return;
    const activeData = active.data.current || {};
    const overData = over.data.current || {};

    // --- Group reorder ---
    if (activeData.type === 'group') {
      if (active.id === over.id) return;
      // Only respond if we dropped onto another group; ignore task drops here.
      if (overData.type && overData.type !== 'group') return;
      const oldIndex = groups.findIndex((g) => g._id === active.id);
      const newIndex = groups.findIndex((g) => g._id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(groups, oldIndex, newIndex);
      reorderGroupsAction(boardId, next.map((g) => g._id)).catch((err) => {
        console.error('Failed to reorder groups:', err);
        toastError('Could not reorder groups');
      });
      return;
    }

    // --- Task reorder / move ---
    if (activeData.type === 'task') {
      const sourceGroupId = activeData.groupId;
      // Resolve target group: if dropped on a task, use that task's groupId;
      // if dropped on a group header/container, the group itself is the target.
      let targetGroupId = null;
      if (overData.type === 'task') targetGroupId = overData.groupId;
      else if (overData.type === 'group') targetGroupId = over.id;
      else if (overData.type === 'group-dropzone') targetGroupId = overData.groupId;
      if (!targetGroupId) return;

      // These are the PERSISTED lists (order asc), which is what `reorderTasks`
      // writes back. Pinned rows are shown at the top of the group instead, so
      // the displayed order and these arrays diverge — every index below is
      // resolved against the persisted list, never against what's on screen.
      const sourceTasks = tasksByGroup[sourceGroupId] || [];
      const targetTasks = tasksByGroup[targetGroupId] || [];
      const isPinned = (t) => isTaskPinned(t, personalPins);

      // Intra-group reorder
      if (sourceGroupId === targetGroupId) {
        if (active.id === over.id) return;
        // Pinned rows have no drag handle, so `active` is always unpinned. We
        // reorder only the unpinned subsequence and then splice it back into
        // the persisted list, leaving every pinned task on its original index.
        // That's what keeps "unpin returns it to its own place" true after a
        // neighbour has been dragged around.
        const unpinned = sourceTasks.filter((t) => !isPinned(t));
        const oldIndex = unpinned.findIndex((t) => t._id === active.id);
        const overTask = sourceTasks.find((t) => t._id === over.id);
        // Dropping onto a pinned row reads as "put it above everything movable".
        const newIndex =
          overTask && isPinned(overTask)
            ? 0
            : unpinned.findIndex((t) => t._id === over.id);
        if (oldIndex < 0 || newIndex < 0) return;
        const moved = arrayMove(unpinned, oldIndex, newIndex);
        let k = 0;
        const next = sourceTasks.map((t) => (isPinned(t) ? t : moved[k++]));
        reorderTasksAction(targetGroupId, next.map((t) => t._id)).catch((err) => {
          console.error('Failed to reorder tasks:', err);
          toastError('Could not reorder tasks');
        });
        return;
      }

      // Cross-group move: insert before the target task, or append if dropped
      // on the group container itself.
      const movingTask = sourceTasks.find((t) => t._id === active.id);
      if (!movingTask) return;
      let insertAt = targetTasks.length;
      if (overData.type === 'task') {
        const idx = targetTasks.findIndex((t) => t._id === over.id);
        // Landing on a pinned row means the top of the group, not that row's
        // persisted slot — which could be anywhere in the list.
        if (idx >= 0) insertAt = isPinned(targetTasks[idx]) ? 0 : idx;
      }
      const nextTargetIds = targetTasks.map((t) => t._id);
      nextTargetIds.splice(insertAt, 0, movingTask._id);
      reorderTasksAction(targetGroupId, nextTargetIds).catch((err) => {
        console.error('Failed to move task:', err);
        toastError('Could not move task');
      });
    }
  };

  return (
    <PageWrapper>
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 font-body"
        style={{ fontSize: 13 }}
      >
        <Link
          to="/boards"
          className="transition-colors duration-150 hover:text-[color:var(--color-accent)]"
          style={{ color: 'var(--color-text-muted)' }}
        >
          My Boards
        </Link>
        <ChevronRight
          size={14}
          color="var(--color-text-muted)"
          aria-hidden="true"
        />
        <span
          style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}
          className="truncate"
        >
          {board?.name || 'Loading…'}
        </span>
      </nav>

      {/* Board header */}
      <header className="mt-4 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1
              className="font-display truncate text-[20px] md:text-[26px]"
              style={{
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '-0.01em',
                color: 'var(--color-text-primary)',
              }}
            >
              {board?.name || '—'}
            </h1>
            <BoardTypePill board={board} />
          </div>
          <p
            className="mt-1 font-body"
            style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
          >
            {board
              ? `Created ${formatDate(board.createdAt)} · ${totalTaskCount} ${totalTaskCount === 1 ? 'task' : 'tasks'}`
                + (isTrackerBoard && selectedMonth ? ` in ${selectedMonth.label}` : '')
              : 'Loading board details…'}
          </p>
          {/* The month scopes all three views, so it sits with the board's
              identity rather than in the action row on the right — which
              already wraps at six controls, and would make a scope control
              look like an action. */}
          {isTrackerBoard && (
            <MonthSelector
              months={months}
              value={monthKey}
              onChange={setMonth}
              loading={monthsLoading}
              timezone={monthTimezone}
              onEditTimezone={
                canOnBoard('board.change_visibility')
                  ? () => setTimezoneOpen(true)
                  : undefined
              }
            />
          )}
        </div>

        {/* `canExportActivity` widens this row deliberately: export is not an
            editing right, so an admin with read-only access to a board must
            still get the button. Every control inside carries its own gate.

            No `shrink-0` on the row below on purpose: a non-shrinking flex item
            is sized to max-content, so `flex-wrap` alone never fires and the row
            (~670px with every control showing) pushed the whole page sideways on
            phones and iPad portrait. Letting it shrink is what allows the buttons
            to wrap. At desktop widths it still fits on one line, unchanged. */}
        {(canEdit || isBoardCreator || canExportActivity || canManageTrackers
          || canConvertToTracker) && (
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {canViewAccess && !isPublic && (
              <Button
                variant="secondary"
                icon={UserPlus}
                onClick={() => setAccessModalOpen(true)}
              >
                Share
              </Button>
            )}
            {canOnBoard('automation.view') && (
              <Button
                variant="secondary"
                icon={Zap}
                onClick={() => setAutomationsOpen(true)}
              >
                Automations
              </Button>
            )}
            {canManageTrackers && (
              <Button
                variant="secondary"
                icon={CalendarCheck}
                onClick={() => setTrackersOpen(true)}
              >
                Trackers
              </Button>
            )}
            {canConvertToTracker && (
              <Button
                variant="secondary"
                icon={CalendarRange}
                onClick={() => setConvertOpen(true)}
              >
                Make it a tracker
              </Button>
            )}
            {canExportActivity && (
              <Button
                variant="secondary"
                icon={Download}
                onClick={() => setExportOpen(true)}
              >
                Export
              </Button>
            )}
            {canEdit && (
              <Button
                variant="primary"
                icon={Plus}
                onClick={handleOpenGroupModal}
              >
                New Group
              </Button>
            )}
            {canOrg('org.manage_settings') && (
              <button
                type="button"
                aria-label="Board settings"
                onClick={() => navigate('/settings')}
                className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  width: 38,
                  height: 38,
                  border: '1.5px solid var(--color-border-strong)',
                }}
              >
                <SettingsIcon
                  size={16}
                  color="var(--color-text-secondary)"
                  aria-hidden="true"
                />
              </button>
            )}
          </div>
        )}
      </header>

      {/* View tabs. Only drawn when there IS a second view to switch to, so a
          standard or client board — which has neither Delivery nor Goals —
          renders exactly as it did before this board type existed. */}
      {visibleTabs.length > 1 && (
        <div
          className="mt-5 flex items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Board views"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          {visibleTabs.map((tab) => {
            const active = view === tab.value;
            const Icon = tab.icon;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setView(tab.value)}
                className="inline-flex items-center gap-1.5 font-body shrink-0 transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  height: 38,
                  padding: '0 12px',
                  fontSize: 13.5,
                  fontWeight: active ? 600 : 500,
                  color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: active
                    ? '2px solid var(--color-accent)'
                    : '2px solid transparent',
                  marginBottom: -1,
                  cursor: 'pointer',
                }}
              >
                <Icon size={14} aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      {view === 'goals' && (
        <GoalsTab
          boardId={boardId}
          monthKey={monthKey}
          monthLabel={selectedMonth?.label}
          canTrack={canTrackGoals}
          canManage={canManageGoals}
          canManageColumns={canManageGoalColumns}
          onGoalsChanged={refreshMonths}
        />
      )}

      {view === 'people' && (
        <ScoreboardTab
          boardId={boardId}
          monthKey={monthKey}
          monthLabel={selectedMonth?.label}
          // The drill-down jumps back to the board and scrolls to the group, so
          // a name in the table is a route to the work rather than a dead end.
          onOpenGroup={(groupId) => {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set('view', 'board');
              next.set('highlightGroup', groupId);
              return next;
            });
          }}
        />
      )}

      {view === 'delivery' && (
        <DeliveryTab
          boardId={boardId}
          groups={groups}
          monthKey={monthKey}
          canManage={canManageTrackers}
          onOpenTask={(taskId) => {
            // Reuse the existing deep-link machinery rather than inventing a
            // second way to reveal a task.
            setView('board');
            setSearchParams({ highlightTask: taskId }, { replace: true });
          }}
        />
      )}

      {/* Filter bar + group sort toggle */}
      {view === 'board' && hasGroups && board && (
        <div className="flex flex-col md:flex-row md:items-start gap-2">
          <div className="flex-1 min-w-0">
            <BoardFilterBar
              board={board}
              allTasks={allTasks}
              filters={filters}
              onChange={setFilters}
              matchedCount={matchedTaskCount}
              totalCount={totalTaskCount}
            />
          </div>
          {/* View-only sort: pushes fully-done (green) groups to the bottom.
              Remembered per board; never writes the persisted group order. */}
          <button
            type="button"
            onClick={toggleGroupSort}
            aria-pressed={sortCompletedLast}
            title="Move completed groups to the bottom"
            className="mt-2 md:mt-5 self-start shrink-0 inline-flex items-center gap-1.5 font-body transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              height: 34,
              padding: '0 12px',
              fontSize: 13,
              fontWeight: 600,
              color: sortCompletedLast
                ? 'var(--color-accent)'
                : 'var(--color-text-secondary)',
              background: sortCompletedLast
                ? 'var(--color-accent-light)'
                : 'transparent',
              border: `1.5px solid ${
                sortCompletedLast
                  ? 'var(--color-accent)'
                  : 'var(--color-border-strong)'
              }`,
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
            }}
          >
            <ArrowDownUp size={14} aria-hidden="true" />
            Completed last
          </button>
        </div>
      )}

      {/* Task groups */}
      {view === 'board' && (
      <section className="mt-6 flex flex-col gap-4">
        {loading && !hasGroups ? (
          <div
            role="status"
            aria-live="polite"
            aria-label="Loading board"
            className="flex flex-col gap-4"
          >
            <SkeletonTaskGroup rowCount={4} index={0} />
            <SkeletonTaskGroup rowCount={3} index={1} />
          </div>
        ) : !hasGroups ? (
          <div
            className="bg-surface"
            style={{
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-card)',
              padding: '48px 16px',
            }}
          >
            <EmptyState
              icon={Plus}
              title="No task groups yet"
              description={
                canEdit
                  ? 'Create your first group to start organising tasks'
                  : 'Nothing has been set up on this board yet'
              }
              actionLabel={canEdit ? 'Create first group' : undefined}
              onAction={canEdit ? handleOpenGroupModal : undefined}
            />
          </div>
        ) : filtersActive && matchedTaskCount === 0 ? (
          <div
            className="bg-surface"
            style={{
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-card)',
              padding: '48px 16px',
            }}
          >
            <EmptyState
              icon={SearchX}
              title="No tasks match your filters"
              description="Try removing or loosening a filter to see more tasks."
              actionLabel="Clear all filters"
              onAction={() => setFilters(EMPTY_FILTERS)}
            />
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleBoardDragEnd}
          >
            <SortableContext items={orderedGroupIds} strategy={verticalListSortingStrategy}>
              {orderedGroups.map((group, idx) => {
                // Pinned-first render order. The progress math below reads the
                // unsorted filtered bucket, since it's order-independent.
                const groupTasks = displayTasksByGroup[group._id] || [];
                // While filtering, groups with no surviving tasks drop out of
                // the view entirely to cut noise.
                if (filtersActive && groupTasks.length === 0) return null;
                const doneStatusId =
                  board && Array.isArray(board.statuses)
                    ? (board.statuses.find((s) => s.key === 'done')?._id || null)
                    : null;
                const doneCount = groupTasks.filter((t) => {
                  if (t.status == null) return false;
                  if (doneStatusId) {
                    return t.status.toString() === doneStatusId.toString();
                  }
                  return t.status === 'done';
                }).length;
                const isCollapsed = collapsed.has(group._id);
                // Disable task DnD inside this group while it's hosting an
                // inline create/edit row — but leave the group's own handle
                // sortable so users can still rearrange columns.
                const isEditingHere =
                  (editingTaskId != null && groupTasks.some((t) => t._id === editingTaskId)) ||
                  creatingInGroup === group._id;
                // Keep the card clipped to its rounded corners in the normal
                // state so the grey header and row backgrounds don't poke past
                // the 14px radius. Only lift the clip while an inline edit/create
                // row is open here, where the field dropdowns must escape the
                // card bounds. The inner table/grid wrappers clip their own
                // overflow, so this doesn't change popover or drag behaviour.
                const needsOverflowVisible = isEditingHere;

                return (
                  <SortableItem
                    key={group._id}
                    id={group._id}
                    data={{ type: 'group' }}
                    disabled={groupDndDisabled}
                  >
                    {({ ref, setActivatorNodeRef, style, attributes, listeners, isDragging }) => (
                      <div
                        ref={ref}
                        // The People tab's drill-down scrolls to a group by id.
                        data-group-id={group._id}
                        className={`bg-surface ${
                          needsOverflowVisible ? 'overflow-visible' : 'overflow-hidden'
                        }`}
                        style={{
                          ...style,
                          borderRadius: 'var(--radius-lg)',
                          boxShadow: 'var(--shadow-card)',
                          position: 'relative',
                          zIndex: isDragging ? 30 : 'auto',
                        }}
                      >
                        <TaskGroupHeader
                          name={group.name}
                          colorDot={GROUP_DOT_CYCLE[idx % GROUP_DOT_CYCLE.length]}
                          totalCount={groupTasks.length}
                          doneCount={doneCount}
                          collapsed={isCollapsed}
                          onToggle={() => toggleGroup(group._id)}
                          onRename={
                            canEdit ? (next) => handleRenameGroup(group, next) : undefined
                          }
                          onDeleteGroup={canEdit ? () => handleDeleteGroup(group) : undefined}
                          onOpenNotes={() => handleOpenNotes(group)}
                          onOpenClientPortal={
                            isClientBoard && canManageAccess
                              ? () => setClientPortalGroup(group)
                              : undefined
                          }
                          tags={resolveGroupTags(group)}
                          onOpenTags={
                            canTagGroups
                              ? (event) => handleOpenGroupTags(group, event)
                              : undefined
                          }
                          owner={group.owner || null}
                          ownerInherited={!!group.ownerInherited}
                          ownerActive={group.ownerActive !== false}
                          ownerFromLabel={
                            group.ownerFromMonth ? formatMonthKey(group.ownerFromMonth) : ''
                          }
                          onOpenOwner={
                            // `monthKey` is legitimately null while the month list
                            // loads or when ?month= is stale. Opening the picker
                            // then would write into the SERVER's current month
                            // instead of the one on screen — a 200, and the wrong
                            // month, with no error anywhere.
                            canOwnGroups && monthKey
                              ? (event) => handleOpenGroupOwner(group, event)
                              : undefined
                          }
                          noteCount={notesCountByGroup[group._id] ?? 0}
                          dragHandle={
                            !groupDndDisabled && (
                              <button
                                ref={setActivatorNodeRef}
                                type="button"
                                aria-label={`Drag to reorder group ${group.name}`}
                                {...attributes}
                                {...listeners}
                                className="flex items-center justify-center opacity-0 group-hover/group-header:opacity-100 focus-visible:opacity-100 transition-opacity duration-150"
                                style={{
                                  width: 20,
                                  height: 24,
                                  cursor: 'grab',
                                  touchAction: 'none',
                                  background: 'transparent',
                                  border: 'none',
                                  padding: 0,
                                  marginLeft: -4,
                                }}
                              >
                                <GripVertical
                                  size={14}
                                  color="var(--color-text-muted)"
                                  aria-hidden="true"
                                />
                              </button>
                            )
                          }
                        />
                        {!isCollapsed && (
                          board?.useFlexibleColumns ? (
                            <DataGrid
                              board={board}
                              tasks={groupTasks}
                              personalPins={personalPins}
                              readOnly={!canEdit}
                            />
                          ) : (
                            <TaskTable
                              tasks={groupTasks}
                              personalPins={personalPins}
                              board={board}
                              members={members}
                              editingTaskId={editingTaskId}
                              isCreating={canEdit && !filtersActive}
                              createKey={newTaskKeysByGroup[group._id] || 0}
                              isAdmin={canEdit}
                              highlightedTaskId={highlightedTaskId}
                              highlightedParentId={highlightedParentId}
                              onOpenTask={handleOpenTask}
                              onStatusClick={handleStatusClick}
                              onPriorityClick={handlePriorityClick}
                              onLabelsClick={handleLabelsClick}
                              onOwnerClick={handleOwnerClick}
                              onActionsClick={canEdit ? handleActionsClick : undefined}
                              onDueDateChange={handleDueDateChange}
                              onSaveNew={(payload) => handleSaveNewTask(group._id, payload)}
                              onSaveEdit={handleSaveEditTask}
                              onCancelEdit={handleCancelEdit}
                              groupId={group._id}
                              dndDisabled={dndDisabledGlobal || isEditingHere}
                              selectedIds={selectedTaskIds}
                              onToggleSelect={handleToggleSelectTask}
                              onToggleSelectAll={handleToggleSelectGroup}
                              askPortalShare={canSharePortal}
                            />
                          )
                        )}
                      </div>
                    )}
                  </SortableItem>
                );
              })}
            </SortableContext>
          </DndContext>
        )}
      </section>
      )}

      {/* Status chip menu */}
      {statusMenu && (
        <StatusMenu
          anchorEl={statusMenu.anchor}
          board={board}
          value={statusMenu.task.status}
          onSelect={handleStatusSelect}
          onEditChips={
            canEdit
              ? () => {
                  setStatusMenu(null);
                  setEditChipsModal('statuses');
                }
              : undefined
          }
          onClose={() => setStatusMenu(null)}
        />
      )}

      {/* Labels picker */}
      {labelMenu && (
        <LabelPicker
          anchorEl={labelMenu.anchor}
          board={board}
          selectedIds={labelMenu.task.labels || []}
          onToggle={canEdit ? handleLabelToggle : undefined}
          onEditChips={
            canEdit
              ? () => {
                  setLabelMenu(null);
                  setEditChipsModal('labels');
                }
              : undefined
          }
          onClose={() => setLabelMenu(null)}
        />
      )}

      {/* Group tags picker (extra feature) — same popover as the label picker,
          pointed at the board's group-tag catalog instead of its labels. */}
      {groupTagMenu && canTagGroups && (
        <LabelPicker
          anchorEl={groupTagMenu.anchor}
          chips={board?.groupTags || []}
          selectedIds={
            groups.find((g) => g._id === groupTagMenu.groupId)?.tags || []
          }
          onToggle={handleGroupTagToggle}
          onEditChips={() => {
            setGroupTagMenu(null);
            setEditChipsModal('groupTags');
          }}
          editLabel="Edit Group Tags"
          emptyLabel="No group tags yet"
          onClose={() => setGroupTagMenu(null)}
        />
      )}

      {/* Group owner picker (tracker boards). Reuses the task assignee menu,
          collapsed to SINGLE-select here at the call site rather than by adding
          a mode to the shared component — so the task-owner picker above cannot
          regress. Clicking a new person yields [current, new]; clicking the
          current one yields [] and means "unassign". */}
      {groupOwnerMenu && canOwnGroups && (() => {
        const currentOwnerId =
          groups.find((g) => g._id === groupOwnerMenu.groupId)?.owner?._id || null;
        return (
          <InlineAssigneeMenu
            anchorEl={groupOwnerMenu.anchor}
            members={members}
            value={currentOwnerId ? [String(currentOwnerId)] : []}
            onChange={(ids) => {
              const nextId = ids.find((id) => String(id) !== String(currentOwnerId)) ?? null;
              const member = nextId ? members.find((m) => String(m._id) === String(nextId)) : null;
              handleSetGroupOwner(groupOwnerMenu.groupId, member || null);
              setGroupOwnerMenu(null); // single-select closes on pick
            }}
            onClose={() => setGroupOwnerMenu(null)}
          />
        );
      })()}

      {/* Inline owner picker */}
      {ownerMenu && (
        <InlineAssigneeMenu
          anchorEl={ownerMenu.anchor}
          members={members}
          value={(ownerMenu.task.assignedTo || []).map((u) =>
            typeof u === 'string' ? u : u._id
          )}
          onChange={handleOwnerChange}
          onClose={() => setOwnerMenu(null)}
        />
      )}

      {/* Edit chips (labels / statuses / group tags) modal. Group tags carry the
          extra-feature gate on top of canEdit; the other two do not. */}
      {canEdit &&
        editChipsModal &&
        (editChipsModal !== 'groupTags' || canTagGroups) && (
          <EditChipsModal
            isOpen={!!editChipsModal}
            onClose={() => setEditChipsModal(null)}
            boardId={boardId}
            kind={editChipsModal}
          />
        )}

      {/* Priority chip menu */}
      {priorityMenu && (
        <PriorityMenu
          anchorEl={priorityMenu.anchor}
          value={priorityMenu.task.priority}
          onSelect={handlePrioritySelect}
          onClose={() => setPriorityMenu(null)}
        />
      )}

      {/* Row actions menu (Pin / Edit / Delete) */}
      {actionsMenu && (
        <TaskActionsMenu
          anchorEl={actionsMenu.anchor}
          pinnedForAll={actionsMenu.task.pinned === true}
          pinnedForMe={personalPins.has(actionsMenu.task._id)}
          // A team pin moves the row for everyone, so it answers to `task.move`
          // — the same capability the server gates the endpoint on. The personal
          // pin never leaves this browser, so it's always offered.
          onPinTeam={canOnBoard('task.move') ? handleMenuPinTeam : undefined}
          onPinPersonal={handleMenuPinPersonal}
          // Offered only where it can actually do something: a client board, a
          // top-level row, and not a request the client raised themselves (that
          // one is already theirs — see the server's denyPortalShare).
          sharedWithClient={actionsMenu.task.portalShared === true}
          onSharePortal={
            canSharePortal &&
            !actionsMenu.task.parent &&
            !actionsMenu.task.portalSubmitter
              ? handleMenuSharePortal
              : undefined
          }
          // Tracker boards only, top-level rows only — subitems follow their
          // parent's month server-side and cannot be refiled on their own.
          onMoveToMonth={
            isTrackerBoard && canOnBoard('task.move') && !actionsMenu.task.parent
              ? () => {
                setMonthMoveTargets([actionsMenu.task._id]);
                setActionsMenu(null);
              }
              : undefined
          }
          onEdit={handleMenuEdit}
          onDelete={handleMenuDelete}
          onClose={() => setActionsMenu(null)}
        />
      )}

      {timezoneOpen && (
        <BoardTimezoneModal
          boardId={boardId}
          current={monthTimezone}
          onClose={() => setTimezoneOpen(false)}
          onChanged={(res) => {
            setTimezoneOpen(false);
            toastSuccess(
              res.moved > 0
                ? `Timezone changed. ${res.moved} task${res.moved === 1 ? '' : 's'} moved month.`
                : 'Timezone changed. No task changed month.'
            );
            // Both the month list and the task set were re-derived server-side.
            refreshMonths();
            refreshBoardTasks(boardId, { month: monthKey });
          }}
        />
      )}

      {convertOpen && (
        <ConvertToTrackerModal
          boardId={boardId}
          boardName={board?.name}
          onClose={() => setConvertOpen(false)}
          onConverted={(result) => {
            setConvertOpen(false);
            toastSuccess(
              `Filed ${result?.filed?.tasks ?? 0} tasks by month. This board is now monthly.`
            );
            // Refetch the boards cache so `board.boardType` flips — that is what
            // makes the tabs and the month picker appear, and the month effect
            // then does the first month-scoped task fetch on its own.
            fetchBoards(orgId).catch((err) =>
              console.error('Failed to refresh boards after conversion:', err)
            );
          }}
        />
      )}

      {/* Move to month — shared by the row menu and the bulk bar. Mounted only
          while open, so the month picker resets between uses without an
          effect syncing state from props. */}
      {monthMoveTargets && (
      <MoveToMonthModal
        open
        onClose={() => setMonthMoveTargets(null)}
        onConfirm={handleConfirmMonthMove}
        months={months}
        currentMonthKey={monthKey}
        taskNames={monthMoveNames}
        saving={monthMoveBusy}
      />
      )}

      {/* Delete confirmation */}
      <Modal
        isOpen={!!taskPendingDelete}
        onClose={() => setTaskPendingDelete(null)}
        title="Delete task?"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setTaskPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleConfirmDelete}>
              Delete
            </Button>
          </>
        }
      >
        <p
          className="font-body"
          style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}
        >
          Are you sure you want to delete{' '}
          <strong style={{ color: 'var(--color-text-primary)' }}>
            {taskPendingDelete?.name}
          </strong>
          ? This will also remove any updates attached to it. This action
          cannot be undone.
        </p>
      </Modal>

      {/* Delete group confirmation */}
      <Modal
        isOpen={!!groupPendingDelete}
        onClose={() => { if (!deletingGroup) setGroupPendingDelete(null); }}
        title="Delete group?"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setGroupPendingDelete(null)}
              disabled={deletingGroup}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleConfirmDeleteGroup} disabled={deletingGroup}>
              {deletingGroup ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        <p
          className="font-body"
          style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}
        >
          Are you sure you want to delete the group{' '}
          <strong style={{ color: 'var(--color-text-primary)' }}>
            {groupPendingDelete?.name}
          </strong>
          ? This will permanently delete all tasks and updates inside it. This
          action cannot be undone.
        </p>
      </Modal>

      {/* New group modal */}
      <Modal
        isOpen={groupModalOpen}
        onClose={handleCloseGroupModal}
        title="New Group"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={handleCloseGroupModal}
              disabled={creatingGroup}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmitNewGroup}
              disabled={creatingGroup}
            >
              {creatingGroup
                ? 'Creating…'
                : isClientBoard
                ? 'Create & invite'
                : 'Create Group'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitNewGroup} className="flex flex-col gap-3">
          <Input
            label={isClientBoard ? 'Client / group name' : 'Group Name'}
            required
            placeholder={isClientBoard ? 'e.g. Acme Corp' : 'e.g. To Do'}
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            autoFocus
          />
          {isClientBoard && (
            <>
              <Input
                label="Client email (we'll send the invitation)"
                type="email"
                placeholder="client@company.com"
                value={newGroupClientEmail}
                onChange={(e) => setNewGroupClientEmail(e.target.value)}
              />
              {/* Only asked once there's someone to ask about. */}
              {newGroupClientEmail.trim() && (
                <ClientSignInMethodField
                  value={newGroupClientAuth}
                  onChange={setNewGroupClientAuth}
                  disabled={creatingGroup}
                />
              )}
              <p
                className="font-body text-xs"
                style={{ color: 'var(--color-text-muted)', marginTop: -4 }}
              >
                A private portal link is created automatically. Leave the email
                blank to share the link yourself instead.
              </p>
            </>
          )}
          {groupModalError && (
            <p
              className="font-body text-xs"
              style={{ color: 'var(--color-status-stuck)' }}
            >
              {groupModalError}
            </p>
          )}
          {/* Hidden submit so <Enter> submits the form */}
          <button type="submit" className="hidden" aria-hidden="true" />
        </form>
      </Modal>

      {/* Dim overlay for notification highlight */}
      {highlightedTaskId && (
        <div
          className="macan-highlight-overlay"
          onClick={() => setHighlightedTaskId(null)}
        />
      )}

      {/* Floating bulk-action bar (visible while >=1 task is ticked) */}
      {canEdit && (
        <BulkActionBar
          count={selectedTaskIds.size}
          groups={groups}
          busy={bulkBusy}
          members={members}
          onAssign={handleBulkAssign}
          onMoveToGroup={handleBulkMoveToGroup}
          onMoveToMonth={
            isTrackerBoard && canOnBoard('task.move')
              ? () => setMonthMoveTargets(Array.from(selectedTaskIds))
              : undefined
          }
          onDelete={() => setBulkDeleteOpen(true)}
          onClear={handleClearSelection}
        />
      )}

      {/* Bulk delete confirmation */}
      <Modal
        isOpen={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        title={`Delete ${selectedTaskIds.size} ${selectedTaskIds.size === 1 ? 'task' : 'tasks'}?`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={bulkBusy}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleConfirmBulkDelete}
              disabled={bulkBusy}
            >
              {bulkBusy ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        <p
          className="font-body"
          style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}
        >
          This will permanently delete{' '}
          <strong style={{ color: 'var(--color-text-primary)' }}>
            {selectedTaskIds.size}{' '}
            {selectedTaskIds.size === 1 ? 'task' : 'tasks'}
          </strong>{' '}
          and any updates attached to them. This action cannot be undone.
        </p>
      </Modal>

      {/* Task detail panel */}
      <CommentPanel
        task={selectedTask}
        board={board}
        isOpen={!!selectedTask}
        initialTab={initialPanelTab}
        onClose={handleCloseTask}
        isAdmin={canEdit}
        onSharePortal={canSharePortal ? handleSharePortal : undefined}
        onUpdateTask={async (taskId, payload) => {
          // Locate the task in the store so we can roll back on failure.
          // Search both the board buckets and the subitem cache — the panel
          // can be open on either.
          const store = useTaskStore.getState();
          let prev = null;
          for (const list of Object.values(store.tasksByGroup)) {
            if (!Array.isArray(list)) continue;
            const m = list.find((t) => t._id === taskId);
            if (m) {
              prev = m;
              break;
            }
          }
          if (!prev) {
            for (const list of Object.values(store.subitemsByParent)) {
              if (!Array.isArray(list)) continue;
              const m = list.find((t) => t._id === taskId);
              if (m) {
                prev = m;
                break;
              }
            }
          }

          // Apply the change optimistically so the UI feels instant. For
          // `assignedTo` we hydrate the id list into populated member objects
          // so the avatar stack renders without flicker until the server
          // response (with full populate) lands.
          if (prev) {
            const optimisticPatch = { ...payload };
            if (Array.isArray(payload.assignedTo)) {
              const idToMember = new Map(
                (members || []).map((m) => [String(m._id), m])
              );
              optimisticPatch.assignedTo = payload.assignedTo.map(
                (id) =>
                  idToMember.get(String(id)) || {
                    _id: id,
                    name: '',
                  }
              );
            }
            updateTaskLocal({ ...prev, ...optimisticPatch });
          }

          try {
            const updated = await taskService.updateTask(taskId, payload);
            updateTaskLocal(updated);
            return updated;
          } catch (err) {
            if (prev) updateTaskLocal(prev);
            console.error('Failed to update task from panel:', err);
            toastError(
              err?.response?.data?.error ||
                'Failed to update task. Please try again.'
            );
            throw err;
          }
        }}
        onEditLabels={canEdit ? () => setEditChipsModal('labels') : undefined}
        onOpenSubitem={handleOpenSubitem}
        onBack={handleBackInStack}
        canGoBack={selectedTaskStack.length > 1}
        onUpdatesCountChange={setUpdatesCount}
      />

      {/* Group notes panel */}
      <GroupNotesPanel
        isOpen={!!notesGroupId}
        group={groups.find((g) => g._id === notesGroupId) || null}
        canEdit={canEdit}
        onClose={handleCloseNotes}
      />

      {/* Automations */}
      {canOnBoard('automation.view') && (
        <AutomationsModal
          isOpen={automationsOpen}
          onClose={() => setAutomationsOpen(false)}
          boardId={boardId}
          board={board}
          groups={groups}
          members={members}
          isAdmin={canOnBoard('automation.manage')}
        />
      )}

      {/* Activity export (opt-in feature + capability, both re-checked server-side) */}
      {canExportActivity && (
        <ExportActivityModal
          isOpen={exportOpen}
          onClose={() => setExportOpen(false)}
          board={board}
        />
      )}

      {/* Trackers config, reachable from the header without leaving the board
          view. The Delivery tab mounts its own copy for the same reason the
          board header carries one: whichever surface you are on, the rules are
          one click away. */}
      {canManageTrackers && trackersOpen && (
        <TrackersModal
          isOpen
          onClose={() => setTrackersOpen(false)}
          boardId={boardId}
          groups={groups}
          canManage={canManageTrackers}
        />
      )}

      {/* Share / access management (private boards: owner + editors) */}
      {canViewAccess && (
        <BoardAccessModal
          board={board}
          isOpen={accessModalOpen}
          onClose={() => setAccessModalOpen(false)}
          isOwner={isBoardCreator}
          canManage={canManageAccess}
        />
      )}

      {/* Client Portal link management (client boards, managers only) */}
      {clientPortalGroup && (
        <ClientPortalModal
          groupId={clientPortalGroup._id}
          groupName={clientPortalGroup.name}
          onClose={() => setClientPortalGroup(null)}
        />
      )}
    </PageWrapper>
  );
};

export default BoardDetailPage;

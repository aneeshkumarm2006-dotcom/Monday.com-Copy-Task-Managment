import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity,
  ArrowDownUp,
  Blocks,
  CalendarCheck,
  CalendarRange,
  ChevronRight,
  Download,
  Globe,
  GripVertical,
  LayoutList,
  Lock,
  Plus,
  SearchX,
  Settings as SettingsIcon,
  ShieldCheck,
  Target,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
  Zap,
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
import ErrorBoundary from '../components/ui/ErrorBoundary';
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
import VaultTab from '../components/vault/VaultTab';
import AddonsTab from '../components/board/addons/AddonsTab';
import ConnectorDataTab from '../components/board/addons/connector/ConnectorDataTab';
import SeoDashboardTab from '../components/board/addons/seo/SeoDashboardTab';
import AdsBudgetTab from '../components/board/adsbudget/AdsBudgetTab';
import {
  gateSignature,
  resolveView,
  resolveViewTabs,
} from '../utils/boardViewTabs';
import useBoardConnectors from '../hooks/useBoardConnectors';
import MonthSelector from '../components/board/MonthSelector';
import MoveToMonthModal from '../components/board/MoveToMonthModal';
import useBoardMonths from '../hooks/useBoardMonths';
import useBoardMembers from '../hooks/useBoardMembers';
import { moveTasksToMonth } from '../services/monthService';
import { findMonth, formatMonthKey } from '../utils/monthKeys';
import { recordBoardVisit } from '../utils/boardVisits';
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
  hasActiveTaskFilters,
  hasActiveGroupFilters,
  taskMatchesFilters,
  groupMatchesFilters,
} from '../utils/taskFilters';
import { isStatusDone } from '../utils/statusUtils';
import {
  loadPersonalPins,
  savePersonalPins,
  isTaskPinned,
  sortPinnedFirst,
} from '../utils/taskPins';
import { buildTaskLinks } from '../utils/taskLink';

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
  // Vault is the one tab that is NOT tied to a board type — every board can hold
  // credentials. On a standard board it is therefore the SECOND tab, which is
  // what makes the tab bar appear there for the first time. That is intended:
  // the bar exists to switch between views, and there are now two.
  { value: 'vault', label: 'Vault', icon: ShieldCheck, visible: (g) => g.canViewVault },
  // Add-ons is the BOARD half of connectors — which external projects feed which
  // group. The ACCOUNT half lives in Settings, once, for the whole workspace.
  // Tracker-only, like Delivery and Goals: a connector pulls a time series into
  // a month-partitioned board, and there is nowhere for it to land otherwise.
  { value: 'addons', label: 'Add-ons', icon: Blocks, visible: (g) => g.canViewAddons },
  // Ads Budget is the first add-on that is NOT a connector: nothing is fetched,
  // nothing is billed, every figure is typed in. It is therefore the first tab
  // whose visibility depends on a per-board SWITCH as well as a board type and
  // a capability — a board with the add-on off has no budgets to show, so the
  // tab is absent rather than empty.
  { value: 'adsbudget', label: 'Ads Budget', icon: Wallet, visible: (g) => g.canViewAdsBudget },
  // The DATA half of connectors — the readings themselves, as opposed to
  // Add-ons, which is the wiring. It appears only once a connector is actually
  // switched on for this board, because until then there is nothing in it.
  //
  // One entry, not one per provider: `connectorProvider` below names whichever
  // connector is enabled, and the tab renders its sections from the kind catalog
  // the SERVER sends. A second provider is a second entry here and no change to
  // the tab. A board with two enabled connectors shows the first; splitting them
  // into two tabs is the change to make when that actually happens rather than
  // in anticipation of it.
  {
    value: 'connector',
    label: (g) => g.connectorLabel || 'Data',
    icon: Activity,
    visible: (g) => g.canViewAddons && !!g.connectorProvider,
  },
  /**
   * The second connector tab, and the reason there is a second one.
   *
   * A provider that declares dashboard SCREENS gets this; one that does not
   * gets the generic per-kind tab above. That is the whole of the
   * `enabledConnectors[0]` fix: a board with both providers switched on used to
   * show whichever came back from the server first and drop the other
   * completely, with no way to reach it.
   *
   * Nothing here names a provider. `seoProvider` is whichever enabled connector
   * declares screens, and the tab titles itself from `seoLabel`, so a third
   * dashboard-shaped provider needs no change to this table.
   */
  {
    value: 'seo',
    label: (g) => g.seoLabel || 'SEO',
    icon: TrendingUp,
    visible: (g) => g.canViewSeo,
  },
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
  const fetchMembers = useOrgStore((s) => s.fetchMembers);
  // THE roster every picker on this page renders: the people who can actually
  // read THIS board, resolved server-side. Not `useOrgStore.members` — that is
  // the whole workspace, and on a private board it listed people who are not on
  // it, whom the server then refused to accept as assignees.
  const members = useBoardMembers(boardId);
  const boards = useBoardStore((s) => s.boards);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);
  const getBoardById = useBoardStore((s) => s.getBoardById);
  const updateBoardLocal = useBoardStore((s) => s.updateBoardLocal);

  const groups = useTaskStore((s) => s.groups);
  const tasksByGroup = useTaskStore((s) => s.tasksByGroup);
  const notesCountByGroup = useTaskStore((s) => s.notesCountByGroup);
  const loading = useTaskStore((s) => s.loading);
  const fetchBoardData = useTaskStore((s) => s.fetchBoardData);
  const clearTasks = useTaskStore((s) => s.clear);
  const addTaskLocal = useTaskStore((s) => s.addTask);
  const setGroupTasksLocal = useTaskStore((s) => s.setGroupTasks);
  const updateTaskLocal = useTaskStore((s) => s.updateTask);
  const lastStatusChange = useTaskStore((s) => s.lastStatusChange);
  const clearLastStatusChange = useTaskStore((s) => s.clearLastStatusChange);
  const goalOpenRequest = useTaskStore((s) => s.goalOpenRequest);
  const clearGoalOpenRequest = useTaskStore((s) => s.clearGoalOpenRequest);
  // Set to a task id when finishing that task is what opened the detail panel,
  // so the panel can take the user to its Goal section. Cleared on close.
  const [goalFocusTaskId, setGoalFocusTaskId] = useState(null);
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
  // status, priority, label, due date, and assignee — plus, on tracker boards,
  // the group's owner, which hides whole groups. See utils/taskFilters.js.
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  // --- Group sort ("completed last") -------------------------------------
  // View-only toggle that pushes fully-done (green) groups to the bottom and
  // floats groups with remaining work to the top. Never touches the persisted
  // TaskGroup.order — it's applied only to the render order. Remembered per
  // board in localStorage.
  const [sortCompletedLast, setSortCompletedLast] = useState(false);

  // "Working here" hold for that sort. Ticking tasks off inside an OPEN group
  // would otherwise slide the group down (or straight to the bottom) mid-click,
  // so the user has to chase it to carry on. A group whose completion changes
  // while it's expanded therefore keeps sorting on the numbers it had BEFORE
  // the change. We freeze the METRIC, not the index, so the sort stays a clean
  // total order instead of two rules fighting over one slot. The hold is
  // released when the user closes (collapses) the group, and on any
  // board/month/sort-mode change. Map<groupId, {complete, pct}>.
  const [heldGroupMetrics, setHeldGroupMetrics] = useState(() => new Map());

  const releaseGroupHold = useCallback((groupId) => {
    const gid = String(groupId);
    setHeldGroupMetrics((cur) => {
      if (!cur.has(gid)) return cur;
      const next = new Map(cur);
      next.delete(gid);
      return next;
    });
  }, []);

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

  // Adding a row is the `contribute` rung, NOT `edit`. These were one bit for a
  // while and it silently broke the whole middle of the ladder: a plain member
  // on a public board opening at `contribute` holds `task.create` — the server
  // happily accepts the POST — but the inline "new task" row was gated on
  // `canEdit`, so it never rendered and there was no way to reach the endpoint.
  // Anyone who was the org OWNER (and therefore `edit` everywhere) never saw it.
  const canCreateTasks = canOnBoard('task.create');

  // Putting a task on SOMEONE ELSE is the `edit` rung's `task.assign`. Putting
  // your own name on it is not — the server lets any contributor move their own
  // name in or out (see requireAssignCapability / isSelfClaim in
  // taskController). The picker has to draw that same line or a contributor
  // ticks a box and gets a 403 toast, which is exactly what it used to do.
  const canAssignOthers = canOnBoard('task.assign');
  const selfId = currentUser?._id ? String(currentUser._id) : null;

  // Opening the picker at all needs one of the two: the power to assign anyone
  // (`edit`), or the power to work on your own tasks (`contribute`), which is
  // what the self-assign carve-out hangs off. A view- or comment-rung member
  // has neither, so the Owner cell stays inert for them rather than opening a
  // menu in which every single row is greyed out.
  const canOpenAssignees = canAssignOthers || canOnBoard('task.edit_assigned');

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
  // Deliberately the SAME gate as setting a target, not a coincidence to be
  // tidied apart later: the columns are part of the goals schema. They used to
  // need org-admin, which locked a board's own creator out of their own board's
  // columns — see goalColumnController for the whole story.
  const canManageGoalColumns = canManageGoals;

  // The People tab opens for anyone who can read the goals. WHAT it shows then
  // narrows server-side rather than here: without `productivity.view_others` the
  // endpoint returns only your own row, and without `tracker.view` the delivery
  // half is absent. Gating the tab itself on those would hide a page people are
  // allowed to see a version of.
  const canViewScoreboard = canViewGoals;

  // The vault answers to capability alone — no board type, no extra-feature
  // switch. A standard board's production credentials are exactly as worth
  // protecting as a tracker board's.
  //
  // `vault.view` sits on the BOTTOM rung of the board ladder, so this opens the
  // tab to anyone who can read the board — and opens nothing else. Every item
  // arrives encrypted and stays that way without the vault password, which the
  // server never has. Writing is a different question with a different answer:
  // `vault.manage` is still `edit`-only, and the tab's own controls follow the
  // server's answer rather than this flag.
  const canViewVault = canOnBoard('vault.view');

  // Add-ons: board type AND capability, the same shape as Delivery and Goals.
  //
  // `connector.view` sits on the bottom rung of the board ladder because nothing
  // this tab renders costs anything — every row comes out of our own database.
  // Reaching the provider is `connector.manage`, and the tab asks the server for
  // that answer rather than trusting this flag: mapping a project decides whose
  // numbers land on whose row, and Refresh spends a quota shared by the whole
  // workspace.
  //
  // The OR is not decoration. The tab now also holds the Ads Budget switch,
  // which answers to its own capability — and roles are DATA in this app, so a
  // custom role really can grant one of the two and not the other. Keying the
  // whole tab on `connector.view` alone would strand that switch, and with it
  // the only way to turn the add-on on.
  const canViewAddons =
    isTrackerBoard && (canOnBoard('connector.view') || canOnBoard('adsBudget.view'));
  const canManageConnectors = canViewAddons && canOnBoard('connector.manage');

  // Which connectors this board has switched on. Reads our own database only —
  // that is why `connector.view` is on the bottom rung of the board ladder and
  // why this is safe on every board load. Gated on `canViewAddons` so a standard
  // board, or a reader without the capability, makes no request at all.
  /**
   * Ads Budget: board type AND capability AND the board's own switch.
   *
   * The third condition is what makes this an ADD-ON rather than a surface of
   * the board type. Delivery and Goals appear on every tracker board because a
   * month-partitioned board always has commitments and targets; a board that
   * runs no advertising has no budgets, and a permanently empty tab is worse
   * than an absent one. The switch lives in Add-ons.
   *
   * `board.adsBudget` is two fields on the board document rather than a second
   * request, so the tab is decided on first paint and does not flicker in.
   */
  const adsBudgetOn = !!board?.adsBudget?.enabled;
  const canViewAdsBudget = isTrackerBoard && adsBudgetOn && canOnBoard('adsBudget.view');
  // Recording spend sits a rung below deciding the allocation, exactly as
  // `goal.track` sits below `goal.manage`. The tab shows the inline spend field
  // to the first and the Add / Edit / Delete controls to the second; the server
  // re-checks both from the body of every write.
  const canTrackAdsBudget = canViewAdsBudget && canOnBoard('adsBudget.track');
  const canManageAdsBudget = canViewAdsBudget && canOnBoard('adsBudget.manage');
  // The SWITCH itself answers to `adsBudget.manage` but NOT to `adsBudgetOn` —
  // turning the add-on on necessarily happens while it is off.
  const canManageAdsBudgetSettings = isTrackerBoard && canOnBoard('adsBudget.manage');

  const { enabledConnectors } = useBoardConnectors(boardId, { enabled: canViewAddons });

  /**
   * WHICH connector goes in WHICH tab — and the end of `enabledConnectors[0]`.
   *
   * That expression was written when there was one provider, and it silently
   * became a bug the moment there were two: a board with both switched on
   * rendered whichever the server happened to return first and made the other
   * completely unreachable, with no error and nothing on screen to suggest
   * anything was missing.
   *
   * The split is by CAPABILITY rather than by name. A provider that declares
   * dashboard screens (`availableScreens`) gets the SEO tab; one that declares
   * none gets the generic tab, which renders a section per snapshot kind. So the
   * two coexist, a third provider lands in one of the two by what it declares,
   * and neither this file nor either tab learns a provider's name.
   *
   * `[0]` survives WITHIN each group, and that residue is deliberate: two
   * dashboard-shaped providers on one board is not a thing that exists, and the
   * honest fix on the day it does is a picker inside the tab rather than an
   * unbounded row of tabs.
   */
  const dataConnector =
    enabledConnectors.find((c) => !c.availableScreens?.length) || null;
  const seoConnector =
    enabledConnectors.find((c) => c.availableScreens?.length > 0) || null;

  const connectorProvider = dataConnector?.name || null;
  const connectorLabel = dataConnector?.label || null;
  const seoProvider = seoConnector?.name || null;
  const seoLabel = seoConnector?.label || null;

  /**
   * The gate key the SEO tab's `visible` predicate reads.
   *
   * Same capability as the other connector tab — nothing either renders costs
   * anything, because every row comes out of our own database — and the same
   * board-type requirement, since a connector pulls a time series into a
   * month-partitioned board and has nowhere to land otherwise.
   */
  const canViewSeo = canViewAddons && !!seoProvider;

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
  /**
   * Everything a tab's `visible` predicate is allowed to ask about.
   *
   * Rebuilt every render — it is eight primitives — and deliberately NOT
   * memoised: `gateSignature` below is what stops the resolution being redone,
   * and a memo on the gate itself would need the same dependency array this
   * change exists to delete.
   *
   * ADDING A TAB THAT READS A KEY THAT IS NOT HERE NOW THROWS BY NAME.
   * `resolveViewTabs` reads this object through a Proxy, so the old failure —
   * predicate returns `undefined`, `undefined` is falsy, tab silently vanishes,
   * `?view=x` falls back to the board, and the feature looks unshipped — is
   * impossible. See `utils/boardViewTabs.js`, and `boardViewTabs.test.mjs` for
   * the property asserted against synthetic tables rather than against this one.
   */
  const gate = {
    canViewDelivery,
    canViewGoals,
    canViewScoreboard,
    canViewVault,
    canViewAddons,
    connectorProvider,
    connectorLabel,
    canViewSeo,
    seoProvider,
    seoLabel,
    canViewAdsBudget,
  };

  /**
   * The memo's dependency, DERIVED rather than hand-maintained.
   *
   * The third edit this registration used to need was extending a literal
   * dependency array, and forgetting it failed differently and worse: the tab
   * appeared only once some unrelated state changed, so it worked in
   * development — where something always changes — and not on a cold production
   * load. There is nothing left to forget.
   */
  const gateKey = gateSignature(gate);

  const visibleTabs = useMemo(
    () => resolveViewTabs(VIEW_TABS, gate),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateKey]
  );

  // Derived from the URL rather than mirrored into state — two sources of truth
  // for "which view am I on" is the classic bug here, and `?view=delivery` is
  // also the thing worth pasting to a colleague.
  //
  // Validated against `visibleTabs` rather than hardcoding one tab's name, so
  // an unknown value, or `?view=goals` on a standard board, or a board that has
  // not loaded yet, all fall back to the board view instead of rendering a tab
  // that is not there.
  const view = resolveView(searchParams.get('view'), visibleTabs);
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

  // Log the visit for the dashboard's "Recent Boards" card.
  //
  // Gated on `board` rather than on the route param: the store is filled from
  // the permission-filtered board list, so a board being present here means the
  // server already agreed this user may see it. Landing on a board you cannot
  // read therefore records nothing.
  //
  // Keyed on the board's OWN organisation, not `currentOrg`, so the entry lands
  // in the right bucket even if the org store is still hydrating.
  useEffect(() => {
    const visitOrgId = board?.organisation || orgId;
    if (!board?._id || !visitOrgId) return;
    recordBoardVisit(visitOrgId, board._id);
  }, [board?._id, board?.organisation, orgId]);

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

  // Fetch ORG members — the whole workspace. The pickers no longer read this
  // (they read `members` above, the board's own roster): what is left needing it
  // is the Share modal, which grants access to people who are BY DEFINITION not
  // on the board yet, plus the @mention list and the activity-log actor filter.
  //
  // Deliberately NOT widened any further than the three roles below. Everyone
  // else — viewers included — still gets each group's owner populated on the
  // group document itself, so they see the name and avatar without ever
  // receiving the workspace roster.
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
  // Two flavours, and the difference matters below: a TASK filter subsets the
  // rows inside a group (so reordering or creating into that subset would write
  // a bogus order), while the GROUP-owner filter only removes whole groups and
  // leaves every surviving group's row list exactly as it was.
  const taskFiltersActive = hasActiveTaskFilters(filters);
  const groupFiltersActive = hasActiveGroupFilters(filters);

  // Apply the active filters per group. When nothing is active we hand back
  // the original buckets untouched so unfiltered boards skip the work.
  const filteredTasksByGroup = useMemo(() => {
    if (!filtersActive) return tasksByGroup;
    const now = new Date();
    const groupById = new Map(groups.map((g) => [String(g._id), g]));
    const out = {};
    for (const [gid, list] of Object.entries(tasksByGroup)) {
      // A group cut out by the owner filter contributes nothing — its tasks are
      // never even tested, which is also what keeps `matchedTaskCount` honest.
      if (!groupMatchesFilters(groupById.get(String(gid)), filters)) {
        out[gid] = [];
        continue;
      }
      out[gid] = taskFiltersActive
        ? (list || []).filter((t) => taskMatchesFilters(t, filters, now, board))
        : list || [];
    }
    return out;
  }, [tasksByGroup, groups, filters, filtersActive, taskFiltersActive, board]);

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

  // Whether a group appears at all under the current filters. Two rules, and
  // they are not the same rule: the owner filter removes a group outright,
  // while an emptied group is only hidden when a TASK filter did the emptying.
  // A group-owner filter on its own therefore keeps a task-less group on
  // screen — answering "which groups does she own?" by quietly dropping the
  // empty ones would be a wrong answer, not a tidier one.
  const isGroupVisible = useCallback(
    (group) => {
      if (!groupMatchesFilters(group, filters)) return false;
      if (taskFiltersActive && (filteredTasksByGroup[group._id] || []).length === 0)
        return false;
      return true;
    },
    [filters, taskFiltersActive, filteredTasksByGroup]
  );

  // Drives the "nothing matched" empty state. The matched TASK count can't:
  // it is legitimately 0 while an owned-but-empty group is showing.
  const visibleGroupCount = useMemo(
    () => (filtersActive ? groups.filter(isGroupVisible).length : groups.length),
    [groups, filtersActive, isGroupVisible]
  );

  // Completion metric per group, read from the same filtered buckets the
  // progress bars render from. Split out of `orderedGroups` so the hold below
  // can freeze a snapshot of exactly the numbers the user can see.
  const groupMetrics = useMemo(() => {
    const out = new Map();
    for (const group of groups) {
      const list = filteredTasksByGroup[group._id] || [];
      const total = list.length;
      const done = list.filter(
        (t) => t.status != null && isStatusDone(board, t.status)
      ).length;
      out.set(String(group._id), {
        complete: total > 0 && done === total, // green == 100% AND non-empty
        pct: total === 0 ? 0 : done / total,
      });
    }
    return out;
  }, [groups, filteredTasksByGroup, board]);

  // The metrics we last sorted on, tagged with the board/month they describe.
  const settledMetricsRef = useRef({ key: null, metrics: null });

  // Take (and drop) the "working here" holds. This is a LAYOUT effect so the
  // corrected order is committed before the browser paints — the group never
  // visibly jumps and snaps back.
  useLayoutEffect(() => {
    const key = `${boardId}:${monthKey || ''}`;
    const settled = settledMetricsRef.current;
    const previous = settled.key === key ? settled.metrics : null;
    settledMetricsRef.current = { key, metrics: groupMetrics };

    // Sort off, or a fresh board/month: nothing to hold, and any existing hold
    // describes a view we've already left.
    if (!sortCompletedLast || !previous) {
      setHeldGroupMetrics((cur) => (cur.size ? new Map() : cur));
      return;
    }

    // Only a SINGLE group changing reads as "the user is working in here". A
    // filter flip, a refetch or a month switch moves many at once and must
    // still re-sort normally.
    const changed = [];
    for (const [gid, metric] of groupMetrics) {
      const before = previous.get(gid);
      if (!before) continue; // brand-new group — let it sort on its real numbers
      if (before.complete === metric.complete && before.pct === metric.pct) continue;
      changed.push([gid, before]);
    }

    setHeldGroupMetrics((cur) => {
      let next = null;
      // Forget groups that are no longer on the board at all.
      for (const gid of cur.keys()) {
        if (groupMetrics.has(gid)) continue;
        next = next || new Map(cur);
        next.delete(gid);
      }
      if (changed.length === 1) {
        const [gid, before] = changed[0];
        // A collapsed group isn't one the user is inside, and an existing hold
        // keeps its ORIGINAL snapshot — otherwise the second tick would rewrite
        // it to the position the first tick already earned.
        if (!collapsed.has(gid) && !cur.has(gid)) {
          next = next || new Map(cur);
          next.set(gid, before);
        }
      }
      return next || cur;
    });
  }, [groupMetrics, sortCompletedLast, collapsed, boardId, monthKey]);

  // Render order for the groups. When "completed last" is off we return the
  // original array untouched (server order). When on, fully-done groups (green
  // progress bar) sink to the bottom and groups with remaining work rise to the
  // top — sorted on the same filtered buckets the progress bars render from, so
  // the ordering always matches the colored bar the user sees. A group the user
  // is currently working in sorts on its HELD metric instead, so ticking tasks
  // off doesn't move it out from under the cursor. This is purely a display
  // transform; the persisted TaskGroup.order is never changed.
  const orderedGroups = useMemo(() => {
    if (!sortCompletedLast) return groups;
    const meta = groups.map((group, idx) => {
      const gid = String(group._id);
      const metric =
        heldGroupMetrics.get(gid) ||
        groupMetrics.get(gid) || { complete: false, pct: 0 };
      return { group, idx, complete: metric.complete, pct: metric.pct };
    });
    meta.sort((a, b) => {
      if (a.complete !== b.complete) return a.complete ? 1 : -1; // done groups last
      if (a.pct !== b.pct) return a.pct - b.pct; // least-done rises highest
      return a.idx - b.idx; // stable: preserve manual order within a tier
    });
    return meta.map((m) => m.group);
  }, [groups, sortCompletedLast, groupMetrics, heldGroupMetrics]);

  const orderedGroupIds = useMemo(
    () => orderedGroups.map((g) => g._id),
    [orderedGroups]
  );

  const toggleGroup = (groupId) => {
    // Closing the group is the signal that the user has finished working in
    // it, so it gives up its held sort position and drops into its real slot.
    if (!collapsed.has(groupId)) releaseGroupHold(groupId);
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
    // Opening a row by hand is not the on-done ask, even if it is the same row.
    setGoalFocusTaskId(null);
  };

  const handleCloseTask = () => {
    setSelectedTaskStack([]);
    setInitialPanelTab(null);
    setGoalFocusTaskId(null);
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

  /**
   * Turn "a status just changed" into "should we ask what it was for?".
   *
   * The store records the transition because it is the one place holding both
   * the old row and the new one — every done path (the row chip, the detail
   * panel, the flexible-columns cell) funnels through it. It cannot decide
   * whether the new status MEANS done, because that lives in board.statuses;
   * this is where that gets resolved.
   *
   * Consumed immediately, so one change asks once. The optimistic paths call
   * the store twice for a single click (once optimistically, then with the
   * server reply); the second call sees from === done and records nothing.
   *
   * The ask is now the DETAIL PANEL, opened on the finished task and pointed at
   * its Goal section — not the bottom-right card this used to raise. One place
   * answers the question, whether you are finishing the task or repairing the
   * answer a week later.
   */
  useEffect(() => {
    if (!lastStatusChange) return;
    clearLastStatusChange();
    if (!isTrackerBoard || !board) return;
    const { taskId, from, to } = lastStatusChange;
    if (isStatusDone(board, from) || !isStatusDone(board, to)) return;

    const store = useTaskStore.getState();
    let found = null;
    for (const list of Object.values(store.tasksByGroup)) {
      if (!Array.isArray(list)) continue;
      const m = list.find((t) => t._id === taskId);
      if (m) { found = m; break; }
    }
    // Subitems carry no evidence, and a task with no month has no goals to
    // point at.
    if (!found || found.parent || !found.monthKey) return;
    // The rule that stops this being a nag: if nobody set a goal for this
    // group this month there was nothing to attach to, so do not ask.
    if (!(store.groupsWithGoals || []).includes(String(found.group))) return;
    // Already attributed — the question has an answer, and opening the panel
    // over the board to show it would be an interruption, not a prompt.
    if (Array.isArray(found.goalLinks) && found.goalLinks.length > 0) return;

    setSelectedTaskStack([found._id]);
    setGoalFocusTaskId(found._id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStatusChange]);

  /**
   * Someone clicked the goal marker on a row: open that task on its Goal
   * section. The same destination as the on-done prompt above, reached
   * deliberately rather than as a consequence of finishing something — which is
   * the whole point, since a task nobody has finished yet shows no prompt.
   */
  useEffect(() => {
    if (!goalOpenRequest) return;
    clearGoalOpenRequest();
    setSelectedTaskStack([goalOpenRequest]);
    setGoalFocusTaskId(goalOpenRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalOpenRequest]);
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
    if (!currentUser || !canOpenAssignees) return;
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

  // --- Bulk copy links --------------------------------------------------
  // Read-only companion to the detail panel's single copy-link button: the
  // same per-task URL, one per line, for every ticked row. Ordered the way the
  // board reads (group order, then row order) rather than by tick order, so
  // pasting a selection of twenty produces a list the recipient can follow.
  //
  // Returns true only when the clipboard actually took the text — the bar's
  // "Copied" tick is driven off that, and clipboard writes are refused outside
  // a secure context.

  const handleBulkCopyLinks = useCallback(async () => {
    const ordered = [];
    for (const group of orderedGroups) {
      for (const task of tasksByGroup[group._id] || []) {
        if (!selectedTaskIds.has(task._id)) continue;
        // A board task's `board` is a bare id here (the board list endpoint
        // does not populate it), so hand buildTaskLink the one we're on.
        ordered.push({ ...task, board: task.board || boardId });
      }
    }
    const links = buildTaskLinks(ordered);
    if (links.length === 0) {
      toastError('None of the selected tasks have a shareable link.');
      return false;
    }
    const text = links.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toastSuccess(
        links.length === 1
          ? 'Task link copied.'
          : `${links.length} task links copied — one per line.`
      );
      return true;
    } catch {
      // Same fallback as the detail panel: show the text so it can be copied
      // by hand rather than leaving a button that silently does nothing.
      toastInfo(text);
      return false;
    }
  }, [
    orderedGroups,
    tasksByGroup,
    selectedTaskIds,
    boardId,
    toastSuccess,
    toastError,
    toastInfo,
  ]);

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
      await reorderTasksAction(targetGroupId, nextOrder, { month: monthKey });
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
  // while TASK filters are active — reordering a filtered subset would write a
  // bogus order back to the full list. The group-owner filter is deliberately
  // NOT in here: it never subsets a group's rows, so dragging one is still safe.
  const dndDisabledGlobal =
    creatingInGroup != null || editingTaskId != null || taskFiltersActive;
  // Group reordering additionally can't happen while the "completed last" sort
  // is active: the displayed order no longer matches the persisted `groups`
  // array, so a drop would write a scrambled order. Filtering groups by owner
  // hides some of them and so has exactly the same problem. Task drag within a
  // group is unaffected and keeps using `dndDisabledGlobal`.
  const groupDndDisabled =
    dndDisabledGlobal || sortCompletedLast || groupFiltersActive;

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
        reorderTasksAction(targetGroupId, next.map((t) => t._id), {
          month: monthKey,
        }).catch((err) => {
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
      reorderTasksAction(targetGroupId, nextTargetIds, { month: monthKey }).catch((err) => {
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
            {/* A public board needs no sharing — everyone is already in it — so
                the button stays hidden there for everyone EXCEPT its owner, who
                reaches Transfer ownership through this modal and would otherwise
                have no way to hand a public board over at all. */}
            {canViewAccess && (!isPublic || isBoardCreator) && (
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
          // Wraps rather than scrolls: a scroll container here hides tabs behind
          // a gesture nobody knows to make, and on touch it steals the swipe.
          // With four short tabs a second row is the honest fallback.
          className="mt-5 flex flex-wrap items-center gap-1"
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

      {/* Every tab gets its own boundary, keyed on the view. A tab that throws
          then loses only itself — the header and the tab bar stay on screen, so
          you can switch away from it instead of staring at a white page. */}
      {view === 'goals' && (
        <ErrorBoundary label="Goals" resetKey={view}>
          <GoalsTab
            boardId={boardId}
            monthKey={monthKey}
            monthLabel={selectedMonth?.label}
            canTrack={canTrackGoals}
            canManage={canManageGoals}
            canManageColumns={canManageGoalColumns}
            // Only offers the link control on each row. Pointing a goal at a
            // tracked keyword is connector wiring — the same act as saying which
            // project feeds which group — and writes nothing to a goal, which is
            // why it is `connector.manage` and not one of the three above.
            canLinkConnector={canManageConnectors}
            // A goal chip lists the work behind it; clicking a row has to LAND
            // on that work. Same params the deep links use (utils/taskLink.js),
            // so there is one way to reach a task. Carrying the task's own
            // month matters here: a task refiled into September must open on
            // September's board, not on one that does not contain it.
            onOpenTask={(task) => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('view', 'board');
                next.set('highlightTask', String(task._id));
                if (task.parent) next.set('highlightParent', String(task.parent));
                if (task.monthKey) next.set('month', task.monthKey);
                next.set('openTab', 'updates');
                return next;
              });
            }}
            onGoalsChanged={refreshMonths}
          />
        </ErrorBoundary>
      )}

      {view === 'vault' && (
        <ErrorBoundary label="Vault" resetKey={view}>
          {/* The tab holds the decrypted vault key in memory, so it is
              deliberately NOT kept mounted across tab switches — unmounting is
              what locks it. See VaultTab's cleanup. */}
          <VaultTab boardId={boardId} boardName={board?.name} />
        </ErrorBoundary>
      )}

      {view === 'adsbudget' && (
        <ErrorBoundary label="Ads Budget" resetKey={view}>
          <AdsBudgetTab
            boardId={boardId}
            boardName={board?.name}
            // The board's own groups — a tracker board holds one client per
            // group, so these ARE the clients the roster lists.
            groups={groups}
            monthKey={monthKey}
            monthLabel={selectedMonth?.label}
            canTrack={canTrackAdsBudget}
            canManage={canManageAdsBudget}
          />
        </ErrorBoundary>
      )}

      {view === 'addons' && (
        <ErrorBoundary label="Add-ons" resetKey={view}>
          <AddonsTab
            boardId={boardId}
            // The board's own groups — mapping is project-to-GROUP, because one
            // Ubersuggest project is one domain and this board holds a client
            // per group.
            groups={groups}
            canManage={canManageConnectors}
            // Only enables the "Add a column for this" shortcut inside the
            // field-mapping panel — the mapping itself is `connector.manage`,
            // because nothing about it writes to a goal. Creating a column does.
            canManageGoalColumns={canManageGoalColumns}
            // The non-connector half of this tab: the Ads Budget switch. Its
            // own capability, and deliberately NOT gated on the add-on already
            // being on — turning it on happens while it is off.
            adsBudget={board?.adsBudget}
            canManageAdsBudget={canManageAdsBudgetSettings}
            // Patch the store's copy rather than refetching the whole board
            // list: the tab bar is derived from `board.adsBudget.enabled`, so
            // the new tab has to appear the moment the switch settles, and a
            // round trip would leave it missing for a beat after the toggle.
            onAdsBudgetChanged={(next) =>
              board && updateBoardLocal({ ...board, adsBudget: next })
            }
          />
        </ErrorBoundary>
      )}

      {view === 'connector' && connectorProvider && (
        <ErrorBoundary label={connectorLabel || 'Connector'} resetKey={view}>
          {/* Reads snapshots out of our own database and never contacts the
              provider — quota is finite and shared across the whole workspace,
              and it is spent on FETCH, never on view. Refresh is a button inside
              the tab, gated server-side on `connector.manage`. */}
          <ConnectorDataTab
            boardId={boardId}
            provider={connectorProvider}
            providerLabel={connectorLabel}
          />
        </ErrorBoundary>
      )}

      {view === 'seo' && seoProvider && (
        <ErrorBoundary label={seoLabel || 'SEO'} resetKey={view}>
          {/* Reads snapshots, budget documents and our own task ledger out of
              this database and NEVER contacts the provider. On this one that is
              a stronger rule than it was on the first: it bills at the moment a
              collection is ordered, so a tab that fetched on mount would buy
              SERPs on a page load, per viewer, per render. */}
          <SeoDashboardTab
            boardId={boardId}
            provider={seoProvider}
            providerLabel={seoLabel}
          />
        </ErrorBoundary>
      )}

      {view === 'people' && (
        <ErrorBoundary label="People" resetKey={view}>
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
        </ErrorBoundary>
      )}

      {view === 'delivery' && (
        <ErrorBoundary label="Delivery" resetKey={view}>
        <DeliveryTab
          boardId={boardId}
          groups={groups}
          monthKey={monthKey}
          canManage={canManageTrackers}
          onOpenTask={(taskId) => {
            // Reuse the existing deep-link machinery rather than inventing a
            // second way to reveal a task.
            //
            // MERGE into the existing params, never replace them: `?month=` is
            // the source of truth for which month this board is showing, and
            // the month seed in useBoardMonths only runs once per board, so
            // dropping it here leaves the board with no month at all — an empty
            // "Pick a month" board with none of its groups loaded. Deleting
            // `view` is what sends us back to the board (see setView).
            setSearchParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                next.delete('view');
                next.set('highlightTask', taskId);
                // Delivery only ever counts top-level tasks, so any parent id
                // still on the URL is stale from an earlier jump.
                next.delete('highlightParent');
                return next;
              },
              { replace: true }
            );
          }}
        />
        </ErrorBoundary>
      )}

      {/* Filter bar + group sort toggle */}
      {view === 'board' && hasGroups && board && (
        <div className="flex flex-col md:flex-row md:items-start gap-2">
          <div className="flex-1 min-w-0">
            <BoardFilterBar
              board={board}
              allTasks={allTasks}
              groups={groups}
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
        ) : filtersActive && visibleGroupCount === 0 ? (
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
              title={
                groupFiltersActive && !taskFiltersActive
                  ? 'No groups match your filters'
                  : 'No tasks match your filters'
              }
              description="Try removing or loosening a filter to see more."
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
                // Filtered out by owner, or emptied by a task filter. `idx` is
                // still the ORDERED index, so the header dot colours don't
                // reshuffle as groups come and go.
                if (filtersActive && !isGroupVisible(group)) return null;
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
                              isCreating={canCreateTasks && !taskFiltersActive}
                              createKey={newTaskKeysByGroup[group._id] || 0}
                              isAdmin={canEdit}
                              canCreate={canCreateTasks}
                              canAssign={canAssignOthers}
                              selfId={selfId}
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
          canAssignOthers={canAssignOthers}
          selfId={selfId}
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
          onCopyLinks={handleBulkCopyLinks}
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
        // Tracker boards: the panel writes evidence through its own endpoint,
        // not the generic task PUT, so the store has to be told separately or
        // the row keeps the marker it had before.
        onTaskPatched={(updated) => updated && updateTaskLocal(updated)}
        // Tracker boards: "you just finished this — what was it for?". Only set
        // when finishing the task is what opened the panel, and only while that
        // same task is the one on screen, so stepping into a subitem or opening
        // another row does not re-ring the section.
        focusGoalToken={
          goalFocusTaskId && selectedTask?._id === goalFocusTaskId
            ? goalFocusTaskId
            : null
        }
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  LayoutGrid,
  List as ListIcon,
  Folder,
  FolderOpen,
  Lock,
  Globe,
  MoreHorizontal,
  Calendar as CalendarIcon,
  GripVertical,
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
  rectSortingStrategy,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import PageWrapper from '../components/layout/PageWrapper';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import {
  SkeletonBoardCard,
  SkeletonBoardListRow,
} from '../components/ui/Skeleton';
import BoardCard from '../components/board/BoardCard';
import BoardFormModal from '../components/board/BoardFormModal';
import DeleteBoardModal from '../components/board/DeleteBoardModal';
import BoardFilterPanel from '../components/board/BoardFilterPanel';
import SortableItem from '../components/dnd/SortableItem';
import useOrgStore from '../store/orgStore';
import useBoardStore from '../store/boardStore';
import useToastStore from '../store/toastStore';
import usePermissions from '../hooks/usePermissions';
import { convertBoard } from '../services/monthService';
import { timeAgo } from '../utils/dateUtils';
import {
  EMPTY_BOARD_FILTERS,
  boardMatchesFilters,
  countActiveBoardFilters,
} from '../utils/boardFilters';

/**
 * Rotating palette for the top accent bar on each card.
 * Matches the stat-card palette from Design doc Section 2.
 */
const ACCENT_CYCLE = [
  'var(--color-card-blue)',
  'var(--color-card-green)',
  'var(--color-card-orange)',
  'var(--color-card-purple)',
];

/**
 * localStorage key for the "Detailed view" preference — whether each board card
 * shows its completion percentage bar. Defaults ON (absent key ⇒ true); only an
 * explicit '0' turns it off, so the bar shows until the user hides it.
 */
const DETAILED_VIEW_KEY = 'myBoards:detailedView';

const readDetailedView = () => {
  try {
    return localStorage.getItem(DETAILED_VIEW_KEY) !== '0';
  } catch {
    return true;
  }
};

const MyBoardsPage = () => {
  const navigate = useNavigate();
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const boards = useBoardStore((s) => s.boards);
  const loading = useBoardStore((s) => s.loading);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);
  const toastSuccess = useToastStore((s) => s.success);
  const createBoardAction = useBoardStore((s) => s.createBoard);
  const updateBoardAction = useBoardStore((s) => s.updateBoard);
  const deleteBoardAction = useBoardStore((s) => s.deleteBoard);
  const reorderBoardsAction = useBoardStore((s) => s.reorderBoards);

  const { can } = usePermissions();
  const canCreateBoard = can('board.create');

  /**
   * Whether the ⋯ menu (Edit / Delete) shows for a board.
   *
   * `GET /api/boards` ships each board's RESOLVED permissions — the two-layer AND
   * already applied — so this just reads the answer. It used to reconstruct the
   * board half locally ("did I make it, or is it public and do I manage public
   * boards"), which quietly missed a member holding an explicit edit grant on
   * someone else's private board: they could rename it, but the menu never
   * appeared. That is exactly the drift a second implementation invites.
   */
  const canManageBoard = useCallback(
    (board) => (board?.permissions?.capabilities || []).includes('board.rename'),
    []
  );

  const [view, setView] = useState('grid'); // "grid" | "list"
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(EMPTY_BOARD_FILTERS);
  const [detailedView, setDetailedView] = useState(readDetailedView);
  const [createOpen, setCreateOpen] = useState(false);

  // Flip the "Detailed view" preference and persist it.
  const toggleDetailedView = () =>
    setDetailedView((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(DETAILED_VIEW_KEY, next ? '1' : '0');
      } catch {
        /* ignore storage failures (private mode, quota) */
      }
      return next;
    });
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const orgId = currentOrg?._id || null;

  // Fetch boards whenever the current org changes
  useEffect(() => {
    if (!orgId) return;
    fetchBoards(orgId).catch((err) => {
      console.error('Failed to fetch boards:', err);
    });
  }, [orgId, fetchBoards]);

  const activeFilterCount = countActiveBoardFilters(filters);

  // Client-side search (Task 7.8) + Filter popup categories. A board must pass
  // the name search AND every active filter category.
  const filteredBoards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return boards.filter((b) => {
      if (q && !(b.name || '').toLowerCase().includes(q)) return false;
      return boardMatchesFilters(b, filters);
    });
  }, [boards, search, filters]);

  const handleCreateSubmit = async (values) => {
    await createBoardAction({
      name: values.name,
      visibility: values.visibility,
      description: values.description,
      // Client Portal boards: boardType 'client' + optional client categories.
      // Tracker boards: boardType 'tracker' + the browser's resolved timezone,
      // which the server requires and validates.
      boardType: values.boardType || 'standard',
      portalCategories: values.portalCategories || [],
      monthTimezone: values.monthTimezone,
      organisation: orgId,
    });
    setCreateOpen(false);
  };

  const handleEditSubmit = async (values) => {
    if (!editTarget) return;

    // The plain fields first. `PUT /api/boards/:id` deliberately ignores
    // `boardType` — changing the type re-files every task, so it is a different
    // operation with its own endpoint and its own capability.
    await updateBoardAction(editTarget._id, {
      name: values.name,
      visibility: values.visibility,
      description: values.description,
    });

    if (values.typeChanged) {
      const result = await convertBoard(editTarget._id, {
        to: values.boardType,
        timezone: values.monthTimezone,
      });
      // Board type drives the tabs, the month picker and the card's pill, so the
      // cache has to see the new shape.
      await fetchBoards(orgId);
      if (values.boardType === 'tracker') {
        toastSuccess(
          `“${values.name}” is now a tracker board — ${result?.filed?.tasks ?? 0} tasks filed by month.`
        );
      } else {
        toastSuccess(`“${values.name}” is back to a standard board. Nothing was deleted.`);
      }
    }

    setEditTarget(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await deleteBoardAction(deleteTarget._id);
    setDeleteTarget(null);
  };

  const openBoard = (board) => navigate(`/boards/${board._id}`);

  const hasBoards = boards.length > 0;
  const hasResults = filteredBoards.length > 0;
  const searching = search.trim().length > 0;
  // The view is "narrowed" when either the name search or the Filter popup is
  // active — both hide boards, so both must gate reordering and drive the
  // "nothing found" state.
  const narrowed = searching || activeFilterCount > 0;

  // Reordering is disabled while the list is narrowed so the user doesn't
  // accidentally rewrite the full order using a partial slice.
  const dndDisabled = narrowed;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleBoardDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id || dndDisabled || !orgId) return;
    const oldIndex = boards.findIndex((b) => b._id === active.id);
    const newIndex = boards.findIndex((b) => b._id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(boards, oldIndex, newIndex);
    const orderedIds = next.map((b) => b._id);
    reorderBoardsAction(orgId, orderedIds).catch((err) => {
      console.error('Failed to reorder boards:', err);
    });
  };

  const boardIds = useMemo(() => filteredBoards.map((b) => b._id), [filteredBoards]);

  return (
    <PageWrapper>
      {/* Page header */}
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1
            className="font-display font-bold text-[22px] md:text-[28px]"
            style={{
              color: 'var(--color-text-primary)',
              letterSpacing: '-0.02em',
            }}
          >
            My Boards
          </h1>
          <p
            className="mt-1 font-body"
            style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}
          >
            Manage your projects and workflows
          </p>
        </div>
        {canCreateBoard && (
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => setCreateOpen(true)}
          >
            Create Board
          </Button>
        )}
      </header>

      {/* Toolbar */}
      <div className="mt-6 flex items-center gap-3 flex-wrap">
        {/* Search input */}
        <div
          className="relative flex items-center w-full sm:w-[320px]"
        >
          <Search
            size={16}
            color="var(--color-text-muted)"
            className="absolute left-3"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search boards..."
            aria-label="Search boards"
            className="w-full font-body text-[14px] transition-[border-color,box-shadow,background-color] duration-150 ease-in-out placeholder:text-[color:var(--color-text-muted)] focus:outline-none focus:bg-white focus:border-[color:var(--color-accent)] focus:shadow-[0_0_0_3px_rgba(37,99,235,0.12)]"
            style={{
              height: 38,
              paddingLeft: 36,
              paddingRight: 12,
              background: 'var(--color-bg-input)',
              border: '1.5px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-primary)',
            }}
          />
        </div>

        {/* View toggle */}
        <div
          className="flex items-center"
          style={{
            padding: 3,
            border: '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-input)',
          }}
        >
          <button
            type="button"
            onClick={() => setView('grid')}
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
            className="flex items-center justify-center transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              width: 30,
              height: 30,
              borderRadius: 'var(--radius-sm)',
              background:
                view === 'grid' ? 'var(--color-accent)' : 'transparent',
              color:
                view === 'grid'
                  ? '#FFFFFF'
                  : 'var(--color-text-secondary)',
            }}
          >
            <LayoutGrid size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setView('list')}
            aria-label="List view"
            aria-pressed={view === 'list'}
            className="flex items-center justify-center transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              width: 30,
              height: 30,
              borderRadius: 'var(--radius-sm)',
              background:
                view === 'list' ? 'var(--color-accent)' : 'transparent',
              color:
                view === 'list'
                  ? '#FFFFFF'
                  : 'var(--color-text-secondary)',
            }}
          >
            <ListIcon size={14} aria-hidden="true" />
          </button>
        </div>

        {/* Filter popup — visibility / progress / ownership / last updated,
            plus the Detailed view toggle */}
        <BoardFilterPanel
          filters={filters}
          onChange={setFilters}
          matchedCount={filteredBoards.length}
          totalCount={boards.length}
          detailedView={detailedView}
          onToggleDetailedView={toggleDetailedView}
        />
      </div>

      {/* Content area */}
      <div className="mt-6">
        {!hasBoards && loading ? (
          <div
            role="status"
            aria-live="polite"
            aria-label="Loading boards"
          >
            {view === 'grid' ? (
              <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <SkeletonBoardCard key={i} index={i} />
                ))}
              </div>
            ) : (
              <div
                className="bg-surface overflow-hidden"
                style={{
                  borderRadius: 'var(--radius-lg)',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                {[0, 1, 2, 3].map((i) => (
                  <SkeletonBoardListRow key={i} isLast={i === 3} />
                ))}
              </div>
            )}
          </div>
        ) : !hasBoards ? (
          <div
            className="bg-surface"
            style={{
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-card)',
              padding: '48px 16px',
            }}
          >
            <EmptyState
              icon={FolderOpen}
              title="No boards yet"
              description="Create your first board to get started"
              actionLabel={canCreateBoard ? 'Create your first board' : undefined}
              onAction={canCreateBoard ? () => setCreateOpen(true) : undefined}
            />
          </div>
        ) : !hasResults && narrowed ? (
          <div
            className="bg-surface"
            style={{
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-card)',
              padding: '48px 16px',
            }}
          >
            <EmptyState
              icon={Search}
              title="Nothing found"
              description={
                searching
                  ? 'Try a different search term or adjust your filters'
                  : 'No boards match the selected filters'
              }
            />
          </div>
        ) : view === 'grid' ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleBoardDragEnd}
          >
            <SortableContext items={boardIds} strategy={rectSortingStrategy}>
              <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {filteredBoards.map((board, i) => (
                  <SortableBoardCard
                    key={board._id}
                    board={board}
                    accentColor={ACCENT_CYCLE[i % ACCENT_CYCLE.length]}
                    onOpen={openBoard}
                    canManage={canManageBoard(board)}
                    onEdit={(b) => setEditTarget(b)}
                    onDelete={(b) => setDeleteTarget(b)}
                    dndDisabled={dndDisabled}
                    showProgress={detailedView}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleBoardDragEnd}
          >
            <SortableContext items={boardIds} strategy={verticalListSortingStrategy}>
              <BoardListView
                boards={filteredBoards}
                accents={ACCENT_CYCLE}
                onOpen={openBoard}
                canManageBoard={canManageBoard}
                onEdit={(b) => setEditTarget(b)}
                onDelete={(b) => setDeleteTarget(b)}
                dndDisabled={dndDisabled}
                showProgress={detailedView}
              />
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Create modal */}
      <BoardFormModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreateSubmit}
        mode="create"
      />

      {/* Edit modal */}
      <BoardFormModal
        isOpen={!!editTarget}
        onClose={() => setEditTarget(null)}
        onSubmit={handleEditSubmit}
        initialValues={editTarget || undefined}
        mode="edit"
      />

      {/* Delete confirmation */}
      <DeleteBoardModal
        isOpen={!!deleteTarget}
        board={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
      />
    </PageWrapper>
  );
};

/**
 * Lightweight list view — one row per board. Uses the same card shell
 * visually so the grid/list toggle feels consistent.
 */
const BoardListView = ({
  boards,
  accents,
  onOpen,
  canManageBoard,
  onEdit,
  onDelete,
  dndDisabled = false,
  showProgress = true,
}) => {
  return (
    <div
      className="bg-surface overflow-hidden"
      style={{
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {boards.map((b, i) => {
        const isPublic = b.visibility === 'public';
        const PrivacyIcon = isPublic ? Globe : Lock;
        return (
          <BoardListRow
            key={b._id}
            board={b}
            accent={accents[i % accents.length]}
            isLast={i === boards.length - 1}
            isPublic={isPublic}
            PrivacyIcon={PrivacyIcon}
            onOpen={onOpen}
            canManage={canManageBoard(b)}
            onEdit={onEdit}
            onDelete={onDelete}
            dndDisabled={dndDisabled}
            showProgress={showProgress}
          />
        );
      })}
    </div>
  );
};

/**
 * SortableBoardCard — wraps BoardCard with @dnd-kit sortable behaviour.
 * The grip handle in the top-left corner owns the drag listeners so the
 * rest of the card stays clickable for navigation.
 */
const SortableBoardCard = ({
  board,
  accentColor,
  onOpen,
  canManage,
  onEdit,
  onDelete,
  dndDisabled,
  showProgress = true,
}) => (
  <SortableItem id={board._id} data={{ type: 'board' }} disabled={dndDisabled}>
    {({ ref, setActivatorNodeRef, style, attributes, listeners, isDragging }) => (
      <div
        ref={ref}
        className="group/board-sortable"
        style={{ ...style, position: 'relative', zIndex: isDragging ? 20 : 'auto' }}
      >
        {!dndDisabled && (
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label="Drag to reorder board"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            className="absolute z-10 flex items-center justify-center opacity-0 group-hover/board-sortable:opacity-100 focus-visible:opacity-100 transition-opacity duration-150"
            style={{
              top: 8,
              left: 8,
              width: 24,
              height: 24,
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(255,255,255,0.85)',
              boxShadow: 'var(--shadow-card)',
              cursor: 'grab',
              touchAction: 'none',
            }}
          >
            <GripVertical size={14} color="var(--color-text-secondary)" aria-hidden="true" />
          </button>
        )}
        <BoardCard
          board={board}
          accentColor={accentColor}
          onOpen={onOpen}
          canManage={canManage}
          onEdit={onEdit}
          onDelete={onDelete}
          showProgress={showProgress}
        />
      </div>
    )}
  </SortableItem>
);

const BoardListRow = ({
  board,
  accent,
  isLast,
  isPublic,
  PrivacyIcon,
  onOpen,
  canManage,
  onEdit,
  onDelete,
  dndDisabled = false,
  showProgress = true,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <SortableItem id={board._id} data={{ type: 'board' }} disabled={dndDisabled}>
      {({ ref, setActivatorNodeRef, style, attributes, listeners, isDragging }) => (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={() => !menuOpen && onOpen?.(board)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen?.(board);
        }
      }}
      className="group/board-row flex items-center gap-4 cursor-pointer transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)] focus-visible:outline-offset-[-2px]"
      style={{
        ...style,
        padding: '14px 16px',
        borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
        background: isDragging ? 'var(--color-bg-subtle)' : undefined,
        position: 'relative',
        zIndex: isDragging ? 20 : 'auto',
      }}
    >
      {!dndDisabled && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label="Drag to reorder board"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center justify-center shrink-0 opacity-0 group-hover/board-row:opacity-100 focus-visible:opacity-100 transition-opacity duration-150"
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
          <GripVertical size={14} color="var(--color-text-muted)" aria-hidden="true" />
        </button>
      )}
      <div
        aria-hidden="true"
        style={{
          width: 4,
          height: 32,
          background: accent,
          borderRadius: 'var(--radius-sm)',
        }}
      />
      <div
        className="flex items-center justify-center shrink-0"
        style={{
          width: 32,
          height: 32,
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-accent-light)',
        }}
        aria-hidden="true"
      >
        <Folder size={16} color="var(--color-accent)" />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className="font-body font-semibold truncate"
          style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
        >
          {board.name}
        </p>
        <p
          className="font-body truncate"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          {board.description || 'No description'}
        </p>
      </div>
      {/* Progress — percentage of tasks done on this board */}
      {showProgress && (
      <div
        className="hidden sm:flex items-center gap-2 shrink-0"
        style={{ width: 128 }}
        title={
          (board.taskCount ?? 0) > 0
            ? `${board.doneCount ?? 0} of ${board.taskCount} tasks done`
            : 'No tasks yet'
        }
      >
        <div
          role="progressbar"
          aria-valuenow={board.progress ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${board.progress ?? 0}% of tasks done`}
          style={{
            flex: 1,
            height: 6,
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-bg-subtle)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${board.progress ?? 0}%`,
              height: '100%',
              background: 'var(--color-status-done)',
              borderRadius: 'var(--radius-full)',
            }}
          />
        </div>
        <span
          className="font-body"
          style={{
            fontSize: 12,
            fontWeight: 600,
            width: 34,
            textAlign: 'right',
            color: 'var(--color-text-secondary)',
          }}
        >
          {board.progress ?? 0}%
        </span>
      </div>
      )}

      <span
        className="inline-flex items-center gap-1 font-body shrink-0"
        style={{
          fontSize: 11,
          fontWeight: 500,
          padding: '2px 8px',
          borderRadius: 'var(--radius-full)',
          background: isPublic ? 'var(--color-status-done-bg)' : '#FFF0F0',
          color: isPublic ? 'var(--color-status-done)' : '#DC2626',
        }}
      >
        <PrivacyIcon size={10} aria-hidden="true" />
        {isPublic ? 'public' : 'private'}
      </span>
      <div
        className="flex items-center gap-1.5 font-body shrink-0"
        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
      >
        <CalendarIcon size={12} aria-hidden="true" />
        <span>{timeAgo(board.updatedAt || board.createdAt)}</span>
      </div>

      {canManage && (
        <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            aria-label="Board options"
            onClick={() => setMenuOpen((m) => !m)}
            className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-border)]"
            style={{ width: 28, height: 28 }}
          >
            <MoreHorizontal
              size={16}
              color="var(--color-text-secondary)"
              aria-hidden="true"
            />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
              />
              <div
                role="menu"
                className="absolute right-0 z-20 mt-1 bg-surface"
                style={{
                  minWidth: 140,
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-md)',
                  border: '1px solid var(--color-border)',
                  padding: 4,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit?.(board);
                  }}
                  className="w-full text-left font-body hover:bg-[color:var(--color-bg-subtle)] transition-colors duration-150"
                  style={{
                    fontSize: 13,
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-text-primary)',
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete?.(board);
                  }}
                  className="w-full text-left font-body hover:bg-[color:var(--color-bg-subtle)] transition-colors duration-150"
                  style={{
                    fontSize: 13,
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-status-stuck)',
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
      )}
    </SortableItem>
  );
};

export default MyBoardsPage;

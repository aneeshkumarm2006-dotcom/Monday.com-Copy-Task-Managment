import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  LayoutGrid,
  List as ListIcon,
  SlidersHorizontal,
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
import SortableItem from '../components/dnd/SortableItem';
import useAuthStore from '../store/authStore';
import useOrgStore from '../store/orgStore';
import useBoardStore from '../store/boardStore';
import { timeAgo } from '../utils/dateUtils';

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
 * Determine whether the signed-in user is the admin of the current org.
 */
const useIsCurrentOrgAdmin = () => {
  const user = useAuthStore((s) => s.user);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  if (!user || !currentOrg) return false;
  const adminId =
    typeof currentOrg.admin === 'object' && currentOrg.admin !== null
      ? currentOrg.admin._id || currentOrg.admin
      : currentOrg.admin;
  const isMainAdmin = !!adminId && String(adminId) === String(user._id);
  const isExtraAdmin = Array.isArray(currentOrg.admins) &&
    currentOrg.admins.some((a) => {
      const id = typeof a === 'object' && a !== null ? a._id || a : a;
      return String(id) === String(user._id);
    });
  return isMainAdmin || isExtraAdmin;
};

const MyBoardsPage = () => {
  const navigate = useNavigate();
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const boards = useBoardStore((s) => s.boards);
  const loading = useBoardStore((s) => s.loading);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);
  const createBoardAction = useBoardStore((s) => s.createBoard);
  const updateBoardAction = useBoardStore((s) => s.updateBoard);
  const deleteBoardAction = useBoardStore((s) => s.deleteBoard);
  const reorderBoardsAction = useBoardStore((s) => s.reorderBoards);

  const isAdmin = useIsCurrentOrgAdmin();

  const [view, setView] = useState('grid'); // "grid" | "list"
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
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

  // Client-side search filter (Task 7.8)
  const filteredBoards = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return boards;
    return boards.filter((b) => (b.name || '').toLowerCase().includes(q));
  }, [boards, search]);

  const handleCreateSubmit = async (values) => {
    await createBoardAction({
      name: values.name,
      visibility: values.visibility,
      description: values.description,
      organisation: orgId,
    });
    setCreateOpen(false);
  };

  const handleEditSubmit = async (values) => {
    if (!editTarget) return;
    await updateBoardAction(editTarget._id, {
      name: values.name,
      visibility: values.visibility,
      description: values.description,
    });
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

  // Reordering is disabled while a search filter is active so the user
  // doesn't accidentally rewrite the full order using a partial slice.
  const dndDisabled = searching;

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
            className="font-display font-bold"
            style={{
              fontSize: 28,
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
        {isAdmin && (
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

        {/* Filter (placeholder — no active filters in v1) */}
        <Button variant="secondary" size="default" icon={SlidersHorizontal}>
          Filter
        </Button>
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
              actionLabel={isAdmin ? 'Create your first board' : undefined}
              onAction={isAdmin ? () => setCreateOpen(true) : undefined}
            />
          </div>
        ) : !hasResults && searching ? (
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
              description="Try a different search term"
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
                    canManage={isAdmin}
                    onEdit={(b) => setEditTarget(b)}
                    onDelete={(b) => setDeleteTarget(b)}
                    dndDisabled={dndDisabled}
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
                canManage={isAdmin}
                onEdit={(b) => setEditTarget(b)}
                onDelete={(b) => setDeleteTarget(b)}
                dndDisabled={dndDisabled}
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
  canManage,
  onEdit,
  onDelete,
  dndDisabled = false,
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
            canManage={canManage}
            onEdit={onEdit}
            onDelete={onDelete}
            dndDisabled={dndDisabled}
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

import { useMemo } from 'react';
import { Plus, Paperclip, Star } from 'lucide-react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  useDroppable,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Avatar from '../../ui/Avatar';
import { columnValue } from '../../../utils/columnValues';
import { computeSummary } from '../../../utils/columnSummary';
import { formatNumber } from '../../../utils/numberFormat';
import { rowCountLabel } from '../../../utils/boardTemplateDisplay';

/**
 * STAGES — the board drawn as columns of cards you drag between.
 *
 * The groups become the columns and the rows become the cards, which is the
 * right shape for a board whose groups are a PROCESS rather than a filing
 * scheme. On a pipeline, moving a deal from Qualified to Proposal sent is the
 * work; in the table that is a menu three clicks deep, and here it is the
 * gesture the view is built around.
 *
 * ---- IT WRITES THROUGH THE SAME ENDPOINT AS THE TABLE ----------------------
 *
 * `onMoveTask(targetGroupId, orderedIds)` is `taskStore.reorderTasks`, exactly
 * what `handleBoardDragEnd` in BoardDetailPage calls. Cross-group moves already
 * worked — `PUT /api/tasks/reorder` sets `group` on any id that was not already
 * in the target — so this view needed no new server route. Sharing the one
 * endpoint is also what keeps a drag here and a drag in the table from
 * producing two different orders.
 *
 * ---- WHAT IT DELIBERATELY DOES NOT DO --------------------------------------
 *
 * PINS ARE IGNORED. The table floats pinned rows to the top of their group and
 * resolves every drop index against the persisted list underneath. A stage
 * column is short and read as a queue, so a pinned card would jump a stage
 * boundary for no reason anybody could see. Cards sit in persisted order.
 *
 * FILTERS. The parent passes already-filtered rows, and the same rule as the
 * table applies: dragging inside a filtered subset would write a bogus order
 * back over the rows you cannot see, so the parent disables dragging then.
 */

/**
 * What each template puts on a card, beyond the title and the money.
 *
 * `terminal` names the groups that are ENDS rather than steps. They collapse to
 * narrow rails and drop out of the "share of open" arithmetic — a year of
 * closed-won deals would otherwise swamp the only number a pipeline is read
 * for. Matched on the group's name, lower-cased: rename Won and it stops being
 * terminal, which is predictable and beats a hidden flag.
 */
const CARD_SHAPE = {
  pipeline: { subtitle: 'nextStep', person: 'owner', terminal: ['won', 'lost'] },
  recruitment: { subtitle: 'role', person: 'interviewer', terminal: ['hired', 'rejected'] },
};
const DEFAULT_SHAPE = { subtitle: null, person: null, terminal: [] };

const DAY = 86400000;

/**
 * How long this card has sat where it is.
 *
 * `groupChangedAt` is stamped only when a task actually changes group, so a
 * reorder inside a stage does not reset it. Null means it has never moved, and
 * the honest answer then is how long it has existed.
 */
const daysInStage = (task) => {
  const since = task?.groupChangedAt || task?.createdAt;
  if (!since) return null;
  const ms = Date.now() - new Date(since).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.floor(ms / DAY);
};

/** Grey, then amber past a fortnight, then red past a month. */
const ageTone = (days) => {
  if (days == null) return null;
  if (days >= 30) return { bg: 'var(--color-status-stuck-light, #FEF2F2)', fg: 'var(--color-status-stuck)' };
  if (days >= 14) return { bg: 'var(--color-status-working-light, #FFF8ED)', fg: 'var(--color-status-working)' };
  return { bg: 'var(--color-bg-subtle)', fg: 'var(--color-text-muted)' };
};

const ageLabel = (days) => (days === 0 ? 'today' : `${days}d`);

const StageCard = ({ task, cols, canDrag, onOpen }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task._id,
    disabled: !canDrag,
    data: { type: 'stage-task', groupId: task.group },
  });

  const title = (cols.primary && columnValue(task, cols.primary)) || task.title || 'Untitled';
  const money = cols.money ? columnValue(task, cols.money) : null;
  const subtitle = cols.subtitle ? columnValue(task, cols.subtitle) : null;
  const rating = cols.rating ? columnValue(task, cols.rating) : null;
  const files = cols.file ? columnValue(task, cols.file) : null;
  // A person column holds ids; the row's own assignees are already hydrated, so
  // they are what actually renders an avatar. Falling back to them also keeps a
  // card useful on a board whose person column has never been filled in.
  const people = Array.isArray(task.assignees) ? task.assignees.slice(0, 3) : [];

  const days = daysInStage(task);
  const tone = ageTone(days);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderLeft: `3px solid ${cols.accent}`,
        borderRadius: 'var(--radius-md)',
        padding: '9px 10px',
        cursor: canDrag ? 'grab' : 'pointer',
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
      }}
      {...attributes}
      {...listeners}
      onClick={() => onOpen?.(task)}
      onKeyDown={(e) => {
        // The drag listeners own Space; Enter is left free to open the card, so
        // a keyboard user can still reach the row panel from this view.
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen?.(task);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${title}${money != null ? `, ${formatNumber(money, cols.money?.settings)}` : ''}`}
    >
      <p
        className="font-body"
        style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.3 }}
      >
        {title}
      </p>

      {money != null && money !== '' && (
        <p
          className="font-body"
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--color-text-primary)',
            fontVariantNumeric: 'tabular-nums',
            marginTop: 4,
          }}
        >
          {formatNumber(money, cols.money?.settings)}
        </p>
      )}

      {rating != null && rating !== '' && (
        <p style={{ marginTop: 4, display: 'flex', gap: 1, alignItems: 'center' }} aria-label={`Rated ${rating}`}>
          {Array.from({ length: cols.rating?.settings?.max || 5 }).map((_, i) => (
            <Star
              key={i}
              size={11}
              aria-hidden="true"
              fill={i < Number(rating) ? 'var(--color-status-working)' : 'none'}
              color={i < Number(rating) ? 'var(--color-status-working)' : 'var(--color-border-strong)'}
            />
          ))}
        </p>
      )}

      {subtitle ? (
        <p
          className="font-body"
          style={{
            fontSize: 11,
            color: 'var(--color-text-secondary)',
            marginTop: 4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {String(subtitle)}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2" style={{ marginTop: 7 }}>
        <span className="flex items-center gap-1">
          {people.map((p) => (
            <Avatar key={p._id || p} user={p} size={19} />
          ))}
          {Array.isArray(files) && files.length > 0 && (
            <span
              className="inline-flex items-center gap-1 font-body"
              style={{ fontSize: 10, color: 'var(--color-text-muted)' }}
              title={`${files.length} file${files.length === 1 ? '' : 's'}`}
            >
              <Paperclip size={10} aria-hidden="true" />
              {files.length}
            </span>
          )}
        </span>
        {tone && (
          <span
            className="font-body"
            style={{
              fontSize: 9.5,
              padding: '1px 5px',
              borderRadius: 3,
              background: tone.bg,
              color: tone.fg,
              whiteSpace: 'nowrap',
            }}
            title={`${days} day${days === 1 ? '' : 's'} in this stage`}
          >
            {ageLabel(days)}
          </span>
        )}
      </div>
    </div>
  );
};

const StageColumn = ({ group, tasks, cols, shape, board, openTotal, canEdit, dragEnabled, onOpenTask, onAddTask }) => {
  const isTerminal = shape.terminal.includes((group.name || '').trim().toLowerCase());
  const { setNodeRef, isOver } = useDroppable({
    id: `stage-col-${group._id}`,
    data: { type: 'stage-col', groupId: group._id },
  });

  const total = cols.money ? computeSummary(tasks, cols.money) : null;
  const share =
    !isTerminal && openTotal > 0 && total && total.value > 0
      ? Math.round((total.value / openTotal) * 100)
      : null;

  return (
    <div
      style={{
        flex: isTerminal ? '0 0 132px' : '0 0 208px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        opacity: isTerminal ? 0.72 : 1,
      }}
    >
      <div
        style={{
          padding: '8px 10px',
          background: 'var(--color-bg-subtle)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <p className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            style={{ width: 7, height: 7, borderRadius: '50%', background: group.color || cols.accent, flex: 'none' }}
          />
          <span
            className="font-body"
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--color-text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {group.name}
          </span>
        </p>
        {total && total.value > 0 && (
          <p
            className="font-body"
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--color-text-primary)',
              fontVariantNumeric: 'tabular-nums',
              marginTop: 3,
            }}
          >
            {formatNumber(total.value, cols.money.settings)}
          </p>
        )}
        <p
          className="font-body"
          style={{ fontSize: 9.5, color: 'var(--color-text-muted)', letterSpacing: '0.05em', marginTop: 2 }}
        >
          {rowCountLabel(board, tasks.length).toUpperCase()}
          {isTerminal ? ' · CLOSED' : share != null ? ` · ${share}% OF OPEN` : ''}
        </p>
      </div>

      {/* Terminal stages stay collapsed: they are an archive, not a step. The
          column still accepts a drop, which is how a deal gets marked Won. */}
      {!isTerminal && (
        <div
          ref={setNodeRef}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            minHeight: 56,
            padding: isOver ? 6 : 0,
            borderRadius: 'var(--radius-md)',
            border: isOver ? '2px dashed var(--color-accent)' : '2px solid transparent',
            background: isOver ? 'var(--color-accent-light)' : 'transparent',
          }}
        >
          <SortableContext items={tasks.map((t) => t._id)} strategy={verticalListSortingStrategy}>
            {tasks.map((task) => (
              <StageCard
                key={task._id}
                task={task}
                cols={cols}
                canDrag={dragEnabled}
                onOpen={onOpenTask}
              />
            ))}
          </SortableContext>

          {tasks.length === 0 && !isOver && (
            <p
              className="font-body text-center"
              style={{ fontSize: 11, color: 'var(--color-text-muted)', padding: '14px 0' }}
            >
              Nothing here yet
            </p>
          )}

          {canEdit && (
            <button
              type="button"
              onClick={() => onAddTask?.(group._id)}
              className="w-full flex items-center justify-center gap-1.5 font-body transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                padding: '7px 0',
                fontSize: 11.5,
                color: 'var(--color-text-muted)',
                border: '1px dashed var(--color-border)',
                borderRadius: 'var(--radius-md)',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              <Plus size={12} aria-hidden="true" />
              Add
            </button>
          )}
        </div>
      )}

      {isTerminal && (
        <div
          ref={setNodeRef}
          style={{
            minHeight: 40,
            borderRadius: 'var(--radius-md)',
            border: isOver ? '2px dashed var(--color-accent)' : '1px dashed var(--color-border)',
            background: isOver ? 'var(--color-accent-light)' : 'transparent',
          }}
          aria-label={`Drop here to move into ${group.name}`}
        />
      )}
    </div>
  );
};

const StagesView = ({
  board,
  groups,
  tasksByGroup,
  canEdit = false,
  dragEnabled = true,
  onOpenTask,
  onAddTask,
  onMoveTask,
}) => {
  const shape = CARD_SHAPE[board?.templateKey] || DEFAULT_SHAPE;

  /**
   * Which columns feed the card, resolved once.
   *
   * Found by ROLE rather than by position — the money column is whichever one
   * is formatted as currency — so a board whose owner has since added, removed
   * or reordered columns still draws a sensible card instead of an empty one.
   */
  const cols = useMemo(() => {
    const all = Array.isArray(board?.columns) ? board.columns : [];
    const byKey = (k) => (k ? all.find((c) => c.key === k) || null : null);
    return {
      primary: all.find((c) => c.isPrimary) || null,
      money: all.find((c) => c.settings?.format === 'currency') || null,
      rating: all.find((c) => c.type === 'rating') || null,
      file: all.find((c) => c.type === 'file') || null,
      subtitle: byKey(shape.subtitle),
      accent: 'var(--color-accent)',
    };
  }, [board, shape.subtitle]);

  const ordered = useMemo(
    () => [...(groups || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [groups]
  );

  /** The open pipeline: every non-terminal stage's money, added up. */
  const openTotal = useMemo(() => {
    if (!cols.money) return 0;
    return ordered.reduce((sum, g) => {
      if (shape.terminal.includes((g.name || '').trim().toLowerCase())) return sum;
      const t = computeSummary(tasksByGroup[g._id] || [], cols.money);
      return sum + (t?.value || 0);
    }, 0);
  }, [ordered, tasksByGroup, cols.money, shape.terminal]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = ({ active, over }) => {
    if (!over) return;
    const from = active.data.current?.groupId;
    const overData = over.data.current || {};
    const to =
      overData.type === 'stage-col'
        ? overData.groupId
        : overData.type === 'stage-task'
          ? overData.groupId
          : null;
    if (!from || !to) return;

    const sourceTasks = tasksByGroup[from] || [];
    const targetTasks = tasksByGroup[to] || [];

    if (String(from) === String(to)) {
      if (active.id === over.id) return;
      const oldIndex = sourceTasks.findIndex((t) => t._id === active.id);
      const newIndex = sourceTasks.findIndex((t) => t._id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(sourceTasks, oldIndex, newIndex).map((t) => t._id);
      onMoveTask?.(to, next);
      return;
    }

    // Cross-stage: insert where it was dropped, or append when the drop landed
    // on the column rather than on a card.
    const moving = sourceTasks.find((t) => t._id === active.id);
    if (!moving) return;
    let insertAt = targetTasks.length;
    if (overData.type === 'stage-task') {
      const idx = targetTasks.findIndex((t) => t._id === over.id);
      if (idx >= 0) insertAt = idx;
    }
    const nextIds = targetTasks.map((t) => t._id);
    nextIds.splice(insertAt, 0, moving._id);
    onMoveTask?.(to, nextIds);
  };

  if (ordered.length === 0) {
    return (
      <p
        className="font-body text-center"
        style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '40px 0' }}
      >
        This board has no stages yet — add a group and it becomes a column here.
      </p>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
      <div
        className="flex gap-2.5 macan-mobile-scroll-row"
        style={{ overflowX: 'auto', alignItems: 'flex-start', paddingBottom: 6 }}
      >
        {ordered.map((group) => (
          <StageColumn
            key={group._id}
            group={group}
            board={board}
            tasks={tasksByGroup[group._id] || []}
            cols={cols}
            shape={shape}
            openTotal={openTotal}
            canEdit={canEdit}
            dragEnabled={dragEnabled}
            onOpenTask={onOpenTask}
            onAddTask={onAddTask}
          />
        ))}
      </div>
    </DndContext>
  );
};

export default StagesView;

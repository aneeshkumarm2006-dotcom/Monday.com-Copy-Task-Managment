import { useMemo } from 'react';
import {
  SlidersHorizontal,
  Search,
  X,
  Calendar,
  Flag,
  CircleDot,
  Tag,
  User,
  UserCog,
} from 'lucide-react';
import {
  PRIORITY_COLORS,
  STATUS_COLORS,
  getColorPair,
} from '../../utils/priorityColors';
import {
  DUE_BUCKETS,
  EMPTY_FILTERS,
  countActiveFilters,
  toggleValue,
} from '../../utils/taskFilters';
import {
  FilterPopover,
  OptionList,
  OptionRow,
  MiniChip,
} from '../ui/FilterControls';

const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];
const LEGACY_STATUS_ORDER = ['not_started', 'working_on_it', 'done', 'stuck'];

/**
 * BoardFilterBar — toolbar above the board groups that filters the visible
 * tasks by name, status, priority, label, due date, and assignee.
 *
 * Stateless w.r.t. the filter result: it only edits the `filters` object via
 * `onChange`. BoardDetailPage owns the state and applies it to the task list
 * (see utils/taskFilters.js).
 *
 * The "Group owner" category is the odd one out: it appears only on tracker
 * boards, where a group carries a per-month owner, and it hides whole GROUPS
 * rather than rows. The distinction lives in utils/taskFilters.js; here it is
 * just one more popover.
 *
 * Props:
 *   board        — current board doc (reads statuses + labels)
 *   allTasks     — flattened array of every board task (derives assignees)
 *   groups       — board groups (derives the group-owner options)
 *   filters      — current filter state (shape: EMPTY_FILTERS)
 *   onChange     — (nextFilters) => void
 *   matchedCount — tasks currently passing the filters
 *   totalCount   — total tasks on the board
 */
const BoardFilterBar = ({
  board,
  allTasks = [],
  groups = [],
  filters,
  onChange,
  matchedCount = 0,
  totalCount = 0,
}) => {
  const activeCount = countActiveFilters(filters);
  const set = (patch) => onChange?.({ ...filters, ...patch });

  // --- Derived option lists ------------------------------------------------

  const statusOptions = useMemo(() => {
    if (board && Array.isArray(board.statuses) && board.statuses.length > 0) {
      return [...board.statuses]
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((s) => {
          const pair = getColorPair(s.color);
          return { id: s._id.toString(), label: s.name, bg: pair.bg, text: pair.text };
        });
    }
    return LEGACY_STATUS_ORDER.map((key) => ({
      id: key,
      label: STATUS_COLORS[key].label,
      bg: STATUS_COLORS[key].bg,
      text: STATUS_COLORS[key].text,
    }));
  }, [board]);

  const labelOptions = useMemo(() => {
    if (!board || !Array.isArray(board.labels)) return [];
    return [...board.labels]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((l) => {
        const pair = getColorPair(l.color);
        return { id: l._id.toString(), label: l.name, bg: pair.bg, text: pair.text };
      });
  }, [board]);

  // Assignees are derived from the tasks themselves so the list works for
  // every member (org member lists are only fetched for admins) and only
  // surfaces people actually assigned on this board.
  const assigneeOptions = useMemo(() => {
    const byId = new Map();
    for (const t of allTasks) {
      for (const a of t.assignedTo || []) {
        const id = (a && a._id ? a._id : a)?.toString();
        if (!id) continue;
        const name = (a && a.name) || '';
        const existing = byId.get(id);
        if (!existing || (!existing.name && name)) {
          byId.set(id, { id, name: name || 'Member', profilePic: a?.profilePic });
        }
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [allTasks]);

  // Group owners exist only on tracker boards. Like the assignee list, the
  // options come from the data on screen rather than the org roster — which
  // also means they follow the month being viewed, since `group.owner` is the
  // owner resolved for that month.
  const showGroupOwner = board?.boardType === 'tracker';

  const groupOwnerOptions = useMemo(() => {
    if (!showGroupOwner) return [];
    const byId = new Map();
    for (const g of groups) {
      const owner = g?.owner;
      if (!owner) continue;
      const id = (owner._id ?? owner)?.toString();
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        name: owner.name || 'Member',
        profilePic: owner.profilePic,
      });
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [groups, showGroupOwner]);

  return (
    <div
      className="mt-5 flex items-center gap-2 flex-wrap"
      role="region"
      aria-label="Filter tasks"
    >
      <span
        className="inline-flex items-center gap-1.5 font-body shrink-0"
        style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
        Filter
      </span>

      {/* Name search */}
      <div
        className="inline-flex items-center gap-1.5"
        style={{
          height: 34,
          padding: '0 10px',
          borderRadius: 'var(--radius-md)',
          border: '1.5px solid var(--color-border-strong)',
          background: 'var(--color-bg-surface, #FFFFFF)',
        }}
      >
        <Search size={14} color="var(--color-text-muted)" aria-hidden="true" />
        <input
          type="text"
          value={filters.search || ''}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Search tasks…"
          aria-label="Search tasks by name"
          className="font-body focus:outline-none"
          style={{
            border: 'none',
            background: 'transparent',
            fontSize: 13,
            width: 150,
            color: 'var(--color-text-primary)',
          }}
        />
        {filters.search ? (
          <button
            type="button"
            onClick={() => set({ search: '' })}
            aria-label="Clear search"
            className="flex items-center justify-center rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
            style={{ width: 18, height: 18, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)' }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* Status */}
      <FilterPopover label="Status" icon={CircleDot} activeCount={filters.statuses?.length || 0}>
        <OptionList emptyLabel="No statuses">
          {statusOptions.map((opt) => (
            <OptionRow
              key={opt.id}
              checked={filters.statuses?.includes(opt.id)}
              onToggle={() => set({ statuses: toggleValue(filters.statuses, opt.id) })}
            >
              <MiniChip bg={opt.bg} text={opt.text}>{opt.label}</MiniChip>
            </OptionRow>
          ))}
        </OptionList>
      </FilterPopover>

      {/* Priority */}
      <FilterPopover label="Priority" icon={Flag} activeCount={filters.priorities?.length || 0}>
        <OptionList>
          {PRIORITY_ORDER.map((key) => {
            const entry = PRIORITY_COLORS[key];
            return (
              <OptionRow
                key={key}
                checked={filters.priorities?.includes(key)}
                onToggle={() => set({ priorities: toggleValue(filters.priorities, key) })}
              >
                <MiniChip bg={entry.bg} text={entry.text} radius="var(--radius-sm)">
                  {entry.label}
                </MiniChip>
              </OptionRow>
            );
          })}
        </OptionList>
      </FilterPopover>

      {/* Labels */}
      <FilterPopover label="Labels" icon={Tag} activeCount={filters.labels?.length || 0}>
        <OptionList emptyLabel="No labels on this board">
          {labelOptions.length > 0 && (
            <OptionRow
              key="__none"
              checked={filters.labels?.includes('none')}
              onToggle={() => set({ labels: toggleValue(filters.labels, 'none') })}
            >
              <span
                className="font-body italic"
                style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
              >
                No label
              </span>
            </OptionRow>
          )}
          {labelOptions.map((opt) => (
            <OptionRow
              key={opt.id}
              checked={filters.labels?.includes(opt.id)}
              onToggle={() => set({ labels: toggleValue(filters.labels, opt.id) })}
            >
              <MiniChip bg={opt.bg} text={opt.text}>{opt.label}</MiniChip>
            </OptionRow>
          ))}
        </OptionList>
      </FilterPopover>

      {/* Due date */}
      <FilterPopover label="Due date" icon={Calendar} activeCount={filters.due?.length || 0}>
        <OptionList>
          {DUE_BUCKETS.map((b) => (
            <OptionRow
              key={b.key}
              checked={filters.due?.includes(b.key)}
              onToggle={() => set({ due: toggleValue(filters.due, b.key) })}
            >
              <span
                className="font-body"
                style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
              >
                {b.label}
              </span>
            </OptionRow>
          ))}
        </OptionList>
      </FilterPopover>

      {/* Assignee */}
      <FilterPopover label="Owner" icon={User} activeCount={filters.assignees?.length || 0}>
        <OptionList emptyLabel="Nobody assigned yet">
          <OptionRow
            checked={filters.assignees?.includes('unassigned')}
            onToggle={() => set({ assignees: toggleValue(filters.assignees, 'unassigned') })}
          >
            <span
              className="font-body italic"
              style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
            >
              Unassigned
            </span>
          </OptionRow>
          {assigneeOptions.map((opt) => (
            <OptionRow
              key={opt.id}
              checked={filters.assignees?.includes(opt.id)}
              onToggle={() => set({ assignees: toggleValue(filters.assignees, opt.id) })}
            >
              <span className="inline-flex items-center gap-2 min-w-0">
                <AssigneeDot user={opt} />
                <span
                  className="font-body truncate"
                  style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                >
                  {opt.name}
                </span>
              </span>
            </OptionRow>
          ))}
        </OptionList>
      </FilterPopover>

      {/* Group owner (tracker boards) — hides whole groups, not rows */}
      {showGroupOwner && (
        <FilterPopover
          label="Group owner"
          icon={UserCog}
          activeCount={filters.groupOwners?.length || 0}
        >
          <OptionList emptyLabel="No group owners set yet">
            <OptionRow
              checked={filters.groupOwners?.includes('unassigned')}
              onToggle={() =>
                set({ groupOwners: toggleValue(filters.groupOwners, 'unassigned') })
              }
            >
              <span
                className="font-body italic"
                style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
              >
                No owner
              </span>
            </OptionRow>
            {groupOwnerOptions.map((opt) => (
              <OptionRow
                key={opt.id}
                checked={filters.groupOwners?.includes(opt.id)}
                onToggle={() =>
                  set({ groupOwners: toggleValue(filters.groupOwners, opt.id) })
                }
              >
                <span className="inline-flex items-center gap-2 min-w-0">
                  <AssigneeDot user={opt} />
                  <span
                    className="font-body truncate"
                    style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                  >
                    {opt.name}
                  </span>
                </span>
              </OptionRow>
            ))}
          </OptionList>
        </FilterPopover>
      )}

      {/* Result count + clear all (only while filtering) */}
      {activeCount > 0 && (
        <div className="inline-flex items-center gap-2 ml-auto">
          <span
            className="font-body"
            style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
          >
            {matchedCount} of {totalCount} {totalCount === 1 ? 'task' : 'tasks'}
          </span>
          <button
            type="button"
            onClick={() => onChange?.({ ...EMPTY_FILTERS })}
            className="inline-flex items-center gap-1 font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              height: 34,
              padding: '0 12px',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-accent)',
              background: 'transparent',
              border: '1.5px solid var(--color-border-strong)',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
            }}
          >
            <X size={14} aria-hidden="true" />
            Clear all
          </button>
        </div>
      )}
    </div>
  );
};

const AssigneeDot = ({ user }) => {
  const name = user?.name || '';
  const initial = name.charAt(0).toUpperCase() || '?';
  if (user?.profilePic) {
    return (
      <img
        src={user.profilePic}
        alt=""
        style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center font-body font-semibold shrink-0"
      style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        background: 'var(--color-accent-light)',
        color: 'var(--color-accent-text)',
        fontSize: 10,
      }}
    >
      {initial}
    </span>
  );
};

export default BoardFilterBar;

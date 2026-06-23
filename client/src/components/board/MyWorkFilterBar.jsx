import { useMemo } from 'react';
import {
  SlidersHorizontal,
  Search,
  X,
  Calendar,
  Flag,
  CircleDot,
  Briefcase,
} from 'lucide-react';
import { PRIORITY_COLORS, getStatusPalette } from '../../utils/priorityColors';
import { DUE_BUCKETS, toggleValue } from '../../utils/taskFilters';
import { countActiveWorkFilters, EMPTY_WORK_FILTERS } from '../../utils/myWorkFilters';
import {
  FilterPopover,
  OptionList,
  OptionRow,
  MiniChip,
} from '../ui/FilterControls';

const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];

// Common statuses sort first in a logical workflow order; anything custom
// falls in afterwards alphabetically.
const STATUS_LABEL_ORDER = ['Not Started', 'Working on it', 'Stuck', 'Done'];

/**
 * MyWorkFilterBar — toolbar above the My Work task list. Mirrors BoardFilterBar
 * but tuned for a multi-board view: status options group by resolved label and
 * a Board category replaces labels/owner (every task here is already yours).
 *
 * Stateless w.r.t. the result — it only edits `filters` via `onChange`.
 * MyTasksPage owns the state and applies it (see utils/myWorkFilters.js).
 *
 * Props:
 *   tasks        — the user's work tasks (derives status + board options)
 *   filters      — current filter state (shape: EMPTY_WORK_FILTERS)
 *   onChange     — (nextFilters) => void
 *   matchedCount — tasks currently passing the filters
 *   totalCount   — total work tasks
 */
const MyWorkFilterBar = ({
  tasks = [],
  filters,
  onChange,
  matchedCount = 0,
  totalCount = 0,
}) => {
  const activeCount = countActiveWorkFilters(filters);
  const set = (patch) => onChange?.({ ...filters, ...patch });

  // --- Derived option lists ------------------------------------------------

  // Distinct status labels across every board, each with its own palette.
  const statusOptions = useMemo(() => {
    const byLabel = new Map();
    for (const t of tasks) {
      const pal = getStatusPalette(t.board || null, t.status);
      if (!pal.label || byLabel.has(pal.label)) continue;
      byLabel.set(pal.label, { label: pal.label, bg: pal.bg, text: pal.text });
    }
    return Array.from(byLabel.values()).sort((a, b) => {
      const ai = STATUS_LABEL_ORDER.indexOf(a.label);
      const bi = STATUS_LABEL_ORDER.indexOf(b.label);
      if (ai !== -1 || bi !== -1) {
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }
      return a.label.localeCompare(b.label);
    });
  }, [tasks]);

  // Distinct source boards the user has work in.
  const boardOptions = useMemo(() => {
    const byId = new Map();
    for (const t of tasks) {
      const b = t.board;
      const id = (b && b._id ? b._id : b)?.toString();
      if (!id || byId.has(id)) continue;
      byId.set(id, { id, name: (b && b.name) || 'Untitled board' });
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [tasks]);

  return (
    <div
      className="mt-6 flex items-center gap-2 flex-wrap"
      role="region"
      aria-label="Filter my work"
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
              key={opt.label}
              checked={filters.statuses?.includes(opt.label)}
              onToggle={() => set({ statuses: toggleValue(filters.statuses, opt.label) })}
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

      {/* Board */}
      <FilterPopover label="Board" icon={Briefcase} activeCount={filters.boards?.length || 0}>
        <OptionList emptyLabel="No boards">
          {boardOptions.map((opt) => (
            <OptionRow
              key={opt.id}
              checked={filters.boards?.includes(opt.id)}
              onToggle={() => set({ boards: toggleValue(filters.boards, opt.id) })}
            >
              <span
                className="font-body truncate"
                style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
              >
                {opt.name}
              </span>
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
            onClick={() => onChange?.({ ...EMPTY_WORK_FILTERS })}
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

export default MyWorkFilterBar;

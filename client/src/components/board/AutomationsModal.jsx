import { useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Play,
  ChevronLeft,
  Zap,
  X,
  ArrowDown,
} from 'lucide-react';
import Modal from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';
import AssigneePicker from './AssigneePicker';
import * as automationService from '../../services/automationService';

const TRIGGER_OPTIONS = [
  { value: 'SCHEDULE', label: 'On a schedule' },
  { value: 'ITEM_CREATED', label: 'When an item is created' },
  { value: 'GROUP_CREATED', label: 'When a group is created' },
];

const CONDITION_TYPES = [
  { value: 'ITEM_IN_GROUP', label: 'item is in group' },
  { value: 'ITEM_IN_STATUS', label: 'item is in status' },
];

const ACTION_TYPES = [
  { value: 'CREATE_SUBITEM', label: 'Create a subitem' },
  { value: 'CREATE_TASK', label: 'Create a task' },
  { value: 'POSITION_ITEM', label: 'Position / sort the item' },
];

// Strategy options for the POSITION_ITEM action. Labels bake in the direction
// (e.g. soonest-first), so the v1 UI needs no separate direction toggle.
const POSITION_STRATEGIES = [
  { value: 'top', label: 'Send to top of group' },
  { value: 'dueDate', label: 'Sort by due date (soonest first)' },
  { value: 'priority', label: 'Sort by priority (highest first)' },
  { value: 'assignee', label: 'Group by assignee' },
];

// Short labels used in the one-line automation summary.
const POSITION_STRATEGY_LABELS = {
  top: 'to top',
  dueDate: 'by due date',
  priority: 'by priority',
  assignee: 'by assignee',
};

const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const FREQUENCIES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const WEEKDAY_CHIPS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const HOURS = Array.from({ length: 24 }, (_, i) => i);

const getBrowserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const getTimezoneList = () => {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone');
    }
  } catch {
    // fall through
  }
  return null;
};

const describeSchedule = (s) => {
  if (!s) return '';
  const hh = String(s.hour ?? 9).padStart(2, '0');
  const tz = s.timezone && s.timezone !== 'UTC' ? ` (${s.timezone})` : '';
  if (s.frequency === 'daily') return `Daily at ${hh}:00${tz}`;
  if (s.frequency === 'weekly') {
    const days = (s.daysOfWeek || []).slice().sort();
    const labels = days.map((d) => WEEKDAY_SHORT[d]).join(', ');
    return `Weekly · ${labels || '—'} at ${hh}:00${tz}`;
  }
  if (s.frequency === 'monthly') {
    if (s.useLastDayOfMonth) {
      return `Monthly · last day at ${hh}:00${tz}`;
    }
    return `Monthly · day ${s.dayOfMonth} at ${hh}:00${tz}`;
  }
  return '';
};

const describeTemplate = (t) => {
  if (!t) return '';
  const groupName = t.group?.name || '—';
  const due =
    Number.isFinite(t.dueInDays) && t.dueInDays !== null
      ? `, due in ${t.dueInDays} day${t.dueInDays === 1 ? '' : 's'}`
      : '';
  return `→ "${t.name}" in ${groupName}${due}`;
};

/**
 * Lookup a group's name by id from the cached groups list. Conditions store
 * raw ObjectIds, so describing them requires the board's group catalog.
 */
const lookupName = (list, id, key = 'name') => {
  if (!id || !Array.isArray(list)) return '—';
  const target = id.toString();
  const found = list.find((it) => (it?._id || '').toString() === target);
  return found?.[key] || '—';
};

/**
 * One-line summary of an ITEM_CREATED automation, e.g.
 * "When item created in [Onboarding] → create 6 subitems".
 */
const describeEventDriven = (automation, groups = [], statuses = []) => {
  const conds = Array.isArray(automation.conditions) ? automation.conditions : [];
  const actions = Array.isArray(automation.actions) ? automation.actions : [];

  let when = 'When an item is created';
  if (conds.length > 0) {
    const parts = conds.map((c) => {
      if (c.type === 'ITEM_IN_GROUP') {
        return `group ${lookupName(groups, c.value)}`;
      }
      if (c.type === 'ITEM_IN_STATUS') {
        return `status ${lookupName(statuses, c.value)}`;
      }
      return '';
    }).filter(Boolean);
    if (parts.length > 0) when += ` in ${parts.join(' & ')}`;
  }

  if (actions.length === 0) return `${when} → (no actions)`;

  const subitemCount = actions.filter((a) => a.type === 'CREATE_SUBITEM').length;
  const taskCount = actions.filter((a) => a.type === 'CREATE_TASK').length;
  const phrases = [];
  if (subitemCount > 0) {
    phrases.push(`create ${subitemCount} subitem${subitemCount === 1 ? '' : 's'}`);
  }
  if (taskCount > 0) {
    phrases.push(`create ${taskCount} task${taskCount === 1 ? '' : 's'}`);
  }
  const position = actions.find((a) => a.type === 'POSITION_ITEM');
  if (position) {
    const lbl = POSITION_STRATEGY_LABELS[position.config?.strategy];
    phrases.push(lbl ? `sort ${lbl}` : 'position the item');
  }
  return `${when} → ${phrases.join(' & ')}`;
};

/**
 * One-line summary of a GROUP_CREATED automation, e.g.
 * "When a group is created matching \"^Deux\" → create 3 tasks".
 */
const describeGroupCreated = (automation) => {
  const conds = Array.isArray(automation.conditions) ? automation.conditions : [];
  const pattern = conds.find((c) => c.type === 'GROUP_NAME_MATCHES')?.value;
  const templates = Array.isArray(automation.groupCreatedTaskTemplates)
    ? automation.groupCreatedTaskTemplates
    : [];

  let when = 'When a group is created';
  if (pattern) when += ` matching "${pattern}"`;

  if (templates.length === 0) return `${when} → (no tasks)`;
  return `${when} → create ${templates.length} task${templates.length === 1 ? '' : 's'}`;
};

/**
 * Top-level describe — branches on triggerType. Returns the schedule string
 * for SCHEDULE automations (preserves existing UI), the event-driven
 * summary for ITEM_CREATED, or the group-created summary for GROUP_CREATED.
 */
const describeAutomation = (automation, groups = [], statuses = []) => {
  if (automation.triggerType === 'ITEM_CREATED') {
    return describeEventDriven(automation, groups, statuses);
  }
  if (automation.triggerType === 'GROUP_CREATED') {
    return describeGroupCreated(automation);
  }
  return describeSchedule(automation.schedule);
};

const formatNextRun = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/**
 * Blank action row for the ITEM_CREATED builder. CREATE_SUBITEM is the
 * default since that matches the screenshot flow ("create N subitems").
 */
const buildEmptyAction = (groups) => ({
  type: 'CREATE_SUBITEM',
  name: '',
  group: groups?.[0]?._id || '',
});

/**
 * Blank task-template row for the GROUP_CREATED builder. These tasks land in
 * the triggering (new) group, so there's no group selector on the row.
 */
const buildEmptyGroupCreatedTemplate = () => ({
  name: '',
  priority: 'medium',
  assignedTo: [],
  dueInDays: '',
  note: '',
});

const buildInitialForm = (groups) => ({
  name: '',
  triggerType: 'SCHEDULE',
  // SCHEDULE fields
  frequency: 'weekly',
  daysOfWeek: [1],
  dayOfMonth: 1,
  useLastDayOfMonth: false,
  hour: 9,
  timezone: getBrowserTimezone(),
  templateName: '',
  group: groups?.[0]?._id || '',
  priority: 'medium',
  assignedTo: [],
  dueInDays: '',
  note: '',
  // ITEM_CREATED fields
  conditions: [],
  actions: [buildEmptyAction(groups)],
  // GROUP_CREATED fields
  groupNamePattern: '',
  groupCreatedTemplates: [buildEmptyGroupCreatedTemplate()],
  enabled: true,
});

const idOf = (v) => (v && typeof v === 'object' ? v._id : v);

const formFromAutomation = (a, groups) => {
  const s = a.schedule || {};
  const t = a.taskTemplate || {};
  const triggerType = a.triggerType || 'SCHEDULE';
  const groupId = idOf(t.group);

  // GROUP_NAME_MATCHES conditions store a raw string, so don't force them
  // through `idOf` — that would clobber the regex pattern.
  const conditions = (a.conditions || []).map((c) => ({
    type: c.type,
    value:
      c.type === 'GROUP_NAME_MATCHES'
        ? c.value == null
          ? ''
          : String(c.value)
        : idOf(c.value) || '',
  }));

  const actions = (a.actions || []).map((act) => ({
    type: act.type,
    name: act.config?.name || '',
    group: idOf(act.config?.group) || '',
    priority: act.config?.priority || 'medium',
    assignedTo: (act.config?.assignedTo || []).map((u) => idOf(u)),
    note: act.config?.note || '',
    strategy: act.config?.strategy || 'top',
  }));

  const groupCreatedTemplates = (a.groupCreatedTaskTemplates || []).map((tpl) => ({
    name: tpl.name || '',
    priority: tpl.priority || 'medium',
    assignedTo: (tpl.assignedTo || []).map((u) => idOf(u)),
    dueInDays:
      Number.isFinite(tpl.dueInDays) && tpl.dueInDays !== null
        ? String(tpl.dueInDays)
        : '',
    note: tpl.note || '',
  }));

  const groupNamePattern =
    (a.conditions || []).find((c) => c.type === 'GROUP_NAME_MATCHES')?.value || '';

  return {
    name: a.name || '',
    triggerType,
    frequency: s.frequency || 'weekly',
    daysOfWeek: Array.isArray(s.daysOfWeek) && s.daysOfWeek.length > 0
      ? s.daysOfWeek
      : [1],
    dayOfMonth: s.dayOfMonth || 1,
    useLastDayOfMonth: s.useLastDayOfMonth === true,
    hour: typeof s.hour === 'number' ? s.hour : 9,
    timezone: s.timezone || getBrowserTimezone(),
    templateName: t.name || '',
    group: groupId || groups?.[0]?._id || '',
    priority: t.priority || 'medium',
    assignedTo: (t.assignedTo || []).map((u) => idOf(u)),
    dueInDays:
      Number.isFinite(t.dueInDays) && t.dueInDays !== null
        ? String(t.dueInDays)
        : '',
    note: t.note || '',
    conditions,
    actions: actions.length > 0 ? actions : [buildEmptyAction(groups)],
    groupNamePattern: String(groupNamePattern || ''),
    groupCreatedTemplates:
      groupCreatedTemplates.length > 0
        ? groupCreatedTemplates
        : [buildEmptyGroupCreatedTemplate()],
    enabled: a.enabled !== false,
  };
};

const SegmentedControl = ({ options, value, onChange, disabled }) => (
  <div
    className="inline-flex"
    style={{
      border: '1.5px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      padding: 2,
      background: 'var(--color-bg-input)',
    }}
  >
    {options.map((opt) => {
      const selected = opt.value === value;
      return (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className="font-body"
          style={{
            fontSize: 13,
            fontWeight: selected ? 600 : 500,
            padding: '6px 14px',
            borderRadius: 'var(--radius-sm)',
            background: selected ? 'var(--color-accent)' : 'transparent',
            color: selected ? '#FFFFFF' : 'var(--color-text-secondary)',
            border: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'background 150ms ease, color 150ms ease',
          }}
        >
          {opt.label}
        </button>
      );
    })}
  </div>
);

const WeekdayChips = ({ value, onChange, disabled }) => {
  const set = new Set(value || []);
  return (
    <div className="flex flex-wrap gap-2">
      {WEEKDAY_CHIPS.map((c) => {
        const selected = set.has(c.value);
        return (
          <button
            key={c.value}
            type="button"
            disabled={disabled}
            onClick={() => {
              const next = new Set(set);
              if (next.has(c.value)) next.delete(c.value);
              else next.add(c.value);
              onChange(Array.from(next));
            }}
            className="font-body"
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '4px 10px',
              borderRadius: 'var(--radius-full)',
              border: selected
                ? '1.5px solid var(--color-accent)'
                : '1.5px solid var(--color-border)',
              background: selected ? 'var(--color-accent-light)' : 'transparent',
              color: selected
                ? 'var(--color-accent-text)'
                : 'var(--color-text-secondary)',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
};

const SelectField = ({ label, value, onChange, options, disabled, listId }) => (
  <div>
    {label && (
      <label
        className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {label}
      </label>
    )}
    <select
      value={value}
      onChange={onChange}
      disabled={disabled}
      list={listId}
      className="w-full font-body"
      style={{
        height: 38,
        padding: '0 10px',
        borderRadius: 'var(--radius-md)',
        border: '1.5px solid var(--color-border)',
        background: 'var(--color-bg-input)',
        color: 'var(--color-text-primary)',
        fontSize: 14,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  </div>
);

const Toggle = ({ checked, onChange, disabled, label }) => (
  <label
    className="inline-flex items-center gap-2 select-none"
    style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
  >
    <span
      style={{
        position: 'relative',
        width: 36,
        height: 20,
        borderRadius: 999,
        background: checked
          ? 'var(--color-accent)'
          : 'var(--color-border-strong)',
        transition: 'background 150ms ease',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#FFFFFF',
          transition: 'left 150ms ease',
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        }}
      />
    </span>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="sr-only"
    />
    {label && (
      <span
        className="font-body"
        style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
      >
        {label}
      </span>
    )}
  </label>
);

/**
 * One row in the conditions list of an ITEM_CREATED automation. The type
 * select picks which task field to compare; the value select shows groups
 * or statuses depending on type. Both are required — empty rows fail
 * `validateLocal`.
 */
const ConditionRow = ({
  condition,
  onChange,
  onRemove,
  groups,
  statuses,
  disabled,
}) => {
  const valueOptions =
    condition.type === 'ITEM_IN_STATUS'
      ? (statuses || []).map((s) => ({ value: s._id, label: s.name }))
      : (groups || []).map((g) => ({ value: g._id, label: g.name }));

  return (
    <div
      className="flex items-center gap-2"
      style={{
        padding: '10px 12px',
        border: '1.5px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg-input)',
      }}
    >
      <select
        value={condition.type}
        disabled={disabled}
        onChange={(e) => onChange({ ...condition, type: e.target.value, value: '' })}
        className="font-body"
        style={{
          height: 32,
          padding: '0 8px',
          borderRadius: 'var(--radius-sm)',
          border: '1.5px solid var(--color-border)',
          background: 'var(--color-bg-surface)',
          color: 'var(--color-text-primary)',
          fontSize: 13,
          flex: '1 1 0',
          minWidth: 0,
        }}
      >
        {CONDITION_TYPES.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <select
        value={condition.value || ''}
        disabled={disabled || valueOptions.length === 0}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
        className="font-body"
        style={{
          height: 32,
          padding: '0 8px',
          borderRadius: 'var(--radius-sm)',
          border: '1.5px solid var(--color-border)',
          background: 'var(--color-bg-surface)',
          color: 'var(--color-text-primary)',
          fontSize: 13,
          flex: '1 1 0',
          minWidth: 0,
        }}
      >
        <option value="">{valueOptions.length === 0 ? '— none available —' : 'Select…'}</option>
        {valueOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Remove condition"
        onClick={onRemove}
        disabled={disabled}
        className="flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
        style={{
          width: 28,
          height: 28,
          border: '1.5px solid var(--color-border)',
          background: 'transparent',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <X size={12} color="var(--color-text-secondary)" />
      </button>
    </div>
  );
};

/**
 * One action row in the ITEM_CREATED builder. CREATE_SUBITEM hides the
 * group selector (subitems inherit their parent's group); CREATE_TASK
 * requires a group.
 */
const ActionRow = ({
  action,
  index,
  onChange,
  onRemove,
  groupOptions,
  disabled,
}) => {
  const isSubitem = action.type === 'CREATE_SUBITEM';
  const isPosition = action.type === 'POSITION_ITEM';
  return (
    <div
      className="flex flex-col gap-2"
      style={{
        padding: '10px 12px',
        border: '1.5px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg-input)',
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="font-body"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
            minWidth: 60,
          }}
        >
          {index === 0 ? 'Then' : 'and then'}
        </span>
        <select
          value={action.type}
          disabled={disabled}
          onChange={(e) => {
            const type = e.target.value;
            const next = { ...action, type };
            // Seed a default strategy so a freshly-switched positioning action
            // is valid without an extra click.
            if (type === 'POSITION_ITEM' && !next.strategy) next.strategy = 'top';
            onChange(next);
          }}
          className="font-body"
          style={{
            height: 32,
            padding: '0 8px',
            borderRadius: 'var(--radius-sm)',
            border: '1.5px solid var(--color-border)',
            background: 'var(--color-bg-surface)',
            color: 'var(--color-text-primary)',
            fontSize: 13,
            flex: '1 1 0',
            minWidth: 0,
          }}
        >
          {ACTION_TYPES.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Remove action"
          onClick={onRemove}
          disabled={disabled}
          className="flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
          style={{
            width: 28,
            height: 28,
            border: '1.5px solid var(--color-border)',
            background: 'transparent',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          <X size={12} color="var(--color-text-secondary)" />
        </button>
      </div>
      {isPosition ? (
        <select
          value={action.strategy || 'top'}
          disabled={disabled}
          onChange={(e) => onChange({ ...action, strategy: e.target.value })}
          className="font-body"
          style={{
            height: 32,
            padding: '0 8px',
            borderRadius: 'var(--radius-sm)',
            border: '1.5px solid var(--color-border)',
            background: 'var(--color-bg-surface)',
            color: 'var(--color-text-primary)',
            fontSize: 13,
          }}
        >
          {POSITION_STRATEGIES.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <div className={isSubitem ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-1 sm:grid-cols-2 gap-2'}>
          <input
            type="text"
            placeholder={isSubitem ? 'Subitem name' : 'Task name'}
            value={action.name}
            disabled={disabled}
            onChange={(e) => onChange({ ...action, name: e.target.value })}
            className="font-body"
            style={{
              height: 32,
              padding: '0 8px',
              borderRadius: 'var(--radius-sm)',
              border: '1.5px solid var(--color-border)',
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
              fontSize: 13,
            }}
          />
          {!isSubitem && (
            <select
              value={action.group || ''}
              disabled={disabled || groupOptions.length === 0}
              onChange={(e) => onChange({ ...action, group: e.target.value })}
              className="font-body"
              style={{
                height: 32,
                padding: '0 8px',
                borderRadius: 'var(--radius-sm)',
                border: '1.5px solid var(--color-border)',
                background: 'var(--color-bg-surface)',
                color: 'var(--color-text-primary)',
                fontSize: 13,
              }}
            >
              <option value="">Select group…</option>
              {groupOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Conditions + actions builder shown when triggerType is ITEM_CREATED.
 * Renders the "When item is created" header with an optional list of
 * conditions, a downward arrow, and the stacked actions list.
 */
const EventDrivenBuilder = ({
  form,
  setForm,
  saving,
  groups,
  groupOptions,
  statuses,
}) => {
  const conditions = form.conditions || [];
  const actions = form.actions || [];

  const updateCondition = (idx, next) => {
    setForm((f) => ({
      ...f,
      conditions: f.conditions.map((c, i) => (i === idx ? next : c)),
    }));
  };
  const removeCondition = (idx) => {
    setForm((f) => ({
      ...f,
      conditions: f.conditions.filter((_, i) => i !== idx),
    }));
  };
  const addCondition = () => {
    setForm((f) => ({
      ...f,
      conditions: [...(f.conditions || []), { type: 'ITEM_IN_GROUP', value: '' }],
    }));
  };

  const updateAction = (idx, next) => {
    setForm((f) => ({
      ...f,
      actions: f.actions.map((a, i) => (i === idx ? next : a)),
    }));
  };
  const removeAction = (idx) => {
    setForm((f) => ({
      ...f,
      actions: f.actions.filter((_, i) => i !== idx),
    }));
  };
  const addAction = () => {
    setForm((f) => ({
      ...f,
      actions: [...(f.actions || []), buildEmptyAction(groups)],
    }));
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Trigger block */}
      <div
        style={{
          padding: '12px 14px',
          border: '1.5px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-bg-surface)',
        }}
      >
        <p
          className="font-body"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text-primary)',
          }}
        >
          When an item is created
        </p>
        {conditions.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {conditions.map((c, i) => (
              <ConditionRow
                key={i}
                condition={c}
                onChange={(next) => updateCondition(i, next)}
                onRemove={() => removeCondition(i)}
                groups={groups}
                statuses={statuses}
                disabled={saving}
              />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={addCondition}
          disabled={saving}
          className="font-body mt-2 inline-flex items-center gap-1"
          style={{
            fontSize: 12,
            color: 'var(--color-accent)',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          <Plus size={12} aria-hidden="true" />
          Add condition
        </button>
      </div>

      {/* Connector arrow */}
      <div className="flex justify-center">
        <ArrowDown
          size={18}
          color="var(--color-text-muted)"
          aria-hidden="true"
        />
      </div>

      {/* Actions block */}
      <div className="flex flex-col gap-2">
        {actions.map((a, i) => (
          <ActionRow
            key={i}
            action={a}
            index={i}
            onChange={(next) => updateAction(i, next)}
            onRemove={() => removeAction(i)}
            groupOptions={groupOptions}
            disabled={saving}
          />
        ))}
        <button
          type="button"
          onClick={addAction}
          disabled={saving}
          className="font-body inline-flex items-center gap-1 self-start"
          style={{
            fontSize: 13,
            color: 'var(--color-accent)',
            background: 'transparent',
            border: 'none',
            padding: '4px 0',
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          <Plus size={14} aria-hidden="true" />
          Add action
        </button>
      </div>
    </div>
  );
};

/**
 * One task-template row in the GROUP_CREATED builder. Unlike ITEM_CREATED
 * actions, there's no group selector — the spawned task always lands in the
 * newly-created triggering group.
 */
const GroupCreatedTemplateRow = ({
  template,
  index,
  onChange,
  onRemove,
  members,
  disabled,
}) => (
  <div
    className="flex flex-col gap-2"
    style={{
      padding: '10px 12px',
      border: '1.5px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-input)',
    }}
  >
    <div className="flex items-center gap-2">
      <span
        className="font-body"
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          minWidth: 60,
        }}
      >
        {index === 0 ? 'Task' : `Task ${index + 1}`}
      </span>
      <input
        type="text"
        placeholder="Task name"
        value={template.name}
        disabled={disabled}
        onChange={(e) => onChange({ ...template, name: e.target.value })}
        className="font-body"
        style={{
          height: 32,
          padding: '0 8px',
          borderRadius: 'var(--radius-sm)',
          border: '1.5px solid var(--color-border)',
          background: 'var(--color-bg-surface)',
          color: 'var(--color-text-primary)',
          fontSize: 13,
          flex: '1 1 0',
          minWidth: 0,
        }}
      />
      <button
        type="button"
        aria-label="Remove task"
        onClick={onRemove}
        disabled={disabled}
        className="flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
        style={{
          width: 28,
          height: 28,
          border: '1.5px solid var(--color-border)',
          background: 'transparent',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <X size={12} color="var(--color-text-secondary)" />
      </button>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <select
        value={template.priority || 'medium'}
        disabled={disabled}
        onChange={(e) => onChange({ ...template, priority: e.target.value })}
        className="font-body"
        style={{
          height: 32,
          padding: '0 8px',
          borderRadius: 'var(--radius-sm)',
          border: '1.5px solid var(--color-border)',
          background: 'var(--color-bg-surface)',
          color: 'var(--color-text-primary)',
          fontSize: 13,
        }}
      >
        {PRIORITIES.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={0}
        placeholder="Due in N days"
        value={template.dueInDays}
        disabled={disabled}
        onChange={(e) => onChange({ ...template, dueInDays: e.target.value })}
        className="font-body"
        style={{
          height: 32,
          padding: '0 8px',
          borderRadius: 'var(--radius-sm)',
          border: '1.5px solid var(--color-border)',
          background: 'var(--color-bg-surface)',
          color: 'var(--color-text-primary)',
          fontSize: 13,
        }}
      />
    </div>
    <AssigneePicker
      members={members}
      value={template.assignedTo || []}
      onChange={(ids) => onChange({ ...template, assignedTo: ids })}
      disabled={disabled}
    />
    <input
      type="text"
      placeholder="Note (optional)"
      value={template.note}
      disabled={disabled}
      onChange={(e) => onChange({ ...template, note: e.target.value })}
      className="font-body"
      style={{
        height: 32,
        padding: '0 8px',
        borderRadius: 'var(--radius-sm)',
        border: '1.5px solid var(--color-border)',
        background: 'var(--color-bg-surface)',
        color: 'var(--color-text-primary)',
        fontSize: 13,
      }}
    />
  </div>
);

/**
 * Trigger + actions builder shown when triggerType is GROUP_CREATED.
 * Renders a "When a group is created" header with an optional name-pattern
 * filter, an arrow, and a stacked list of task templates that will be
 * spawned into the new group.
 */
const GroupCreatedBuilder = ({
  form,
  setForm,
  saving,
  members,
}) => {
  const templates = form.groupCreatedTemplates || [];

  const updateTemplate = (idx, next) => {
    setForm((f) => ({
      ...f,
      groupCreatedTemplates: f.groupCreatedTemplates.map((t, i) =>
        i === idx ? next : t
      ),
    }));
  };
  const removeTemplate = (idx) => {
    setForm((f) => ({
      ...f,
      groupCreatedTemplates: f.groupCreatedTemplates.filter((_, i) => i !== idx),
    }));
  };
  const addTemplate = () => {
    setForm((f) => ({
      ...f,
      groupCreatedTemplates: [
        ...(f.groupCreatedTemplates || []),
        buildEmptyGroupCreatedTemplate(),
      ],
    }));
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Trigger block */}
      <div
        style={{
          padding: '12px 14px',
          border: '1.5px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-bg-surface)',
        }}
      >
        <p
          className="font-body"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text-primary)',
          }}
        >
          When a group is created
        </p>
        <p
          className="font-body mt-2"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          Only when group name matches (regex, optional)
        </p>
        <input
          type="text"
          placeholder="e.g. ^Deux"
          value={form.groupNamePattern || ''}
          disabled={saving}
          onChange={(e) =>
            setForm((f) => ({ ...f, groupNamePattern: e.target.value }))
          }
          className="font-body mt-1 w-full"
          style={{
            height: 32,
            padding: '0 8px',
            borderRadius: 'var(--radius-sm)',
            border: '1.5px solid var(--color-border)',
            background: 'var(--color-bg-input)',
            color: 'var(--color-text-primary)',
            fontSize: 13,
          }}
        />
      </div>

      {/* Connector arrow */}
      <div className="flex justify-center">
        <ArrowDown
          size={18}
          color="var(--color-text-muted)"
          aria-hidden="true"
        />
      </div>

      {/* Templates block */}
      <p
        className="font-body"
        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
      >
        Then create the following tasks in the new group:
      </p>
      <div className="flex flex-col gap-2">
        {templates.map((t, i) => (
          <GroupCreatedTemplateRow
            key={i}
            template={t}
            index={i}
            onChange={(next) => updateTemplate(i, next)}
            onRemove={() => removeTemplate(i)}
            members={members}
            disabled={saving}
          />
        ))}
        <button
          type="button"
          onClick={addTemplate}
          disabled={saving}
          className="font-body inline-flex items-center gap-1 self-start"
          style={{
            fontSize: 13,
            color: 'var(--color-accent)',
            background: 'transparent',
            border: 'none',
            padding: '4px 0',
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          <Plus size={14} aria-hidden="true" />
          Add task
        </button>
      </div>
    </div>
  );
};

const AutomationsModal = ({
  isOpen,
  onClose,
  boardId,
  board = null,
  groups = [],
  members = [],
  isAdmin = false,
}) => {
  const boardStatuses = useMemo(
    () => (board && Array.isArray(board.statuses) ? board.statuses : []),
    [board]
  );
  const [view, setView] = useState('list');
  const [editingId, setEditingId] = useState(null);
  const [automations, setAutomations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(null);
  const [form, setForm] = useState(() => buildInitialForm(groups));
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const tzList = useMemo(() => getTimezoneList(), []);

  useEffect(() => {
    if (!isOpen || !boardId) return;
    setView('list');
    setEditingId(null);
    setListError(null);
    setLoading(true);
    automationService
      .listAutomations(boardId)
      .then((data) => setAutomations(data || []))
      .catch((err) => {
        console.error('Failed to load automations:', err);
        setListError(
          err?.response?.data?.error ||
            'Failed to load automations. Please try again.'
        );
      })
      .finally(() => setLoading(false));
  }, [isOpen, boardId]);

  const groupOptions = useMemo(
    () => groups.map((g) => ({ value: g._id, label: g.name })),
    [groups]
  );

  const hourOptions = useMemo(
    () =>
      HOURS.map((h) => ({
        value: h,
        label: `${String(h).padStart(2, '0')}:00`,
      })),
    []
  );

  const openCreate = () => {
    setEditingId(null);
    setForm(buildInitialForm(groups));
    setFormError(null);
    setView('form');
  };

  const openEdit = (automation) => {
    setEditingId(automation._id);
    setForm(formFromAutomation(automation, groups));
    setFormError(null);
    setView('form');
  };

  const backToList = () => {
    if (saving) return;
    setView('list');
    setEditingId(null);
    setFormError(null);
  };

  const handleClose = () => {
    if (saving) return;
    onClose?.();
  };

  const buildPayload = () => {
    if (form.triggerType === 'GROUP_CREATED') {
      const pattern = (form.groupNamePattern || '').trim();
      const conditions = pattern
        ? [{ type: 'GROUP_NAME_MATCHES', value: pattern }]
        : [];
      const templates = (form.groupCreatedTemplates || []).map((t) => {
        const dueInDays =
          t.dueInDays === '' || t.dueInDays === null || t.dueInDays === undefined
            ? null
            : Number(t.dueInDays);
        return {
          name: t.name.trim(),
          priority: t.priority || 'medium',
          assignedTo: t.assignedTo || [],
          note: t.note?.trim() || undefined,
          dueInDays,
        };
      });
      return {
        name: form.name.trim(),
        enabled: form.enabled,
        triggerType: 'GROUP_CREATED',
        conditions,
        groupCreatedTaskTemplates: templates,
      };
    }

    if (form.triggerType === 'ITEM_CREATED') {
      return {
        name: form.name.trim(),
        enabled: form.enabled,
        triggerType: 'ITEM_CREATED',
        conditions: (form.conditions || []).map((c) => ({
          type: c.type,
          value: c.value,
        })),
        actions: (form.actions || []).map((a) => {
          // POSITION_ITEM carries only a sort strategy — no name/group/assignee.
          if (a.type === 'POSITION_ITEM') {
            return { type: a.type, config: { strategy: a.strategy || 'top' } };
          }
          const config = {
            name: a.name.trim(),
            priority: a.priority || 'medium',
            assignedTo: a.assignedTo || [],
            note: a.note?.trim() || undefined,
          };
          if (a.type === 'CREATE_TASK') {
            config.group = a.group;
          }
          return { type: a.type, config };
        }),
      };
    }

    const schedule = {
      frequency: form.frequency,
      hour: Number(form.hour),
      timezone: form.timezone || 'UTC',
    };
    if (form.frequency === 'weekly') {
      schedule.daysOfWeek = form.daysOfWeek;
    }
    if (form.frequency === 'monthly') {
      if (form.useLastDayOfMonth) {
        schedule.useLastDayOfMonth = true;
      } else {
        schedule.dayOfMonth = Number(form.dayOfMonth);
      }
    }
    const dueInDays =
      form.dueInDays === '' || form.dueInDays === null
        ? null
        : Number(form.dueInDays);
    return {
      name: form.name.trim(),
      enabled: form.enabled,
      triggerType: 'SCHEDULE',
      schedule,
      taskTemplate: {
        name: form.templateName.trim(),
        group: form.group,
        priority: form.priority,
        assignedTo: form.assignedTo,
        note: form.note.trim() || undefined,
        dueInDays,
      },
    };
  };

  const validateLocal = () => {
    if (!form.name.trim()) return 'Automation name is required';

    if (form.triggerType === 'GROUP_CREATED') {
      const templates = form.groupCreatedTemplates || [];
      if (templates.length === 0) return 'Add at least one task template';
      for (let i = 0; i < templates.length; i++) {
        const t = templates[i];
        if (!t.name?.trim()) return `Task ${i + 1}: name is required`;
        if (t.dueInDays !== '' && t.dueInDays !== null && t.dueInDays !== undefined) {
          const n = Number(t.dueInDays);
          if (!Number.isFinite(n) || n < 0) {
            return `Task ${i + 1}: due in days must be a non-negative number`;
          }
        }
      }
      const pattern = (form.groupNamePattern || '').trim();
      if (pattern) {
        try {
          new RegExp(pattern);
        } catch (err) {
          return `Group name pattern is not a valid regex: ${err.message}`;
        }
      }
      return null;
    }

    if (form.triggerType === 'ITEM_CREATED') {
      const acts = form.actions || [];
      if (acts.length === 0) return 'Add at least one action';
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i];
        if (a.type === 'POSITION_ITEM') {
          if (!a.strategy) return `Action ${i + 1}: choose how to position the item`;
          continue;
        }
        if (!a.name?.trim()) return `Action ${i + 1}: task name is required`;
        if (a.type === 'CREATE_TASK' && !a.group) {
          return `Action ${i + 1}: choose a group for the new task`;
        }
      }
      const conds = form.conditions || [];
      for (let i = 0; i < conds.length; i++) {
        if (!conds[i].type) return `Condition ${i + 1}: choose a type`;
        if (!conds[i].value) return `Condition ${i + 1}: choose a value`;
      }
      return null;
    }

    if (!form.templateName.trim()) return 'Task title is required';
    if (!form.group) return 'Please choose a group';
    if (form.frequency === 'weekly' && (!form.daysOfWeek || form.daysOfWeek.length === 0)) {
      return 'Pick at least one day of the week';
    }
    if (form.frequency === 'monthly' && !form.useLastDayOfMonth) {
      const d = Number(form.dayOfMonth);
      if (!Number.isInteger(d) || d < 1 || d > 28) {
        return 'Day of month must be between 1 and 28 (or use "Last day of the month")';
      }
    }
    if (form.dueInDays !== '' && form.dueInDays !== null) {
      const n = Number(form.dueInDays);
      if (!Number.isFinite(n) || n < 0) {
        return 'Due in days must be a non-negative number';
      }
    }
    return null;
  };

  const handleSave = async () => {
    const err = validateLocal();
    if (err) {
      setFormError(err);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = buildPayload();
      if (editingId) {
        const updated = await automationService.updateAutomation(editingId, payload);
        setAutomations((list) =>
          list.map((a) => (a._id === updated._id ? updated : a))
        );
      } else {
        const created = await automationService.createAutomation(boardId, payload);
        setAutomations((list) => [created, ...list]);
      }
      setView('list');
      setEditingId(null);
    } catch (e) {
      setFormError(
        e?.response?.data?.error || 'Failed to save automation. Please try again.'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (automation) => {
    if (!window.confirm(`Delete automation "${automation.name}"?`)) return;
    setBusyId(automation._id);
    try {
      await automationService.deleteAutomation(automation._id);
      setAutomations((list) => list.filter((a) => a._id !== automation._id));
    } catch (e) {
      setListError(
        e?.response?.data?.error || 'Failed to delete automation.'
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleToggle = async (automation, enabled) => {
    setBusyId(automation._id);
    try {
      const updated = await automationService.updateAutomation(automation._id, {
        enabled,
      });
      setAutomations((list) =>
        list.map((a) => (a._id === updated._id ? updated : a))
      );
    } catch (e) {
      setListError(
        e?.response?.data?.error || 'Failed to update automation.'
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleRunNow = async (automation) => {
    setBusyId(automation._id);
    try {
      const data = await automationService.runAutomationNow(automation._id);
      if (data?.automation) {
        setAutomations((list) =>
          list.map((a) => (a._id === data.automation._id ? data.automation : a))
        );
      }
    } catch (e) {
      setListError(
        e?.response?.data?.error || 'Failed to run automation.'
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleRunNowFromForm = async () => {
    if (!editingId) return;
    setSaving(true);
    setFormError(null);
    try {
      const data = await automationService.runAutomationNow(editingId);
      if (data?.automation) {
        setAutomations((list) =>
          list.map((a) => (a._id === data.automation._id ? data.automation : a))
        );
      }
    } catch (e) {
      setFormError(
        e?.response?.data?.error || 'Failed to run automation.'
      );
    } finally {
      setSaving(false);
    }
  };

  const renderListView = () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
        >
          Automatically create tasks on a recurring schedule, or when an item is created.
        </p>
        {isAdmin && (
          <Button variant="primary" size="sm" icon={Plus} onClick={openCreate}>
            New Automation
          </Button>
        )}
      </div>

      {listError && (
        <p
          className="font-body text-xs"
          style={{ color: 'var(--color-status-stuck)' }}
        >
          {listError}
        </p>
      )}

      {loading ? (
        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
        >
          Loading…
        </p>
      ) : automations.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center text-center"
          style={{ padding: '32px 16px', color: 'var(--color-text-muted)' }}
        >
          <Zap size={28} aria-hidden="true" />
          <p className="font-body mt-2" style={{ fontSize: 14 }}>
            No automations yet
          </p>
          <p className="font-body" style={{ fontSize: 12 }}>
            Create one to spawn tasks on a schedule or when items are created.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {automations.map((a) => {
            const isBusy = busyId === a._id;
            return (
              <li
                key={a._id}
                style={{
                  border: '1.5px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px 14px',
                  background: a.enabled
                    ? 'var(--color-bg-surface)'
                    : 'var(--color-bg-subtle)',
                }}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="font-display font-semibold truncate"
                        style={{
                          fontSize: 14,
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        {a.name}
                      </span>
                      {!a.enabled && (
                        <span
                          className="font-body"
                          style={{
                            fontSize: 11,
                            fontWeight: 500,
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-full)',
                            background: 'var(--color-bg-subtle)',
                            color: 'var(--color-text-muted)',
                          }}
                        >
                          paused
                        </span>
                      )}
                    </div>
                    <p
                      className="font-body mt-1"
                      style={{
                        fontSize: 12,
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      {describeAutomation(a, groups, boardStatuses)}
                    </p>
                    {a.triggerType === 'SCHEDULE' && (
                      <p
                        className="font-body"
                        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                      >
                        {describeTemplate(a.taskTemplate)}
                      </p>
                    )}
                    <p
                      className="font-body mt-1"
                      style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                    >
                      {a.triggerType === 'ITEM_CREATED'
                        ? a.enabled
                          ? 'Runs on item creation'
                          : 'paused'
                        : a.triggerType === 'GROUP_CREATED'
                          ? a.enabled
                            ? 'Runs on group creation'
                            : 'paused'
                          : `Next run: ${a.enabled ? formatNextRun(a.nextRunAt) : 'paused'}`}
                      {a.lastRunAt && ` · Last: ${formatNextRun(a.lastRunAt)}`}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Toggle
                      checked={a.enabled}
                      disabled={isBusy}
                      onChange={(v) => handleToggle(a, v)}
                    />
                    <button
                      type="button"
                      onClick={() => handleRunNow(a)}
                      disabled={isBusy}
                      aria-label="Run now"
                      title="Run now"
                      className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                      style={{
                        width: 30,
                        height: 30,
                        border: '1.5px solid var(--color-border)',
                        cursor: isBusy ? 'not-allowed' : 'pointer',
                        opacity: isBusy ? 0.6 : 1,
                      }}
                    >
                      <Play size={14} color="var(--color-text-secondary)" />
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(a)}
                      disabled={isBusy}
                      aria-label="Edit"
                      title="Edit"
                      className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                      style={{
                        width: 30,
                        height: 30,
                        border: '1.5px solid var(--color-border)',
                        cursor: isBusy ? 'not-allowed' : 'pointer',
                        opacity: isBusy ? 0.6 : 1,
                      }}
                    >
                      <Pencil size={14} color="var(--color-text-secondary)" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(a)}
                      disabled={isBusy}
                      aria-label="Delete"
                      title="Delete"
                      className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                      style={{
                        width: 30,
                        height: 30,
                        border: '1.5px solid var(--color-border)',
                        cursor: isBusy ? 'not-allowed' : 'pointer',
                        opacity: isBusy ? 0.6 : 1,
                      }}
                    >
                      <Trash2 size={14} color="#DC2626" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  const setField = (k) => (e) => {
    const value = e?.target ? e.target.value : e;
    setForm((f) => ({ ...f, [k]: value }));
  };

  const renderFormView = () => (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={backToList}
        disabled={saving}
        className="inline-flex items-center gap-1 self-start font-body"
        style={{
          fontSize: 13,
          color: 'var(--color-text-muted)',
          background: 'transparent',
          border: 'none',
          cursor: saving ? 'not-allowed' : 'pointer',
        }}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        Back to list
      </button>

      <Input
        label="Automation Name"
        placeholder="e.g. Weekly standup task"
        value={form.name}
        onChange={setField('name')}
        required
        disabled={saving}
        autoFocus
      />

      <div>
        <label
          className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          Trigger
        </label>
        <SegmentedControl
          options={TRIGGER_OPTIONS}
          value={form.triggerType}
          onChange={(v) => setForm((f) => ({ ...f, triggerType: v }))}
          disabled={saving}
        />
      </div>

      {form.triggerType === 'SCHEDULE' && (
      <div>
        <label
          className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          Frequency
        </label>
        <SegmentedControl
          options={FREQUENCIES}
          value={form.frequency}
          onChange={(v) => setForm((f) => ({ ...f, frequency: v }))}
          disabled={saving}
        />
      </div>
      )}

      {form.triggerType === 'SCHEDULE' && form.frequency === 'weekly' && (
        <div>
          <label
            className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Days of week
          </label>
          <WeekdayChips
            value={form.daysOfWeek}
            onChange={(v) => setForm((f) => ({ ...f, daysOfWeek: v }))}
            disabled={saving}
          />
        </div>
      )}

      {form.triggerType === 'SCHEDULE' && form.frequency === 'monthly' && (
        <div>
          <label
            className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Day of month
          </label>
          <select
            value={form.useLastDayOfMonth ? 'last' : String(form.dayOfMonth)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'last') {
                setForm((f) => ({ ...f, useLastDayOfMonth: true }));
              } else {
                setForm((f) => ({
                  ...f,
                  useLastDayOfMonth: false,
                  dayOfMonth: Number(v),
                }));
              }
            }}
            disabled={saving}
            className="w-full font-body"
            style={{
              height: 38,
              padding: '0 10px',
              borderRadius: 'var(--radius-md)',
              border: '1.5px solid var(--color-border)',
              background: 'var(--color-bg-input)',
              color: 'var(--color-text-primary)',
              fontSize: 14,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={String(d)}>
                {d}
              </option>
            ))}
            <option value="last">Last day of the month</option>
          </select>
        </div>
      )}

      {form.triggerType === 'SCHEDULE' && (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SelectField
          label="Time of day"
          value={form.hour}
          onChange={(e) =>
            setForm((f) => ({ ...f, hour: Number(e.target.value) }))
          }
          options={hourOptions}
          disabled={saving}
        />
        <div>
          <label
            className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Timezone
          </label>
          {tzList ? (
            <select
              value={form.timezone}
              onChange={(e) =>
                setForm((f) => ({ ...f, timezone: e.target.value }))
              }
              disabled={saving}
              className="w-full font-body"
              style={{
                height: 38,
                padding: '0 10px',
                borderRadius: 'var(--radius-md)',
                border: '1.5px solid var(--color-border)',
                background: 'var(--color-bg-input)',
                color: 'var(--color-text-primary)',
                fontSize: 14,
              }}
            >
              {tzList.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          ) : (
            <Input
              value={form.timezone}
              onChange={(e) =>
                setForm((f) => ({ ...f, timezone: e.target.value }))
              }
              disabled={saving}
              placeholder="e.g. Europe/Paris"
            />
          )}
        </div>
      </div>
      )}

      {form.triggerType === 'SCHEDULE' && (
      <div
        style={{
          height: 1,
          background: 'var(--color-border)',
          margin: '4px 0',
        }}
      />
      )}

      {form.triggerType === 'SCHEDULE' && (
      <Input
        label="Task Title"
        placeholder="e.g. Daily standup"
        value={form.templateName}
        onChange={setField('templateName')}
        required
        disabled={saving}
      />
      )}

      {form.triggerType === 'SCHEDULE' && (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SelectField
          label="Group"
          value={form.group}
          onChange={(e) => setForm((f) => ({ ...f, group: e.target.value }))}
          options={groupOptions.length > 0 ? groupOptions : [{ value: '', label: 'No groups' }]}
          disabled={saving || groupOptions.length === 0}
        />
        <SelectField
          label="Priority"
          value={form.priority}
          onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
          options={PRIORITIES}
          disabled={saving}
        />
      </div>
      )}

      {form.triggerType === 'SCHEDULE' && (
      <div>
        <label
          className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          Assignees
        </label>
        <AssigneePicker
          members={members}
          value={form.assignedTo}
          onChange={(ids) => setForm((f) => ({ ...f, assignedTo: ids }))}
          disabled={saving}
        />
      </div>
      )}

      {form.triggerType === 'SCHEDULE' && (
      <Input
        label="Due in N days (optional)"
        type="number"
        min={0}
        placeholder="e.g. 3"
        value={form.dueInDays}
        onChange={setField('dueInDays')}
        disabled={saving}
      />
      )}

      {form.triggerType === 'SCHEDULE' && (
      <Input
        label="Note (optional)"
        placeholder="Any additional context…"
        value={form.note}
        onChange={setField('note')}
        disabled={saving}
        multiline
        rows={3}
      />
      )}

      {form.triggerType === 'ITEM_CREATED' && (
        <EventDrivenBuilder
          form={form}
          setForm={setForm}
          saving={saving}
          groups={groups}
          groupOptions={groupOptions}
          members={members}
          statuses={boardStatuses}
        />
      )}

      {form.triggerType === 'GROUP_CREATED' && (
        <GroupCreatedBuilder
          form={form}
          setForm={setForm}
          saving={saving}
          members={members}
        />
      )}

      <Toggle
        checked={form.enabled}
        onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
        disabled={saving}
        label="Enabled"
      />

      {formError && (
        <p
          className="text-xs font-body"
          style={{ color: 'var(--color-status-stuck)' }}
        >
          {formError}
        </p>
      )}
    </div>
  );

  const footer = view === 'list' ? (
    <Button variant="secondary" onClick={handleClose}>
      Close
    </Button>
  ) : (
    <>
      {editingId && (
        <Button
          variant="secondary"
          onClick={handleRunNowFromForm}
          disabled={saving}
        >
          Run now
        </Button>
      )}
      <Button variant="secondary" onClick={backToList} disabled={saving}>
        Cancel
      </Button>
      <Button variant="primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Automation'}
      </Button>
    </>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={view === 'list' ? 'Automations' : editingId ? 'Edit Automation' : 'New Automation'}
      maxWidth={620}
      footer={footer}
    >
      {view === 'list' ? renderListView() : renderFormView()}
    </Modal>
  );
};

export default AutomationsModal;

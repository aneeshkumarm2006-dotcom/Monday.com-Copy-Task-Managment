import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Target, X } from 'lucide-react';
import {
  getTaskGoalOptions,
  setTaskGoalLinks,
} from '../../../services/taskService';

/**
 * GoalLinksField — the "Goal" row in the task detail panel.
 *
 * Which of this month's goals this task counted towards, editable at any time.
 * EVIDENCE ONLY: nothing here moves a goal's number, and the server refuses any
 * goal outside this task's own group and month.
 *
 * This is the REPAIR PATH. The on-done prompt is the fast way to attach and it
 * is skippable by design, so everything it gets wrong — dismissed too early,
 * attached to the wrong goal, answered before the goal existed — has to be
 * fixable here, on a task in any state.
 *
 * Writes go through the dedicated `PUT /api/tasks/:id/goal-links`, NOT through
 * the panel's generic `onUpdateTask`: that one is the catch-all task PUT, whose
 * full-edit branch demands edit rights over the row. The person who finished
 * the work should be able to say what it was for without them.
 *
 * The options come from the server rather than being derived from a board prop,
 * because "the goals in this task's group for this task's month" is the scope
 * rule itself, and the picker must not be able to offer something the write
 * would then refuse.
 */
const GoalLinksField = ({ task, onTaskPatched }) => {
  const [options, setOptions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const taskId = task?._id;

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const next = await getTaskGoalOptions(taskId);
      setOptions(next);
      setError('');
    } catch {
      // Swallowed on purpose: a task panel that cannot reach this endpoint
      // should still show the task. The row simply renders nothing.
      setOptions(null);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const linked = useMemo(
    () => (options?.goals || []).filter((g) => g.linked),
    [options]
  );
  const available = useMemo(
    () => (options?.goals || []).filter((g) => !g.linked),
    [options]
  );

  const canAttach = !!options?.canAttach;

  const commit = async (payload) => {
    if (!taskId || saving) return;
    setSaving(true);
    setError('');
    try {
      const updated = await setTaskGoalLinks(taskId, payload);
      // The parent owns the row, so it refreshes the board grid's marker; the
      // options are refetched because `linked` lives on them, not on the task.
      onTaskPatched?.(updated);
      await load();
    } catch (err) {
      setError(
        err?.response?.data?.error || 'Could not save. Try again.'
      );
    } finally {
      setSaving(false);
    }
  };

  const currentIds = linked.map((g) => g._id);

  const attach = (goalId) => {
    setPickerOpen(false);
    commit({ goalIds: [...currentIds, goalId] });
  };

  const detach = (goalId) => {
    commit({ goalIds: currentIds.filter((id) => id !== goalId) });
  };

  const toggleDismissed = () => {
    commit({ dismissed: !options?.dismissed });
  };

  if (loading) {
    return (
      <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
        Loading…
      </span>
    );
  }

  // Not a tracker board, a subitem, or no month — there is nothing to attach to
  // and the row should not exist. The parent also gates on this, so reaching
  // here means the server disagreed with the client, and the server wins.
  if (!options || !options.attachable) return null;

  const showDismiss = linked.length === 0 && options.done;

  return (
    <div className="flex flex-col gap-1.5" style={{ minHeight: 24 }}>
      <div className="flex items-center gap-2 flex-wrap">
        {linked.length === 0 && (
          <span
            className="font-body"
            style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
          >
            {options.dismissed ? 'Not goal work' : 'No goal'}
          </span>
        )}

        {linked.map((goal) => (
          <span
            key={goal._id}
            className="inline-flex items-center gap-1 font-body font-medium"
            style={{
              fontSize: 12,
              padding: '3px 4px 3px 8px',
              borderRadius: 'var(--radius-full)',
              backgroundColor: 'var(--color-bg-subtle)',
              color: 'var(--color-text-primary)',
            }}
          >
            <Target size={11} aria-hidden="true" style={{ opacity: 0.7 }} />
            {goal.name}
            {canAttach && (
              <button
                type="button"
                onClick={() => detach(goal._id)}
                disabled={saving}
                aria-label={`Detach from ${goal.name}`}
                style={{
                  width: 14,
                  height: 14,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  cursor: saving ? 'default' : 'pointer',
                  borderRadius: '50%',
                  opacity: 0.7,
                }}
              >
                <X size={10} />
              </button>
            )}
          </span>
        ))}

        {canAttach && available.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              disabled={saving}
              aria-label="Attach to a goal"
              aria-expanded={pickerOpen}
              className="inline-flex items-center justify-center rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                width: 22,
                height: 22,
                background: 'transparent',
                border: '1px dashed var(--color-border-strong)',
                color: 'var(--color-text-muted)',
                cursor: saving ? 'default' : 'pointer',
              }}
            >
              <Plus size={12} aria-hidden="true" />
            </button>
            {pickerOpen && (
              <div
                role="listbox"
                onMouseLeave={() => setPickerOpen(false)}
                style={{
                  position: 'absolute',
                  top: 28,
                  left: 0,
                  zIndex: 60,
                  minWidth: 220,
                  maxHeight: 240,
                  overflowY: 'auto',
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-md)',
                  padding: 6,
                }}
              >
                {available.map((goal) => (
                  <button
                    key={goal._id}
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => attach(goal._id)}
                    className="w-full text-left font-body rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                    style={{
                      fontSize: 13,
                      padding: '6px 8px',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--color-text-primary)',
                      cursor: 'pointer',
                    }}
                  >
                    {goal.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/*
        Only offered once the task is done and nothing is attached. Before that
        there is nothing to excuse, and after an attachment the answer is
        already "yes, it was goal work".
      */}
      {canAttach && (showDismiss || options.dismissed) && (
        <button
          type="button"
          onClick={toggleDismissed}
          disabled={saving}
          className="font-body self-start rounded transition-colors duration-150 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            fontSize: 12,
            background: 'transparent',
            border: 'none',
            padding: 0,
            color: 'var(--color-text-muted)',
            cursor: saving ? 'default' : 'pointer',
          }}
        >
          {options.dismissed ? 'Actually, it was goal work' : 'Not goal work'}
        </button>
      )}

      {error && (
        <span className="font-body" style={{ fontSize: 12, color: 'var(--color-danger)' }}>
          {error}
        </span>
      )}
    </div>
  );
};

export default GoalLinksField;

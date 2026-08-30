import { useCallback, useEffect, useMemo, useState } from 'react';
import { Target, X } from 'lucide-react';
import {
  getTaskGoalOptions,
  setTaskGoalLinks,
} from '../../../services/taskService';

/**
 * GoalLinksField — the "Goal" section in the task detail panel's sidebar,
 * directly under Subitems.
 *
 * Which of this month's goals this task counted towards, editable at any time.
 * EVIDENCE ONLY: nothing here moves a goal's number, and the server refuses any
 * goal outside this task's own group and month.
 *
 * THIS IS THE ONLY PLACE THE ANSWER IS GIVEN. It replaced the bottom-right
 * on-done prompt, which asked the same question in a second, smaller,
 * easier-to-lose piece of UI. Marking a task done now opens this panel with
 * this section highlighted (see `highlight`), so the fast path and the repair
 * path are the same control — a task in any state, done or not, is attached
 * from here.
 *
 * That is why the goals are CHIPS rather than a "+" dropdown: the on-done flow
 * has to stay one click, and hiding the options behind a menu would cost the
 * one thing the prompt was good at.
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
 *
 * Props:
 *   task          — the task the panel is focused on
 *   onTaskPatched — (updatedTask) => void, so the board grid's marker refreshes
 *   highlight     — draw attention to the section (the panel sets this when it
 *                   was opened BY the task being marked done)
 */
const GoalLinksField = ({ task, onTaskPatched, highlight = false }) => {
  const [options, setOptions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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
      // should still show the task. The section simply renders nothing.
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
      setError(err?.response?.data?.error || 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const currentIds = linked.map((g) => g._id);

  const attach = (goalId) => commit({ goalIds: [...currentIds, goalId] });

  const detach = (goalId) =>
    commit({ goalIds: currentIds.filter((id) => id !== goalId) });

  const toggleDismissed = () => commit({ dismissed: !options?.dismissed });

  // Nothing is drawn until we know there is something to draw. A header that
  // appears and then removes itself is worse than one that arrives a beat late,
  // and this sits under Subitems, so nothing below it moves.
  if (loading) return null;

  // Not a tracker board, a subitem, or no month — there is nothing to attach to
  // and the section should not exist. The panel also gates on this, so reaching
  // here means the server disagreed with the client, and the server wins.
  if (!options || !options.attachable) return null;

  const showDismiss = linked.length === 0 && options.done;

  return (
    <section
      aria-label="Goal"
      style={{
        // The padding is always there so switching the highlight on moves
        // nothing; only the ring and the tint change.
        margin: '0 -8px 4px',
        padding: 8,
        borderRadius: 'var(--radius-md)',
        background: highlight ? 'var(--color-bg-subtle)' : 'transparent',
        boxShadow: highlight ? '0 0 0 2px var(--color-accent)' : 'none',
        transition: 'background-color 300ms ease, box-shadow 300ms ease',
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: 8 }}
      >
        <p
          className="font-body"
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: 'var(--color-text-muted)',
          }}
        >
          Goal
        </p>
        {linked.length > 0 && (
          <span
            className="font-body"
            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
          >
            {linked.length}
          </span>
        )}
      </div>

      {/* What this task already counts towards. */}
      {linked.length > 0 && (
        <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 8 }}>
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
                  className="rounded transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]"
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
        </div>
      )}

      {/* The question, and its one-click answers. */}
      {canAttach && available.length > 0 && (
        <>
          {linked.length === 0 && (
            <p
              className="font-body"
              style={{
                fontSize: 12,
                color: 'var(--color-text-muted)',
                marginBottom: 6,
              }}
            >
              {options.dismissed
                ? 'Marked as not goal work.'
                : 'Which goal did this move?'}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {available.map((goal) => (
              <button
                key={goal._id}
                type="button"
                onClick={() => attach(goal._id)}
                disabled={saving}
                className="inline-flex items-center gap-1 font-body font-medium transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  fontSize: 12,
                  padding: '3px 10px',
                  borderRadius: 'var(--radius-full)',
                  background: 'transparent',
                  border: '1px dashed var(--color-border-strong)',
                  color: 'var(--color-text-primary)',
                  cursor: saving ? 'default' : 'pointer',
                  textAlign: 'left',
                }}
              >
                <Target size={11} aria-hidden="true" style={{ opacity: 0.6 }} />
                {goal.name}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Nothing linked and nothing on offer: say why, rather than show an
          empty section that reads as broken. */}
      {linked.length === 0 && available.length === 0 && (
        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          {options.dismissed
            ? 'Not goal work.'
            : 'No goals set for this group this month.'}
        </p>
      )}

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
          className="font-body block rounded transition-colors duration-150 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            fontSize: 12,
            marginTop: 8,
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
        <p
          className="font-body"
          role="alert"
          style={{
            fontSize: 12,
            marginTop: 6,
            color: 'var(--color-danger)',
          }}
        >
          {error}
        </p>
      )}
    </section>
  );
};

export default GoalLinksField;

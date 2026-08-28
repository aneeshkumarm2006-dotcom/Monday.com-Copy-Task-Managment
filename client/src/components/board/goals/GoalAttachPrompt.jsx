import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Target, X } from 'lucide-react';
import {
  getTaskGoalOptions,
  setTaskGoalLinks,
} from '../../../services/taskService';

/**
 * GoalAttachPrompt — "you just finished this; what was it for?"
 *
 * Appears bottom-right the moment someone marks a task done on a tracker board,
 * offering that group's goals for that month as one-click chips. Skippable by
 * design: the panel's Goal field is the repair path, and a prompt that cannot be
 * ignored is a prompt that gets answered wrongly to make it go away.
 *
 * NOT A `toastStore` TOAST. That store holds `{ id, type, message, duration }`
 * and Toast.jsx renders `message` as text inside a <p> — there is nowhere to put
 * chips, and widening it would change the shape of every toast in the app. This
 * copies Toast's geometry and entrance so it reads as the same family of object,
 * without dragging interactive content into a store built for strings. It also
 * carries its OWN keyframes: Toast's live in ToastContainer's `<style>` block,
 * which is only in the document while a toast is on screen.
 *
 * PERSISTENT, with an explicit dismiss. The toast default of a few seconds is
 * right for reporting something and wrong for asking something.
 *
 * MULTI-SELECT: a task can count towards several goals, so the card stays open
 * after the first chip and each click re-sends the full set.
 *
 * THE CONTRACT, and it needs saying because it will otherwise be filed as a bug:
 * this fires on YOUR OWN action in THIS tab. A colleague marking something done,
 * or a status arriving over SSE, replaces the group's rows wholesale rather than
 * going through `taskStore.updateTask`, so it will not prompt — which is right,
 * because it was not your action and you are not the one who knows what the work
 * was for.
 */
const GoalAttachPrompt = ({ task, onClose, onTaskPatched }) => {
  const [options, setOptions] = useState(null);
  const [saving, setSaving] = useState(null); // goal id being written
  const [failed, setFailed] = useState(false);

  const taskId = task?._id;

  useEffect(() => {
    let alive = true;
    if (!taskId) return undefined;
    getTaskGoalOptions(taskId)
      .then((next) => alive && setOptions(next))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [taskId]);

  const linked = (options?.goals || []).filter((g) => g.linked);
  const available = (options?.goals || []).filter((g) => !g.linked);

  const commit = async (payload, goalId = null) => {
    setSaving(goalId ?? 'dismiss');
    try {
      const updated = await setTaskGoalLinks(taskId, payload);
      onTaskPatched?.(updated);
      const next = await getTaskGoalOptions(taskId);
      setOptions(next);
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
    }
  };

  const attach = (goalId) =>
    commit({ goalIds: [...linked.map((g) => g._id), goalId] }, goalId);

  const dismiss = async () => {
    await commit({ dismissed: true });
    onClose?.();
  };

  // Nothing to offer, or we could not find out — say nothing rather than show an
  // empty question. The caller has already checked the group has goals; this is
  // the belt for the case where the server disagrees.
  if (failed) return null;
  if (options && (!options.attachable || !options.canAttach)) return null;
  if (options && options.goals.length === 0) return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 80,
        width: 360,
        maxWidth: 'calc(100vw - 32px)',
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderLeft: '4px solid var(--color-accent)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        padding: '12px 12px 12px 14px',
        animation: 'macan-goal-prompt-enter 200ms ease-out',
      }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p
            className="font-body"
            style={{ fontSize: 13, color: 'var(--color-text-primary)', margin: 0 }}
          >
            {linked.length > 0 ? (
              <>
                Counted towards{' '}
                <strong style={{ fontWeight: 600 }}>
                  {linked.map((g) => g.name).join(', ')}
                </strong>
                .
              </>
            ) : (
              <>
                Which goal did{' '}
                <strong style={{ fontWeight: 600 }}>{task?.name}</strong> move?
              </>
            )}
          </p>

          {!options && (
            <p
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 6 }}
            >
              Loading goals…
            </p>
          )}

          {available.length > 0 && (
            <div className="flex flex-wrap gap-1.5" style={{ marginTop: 8 }}>
              {available.map((goal) => (
                <button
                  key={goal._id}
                  type="button"
                  onClick={() => attach(goal._id)}
                  disabled={saving !== null}
                  className="inline-flex items-center gap-1 font-body font-medium rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                  style={{
                    fontSize: 12,
                    padding: '3px 10px',
                    borderRadius: 'var(--radius-full)',
                    background: 'transparent',
                    border: '1px solid var(--color-border-strong)',
                    color: 'var(--color-text-primary)',
                    cursor: saving !== null ? 'default' : 'pointer',
                    opacity: saving === goal._id ? 0.5 : 1,
                  }}
                >
                  <Target size={11} aria-hidden="true" />
                  {goal.name}
                </button>
              ))}
            </div>
          )}

          {options && linked.length === 0 && (
            <button
              type="button"
              onClick={dismiss}
              disabled={saving !== null}
              className="font-body rounded transition-colors duration-150 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                fontSize: 12,
                marginTop: 8,
                padding: 0,
                background: 'transparent',
                border: 'none',
                color: 'var(--color-text-muted)',
                cursor: saving !== null ? 'default' : 'pointer',
              }}
            >
              Not goal work
            </button>
          )}

          {linked.length > 0 && (
            <button
              type="button"
              onClick={onClose}
              className="font-body rounded transition-colors duration-150 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                fontSize: 12,
                marginTop: 8,
                padding: 0,
                background: 'transparent',
                border: 'none',
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
              }}
            >
              Done
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="shrink-0 rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            width: 20,
            height: 20,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
          }}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <style>{`
        @keyframes macan-goal-prompt-enter {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>,
    document.body
  );
};

export default GoalAttachPrompt;

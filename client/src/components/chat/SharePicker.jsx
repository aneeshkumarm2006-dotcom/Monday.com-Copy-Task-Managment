import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import * as goalService from '../../services/goalService';
import * as taskService from '../../services/taskService';
import { currentMonthKey } from './chatFormat';

/**
 * The picker behind the composer's Task / Goal buttons.
 *
 * Extracted from `ChatPage.jsx` unchanged. It positions itself against the
 * composer's `relative` wrapper (`absolute bottom-full`), so whatever renders
 * it has to be that wrapper's child — the page is, and so is any other surface
 * that grows a Task/Goal chip later.
 *
 * Chat never writes a score: this only ever POINTS at a task or a goal.
 */
const SharePicker = ({ kind, channel, onPick, onClose }) => {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // Tracker boards refuse an unscoped task read (rightly — every task
        // lives in a month). "This month, in the board's timezone" is what a
        // chat share means, so that's what we ask for.
        const month =
          channel.board.boardType === 'tracker'
            ? currentMonthKey(channel.board.monthTimezone)
            : undefined;
        if (kind === 'task') {
          const tasks = await taskService.getTasks(channel.board._id, {
            group: channel.group || undefined,
            month,
          });
          if (!cancelled) setItems(tasks.filter((t) => !t.parent));
        } else {
          const goals = await goalService.getGoals(channel.board._id, month);
          if (!cancelled) {
            const list = Array.isArray(goals) ? goals : [];
            setItems(
              channel.group
                ? list.filter((g) => String(g.group?._id || g.group) === String(channel.group))
                : list
            );
          }
        }
      } catch (err) {
        console.error('Share picker load failed:', err);
        if (!cancelled) setError('Could not load the list.');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [kind, channel]);

  return (
    <div
      className="absolute bottom-full left-0 mb-2 bg-white overflow-y-auto z-20"
      style={{
        width: 320,
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 280,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 sticky top-0 bg-white"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <span className="font-body font-semibold text-[12px] text-[color:var(--color-text-primary)]">
          {kind === 'task' ? 'Share a task' : 'Share a goal'}
        </span>
        <button type="button" onClick={onClose} aria-label="Close">
          <X size={14} color="var(--color-text-muted)" />
        </button>
      </div>
      {error ? (
        <p className="font-body px-3 py-4 text-[12.5px] text-[color:var(--color-text-muted)]">{error}</p>
      ) : items === null ? (
        <p className="font-body px-3 py-4 text-[12.5px] text-[color:var(--color-text-muted)]">Loading…</p>
      ) : items.length === 0 ? (
        <p className="font-body px-3 py-4 text-[12.5px] text-[color:var(--color-text-muted)]">
          Nothing to share here yet.
        </p>
      ) : (
        items.map((item) => (
          <button
            key={item._id}
            type="button"
            onClick={() => onPick(item)}
            className="w-full text-left px-3 py-2 font-body text-[13px] text-[color:var(--color-text-primary)] truncate transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
          >
            {item.name}
          </button>
        ))
      )}
    </div>
  );
};

export default SharePicker;

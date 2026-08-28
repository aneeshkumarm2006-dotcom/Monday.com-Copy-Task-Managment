import { useCallback, useEffect, useState } from 'react';
import { History } from 'lucide-react';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Spinner from '../../ui/Spinner';
import Avatar from '../../ui/Avatar';
import ActivityEntry from '../ActivityEntry';
import * as goalService from '../../../services/goalService';
import { formatDate } from '../../../utils/dateUtils';

/**
 * One goal's history — who promised what, who changed it, who reported it.
 *
 * The rows come from the SAME `ActivityLog` collection as a task's activity
 * feed and arrive in the same shape, which is why they render through the same
 * `ActivityEntry`. A goal event described one way here and another way in the
 * board's exported report is the bug that shape exists to prevent.
 *
 * THE STAMPS ABOVE THE TIMELINE ARE NOT THE FIRST ROW. `createdBy` is read off
 * the goal document, not inferred from a `goal.created` event, because goals
 * that predate this log have no such event — and "Added by" reading "unknown"
 * for every goal already on a board would be a worse answer than the one the
 * document has held all along.
 *
 * Read-only, and open to anyone with `goal.view`: there is nothing in here that
 * is not already on the row it was opened from.
 */
const Stamp = ({ label, user, at }) => {
  if (!user && !at) return null;
  return (
    <div className="flex items-center gap-2 min-w-0">
      {user ? <Avatar user={user} size={22} /> : null}
      <span
        className="font-body truncate"
        style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
      >
        {label}{' '}
        <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>
          {user?.name || 'Unknown'}
        </strong>
        {at ? ` · ${formatDate(at)}` : ''}
      </span>
    </div>
  );
};

const GoalHistoryModal = ({
  goal,
  groupName,
  monthLabel,
  // Goal type key → its plain-language label, from `/api/goal-types`. Passed
  // down rather than looked up here so the timeline never holds a second copy
  // of a catalog the server owns.
  typeLabels = {},
  onClose,
}) => {
  const goalId = goal?._id;

  const [header, setHeader] = useState(null);
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!goalId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    goalService
      .getGoalActivity(goalId)
      .then((data) => {
        if (cancelled) return;
        setHeader(data.goal || null);
        setItems(data.items || []);
        setNextCursor(data.nextCursor || null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.response?.data?.error || 'Could not load this goal’s history.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [goalId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await goalService.getGoalActivity(goalId, { cursor: nextCursor });
      setItems((prev) => [...prev, ...(data.items || [])]);
      setNextCursor(data.nextCursor || null);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load any more.');
    } finally {
      setLoadingMore(false);
    }
  }, [goalId, nextCursor, loadingMore]);

  // Prefer the freshly-read document over the row the modal was opened from:
  // somebody else may have renamed the goal since this tab last fetched.
  const name = header?.name || goal?.name || 'this goal';
  const createdBy = header?.createdBy || goal?.createdBy || null;
  const updatedBy = header?.updatedBy || goal?.updatedBy || null;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`History — ${name}`}
      maxWidth={560}
    >
      <p
        className="font-body"
        style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: -4 }}
      >
        {[groupName, monthLabel].filter(Boolean).join(' · ')}
      </p>

      {/* Who put this goal on the board, and who last touched it. Above the
          timeline rather than inside it: these two are true of the goal, while
          everything below is something that happened to it. */}
      {(createdBy || updatedBy || header?.createdAt) && (
        <div
          className="flex flex-col gap-2 mt-3"
          style={{
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-subtle)',
          }}
        >
          <Stamp label="Added by" user={createdBy} at={header?.createdAt} />
          {/* Only when it says something the line above does not. */}
          {updatedBy && String(updatedBy?._id) !== String(createdBy?._id) && (
            <Stamp label="Last edited by" user={updatedBy} at={header?.updatedAt} />
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : error ? (
        <p
          className="font-body py-6 text-center"
          style={{ fontSize: 13, color: 'var(--color-status-stuck)' }}
        >
          {error}
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <History size={20} color="var(--color-text-muted)" aria-hidden="true" />
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            Nothing has been recorded against this goal yet.
          </p>
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            Changes made from now on will show up here.
          </p>
        </div>
      ) : (
        <>
          <ul
            className="mt-2"
            style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 420, overflowY: 'auto' }}
          >
            {items.map((entry) => (
              <ActivityEntry key={entry._id} entry={entry} typeLabels={typeLabels} />
            ))}
          </ul>
          {nextCursor && (
            <div className="flex justify-center mt-2">
              <Button variant="ghost" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load older changes'}
              </Button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
};

export default GoalHistoryModal;

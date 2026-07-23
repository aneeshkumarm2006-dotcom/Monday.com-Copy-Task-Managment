import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Filter as FilterIcon } from 'lucide-react';
import * as activityService from '../../services/activityService';
import useOrgStore from '../../store/orgStore';
import ActivityEntry from './ActivityEntry';

// Mirrored from server/src/models/ActivityLog.js ACTIVITY_TYPES — keep in sync
// when adding new event types. Used for the type filter dropdown.
const TYPE_OPTIONS = [
  { value: '', label: 'All events' },
  { value: 'task.created', label: 'Task created' },
  { value: 'task.deleted', label: 'Task deleted' },
  { value: 'task.field_changed', label: 'Field changed' },
  { value: 'checklist.added', label: 'Checklist added' },
  { value: 'checklist.toggled', label: 'Checklist toggled' },
  { value: 'checklist.renamed', label: 'Checklist renamed' },
  { value: 'checklist.deleted', label: 'Checklist deleted' },
  { value: 'checklist.reordered', label: 'Checklist reordered' },
  { value: 'attachment.uploaded', label: 'File uploaded' },
  { value: 'attachment.deleted', label: 'File deleted' },
  { value: 'comment.added', label: 'Comment added' },
  { value: 'update.added', label: 'Update posted' },
  { value: 'client.request_created', label: 'Client raised request' },
  { value: 'client.update_added', label: 'Client message' },
];

/**
 * ActivityLogTab — chronological timeline of every meaningful change made
 * to a task. Fetches /api/tasks/:id/activity with cursor-based pagination.
 * Re-fetches on filter change. No WebSocket — manual refresh button.
 */
const ActivityLogTab = ({ taskId }) => {
  const orgMembers = useOrgStore((s) => s.members);

  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const [actorFilter, setActorFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  // Actor options come from org members (board tasks) or empty (personal).
  const actorOptions = useMemo(
    () => [
      { value: '', label: 'All people' },
      ...orgMembers.map((m) => ({ value: m._id, label: m.name || m.email || '?' })),
    ],
    [orgMembers]
  );

  // Initial load + reload on filter or refresh.
  useEffect(() => {
    if (!taskId) {
      setItems([]);
      setNextCursor(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    activityService
      .getActivity(taskId, {
        actor: actorFilter || undefined,
        type: typeFilter || undefined,
      })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items || []);
        setNextCursor(data.nextCursor || null);
      })
      .catch((err) => {
        console.error('Failed to load activity:', err);
        if (!cancelled) {
          setError(
            err?.response?.data?.error || 'Failed to load activity log.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, actorFilter, typeFilter, refreshKey]);

  const handleLoadMore = useCallback(async () => {
    if (!taskId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await activityService.getActivity(taskId, {
        cursor: nextCursor,
        actor: actorFilter || undefined,
        type: typeFilter || undefined,
      });
      setItems((prev) => [...prev, ...(data.items || [])]);
      setNextCursor(data.nextCursor || null);
    } catch (err) {
      console.error('Failed to load more activity:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [taskId, nextCursor, actorFilter, typeFilter, loadingMore]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 0 }}>
      {/* Filter bar */}
      <div
        className="flex items-center gap-2 flex-wrap"
        style={{
          padding: '12px 24px',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <FilterIcon
          size={14}
          aria-hidden="true"
          style={{ color: 'var(--color-text-muted)' }}
        />
        <select
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          aria-label="Filter by person"
          className="font-body"
          style={{
            fontSize: 12,
            padding: '4px 8px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg-surface, #FFFFFF)',
            color: 'var(--color-text-secondary)',
            cursor: 'pointer',
          }}
        >
          {actorOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Filter by event type"
          className="font-body"
          style={{
            fontSize: 12,
            padding: '4px 8px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg-surface, #FFFFFF)',
            color: 'var(--color-text-secondary)',
            cursor: 'pointer',
          }}
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleRefresh}
          aria-label="Refresh activity"
          title="Refresh"
          className="inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-bg-subtle)]"
          style={{
            width: 28,
            height: 28,
            marginLeft: 'auto',
            background: 'transparent',
            border: 'none',
            color: 'var(--color-text-secondary)',
            cursor: loading ? 'wait' : 'pointer',
          }}
          disabled={loading}
        >
          <RefreshCw
            size={14}
            aria-hidden="true"
            style={{
              animation: loading ? 'spin 1s linear infinite' : 'none',
            }}
          />
        </button>
      </div>

      {/* Timeline */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ padding: '0 24px', minHeight: 0 }}
      >
        {loading && items.length === 0 ? (
          <p
            className="font-body text-center"
            style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '24px 0' }}
          >
            Loading activity…
          </p>
        ) : error ? (
          <p
            className="font-body text-center"
            role="alert"
            style={{ fontSize: 13, color: 'var(--color-status-stuck)', padding: '24px 0' }}
          >
            {error}
          </p>
        ) : items.length === 0 ? (
          <p
            className="font-body text-center"
            style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '32px 0' }}
          >
            No activity yet.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {items.map((entry) => (
              <li
                key={entry._id}
                style={{
                  borderBottom: '1px solid var(--color-border)',
                }}
              >
                <ActivityEntry entry={entry} />
              </li>
            ))}
          </ul>
        )}

        {nextCursor && (
          <div style={{ textAlign: 'center', padding: '12px 0 24px 0' }}>
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="font-body"
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 14px',
                background: 'var(--color-bg-subtle, #F3F4F6)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                cursor: loadingMore ? 'wait' : 'pointer',
              }}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ActivityLogTab;

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarCheck, Settings2 } from 'lucide-react';

import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import { SkeletonBlock } from '../../ui/Skeleton';
import { Toggle } from '../../ui/FormControls';
import useTaskStore from '../../../store/taskStore';
import useToastStore from '../../../store/toastStore';
import * as trackerService from '../../../services/trackerService';
import { loadPrefs, orderTrackers, savePrefs, windowFor } from '../../../utils/deliveryPrefs';
import DeliverySummary from './DeliverySummary';
import DeliverySection from './DeliverySection';
import DeliveryCellPopover from './DeliveryCellPopover';
import NeedsAttention from './NeedsAttention';
import TrackersModal from './TrackersModal';

/**
 * The Delivery tab: summary tiles, one section per tracker, then the list of
 * clients that actually need chasing.
 *
 * No new Zustand slice — nothing else in the app needs this data, so it lives in
 * component state and refetches on the existing SSE `board.changed` signal.
 */

const SkeletonSection = () => (
  <div
    style={{
      background: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      padding: 20,
    }}
  >
    <SkeletonBlock width={180} height={16} />
    <div style={{ marginTop: 10 }}>
      <SkeletonBlock width={280} height={12} />
    </div>
    {/* The skeleton teaches the layout before the data lands, which a spinner
        cannot do — you already know a grid is coming and roughly how big. */}
    <div className="mt-5 flex flex-col gap-2" style={{ opacity: 0.4 }}>
      {Array.from({ length: 6 }).map((_, r) => (
        <div key={r} className="flex items-center gap-1.5">
          <SkeletonBlock width={140} height={14} />
          {Array.from({ length: 12 }).map((__, c) => (
            <SkeletonBlock key={c} width={24} height={24} borderRadius={6} />
          ))}
        </div>
      ))}
    </div>
  </div>
);

const DeliveryTab = ({ boardId, groups = [], canManage, onOpenTask }) => {
  const [delivery, setDelivery] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [prefs, setPrefs] = useState(() => loadPrefs(boardId));
  const [modal, setModal] = useState(null); // null | { view }
  const [popover, setPopover] = useState(null);

  const toastError = useToastStore((s) => s.error);
  const boardRefreshSignal = useTaskStore((s) => s.boardRefreshSignal);
  const boardRefreshTarget = useTaskStore((s) => s.boardRefreshTarget);
  const sectionRefs = useRef(new Map());

  const updatePrefs = useCallback(
    (patch) => {
      setPrefs((prev) => {
        const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
        savePrefs(boardId, next);
        return next;
      });
    },
    [boardId]
  );

  const windows = useMemo(() => {
    const out = {};
    for (const t of delivery?.trackers || []) out[t._id] = windowFor(prefs, t);
    return out;
  }, [delivery, prefs]);

  const fetchDelivery = useCallback(
    async (windowMap, { quiet = false } = {}) => {
      if (!boardId) return;
      if (!quiet) setLoading(true);
      try {
        const data = await trackerService.getDelivery(boardId, windowMap);
        setDelivery(data);
        setError(null);
      } catch (err) {
        // 403 here is meaningful — the feature is off, or the role lacks the
        // capability — so the tab renders the server's own sentence rather than
        // firing the generic toast.
        setError(err?.response?.data?.error || 'Could not load the delivery view.');
      } finally {
        setLoading(false);
      }
    },
    [boardId]
  );

  useEffect(() => {
    setPrefs(loadPrefs(boardId));
    fetchDelivery({});
  }, [boardId, fetchDelivery]);

  // Live refresh off the existing SSE board.changed path, debounced: creating
  // five tasks in a row must not fire five refetches.
  useEffect(() => {
    if (boardRefreshTarget !== boardId) return undefined;
    const timer = setTimeout(() => fetchDelivery(windows, { quiet: true }), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRefreshSignal]);

  const changeWindow = (tracker, token) => {
    const nextWindows = { ...windows, [tracker._id]: token };
    updatePrefs((p) => ({ ...p, windows: { ...p.windows, [tracker._id]: token } }));
    fetchDelivery(nextWindows, { quiet: true });
  };

  const mutateEntry = async (fn, label) => {
    try {
      await fn();
      await fetchDelivery(windows, { quiet: true });
    } catch (err) {
      toastError(err?.response?.data?.error || `Could not ${label}.`);
    }
  };

  const trackers = useMemo(
    () => orderTrackers(delivery?.trackers || [], prefs.order),
    [delivery, prefs.order]
  );

  const visibleTrackers = useMemo(() => {
    if (!prefs.hideUntracked) return trackers;
    return trackers.map((t) => ({
      ...t,
      rows: (t.rows || []).filter((r) => r.summary.required > 0),
    }));
  }, [trackers, prefs.hideUntracked]);

  const jumpToTracker = (item) => {
    const node = sectionRefs.current.get(String(item.trackerId));
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (loading && !delivery) {
    return (
      <div className="mt-5 flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonBlock key={i} height={120} borderRadius="var(--radius-lg)" />
          ))}
        </div>
        <SkeletonSection />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-5">
        <EmptyState
          icon={CalendarCheck}
          title="Delivery is not available"
          description={error}
        />
      </div>
    );
  }

  const hasTrackers = trackers.length > 0;

  return (
    <div className="mt-5 flex flex-col gap-4">
      {hasTrackers ? (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-4 flex-wrap">
              <Toggle
                checked={prefs.density === 'compact'}
                onChange={(v) => updatePrefs({ density: v ? 'compact' : 'comfortable' })}
                label="Compact rows"
              />
              <Toggle
                checked={prefs.hideUntracked}
                onChange={(v) => updatePrefs({ hideUntracked: v })}
                label="Hide clients with nothing tracked"
              />
            </div>
            {canManage && (
              <Button variant="secondary" size="sm" icon={Settings2} onClick={() => setModal({ view: 'list' })}>
                Trackers
              </Button>
            )}
          </div>

          <DeliverySummary trackers={trackers} />

          {visibleTrackers.map((tracker) => (
            <DeliverySection
              key={tracker._id}
              sectionRef={(node) => {
                if (node) sectionRefs.current.set(String(tracker._id), node);
                else sectionRefs.current.delete(String(tracker._id));
              }}
              tracker={tracker}
              groups={groups}
              canManage={canManage}
              density={prefs.density}
              collapsed={!!prefs.collapsed[tracker._id]}
              view={prefs.views[tracker._id] || 'grid'}
              window={windows[tracker._id]}
              onToggleCollapsed={() =>
                updatePrefs((p) => ({
                  ...p,
                  collapsed: { ...p.collapsed, [tracker._id]: !p.collapsed[tracker._id] },
                }))}
              onChangeView={(v) =>
                updatePrefs((p) => ({ ...p, views: { ...p.views, [tracker._id]: v } }))}
              onChangeWindow={(token) => changeWindow(tracker, token)}
              onEdit={() => setModal({ view: 'list' })}
              onCellClick={({ cell, period, row, anchor }) =>
                setPopover({ tracker, cell, period, row, anchor })}
            />
          ))}

          <NeedsAttention trackers={trackers} onJump={jumpToTracker} />
        </>
      ) : (
        <EmptyState
          icon={CalendarCheck}
          title="Nothing is being tracked yet"
          description={
            canManage
              ? 'A tracker is a promise you make to your clients — a task and an update every '
                + 'weekday, a report every month. Add one and this page shows you, client by '
                + 'client, whether it happened.'
              : 'Nobody has set up tracking for this board yet. Ask an admin to add one.'
          }
          actionLabel={canManage ? 'Add your first tracker' : undefined}
          onAction={canManage ? () => setModal({ view: 'form' }) : undefined}
        />
      )}

      {popover && (
        <DeliveryCellPopover
          anchorEl={popover.anchor}
          tracker={popover.tracker}
          period={popover.period}
          row={popover.row}
          cell={popover.cell}
          canManage={canManage}
          onClose={() => setPopover(null)}
          onOpenTask={onOpenTask}
          onConfirm={({ link, note }) =>
            mutateEntry(
              () =>
                trackerService.setTrackerEntry(popover.tracker._id, {
                  group: popover.row.groupId,
                  periodKey: popover.cell.p,
                  state: 'confirmed',
                  link,
                  note,
                }),
              'confirm this period'
            )}
          onExcuse={({ note }) =>
            mutateEntry(
              () =>
                trackerService.setTrackerEntry(popover.tracker._id, {
                  group: popover.row.groupId,
                  periodKey: popover.cell.p,
                  state: 'excused',
                  note,
                }),
              'excuse this period'
            )}
          onClearEntry={() =>
            mutateEntry(
              () =>
                trackerService.deleteTrackerEntry(popover.tracker._id, {
                  group: popover.row.groupId,
                  periodKey: popover.cell.p,
                }),
              'undo this'
            )}
        />
      )}

      {modal && (
        <TrackersModal
          isOpen
          onClose={() => setModal(null)}
          boardId={boardId}
          groups={groups}
          canManage={canManage}
          initialView={modal.view}
          onChanged={() => fetchDelivery(windows, { quiet: true })}
        />
      )}
    </div>
  );
};

export default DeliveryTab;

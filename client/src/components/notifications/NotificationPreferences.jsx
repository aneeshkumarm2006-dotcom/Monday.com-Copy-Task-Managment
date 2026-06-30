import { useEffect, useState } from 'react';
import Switch from '../ui/Switch';
import useToastStore from '../../store/toastStore';
import {
  getPreferences,
  updatePreferences,
} from '../../services/notificationService';

const CATEGORIES = [
  { key: 'assignments', label: 'Assignments', hint: 'When you’re assigned or unassigned' },
  { key: 'mentions', label: 'Mentions', hint: 'When someone @mentions you' },
  { key: 'statusChanges', label: 'Status changes', hint: 'When a task’s status changes' },
  { key: 'updates', label: 'Updates & replies', hint: 'Comments and replies on your tasks' },
  { key: 'dueDates', label: 'Due dates', hint: 'Due-soon and due-date changes' },
  { key: 'taskMoves', label: 'Task moves', hint: 'When a task is moved to a new group' },
  { key: 'invites', label: 'Invites & members', hint: 'Board access and workspace joins' },
];

const minutesToTime = (mins) => {
  const m = ((mins % 1440) + 1440) % 1440;
  const h = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${h}:${mm}`;
};

const timeToMinutes = (str) => {
  const [h, m] = (str || '00:00').split(':').map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
};

const SectionHeading = ({ children }) => (
  <p
    className="font-display font-bold text-[color:var(--color-text-primary)] mb-1"
    style={{ fontSize: 15 }}
  >
    {children}
  </p>
);

/**
 * Notification preferences editor: per-category in-app + email toggles and a
 * Do-Not-Disturb quiet-hours window. Saves each change immediately (optimistic)
 * via PUT /api/notifications/preferences. Shared by the Settings tab and the
 * full-page notification center.
 */
const NotificationPreferences = () => {
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const toastError = useToastStore((s) => s.error);

  useEffect(() => {
    let active = true;
    getPreferences()
      .then((p) => {
        if (active) setPrefs(p);
      })
      .catch(() => {
        if (active) toastError('Could not load notification preferences.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [toastError]);

  // Optimistically apply a change locally, then persist. Rolls back on failure.
  const persist = async (next, patch) => {
    const prev = prefs;
    setPrefs(next);
    try {
      const saved = await updatePreferences(patch);
      setPrefs(saved);
    } catch {
      setPrefs(prev);
      toastError('Could not save preferences. Please try again.');
    }
  };

  const setCategory = (key, channel, value) => {
    const next = {
      ...prefs,
      categories: {
        ...prefs.categories,
        [key]: { ...prefs.categories[key], [channel]: value },
      },
    };
    persist(next, { categories: { [key]: { [channel]: value } } });
  };

  const setDnd = (patch) => {
    const next = { ...prefs, dnd: { ...prefs.dnd, ...patch } };
    persist(next, { dnd: patch });
  };

  if (loading || !prefs) {
    return (
      <div className="py-8 text-center font-body text-[13px] text-[color:var(--color-text-muted)]">
        Loading preferences…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionHeading>Notify me about</SectionHeading>
        <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mb-3">
          Choose which events reach you, and through which channels.
        </p>

        {/* Column headers */}
        <div className="flex items-center gap-4 px-1 pb-2">
          <div className="flex-1" />
          <div className="w-16 text-center font-body text-[11px] uppercase tracking-wide text-[color:var(--color-text-muted)]">
            In-app
          </div>
          <div className="w-16 text-center font-body text-[11px] uppercase tracking-wide text-[color:var(--color-text-muted)]">
            Email
          </div>
        </div>

        <div
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          {CATEGORIES.map((cat, i) => {
            const c = prefs.categories?.[cat.key] || {};
            return (
              <div
                key={cat.key}
                className="flex items-center gap-4 px-3 py-3"
                style={{
                  borderTop:
                    i === 0 ? 'none' : '1px solid var(--color-border)',
                }}
              >
                <div className="flex-1 min-w-0">
                  <p className="font-body text-[13px] font-medium text-[color:var(--color-text-primary)]">
                    {cat.label}
                  </p>
                  <p className="font-body text-[12px] text-[color:var(--color-text-muted)]">
                    {cat.hint}
                  </p>
                </div>
                <div className="w-16 flex justify-center">
                  <Switch
                    checked={c.inApp !== false}
                    onChange={(v) => setCategory(cat.key, 'inApp', v)}
                    label={`${cat.label} in-app`}
                  />
                </div>
                <div className="w-16 flex justify-center">
                  <Switch
                    checked={c.email !== false}
                    onChange={(v) => setCategory(cat.key, 'email', v)}
                    label={`${cat.label} email`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <SectionHeading>Do Not Disturb</SectionHeading>
        <div className="flex items-center justify-between gap-4 mb-3">
          <p className="font-body text-[13px] text-[color:var(--color-text-secondary)]">
            Mute real-time alerts and emails during quiet hours. Notifications
            still collect in your bell.
          </p>
          <Switch
            checked={!!prefs.dnd?.enabled}
            onChange={(v) => setDnd({ enabled: v })}
            label="Enable Do Not Disturb"
          />
        </div>
        {prefs.dnd?.enabled && (
          <div className="flex items-center gap-3">
            <label className="font-body text-[13px] text-[color:var(--color-text-secondary)] flex items-center gap-2">
              From
              <input
                type="time"
                value={minutesToTime(prefs.dnd.startMinute)}
                onChange={(e) =>
                  setDnd({ startMinute: timeToMinutes(e.target.value) })
                }
                className="font-body text-[13px] px-2 py-1"
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                }}
              />
            </label>
            <label className="font-body text-[13px] text-[color:var(--color-text-secondary)] flex items-center gap-2">
              to
              <input
                type="time"
                value={minutesToTime(prefs.dnd.endMinute)}
                onChange={(e) =>
                  setDnd({ endMinute: timeToMinutes(e.target.value) })
                }
                className="font-body text-[13px] px-2 py-1"
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                }}
              />
            </label>
          </div>
        )}
      </section>
    </div>
  );
};

export default NotificationPreferences;

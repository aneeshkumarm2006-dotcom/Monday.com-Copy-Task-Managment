import { useEffect, useMemo, useState } from 'react';
import Switch from '../ui/Switch';
import useToastStore from '../../store/toastStore';
import useOrgStore from '../../store/orgStore';
import useAuthStore from '../../store/authStore';
import { getBoards } from '../../services/boardService';
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

const initialsOf = (name, email) => {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
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
 * A searchable checklist for muting email from a set of entities (boards or
 * people). `items` is [{ id, label, sublabel, avatarText, avatarColor }],
 * `selected` is a Set of muted ids. Each checked row = email muted for it.
 */
const MuteChecklist = ({
  items,
  selected,
  onToggle,
  searchPlaceholder,
  emptyText,
  disabled,
}) => {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return items;
    return items.filter((it) =>
      `${it.label} ${it.sublabel || ''}`.toLowerCase().includes(query)
    );
  }, [items, q]);

  if (!items.length) {
    return (
      <p className="font-body text-[13px] text-[color:var(--color-text-muted)] py-2">
        {emptyText}
      </p>
    );
  }

  return (
    <div style={{ opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
      {items.length > 6 && (
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={searchPlaceholder}
          className="w-full font-body text-[13px] px-3 py-2 mb-2"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
          }}
        />
      )}
      <div
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          maxHeight: 240,
          overflowY: 'auto',
        }}
      >
        {filtered.map((it, i) => {
          const isMuted = selected.has(it.id);
          return (
            <label
              key={it.id}
              className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
              style={{
                borderTop: i === 0 ? 'none' : '1px solid var(--color-border)',
                background: isMuted ? 'var(--color-surface-2, rgba(0,0,0,0.02))' : 'transparent',
              }}
            >
              <span
                className="flex items-center justify-center shrink-0 font-body font-semibold text-white"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  fontSize: 11,
                  background: it.avatarColor || 'var(--color-accent)',
                }}
                aria-hidden="true"
              >
                {it.avatarText}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block font-body text-[13px] font-medium text-[color:var(--color-text-primary)] truncate">
                  {it.label}
                </span>
                {it.sublabel && (
                  <span className="block font-body text-[12px] text-[color:var(--color-text-muted)] truncate">
                    {it.sublabel}
                  </span>
                )}
              </span>
              <input
                type="checkbox"
                checked={isMuted}
                onChange={() => onToggle(it.id)}
                className="shrink-0"
                style={{ width: 16, height: 16, accentColor: 'var(--color-accent)' }}
                aria-label={`Mute email from ${it.label}`}
              />
            </label>
          );
        })}
        {!filtered.length && (
          <p className="font-body text-[13px] text-[color:var(--color-text-muted)] px-3 py-3">
            No matches.
          </p>
        )}
      </div>
    </div>
  );
};

/**
 * Notification preferences editor: per-category in-app + email toggles, email
 * mute switches (master pause, per-board, per-person), and a Do-Not-Disturb
 * quiet-hours window. Saves each change immediately (optimistic) via
 * PUT /api/notifications/preferences. Shared by the Settings tab and the
 * full-page notification center.
 */
const NotificationPreferences = () => {
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [boards, setBoards] = useState([]);
  const toastError = useToastStore((s) => s.error);

  const currentOrgId = useOrgStore((s) => s.currentOrg?._id);
  const orgMembers = useOrgStore((s) => s.members);
  const fetchMembers = useOrgStore((s) => s.fetchMembers);
  const myId = useAuthStore((s) => s.user?._id || s.user?.id);

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

  // Load the boards that power the board-mute checklist. Best effort — a
  // failure just leaves the list empty with a friendly note.
  useEffect(() => {
    if (!currentOrgId) return undefined;
    let active = true;
    getBoards(currentOrgId)
      .then((list) => {
        if (active) setBoards(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        /* leave boards empty */
      });
    return () => {
      active = false;
    };
  }, [currentOrgId]);

  // Ensure org members are loaded for the people-mute checklist (they usually
  // already are from the app shell). Fetch only when empty to avoid a re-fetch
  // loop as the store populates.
  useEffect(() => {
    if (!currentOrgId) return;
    if (!orgMembers || orgMembers.length === 0) {
      fetchMembers(currentOrgId).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrgId]);

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

  const setMasterOff = (value) => {
    persist({ ...prefs, emailMasterOff: value }, { emailMasterOff: value });
  };

  // Toggle one id in a mute array (mutedBoards / mutedActors) and persist the
  // whole (deduped) array — the API replaces the field wholesale.
  const toggleMute = (field, id) => {
    const current = (prefs[field] || []).map(String);
    const set = new Set(current);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    const nextArr = [...set];
    persist({ ...prefs, [field]: nextArr }, { [field]: nextArr });
  };

  const mutedBoardSet = useMemo(
    () => new Set((prefs?.mutedBoards || []).map(String)),
    [prefs]
  );
  const mutedActorSet = useMemo(
    () => new Set((prefs?.mutedActors || []).map(String)),
    [prefs]
  );

  const boardItems = useMemo(
    () =>
      (boards || []).map((b) => ({
        id: String(b._id),
        label: b.name || 'Untitled board',
        sublabel: b.boardType === 'client' ? 'Client portal' : null,
        avatarText: (b.name || '?').trim().slice(0, 2).toUpperCase(),
        avatarColor: b.color || 'var(--color-accent)',
      })),
    [boards]
  );

  const peopleItems = useMemo(
    () =>
      (orgMembers || [])
        .filter((m) => String(m._id) !== String(myId))
        .map((m) => ({
          id: String(m._id),
          label: m.name || m.email || 'Member',
          sublabel: m.name ? m.email : null,
          avatarText: initialsOf(m.name, m.email),
          avatarColor: 'var(--color-accent)',
        })),
    [orgMembers, myId]
  );

  if (loading || !prefs) {
    return (
      <div className="py-8 text-center font-body text-[13px] text-[color:var(--color-text-muted)]">
        Loading preferences…
      </div>
    );
  }

  const masterOff = !!prefs.emailMasterOff;

  return (
    <div className="flex flex-col gap-6">
      {/* ---- Master email switch ---- */}
      <section
        className="flex items-center justify-between gap-4 px-4 py-3.5"
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          background: masterOff
            ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)'
            : 'transparent',
        }}
      >
        <div className="min-w-0">
          <p className="font-display font-bold text-[color:var(--color-text-primary)]" style={{ fontSize: 14 }}>
            Pause all email notifications
          </p>
          <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mt-0.5">
            {masterOff
              ? 'Email is off everywhere. You’ll still see everything in your bell.'
              : 'Turn off every email at once. In-app notifications keep working.'}
          </p>
        </div>
        <Switch
          checked={masterOff}
          onChange={setMasterOff}
          label="Pause all email notifications"
        />
      </section>

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
                <div className="w-16 flex justify-center" style={{ opacity: masterOff ? 0.4 : 1 }}>
                  <Switch
                    checked={c.email !== false}
                    onChange={(v) => setCategory(cat.key, 'email', v)}
                    disabled={masterOff}
                    label={`${cat.label} email`}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {masterOff && (
          <p className="font-body text-[12px] text-[color:var(--color-text-muted)] mt-2">
            Email is paused globally, so these email switches are inactive.
          </p>
        )}
      </section>

      {/* ---- Mute specific boards ---- */}
      <section>
        <SectionHeading>Mute emails from specific boards</SectionHeading>
        <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mb-3">
          Check a board to stop its email notifications. You’ll still get them
          in your bell.
        </p>
        <MuteChecklist
          items={boardItems}
          selected={mutedBoardSet}
          onToggle={(id) => toggleMute('mutedBoards', id)}
          searchPlaceholder="Search boards…"
          emptyText="No boards to show."
          disabled={masterOff}
        />
      </section>

      {/* ---- Mute specific people ---- */}
      <section>
        <SectionHeading>Mute emails from specific people</SectionHeading>
        <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mb-3">
          Check a teammate to stop emails triggered by their actions (their
          assignments, mentions and updates).
        </p>
        <MuteChecklist
          items={peopleItems}
          selected={mutedActorSet}
          onToggle={(id) => toggleMute('mutedActors', id)}
          searchPlaceholder="Search people…"
          emptyText="No teammates to show."
          disabled={masterOff}
        />
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

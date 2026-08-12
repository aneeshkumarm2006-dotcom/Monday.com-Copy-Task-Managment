import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Globe } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Spinner from '../ui/Spinner';
import { previewMonthTimezone, setMonthTimezone } from '../../services/monthService';

/**
 * Change which calendar defines a tracker board's months.
 *
 * The important thing this screen has to communicate is that it is NOT a
 * settings toggle. Moving the timezone moves every month boundary, so a task
 * created near midnight on the 1st changes month — and one that somebody had
 * deliberately moved by hand gets recomputed along with the rest. So the modal
 * refuses to be a bare dropdown: pick a zone, and it tells you exactly how many
 * tasks would move before you can commit.
 */

/** Every zone the browser knows, newest API first with a small hand list behind it. */
const allZones = () => {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone');
    }
  } catch {
    // Older engine — fall through.
  }
  return [
    'UTC', 'Asia/Calcutta', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'America/Toronto', 'America/New_York', 'America/Chicago', 'America/Los_Angeles',
    'Australia/Sydney',
  ];
};

const BoardTimezoneModal = ({ boardId, current, onClose, onChanged }) => {
  const zones = useMemo(() => allZones(), []);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(current || 'UTC');
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const reqRef = useRef(0);

  // Derived rather than stored: if the preview we hold is not for the zone
  // currently selected, one is still in flight. A `checking` state would have to
  // be set synchronously inside the effect below, which is the cascading-render
  // pattern — and this needs no extra state to say the same thing.
  const checking = !error && preview?.to !== picked;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? zones.filter((z) => z.toLowerCase().includes(q))
      : zones;
    return list.slice(0, 200);
  }, [zones, query]);

  // Re-price the change whenever the selection moves. The sequence guard stops a
  // slow earlier response overwriting a newer one.
  useEffect(() => {
    if (!picked) return undefined;
    const seq = ++reqRef.current;
    previewMonthTimezone(boardId, picked)
      .then((p) => { if (seq === reqRef.current) setPreview(p); })
      .catch((err) => {
        if (seq !== reqRef.current) return;
        setPreview(null);
        setError(err?.response?.data?.error || 'Could not work out what would change.');
      });
    return undefined;
  }, [boardId, picked]);

  const commit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await setMonthTimezone(boardId, picked);
      onChanged?.(res);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not change the timezone.');
      setSaving(false);
    }
  };

  const unchanged = preview?.unchanged;

  return (
    <Modal isOpen onClose={saving ? undefined : onClose} title="Month timezone" maxWidth={520}>
      <div className="flex flex-col gap-4">
        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}
        >
          This decides where one month ends and the next begins. A task created
          just before midnight lands on one side or the other depending on it, so
          changing it re-files every task on the board.
        </p>

        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ background: 'var(--color-bg-subtle)', borderRadius: 'var(--radius-md)' }}
        >
          <Globe size={14} color="var(--color-text-secondary)" aria-hidden="true" />
          <span className="font-body" style={{ fontSize: 13 }}>
            Currently <strong>{current}</strong>
          </span>
        </div>

        <Input
          label="Change to"
          placeholder="Search — e.g. Calcutta, Toronto, London"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div
          style={{
            maxHeight: 190,
            overflowY: 'auto',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {matches.length === 0 ? (
            <p className="font-body p-3" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              No timezone matches “{query}”.
            </p>
          ) : (
            matches.map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => { setError(null); setPicked(z); }}
                className="w-full text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
                style={{
                  padding: '7px 12px',
                  fontSize: 13,
                  background: picked === z ? 'var(--color-accent-light)' : 'transparent',
                  color: picked === z ? 'var(--color-accent-text)' : 'var(--color-text-primary)',
                  fontWeight: picked === z ? 600 : 400,
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {z}
                {z === current && (
                  <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}> · current</span>
                )}
              </button>
            ))
          )}
        </div>

        {/* The number that makes this decision informed. */}
        <div
          className="px-3 py-2"
          style={{
            background: unchanged
              ? 'var(--color-bg-subtle)'
              : preview?.moved
                ? 'var(--color-status-working-bg)'
                : 'var(--color-status-done-bg)',
            borderRadius: 'var(--radius-md)',
            minHeight: 44,
          }}
        >
          {checking ? (
            <span className="flex items-center gap-2 font-body" style={{ fontSize: 13 }}>
              <Spinner size={14} /> Working out what would change…
            </span>
          ) : unchanged ? (
            <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              That is the timezone this board already uses.
            </span>
          ) : preview ? (
            <span
              className="flex items-start gap-2 font-body"
              style={{
                fontSize: 13,
                color: preview.moved
                  ? 'var(--color-status-working)'
                  : 'var(--color-status-done)',
              }}
            >
              {preview.moved > 0 && (
                <AlertTriangle size={14} aria-hidden="true" className="shrink-0 mt-0.5" />
              )}
              <span>
                {preview.moved === 0
                  ? `No task changes month. All ${preview.tasks} stay where they are.`
                  : `${preview.moved} of ${preview.tasks} task${preview.tasks === 1 ? '' : 's'} would move to a different month.`}
              </span>
            </span>
          ) : (
            <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              Pick a timezone to see what would change.
            </span>
          )}
        </div>

        {preview?.moved > 0 && (
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            Months are recomputed from each task’s creation date, so any task you
            moved between months by hand will be recomputed too. Trackers keep
            their own separate timezone — worth matching them up if they differ.
          </p>
        )}

        {error && (
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-status-stuck)' }}>
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={commit} disabled={saving || checking || unchanged || !preview}>
            {saving ? 'Re-filing…' : 'Change timezone'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default BoardTimezoneModal;

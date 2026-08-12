import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarRange } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Spinner from '../ui/Spinner';
import { previewBoardConversion, convertBoard } from '../../services/monthService';
import MonthSplitPreview from './MonthSplitPreview';

/**
 * Turn an existing standard board into a monthly one, showing exactly what will
 * happen first.
 *
 * The preview is a real dry run against the server — the same code path the
 * commit uses, with `dryRun: true` — so the histogram is what you will actually
 * get rather than an estimate. Tasks are filed by their creation date, which is
 * the only signal that exists for every task; the copy says so, because a task
 * created on 31 July for August's work will land in July and somebody has to
 * know to move it.
 */
const ConvertToTrackerModal = ({ boardId, boardName, onClose, onConverted }) => {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await previewBoardConversion(boardId, { to: 'tracker', timezone });
        if (!cancelled) setPreview(data);
      } catch (err) {
        if (!cancelled) {
          setError(err?.response?.data?.error || 'Could not work out what would change.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [boardId, timezone]);

  const handleConvert = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await convertBoard(boardId, { to: 'tracker', timezone });
      onConverted?.(result);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not convert this board.');
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={saving ? undefined : onClose}
      title={`Make “${boardName}” a tracker board`}
      maxWidth={560}
    >
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p
            className="font-body"
            style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}
          >
            Every task on this board will be filed into the month it was created in.
            Nothing is deleted, nothing moves between groups — you will just see
            one month at a time.
          </p>

          {preview?.refusals?.length > 0 && (
            <div
              className="flex gap-2 p-3 font-body"
              style={{
                background: 'var(--color-status-stuck-bg)',
                borderRadius: 'var(--radius-md)',
                fontSize: 13,
                color: 'var(--color-status-stuck)',
              }}
            >
              <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
              <span>{preview.refusals.join(' ')}</span>
            </div>
          )}

          {preview?.canConvert && (
            <>
              <MonthSplitPreview preview={preview} />

              <p
                className="font-body"
                style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}
              >
                Filed by creation date, in {preview.timezone}. A task created at the
                end of one month for the next month’s work will land in the earlier
                one — move those with “Move to month” afterwards.
                {preview.subitems > 0 && ` ${preview.subitems} subitem${preview.subitems === 1 ? '' : 's'} will follow their parent.`}
                {preview.noGroup > 0 && ` ${preview.noGroup} task${preview.noGroup === 1 ? ' is' : 's are'} in no group and will not appear in any group section.`}
              </p>

              {preview.warnings?.length > 0 && (
                <p
                  className="font-body"
                  style={{ fontSize: 12, color: 'var(--color-status-working)' }}
                >
                  {preview.warnings.join(' ')}
                </p>
              )}

              <div>
                <p
                  className="font-body font-medium mb-1"
                  style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}
                >
                  You’ll also get
                </p>
                <ul className="flex flex-col gap-1">
                  {(preview.effects || []).map((e) => (
                    <li
                      key={e}
                      className="font-body flex gap-2"
                      style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
                    >
                      <CalendarRange size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                      {e}
                    </li>
                  ))}
                </ul>
              </div>

              <p
                className="font-body"
                style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
              >
                You can switch this board back to a standard board later. Tasks keep
                their month either way, so converting again is instant.
              </p>
            </>
          )}

          {error && (
            <p
              className="font-body"
              style={{ fontSize: 13, color: 'var(--color-status-stuck)' }}
            >
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            {preview?.canConvert && (
              <Button onClick={handleConvert} disabled={saving}>
                {saving ? 'Converting…' : 'Make it a tracker board'}
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};

export default ConvertToTrackerModal;

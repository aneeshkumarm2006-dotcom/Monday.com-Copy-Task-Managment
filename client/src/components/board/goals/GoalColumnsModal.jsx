import { useState } from 'react';
import { Trash2, Plus, ArrowUp, ArrowDown } from 'lucide-react';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import { Toggle } from '../../ui/FormControls';
import * as goalService from '../../../services/goalService';

/**
 * The shared goal-column schema. Org admins only.
 *
 * These columns are identical for every group on the board — that is the point,
 * because it is what lets one client's month be compared with another's. So the
 * copy here is careful to say that a change lands everywhere, and the required
 * toggle spells out its consequence before you flip it.
 *
 * Deleting ARCHIVES by default. Losing a chip is a nuisance; losing a number
 * somebody already reported to a client is not, so the hard delete is a second,
 * explicit confirmation that names how many rows hold a value.
 *
 * ---- `prefill` and `onAdded` -----------------------------------------------
 *
 * Both optional, both additive, and both exist for one caller: the connector
 * field-mapping panel's "Add a column for this". Somebody looking at "Search
 * volume — nowhere to put it" should get a column named and typed to match in
 * one step, and be bound to it without hunting for it in a second dropdown. So
 * the panel opens this modal already filled in and takes the created column
 * back. Every existing caller passes neither and behaves exactly as before.
 */
const COLUMN_KINDS = [
  { type: 'text', label: 'Text', example: 'A note, a name, anything short' },
  { type: 'number', label: 'Number', example: 'A count or an amount' },
  { type: 'date', label: 'Date', example: 'When something happened' },
  { type: 'dropdown', label: 'Choose from a list', example: 'Pick one of your own options' },
  { type: 'link', label: 'Link', example: 'A report or a document' },
  { type: 'person', label: 'Person', example: 'Who is on it' },
];

const GoalColumnsModal = ({
  boardId,
  columns = [],
  onClose,
  onChanged,
  // { name, type } — opens straight into the add form with those filled in.
  prefill = null,
  // Called with the column that was just created, so a caller can bind to it.
  onAdded,
}) => {
  const [rows, setRows] = useState(columns);
  const [adding, setAdding] = useState(!!prefill);
  const [draft, setDraft] = useState({
    name: prefill?.name || '',
    type: prefill?.type || 'text',
    required: false,
    options: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmPurge, setConfirmPurge] = useState(null);

  const apply = (next) => {
    setRows(next);
    onChanged?.(next);
  };

  const guard = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      apply(await fn());
    } catch (err) {
      setError(err?.response?.data?.error || 'That change did not save.');
    } finally {
      setBusy(false);
    }
  };

  const addColumn = () => {
    if (!draft.name.trim()) { setError('Give the column a name.'); return; }
    guard(async () => {
      const settings = draft.type === 'dropdown'
        ? {
          options: draft.options
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((label, i) => ({ id: `${i}_${label.toLowerCase()}`, label, order: i })),
        }
        : undefined;
      // Which ids existed before, so the new column can be handed back to a
      // caller that wants to bind to it. The server returns the whole list and
      // does not single the new one out.
      const before = new Set(rows.map((c) => String(c._id)));
      const next = await goalService.addGoalColumn(boardId, {
        name: draft.name.trim(), type: draft.type, required: draft.required, settings,
      });
      setAdding(false);
      setDraft({ name: '', type: 'text', required: false, options: '' });
      const added = next.find((c) => !before.has(String(c._id)));
      if (added) onAdded?.(added);
      return next;
    });
  };

  const move = (index, delta) => {
    const ordered = rows.filter((c) => !c.archived);
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[target]] = [next[target], next[index]];
    guard(() => goalService.reorderGoalColumns(boardId, next.map((c) => c._id)));
  };

  const remove = async (col, purge) => {
    setBusy(true);
    setError(null);
    try {
      const res = await goalService.deleteGoalColumn(boardId, col._id, { purge });
      if (!purge && res.valuedRowCount > 0) setConfirmPurge({ col, count: res.valuedRowCount });
      else setConfirmPurge(null);
      apply(res.columns);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not remove that column.');
    } finally {
      setBusy(false);
    }
  };

  const live = rows.filter((c) => !c.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const archived = rows.filter((c) => c.archived);

  return (
    <Modal isOpen onClose={onClose} title="Goal columns" maxWidth={620}>
      <div className="flex flex-col gap-4">
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          These columns appear on every group’s goals table, on every month of this
          board — that is what makes one client’s month comparable with another’s.
          Anyone who can set this board’s goals can change them.
        </p>

        <div className="flex flex-col gap-2">
          {live.length === 0 && (
            <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              No extra columns yet. Goals already track their target, their result and
              their score — add a column only for detail those don’t cover.
            </p>
          )}
          {live.map((col, i) => (
            <div
              key={col._id}
              className="flex items-center gap-2 p-2"
              style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}
            >
              <div className="flex flex-col">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0 || busy} aria-label="Move up">
                  <ArrowUp size={12} color="var(--color-text-muted)" />
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === live.length - 1 || busy} aria-label="Move down">
                  <ArrowDown size={12} color="var(--color-text-muted)" />
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-body font-medium truncate" style={{ fontSize: 13 }}>{col.name}</p>
                <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  {COLUMN_KINDS.find((k) => k.type === col.type)?.label || col.type}
                </p>
              </div>
              <label className="flex items-center gap-2 shrink-0">
                <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  Required
                </span>
                <Toggle
                  checked={col.required}
                  disabled={busy}
                  onChange={(v) =>
                    guard(() => goalService.updateGoalColumn(boardId, col._id, { required: v }))
                  }
                />
              </label>
              <button type="button" onClick={() => remove(col, false)} disabled={busy} aria-label={`Remove ${col.name}`}>
                <Trash2 size={14} color="var(--color-status-stuck)" />
              </button>
            </div>
          ))}
        </div>

        {confirmPurge && (
          <div
            className="p-3"
            style={{ background: 'var(--color-status-stuck-bg)', borderRadius: 'var(--radius-md)' }}
          >
            <p className="font-body" style={{ fontSize: 13, color: 'var(--color-status-stuck)' }}>
              “{confirmPurge.col.name}” is hidden, but {confirmPurge.count} goal
              {confirmPurge.count === 1 ? '' : 's'} still hold a value in it. Delete those
              values permanently?
            </p>
            <div className="flex gap-2 mt-2">
              <Button variant="secondary" onClick={() => setConfirmPurge(null)}>Keep them</Button>
              <Button variant="danger" onClick={() => remove(confirmPurge.col, true)} disabled={busy}>
                Delete permanently
              </Button>
            </div>
          </div>
        )}

        {archived.length > 0 && (
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {archived.length} hidden column{archived.length === 1 ? '' : 's'} — their values
            are kept but not shown.
          </p>
        )}

        {adding ? (
          <div
            className="flex flex-col gap-3 p-3"
            style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}
          >
            <Input
              label="What should this column be called?"
              placeholder="Report link"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              autoFocus
            />
            <div>
              <label
                className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                What kind of thing goes in it?
              </label>
              <div className="grid grid-cols-2 gap-2">
                {COLUMN_KINDS.map((k) => (
                  <button
                    key={k.type}
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, type: k.type }))}
                    className="text-left p-2"
                    style={{
                      border: `1.5px solid ${draft.type === k.type ? 'var(--color-accent)' : 'var(--color-border)'}`,
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    <span className="font-body font-medium block" style={{ fontSize: 13 }}>{k.label}</span>
                    <span className="font-body block" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                      {k.example}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            {draft.type === 'dropdown' && (
              <Input
                label="What are the choices?"
                placeholder="Not started, In progress, Done"
                helperText="Separate them with commas."
                value={draft.options}
                onChange={(e) => setDraft((d) => ({ ...d, options: e.target.value }))}
              />
            )}
            <label className="flex items-center gap-2">
              <Toggle
                checked={draft.required}
                onChange={(v) => setDraft((d) => ({ ...d, required: v }))}
              />
              <span className="font-body" style={{ fontSize: 13 }}>
                Do people have to fill this in?
              </span>
            </label>
            {draft.required && (
              <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                A goal can’t be saved without it, and a month can’t be closed until every
                goal has one. Goals added before today won’t be affected.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
              <Button onClick={addColumn} disabled={busy}>Add column</Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" icon={Plus} onClick={() => setAdding(true)}>
            Add a column
          </Button>
        )}

        {error && (
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-status-stuck)' }}>
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
};

export default GoalColumnsModal;

import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Toggle } from '../ui/FormControls';
import useBoardStore from '../../store/boardStore';
import useToastStore from '../../store/toastStore';

/**
 * WHICH BOARDS A "CONNECT BOARDS" COLUMN LINKS TO — the one editor for it.
 *
 * Used twice, and it used to exist once: `AddColumnButton` had this checklist
 * inline in its create step, and nothing else could set targets at all. So a
 * connect column created without them — which is every Billing board's
 * "Client" column, seeded by the template with no target — could never be
 * pointed anywhere: its cell said "No matching rows" forever, and even its
 * footer summary refused to save. Extracted so the column menu ("Connected
 * boards…") and the cell's own "Set up" open the same control the create flow
 * uses.
 *
 * `ConnectTargetsEditor` is the fields alone (controlled); the create step
 * wraps it with a name and an Add button. `ConnectTargetsModal` is the edit
 * surface: it PATCHes `settings: { ...column.settings, targetBoardIds,
 * allowMultiple }` and shows the server's refusal where the person is looking.
 *
 * Props (editor):
 *   boardId   the board the column is ON — the server lists what it may target
 *   value     { targetBoardIds: string[], allowMultiple: boolean }
 *   onChange  (nextValue) => void
 */

const ConnectTargetsEditor = ({ boardId, value, onChange, disabled = false }) => {
  const fetchConnectable = useBoardStore((s) => s.fetchConnectable);
  const [state, setState] = useState({ loading: true, list: [], error: '' });
  const selected = (value?.targetBoardIds || []).map(String);
  // Read exactly as the cell reads it (`!!settings.allowMultiple`): a column
  // with no flag links ONE row, and defaulting this toggle to on would quietly
  // turn every template's single-client column multi-valued on its first save.
  const allowMultiple = !!value?.allowMultiple;

  useEffect(() => {
    if (!boardId) return undefined;
    let cancelled = false;
    fetchConnectable(boardId)
      .then((list) => {
        if (!cancelled) setState({ loading: false, list: Array.isArray(list) ? list : [], error: '' });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            loading: false,
            list: [],
            error: err?.response?.data?.error || 'Could not load the boards you can connect to.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [boardId, fetchConnectable]);

  const toggle = (bid) => {
    const next = selected.includes(bid) ? selected.filter((x) => x !== bid) : [...selected, bid];
    onChange?.({ targetBoardIds: next, allowMultiple });
  };

  // A target this viewer cannot see any more (deleted, or made private) still
  // counts as selected on the column; say so rather than silently dropping it
  // on the next save.
  const known = new Set(state.list.map((e) => String(e.board?._id)));
  const unseen = state.loading ? 0 : selected.filter((id) => !known.has(id)).length;

  return (
    <div>
      <span
        id={`connect-targets-${boardId}`}
        style={{ display: 'block', fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}
      >
        Link rows from
      </span>
      <div
        role="group"
        aria-labelledby={`connect-targets-${boardId}`}
        style={{
          maxHeight: 180,
          overflowY: 'auto',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          padding: 4,
          marginBottom: 10,
        }}
      >
        {state.loading ? (
          <div style={{ padding: 6, fontSize: 12, color: 'var(--color-text-muted)' }}>Loading boards…</div>
        ) : state.error ? (
          <div role="alert" style={{ padding: 6, fontSize: 12, color: 'var(--color-status-stuck)' }}>
            {state.error}
          </div>
        ) : state.list.length === 0 ? (
          <div style={{ padding: 6, fontSize: 12, color: 'var(--color-text-muted)' }}>
            No other boards in this workspace you can see. Create the board your rows live on
            (a Clients board, say) first.
          </div>
        ) : (
          state.list.map((entry) => {
            const bid = String(entry.board._id);
            return (
              <label
                key={bid}
                className="hover:bg-[color:var(--color-bg-subtle)]"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 6px',
                  fontSize: 13,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(bid)}
                  disabled={disabled}
                  onChange={() => toggle(bid)}
                  style={{ accentColor: 'var(--color-accent)', width: 15, height: 15 }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.board.name}
                </span>
              </label>
            );
          })
        )}
      </div>
      {unseen > 0 && (
        <p style={{ margin: '-4px 0 10px', fontSize: 11, color: 'var(--color-text-muted)' }}>
          Also linked to {unseen} board{unseen === 1 ? '' : 's'} you can&rsquo;t see.
        </p>
      )}
      <div style={{ marginBottom: 10 }}>
        <Toggle
          checked={allowMultiple}
          disabled={disabled}
          onChange={(checked) => onChange?.({ targetBoardIds: selected, allowMultiple: checked })}
          label="Allow linking more than one row"
        />
      </div>
    </div>
  );
};

/**
 * The edit surface: a modal over the board, opened from the column menu or a
 * cell's "Set up". Mounted only while open, so it starts from the column's
 * current settings every time.
 */
export const ConnectTargetsModal = ({ boardId, column, onClose }) => {
  const updateColumn = useBoardStore((s) => s.updateColumn);
  const toastSuccess = useToastStore((s) => s.success);
  const [value, setValue] = useState(() => ({
    targetBoardIds: (column?.settings?.targetBoardIds || []).map(String),
    allowMultiple: !!column?.settings?.allowMultiple,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!boardId || !column?._id) return;
    if (value.targetBoardIds.length === 0) {
      setError('Pick at least one board to link rows from.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await updateColumn(boardId, column._id, {
        settings: {
          ...(column.settings || {}),
          targetBoardIds: value.targetBoardIds,
          allowMultiple: value.allowMultiple,
        },
      });
      toastSuccess(`${column.name || 'Column'} now links rows from ${value.targetBoardIds.length} board${value.targetBoardIds.length === 1 ? '' : 's'}.`);
      onClose?.();
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not save the connected boards.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Connected boards — ${column?.name || 'Column'}`}
      maxWidth={440}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving || value.targetBoardIds.length === 0}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--color-text-secondary)' }}>
        Each row on this board can link to rows on the boards you pick here — an invoice to its
        client, say.
      </p>
      <ConnectTargetsEditor boardId={boardId} value={value} onChange={setValue} disabled={saving} />
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--color-status-stuck)' }}>
          {error}
        </p>
      )}
    </Modal>
  );
};

export default ConnectTargetsEditor;

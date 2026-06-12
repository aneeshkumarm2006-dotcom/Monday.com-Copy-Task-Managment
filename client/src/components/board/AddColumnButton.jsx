import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import useBoardStore from '../../store/boardStore';
import useToastStore from '../../store/toastStore';

/**
 * AddColumnButton — opens a type picker and creates a new column via the
 * boardStore. Categories mirror the grouping in the phase doc.
 *
 * Cross-board types (F2) carry extra configuration:
 *   - connect_boards → pick target board(s) + allow-multiple
 *   - mirror         → pick a source connect column + a source column +
 *                      aggregation (disabled until a connect column exists)
 *
 * Props:
 *   board   — current board doc (with `columns`); preferred
 *   boardId — fallback board id (back-compat)
 */

const MIRROR_AGGREGATIONS = ['first', 'concat', 'sum', 'min', 'max', 'count'];

const CATEGORIES = [
  {
    name: 'Text',
    types: [
      { id: 'text', label: 'Text' },
      { id: 'long_text', label: 'Long Text' },
      { id: 'link', label: 'Link' },
      { id: 'email', label: 'Email' },
      { id: 'phone', label: 'Phone' },
    ],
  },
  {
    name: 'Numbers',
    types: [
      { id: 'number', label: 'Number' },
      { id: 'rating', label: 'Rating' },
      { id: 'formula', label: 'Formula (read-only)' },
    ],
  },
  {
    name: 'People',
    types: [{ id: 'person', label: 'People' }],
  },
  {
    name: 'Dates',
    types: [
      { id: 'date', label: 'Date' },
      { id: 'timeline', label: 'Timeline' },
    ],
  },
  {
    name: 'Custom',
    types: [
      { id: 'status', label: 'Status (chips)' },
      { id: 'dropdown', label: 'Dropdown' },
      { id: 'tags', label: 'Tags (multi)' },
      { id: 'checkbox', label: 'Checkbox' },
      { id: 'location', label: 'Location' },
      { id: 'file', label: 'File' },
    ],
  },
  {
    name: 'Connect',
    types: [
      { id: 'connect_boards', label: 'Connect boards' },
      { id: 'mirror', label: 'Mirror column' },
    ],
  },
];

const menuItemStyle = {
  display: 'block',
  width: '100%',
  padding: '6px 10px',
  fontSize: 12,
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--color-text-primary)',
};

const labelStyle = {
  fontSize: 11,
  color: 'var(--color-text-muted)',
  marginBottom: 4,
  display: 'block',
};

const controlStyle = {
  width: '100%',
  padding: '6px 8px',
  fontSize: 13,
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  marginBottom: 10,
  background: 'var(--color-bg-surface, #fff)',
  color: 'var(--color-text-primary)',
};

const AddColumnButton = ({ boardId, board }) => {
  const id = boardId || (board && board._id);
  const [open, setOpen] = useState(false);
  // 'picker' | 'naming' | 'connect-config' | 'mirror-config'
  const [step, setStep] = useState('picker');
  const [pickedType, setPickedType] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // connect_boards config
  const [connectable, setConnectable] = useState([]);
  const [selectedTargetIds, setSelectedTargetIds] = useState([]);
  const [allowMultiple, setAllowMultiple] = useState(true);

  // mirror config
  const [sourceConnectColumnId, setSourceConnectColumnId] = useState('');
  const [sourceColumnId, setSourceColumnId] = useState('');
  const [aggregation, setAggregation] = useState('first');

  const ref = useRef(null);
  const nameRef = useRef(null);
  const addColumn = useBoardStore((s) => s.addColumn);
  const fetchConnectable = useBoardStore((s) => s.fetchConnectable);
  const toastError = useToastStore((s) => s.error);

  const connectColumns = (board && Array.isArray(board.columns) ? board.columns : []).filter(
    (c) => c.type === 'connect_boards'
  );
  const hasConnectColumn = connectColumns.length > 0;

  const resetAll = () => {
    setStep('picker');
    setPickedType(null);
    setName('');
    setSelectedTargetIds([]);
    setAllowMultiple(true);
    setSourceConnectColumnId('');
    setSourceColumnId('');
    setAggregation('first');
  };

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      setOpen(false);
      resetAll();
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  useEffect(() => {
    if (step === 'naming' && nameRef.current) nameRef.current.focus();
  }, [step]);

  const loadConnectable = async () => {
    if (!id) return;
    try {
      const list = await fetchConnectable(id);
      setConnectable(list || []);
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not load connectable boards');
    }
  };

  const startWithType = (typeId, defaultName) => {
    setPickedType(typeId);
    setName(defaultName);
    if (typeId === 'connect_boards') {
      setStep('connect-config');
      loadConnectable();
    } else if (typeId === 'mirror') {
      if (!hasConnectColumn) return; // disabled — guard
      setStep('mirror-config');
      loadConnectable();
    } else {
      setStep('naming');
    }
  };

  const close = () => {
    setOpen(false);
    resetAll();
  };

  // Source columns available to a mirror: the columns of the FIRST target
  // board of the selected connect column (the common single-target case).
  const sourceColumnOptions = (() => {
    if (!sourceConnectColumnId) return [];
    const connectCol = connectColumns.find((c) => c._id.toString() === sourceConnectColumnId);
    const targetIds = connectCol?.settings?.targetBoardIds || [];
    if (targetIds.length === 0) return [];
    const firstTarget = connectable.find(
      (entry) => entry.board._id.toString() === targetIds[0].toString()
    );
    const cols = firstTarget?.board?.columns || [];
    // Mirroring another mirror is allowed by the server (cycle-checked); only
    // hide the trivially useless connect columns from the picker.
    return cols.filter((c) => c.type !== 'connect_boards');
  })();

  const createSimple = async () => {
    if (!name.trim() || !pickedType) return;
    const payload = { name: name.trim(), type: pickedType };
    if (pickedType === 'status' || pickedType === 'dropdown' || pickedType === 'tags') {
      payload.settings = { options: [] };
    } else if (pickedType === 'rating') {
      payload.settings = { max: 5 };
    }
    await submit(payload);
  };

  const createConnect = async () => {
    if (!name.trim()) return;
    if (selectedTargetIds.length === 0) {
      toastError('Pick at least one board to connect to');
      return;
    }
    await submit({
      name: name.trim(),
      type: 'connect_boards',
      settings: { targetBoardIds: selectedTargetIds, allowMultiple },
    });
  };

  const createMirror = async () => {
    if (!name.trim()) return;
    if (!sourceConnectColumnId || !sourceColumnId) {
      toastError('Pick a connect column and a source column');
      return;
    }
    await submit({
      name: name.trim(),
      type: 'mirror',
      settings: { sourceConnectColumnId, sourceColumnId, aggregation },
    });
  };

  const submit = async (payload) => {
    setBusy(true);
    try {
      await addColumn(id, payload);
      close();
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not create column');
    } finally {
      setBusy(false);
    }
  };

  const toggleTarget = (bid) => {
    setSelectedTargetIds((prev) =>
      prev.includes(bid) ? prev.filter((x) => x !== bid) : [...prev, bid]
    );
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add column"
        style={{
          width: 28,
          height: 28,
          padding: 0,
          borderRadius: '50%',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Plus size={14} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 6,
            zIndex: 50,
            minWidth: 'min(260px, calc(100vw - 32px))',
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 380,
            overflowY: 'auto',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            padding: 8,
          }}
        >
          {step === 'picker' &&
            CATEGORIES.map((cat) => (
              <div key={cat.name} style={{ marginBottom: 8 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--color-text-muted)',
                    padding: '4px 6px',
                  }}
                >
                  {cat.name}
                </div>
                {cat.types.map((t) => {
                  const disabled = t.id === 'mirror' && !hasConnectColumn;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      disabled={disabled}
                      title={
                        disabled
                          ? 'Add a “Connect boards” column first to mirror data from it'
                          : undefined
                      }
                      onClick={() => startWithType(t.id, t.label)}
                      style={{
                        ...menuItemStyle,
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        opacity: disabled ? 0.4 : 1,
                      }}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            ))}

          {step === 'naming' && (
            <div style={{ padding: 6 }}>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 6 }}>
                Name your new {pickedType} column
              </div>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createSimple();
                  if (e.key === 'Escape') resetAll();
                }}
                style={controlStyle}
              />
              <ConfigFooter onBack={resetAll} onSubmit={createSimple} disabled={!name.trim() || busy} />
            </div>
          )}

          {step === 'connect-config' && (
            <div style={{ padding: 6 }}>
              <label style={labelStyle}>Column name</label>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={controlStyle}
              />
              <label style={labelStyle}>Connect to board(s)</label>
              <div
                style={{
                  maxHeight: 140,
                  overflowY: 'auto',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 4,
                  marginBottom: 10,
                }}
              >
                {connectable.length === 0 ? (
                  <div style={{ padding: 6, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    No other boards in this workspace
                  </div>
                ) : (
                  connectable.map((entry) => {
                    const bid = entry.board._id.toString();
                    const checked = selectedTargetIds.includes(bid);
                    return (
                      <label
                        key={bid}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '5px 6px',
                          fontSize: 13,
                          cursor: 'pointer',
                        }}
                      >
                        <input type="checkbox" checked={checked} onChange={() => toggleTarget(bid)} />
                        <span>{entry.board.name}</span>
                      </label>
                    );
                  })
                )}
              </div>
              <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <input
                  type="checkbox"
                  checked={allowMultiple}
                  onChange={(e) => setAllowMultiple(e.target.checked)}
                />
                Allow linking multiple rows
              </label>
              <ConfigFooter
                onBack={resetAll}
                onSubmit={createConnect}
                disabled={!name.trim() || selectedTargetIds.length === 0 || busy}
              />
            </div>
          )}

          {step === 'mirror-config' && (
            <div style={{ padding: 6 }}>
              <label style={labelStyle}>Column name</label>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={controlStyle}
              />
              <label style={labelStyle}>From connect column</label>
              <select
                value={sourceConnectColumnId}
                onChange={(e) => {
                  setSourceConnectColumnId(e.target.value);
                  setSourceColumnId('');
                }}
                style={controlStyle}
              >
                <option value="">Select a connect column…</option>
                {connectColumns.map((c) => (
                  <option key={c._id} value={c._id.toString()}>
                    {c.name}
                  </option>
                ))}
              </select>
              <label style={labelStyle}>Mirror which column</label>
              <select
                value={sourceColumnId}
                onChange={(e) => setSourceColumnId(e.target.value)}
                disabled={!sourceConnectColumnId}
                style={controlStyle}
              >
                <option value="">
                  {sourceConnectColumnId ? 'Select a source column…' : 'Pick a connect column first'}
                </option>
                {sourceColumnOptions.map((c) => (
                  <option key={c._id} value={c._id.toString()}>
                    {c.name}
                  </option>
                ))}
              </select>
              <label style={labelStyle}>Aggregation</label>
              <select
                value={aggregation}
                onChange={(e) => setAggregation(e.target.value)}
                style={controlStyle}
              >
                {MIRROR_AGGREGATIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <ConfigFooter
                onBack={resetAll}
                onSubmit={createMirror}
                disabled={!name.trim() || !sourceConnectColumnId || !sourceColumnId || busy}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ConfigFooter = ({ onBack, onSubmit, disabled }) => (
  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
    <button
      type="button"
      onClick={onBack}
      style={{
        padding: '4px 10px',
        fontSize: 12,
        background: 'transparent',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
      }}
    >
      Back
    </button>
    <button
      type="button"
      onClick={onSubmit}
      disabled={disabled}
      style={{
        padding: '4px 10px',
        fontSize: 12,
        background: 'var(--color-accent)',
        color: '#fff',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      Add
    </button>
  </div>
);

export default AddColumnButton;

import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import useBoardStore from '../../store/boardStore';
import useTaskStore from '../../store/taskStore';
import useToastStore from '../../store/toastStore';
import useMoney from '../../hooks/useMoney';
import AnchoredPopover from '../ui/AnchoredPopover';
import FormulaEditor from './FormulaEditor';
import ConnectTargetsEditor from './ConnectTargetsEditor';
import { boardCurrencyOf } from '../../utils/money';
import { checkFormula, formulaDraftOf, formulaSettingsFrom } from '../../utils/dataGrid';

/**
 * AddColumnButton — opens a type picker and creates a new column via the
 * boardStore. Categories mirror the grouping in the phase doc.
 *
 * Types that carry configuration get a step of their own before "Add":
 *   - formula        → `FormulaEditor`: the expression (with column chips, a
 *                      live check in the server's words and a preview on the
 *                      first row), format, currency and decimals. It used to be
 *                      offered as "Formula (read-only)" and sent with NO
 *                      expression, which the server refuses — so the type was
 *                      in the menu and could never be created.
 *   - connect_boards → `ConnectTargetsEditor`: which boards it links rows from
 *                      + allow-multiple. The same editor the column menu's
 *                      "Connected boards…" and the cell's "Set up" open, so the
 *                      three can never disagree about what a target is.
 *   - mirror         → a source connect column + a source column +
 *                      aggregation (disabled until a connect column exists)
 *
 * And two whose settings are decided here rather than asked:
 *   - payments       → money by definition: `format: 'currency'`, the BOARD's
 *                      currency (`boardCurrencyOf`, the same unit its Amount
 *                      is in — never a literal, never the reader's display
 *                      choice), and a sum footer. The server pins the format
 *                      too; sending the currency keeps a new column from
 *                      starting in a unit the board does not use.
 *   - client         → which of the workspace's client boards a row is for
 *                      (`ClientCell`); no settings at all.
 *
 * The panel is an `AnchoredPopover`, not an absolute box: the button lives in
 * the grid header, inside the grid's horizontal scroller and an
 * `overflow: hidden` group card, and the formula step is taller than a short
 * group — the old absolute panel was cut off below its first few fields.
 *
 * Props:
 *   board      — current board doc (with `columns`); preferred
 *   boardId    — fallback board id (back-compat)
 *   sampleTask — optional row the formula preview computes against; defaults
 *                to the first of this board's rows the task store holds
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
      { id: 'payments', label: 'Payments' },
      { id: 'rating', label: 'Rating' },
      { id: 'formula', label: 'Formula' },
    ],
  },
  {
    name: 'People',
    types: [
      { id: 'person', label: 'People' },
      { id: 'client', label: 'Client' },
    ],
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

/** A line under a type's name in the naming step, where the type needs saying. */
const TYPE_HINTS = {
  payments:
    'Money received against each row, receipt by receipt. Totals add up in the board’s currency.',
  client:
    'Which client a row is for — one of this workspace’s client boards, or a name you type.',
};

/** The popover's width per step — the formula editor needs room for its chips. */
const STEP_WIDTH = {
  picker: 240,
  naming: 280,
  'formula-config': 380,
  'connect-config': 320,
  'mirror-config': 300,
};

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

/** The first row of `boardId` the task store holds, for the formula preview. */
const firstTaskOf = (tasksByGroup, boardId) => {
  if (!boardId || !tasksByGroup) return null;
  for (const list of Object.values(tasksByGroup)) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const b = t?.board;
      const bid = b && typeof b === 'object' ? b._id : b;
      if (bid != null && String(bid) === String(boardId)) return t;
    }
  }
  return null;
};

const AddColumnButton = ({ boardId, board, sampleTask = null }) => {
  const id = boardId || (board && board._id);
  const [anchor, setAnchor] = useState(null);
  // 'picker' | 'naming' | 'formula-config' | 'connect-config' | 'mirror-config'
  const [step, setStep] = useState('picker');
  const [pickedType, setPickedType] = useState(null);
  const [pickedLabel, setPickedLabel] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // connect_boards config — the editor's controlled value
  const [connectTargets, setConnectTargets] = useState({ targetBoardIds: [], allowMultiple: true });

  // formula config — FormulaEditor's controlled value
  const [formulaDraft, setFormulaDraft] = useState(null);

  // mirror config
  const [connectable, setConnectable] = useState([]);
  const [sourceConnectColumnId, setSourceConnectColumnId] = useState('');
  const [sourceColumnId, setSourceColumnId] = useState('');
  const [aggregation, setAggregation] = useState('first');

  const triggerRef = useRef(null);
  const nameRef = useRef(null);
  const addColumn = useBoardStore((s) => s.addColumn);
  const fetchConnectable = useBoardStore((s) => s.fetchConnectable);
  const toastError = useToastStore((s) => s.error);
  const money = useMoney();
  // Only looked up while the formula step is open; otherwise every task edit
  // on the board would walk the store for a preview nobody is looking at.
  const storeSample = useTaskStore((s) =>
    step === 'formula-config' && !sampleTask ? firstTaskOf(s.tasksByGroup, id) : null
  );

  const columns = board && Array.isArray(board.columns) ? board.columns : [];
  const boardCurrency = boardCurrencyOf(board, money.baseCurrency);
  const connectColumns = columns.filter((c) => c.type === 'connect_boards');
  const hasConnectColumn = connectColumns.length > 0;
  const open = !!anchor;

  const resetAll = () => {
    setStep('picker');
    setPickedType(null);
    setPickedLabel('');
    setName('');
    setConnectTargets({ targetBoardIds: [], allowMultiple: true });
    setFormulaDraft(null);
    setSourceConnectColumnId('');
    setSourceColumnId('');
    setAggregation('first');
  };

  // Focus follows the step: into the name field on the way in, and back onto
  // the type list on the way out (Back, or Escape in the name field) — the
  // control that had focus has just unmounted, which would otherwise drop it
  // on <body> with the popover still open.
  const pickerRef = useRef(null);
  const prevStepRef = useRef(step);
  useEffect(() => {
    const prev = prevStepRef.current;
    prevStepRef.current = step;
    if (!open) return;
    if (step !== 'picker') {
      nameRef.current?.focus();
    } else if (prev !== 'picker') {
      pickerRef.current?.querySelector('button:not([disabled])')?.focus();
    }
  }, [step, open]);

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
    setPickedLabel(defaultName);
    setName(defaultName);
    if (typeId === 'connect_boards') {
      setStep('connect-config');
    } else if (typeId === 'formula') {
      setFormulaDraft(formulaDraftOf(null, boardCurrency));
      setStep('formula-config');
    } else if (typeId === 'mirror') {
      if (!hasConnectColumn) return; // disabled — guard
      setStep('mirror-config');
      loadConnectable();
    } else {
      setStep('naming');
    }
  };

  const close = () => {
    setAnchor(null);
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

  const createSimple = async () => {
    if (!name.trim() || !pickedType || busy) return;
    const payload = { name: name.trim(), type: pickedType };
    if (pickedType === 'status' || pickedType === 'dropdown' || pickedType === 'tags') {
      payload.settings = { options: [] };
    } else if (pickedType === 'rating') {
      payload.settings = { max: 5 };
    } else if (pickedType === 'payments') {
      payload.settings = {
        format: 'currency',
        ...(boardCurrency ? { currency: boardCurrency } : {}),
        summary: 'sum',
      };
    }
    await submit(payload);
  };

  const formulaCheck =
    step === 'formula-config' ? checkFormula(formulaDraft?.expression || '', columns, null) : null;

  const createFormula = async () => {
    if (!name.trim() || busy) return;
    if (!formulaCheck?.ok) {
      toastError(formulaCheck?.error || 'Write the formula first');
      return;
    }
    await submit({
      name: name.trim(),
      type: 'formula',
      settings: formulaSettingsFrom({}, formulaDraft),
    });
  };

  const createConnect = async () => {
    if (!name.trim() || busy) return;
    if (connectTargets.targetBoardIds.length === 0) {
      toastError('Pick at least one board to connect to');
      return;
    }
    await submit({
      name: name.trim(),
      type: 'connect_boards',
      settings: {
        targetBoardIds: connectTargets.targetBoardIds,
        allowMultiple: !!connectTargets.allowMultiple,
      },
    });
  };

  const createMirror = async () => {
    if (!name.trim() || busy) return;
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

  /**
   * Escape inside a step's name field goes BACK to the type list, as it always
   * has, rather than closing the whole popover. Stopped here so the popover's
   * own Escape (which closes) never sees it.
   */
  const backOnEscape = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    resetAll();
  };

  const nameField = (onEnter) => (
    <>
      <label style={labelStyle} htmlFor={`add-col-name-${id}`}>
        Column name
      </label>
      <input
        id={`add-col-name-${id}`}
        ref={nameRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
          backOnEscape(e);
        }}
        style={controlStyle}
      />
    </>
  );

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (anchor) close();
          else setAnchor(triggerRef.current);
        }}
        aria-label="Add column"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
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
        <Plus size={14} aria-hidden="true" />
      </button>
      {open && (
        <AnchoredPopover
          anchorEl={anchor}
          onClose={close}
          align="end"
          width={STEP_WIDTH[step] || 280}
          maxHeight={step === 'formula-config' ? 560 : 420}
          padding={8}
          ariaLabel={step === 'picker' ? 'Add a column' : `New ${pickedLabel || 'column'} column`}
          initialFocus
        >
          {step === 'picker' && (
            <div ref={pickerRef}>
              {CATEGORIES.map((cat) => (
                <div key={cat.name} role="group" aria-label={cat.name} style={{ marginBottom: 8 }}>
                  <div
                    aria-hidden="true"
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
                        className="hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
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
            </div>
          )}

          {step === 'naming' && (
            <div style={{ padding: 6 }}>
              {nameField(createSimple)}
              {TYPE_HINTS[pickedType] && (
                <p style={{ margin: '-4px 0 10px', fontSize: 11, lineHeight: 1.45, color: 'var(--color-text-muted)' }}>
                  {TYPE_HINTS[pickedType]}
                  {pickedType === 'payments' && boardCurrency ? ` (${boardCurrency})` : ''}
                </p>
              )}
              <ConfigFooter onBack={resetAll} onSubmit={createSimple} disabled={!name.trim() || busy} />
            </div>
          )}

          {step === 'formula-config' && formulaDraft && (
            <div style={{ padding: 6 }}>
              {nameField(null)}
              <FormulaEditor
                columns={columns}
                sampleTask={sampleTask || storeSample}
                value={formulaDraft}
                onChange={setFormulaDraft}
                boardCurrency={boardCurrency}
                disabled={busy}
              />
              <div style={{ marginTop: 10 }}>
                <ConfigFooter
                  onBack={resetAll}
                  onSubmit={createFormula}
                  disabled={!name.trim() || !formulaCheck?.ok || busy}
                />
              </div>
            </div>
          )}

          {step === 'connect-config' && (
            <div style={{ padding: 6 }}>
              {nameField(null)}
              <ConnectTargetsEditor
                boardId={id}
                value={connectTargets}
                onChange={setConnectTargets}
                disabled={busy}
              />
              <ConfigFooter
                onBack={resetAll}
                onSubmit={createConnect}
                disabled={!name.trim() || connectTargets.targetBoardIds.length === 0 || busy}
              />
            </div>
          )}

          {step === 'mirror-config' && (
            <div style={{ padding: 6 }}>
              {nameField(null)}
              <label style={labelStyle} htmlFor={`add-col-mirror-src-${id}`}>
                From connect column
              </label>
              <select
                id={`add-col-mirror-src-${id}`}
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
              <label style={labelStyle} htmlFor={`add-col-mirror-col-${id}`}>
                Mirror which column
              </label>
              <select
                id={`add-col-mirror-col-${id}`}
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
              <label style={labelStyle} htmlFor={`add-col-mirror-agg-${id}`}>
                Aggregation
              </label>
              <select
                id={`add-col-mirror-agg-${id}`}
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
        </AnchoredPopover>
      )}
    </div>
  );
};

const ConfigFooter = ({ onBack, onSubmit, disabled }) => (
  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
    <button
      type="button"
      onClick={onBack}
      className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
      style={{
        padding: '4px 10px',
        fontSize: 12,
        background: 'transparent',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--color-text-primary)',
        cursor: 'pointer',
      }}
    >
      Back
    </button>
    <button
      type="button"
      onClick={onSubmit}
      disabled={disabled}
      className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
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

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDown, ArrowUp, Plus, RotateCcw, Trash2,
} from 'lucide-react';
import Button from '../../ui/Button';
import { getColorPair } from '../../../utils/priorityColors';
import * as goalService from '../../../services/goalService';

/**
 * The choices inside ONE goal column of type "Choose from a list" — the tags a
 * dropdown column offers.
 *
 * The list used to be write-once: you typed five comma-separated words when you
 * created the column and that was the last word on the subject. This is the
 * editor for it — add, rename, recolour, reorder, and remove.
 *
 * ---- Why removing is three buttons and not one ----------------------------
 *
 * A goal stores the option's ID, not its label. That is what makes renaming and
 * recolouring free — every row holding the choice simply renders the new word —
 * and it is also what makes removing dangerous, because a value pointing at an
 * id that no longer exists renders as an empty cell and says nothing about what
 * it lost.
 *
 * So the server refuses to guess. Deleting a choice nobody has used just
 * happens. Deleting one that IS on goals changes nothing and comes back saying
 * how many, and this component then asks the only question worth asking:
 *
 *   Retire it            — out of every picker so nobody can choose it again,
 *                          still shown on the rows that already hold it. The
 *                          safe answer, and the one offered first.
 *   Delete permanently   — gone, and cleared off those goals. Each clear lands
 *                          in that goal's own history, so a number that
 *                          disappears from a client report is still traceable.
 *
 * If the column is REQUIRED, deleting permanently also empties a cell the month
 * is waiting on, so the confirmation says that in as many words. (The server
 * separately refuses to leave a required column with nothing at all to pick —
 * that is a block on closing the month nobody could clear.)
 *
 * ---- Server is the source of truth ---------------------------------------
 *
 * Every call here resolves to the same `{ options, usage }` payload and this
 * component renders whatever came back, rather than patching its own copy. That
 * is deliberate: `usage` is the number sitting next to a delete button, and a
 * stale count there is how somebody deletes three months of tagging thinking it
 * was unused.
 */

const DEFAULT_NEW_COLOR = '#6B7280';
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const isValidHex = (v) => typeof v === 'string' && HEX_RE.test(v.trim());

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

const swatchStyle = {
  width: 30,
  height: 26,
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: 0,
  cursor: 'pointer',
  background: 'transparent',
  flexShrink: 0,
};

const nameInputStyle = {
  fontSize: 13,
  height: 28,
  padding: '0 8px',
  border: '1.5px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-bg-input)',
  color: 'var(--color-text-primary)',
  minWidth: 0,
};

const iconBtnStyle = {
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  flexShrink: 0,
};

/** "3 goals" / "1 goal" / nothing at all, because zero deserves no ink. */
const usageLabel = (count) => {
  if (!count) return null;
  return `${count} goal${count === 1 ? '' : 's'}`;
};

const Chip = ({ label, color, muted = false }) => {
  const pair = getColorPair(color);
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        fontSize: 11,
        fontWeight: 500,
        color: pair.text,
        background: pair.bg,
        borderRadius: 'var(--radius-full)',
        ...(muted ? { opacity: 0.6, textDecoration: 'line-through' } : null),
      }}
    >
      {label}
    </span>
  );
};

const GoalColumnOptionsEditor = ({ boardId, column, onColumnsChanged }) => {
  const [options, setOptions] = useState(() => (column.settings?.options || []).slice().sort(byOrder));
  const [usage, setUsage] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // A retired twin the server offered back instead of letting us add a duplicate.
  const [restorable, setRestorable] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_NEW_COLOR);

  const columnId = column._id;

  const absorb = useCallback((payload) => {
    if (!payload) return;
    setOptions((payload.options || []).slice().sort(byOrder));
    setUsage(payload.usage || {});
    if (payload.columns) onColumnsChanged?.(payload.columns);
  }, [onColumnsChanged]);

  // The counts cannot be derived from the column the modal was handed, so they
  // are fetched once on open. A failure here is not fatal: the editor still
  // works, it just cannot say who is using what, which the copy admits to.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await goalService.listGoalColumnOptions(boardId, columnId);
        if (!alive) return;
        setOptions((data.options || []).slice().sort(byOrder));
        setUsage(data.usage || {});
      } catch {
        if (alive) setError('Could not check which goals use these choices.');
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [boardId, columnId]);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    setRestorable(null);
    try {
      return absorb(await fn()) ?? true;
    } catch (err) {
      setError(err?.response?.data?.error || 'That change did not save.');
      const id = err?.response?.data?.restorableId;
      if (id) setRestorable(id);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const draftFor = (id, field, fallback) => {
    const d = drafts[id];
    return d && Object.prototype.hasOwnProperty.call(d, field) ? d[field] : fallback;
  };

  const setDraft = (id, field, value) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }));

  const clearDraft = (id, field) =>
    setDrafts((prev) => {
      const row = prev[id];
      if (!row || !Object.prototype.hasOwnProperty.call(row, field)) return prev;
      const { [field]: _dropped, ...rest } = row;
      const next = { ...prev };
      if (Object.keys(rest).length) next[id] = rest;
      else delete next[id];
      return next;
    });

  /** Commit a label or colour edit, but only if it actually moved. */
  const flush = async (opt, field) => {
    const draft = draftFor(opt.id, field, null);
    if (draft === null) return;
    const trimmed = field === 'label' ? String(draft).trim() : draft;
    const unchanged = trimmed === opt[field];
    const invalid = field === 'label' ? !trimmed : !isValidHex(trimmed);
    if (unchanged || invalid) {
      clearDraft(opt.id, field);
      return;
    }
    await run(() =>
      goalService.updateGoalColumnOption(boardId, columnId, opt.id, { [field]: trimmed }));
    // On a rejection the draft is dropped so the row snaps back to the truth
    // rather than sitting there showing a name the server refused.
    clearDraft(opt.id, field);
  };

  const add = async () => {
    const label = newLabel.trim();
    if (!label) { setError('Give the choice a name.'); return; }
    const ok = await run(() =>
      goalService.addGoalColumnOption(boardId, columnId, { label, color: newColor }));
    if (ok) {
      setNewLabel('');
      setNewColor(DEFAULT_NEW_COLOR);
    }
  };

  const live = options.filter((o) => !o.archived);
  const retired = options.filter((o) => o.archived);

  const move = (opt, delta) => {
    const at = live.findIndex((o) => String(o.id) === String(opt.id));
    const to = at + delta;
    if (at < 0 || to < 0 || to >= live.length) return;
    const reordered = [...live];
    [reordered[at], reordered[to]] = [reordered[to], reordered[at]];
    // Retired choices keep their places at the end of the list, so reordering
    // the live ones cannot shuffle them back into view.
    run(() => goalService.reorderGoalColumnOptions(
      boardId,
      columnId,
      [...reordered, ...retired].map((o) => o.id),
    ));
  };

  /**
   * First click on the bin. An unused choice goes; a used one comes back with a
   * count and nothing changed, and `confirm` then holds the question.
   */
  const remove = async (opt) => {
    setBusy(true);
    setError(null);
    try {
      const data = await goalService.deleteGoalColumnOption(boardId, columnId, opt.id);
      absorb(data);
      if (data.confirmRequired) {
        setConfirm({
          option: opt,
          count: data.usedByCount,
          columnRequired: data.columnRequired,
        });
      } else {
        setConfirm(null);
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not remove that choice.');
    } finally {
      setBusy(false);
    }
  };

  const purge = async () => {
    const { option } = confirm;
    setConfirm(null);
    await run(() =>
      goalService.deleteGoalColumnOption(boardId, columnId, option.id, { purge: true }));
  };

  const retire = async () => {
    const { option } = confirm;
    setConfirm(null);
    await run(() =>
      goalService.updateGoalColumnOption(boardId, columnId, option.id, { archived: true }));
  };

  const restore = (opt) =>
    run(() => goalService.updateGoalColumnOption(boardId, columnId, opt.id, { archived: false }));

  const row = (opt, { index = 0, isRetired = false } = {}) => {
    const label = draftFor(opt.id, 'label', opt.label);
    const color = draftFor(opt.id, 'color', opt.color || DEFAULT_NEW_COLOR);
    const used = usageLabel(usage[String(opt.id)]);
    return (
      <div key={opt.id} className="flex items-center gap-1.5" style={{ padding: '3px 0' }}>
        <input
          type="color"
          value={isValidHex(color) ? color : DEFAULT_NEW_COLOR}
          disabled={busy}
          onChange={(e) => setDraft(opt.id, 'color', e.target.value)}
          onBlur={() => flush(opt, 'color')}
          aria-label={`${opt.label} colour`}
          style={swatchStyle}
        />
        {isRetired ? (
          <span className="flex-1 min-w-0 truncate">
            <Chip label={opt.label} color={opt.color} muted />
          </span>
        ) : (
          <input
            type="text"
            value={label}
            disabled={busy}
            maxLength={60}
            onChange={(e) => setDraft(opt.id, 'label', e.target.value)}
            onBlur={() => flush(opt, 'label')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === 'Escape') { clearDraft(opt.id, 'label'); e.currentTarget.blur(); }
            }}
            aria-label={`${opt.label} name`}
            className="flex-1 font-body focus:outline-none"
            style={nameInputStyle}
          />
        )}
        {used && (
          <span
            className="font-body shrink-0"
            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
            title={`${used} currently hold this choice`}
          >
            {used}
          </span>
        )}
        {!isRetired && (
          <div className="flex flex-col shrink-0">
            <button
              type="button"
              onClick={() => move(opt, -1)}
              disabled={busy || index === 0}
              aria-label={`Move ${opt.label} up`}
              style={{ ...iconBtnStyle, height: 13 }}
            >
              <ArrowUp size={11} color="var(--color-text-muted)" />
            </button>
            <button
              type="button"
              onClick={() => move(opt, 1)}
              disabled={busy || index === live.length - 1}
              aria-label={`Move ${opt.label} down`}
              style={{ ...iconBtnStyle, height: 13 }}
            >
              <ArrowDown size={11} color="var(--color-text-muted)" />
            </button>
          </div>
        )}
        {isRetired && (
          <button
            type="button"
            onClick={() => restore(opt)}
            disabled={busy}
            aria-label={`Bring ${opt.label} back`}
            title="Bring this choice back"
            style={iconBtnStyle}
          >
            <RotateCcw size={13} color="var(--color-text-secondary)" />
          </button>
        )}
        <button
          type="button"
          onClick={() => remove(opt)}
          disabled={busy}
          aria-label={`Remove ${opt.label}`}
          title={used ? `${used} use this — you will be asked what to do` : 'Remove this choice'}
          style={iconBtnStyle}
        >
          <Trash2 size={13} color="var(--color-status-stuck)" />
        </button>
      </div>
    );
  };

  return (
    <div
      className="flex flex-col gap-1"
      style={{
        marginTop: 8,
        padding: 8,
        background: 'var(--color-bg-subtle)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <p
        className="font-body font-medium uppercase tracking-wide"
        style={{ fontSize: 10, color: 'var(--color-text-muted)' }}
      >
        Choices
      </p>

      {live.length === 0 && (
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          Nothing to pick yet — add a choice below.
        </p>
      )}

      {live.map((opt, i) => row(opt, { index: i }))}

      {retired.length > 0 && (
        <>
          <p
            className="font-body"
            style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 6 }}
          >
            RETIRED — still shown on goals that have them, never offered again
          </p>
          {retired.map((opt) => row(opt, { isRetired: true }))}
        </>
      )}

      {confirm && (
        <div
          className="flex flex-col gap-2"
          style={{
            marginTop: 6,
            padding: 8,
            background: 'var(--color-status-stuck-bg)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-status-stuck)', lineHeight: 1.5 }}>
            “{confirm.option.label}” is on {confirm.count} goal
            {confirm.count === 1 ? '' : 's'}. Retiring it takes it out of every picker
            but leaves those goals as they are. Deleting it clears it off them for good.
            {confirm.columnRequired && (
              <>
                {' '}
                This column is required, so those goals would then be empty and the
                month could not be closed until somebody fills them in again.
              </>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={retire} disabled={busy}>Retire it</Button>
            <Button size="sm" variant="danger" onClick={purge} disabled={busy}>
              Delete and clear {confirm.count}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5" style={{ marginTop: 6 }}>
        <input
          type="color"
          value={newColor}
          disabled={busy}
          onChange={(e) => setNewColor(e.target.value)}
          aria-label="New choice colour"
          style={swatchStyle}
        />
        <input
          type="text"
          value={newLabel}
          disabled={busy}
          maxLength={60}
          placeholder="Add a choice…"
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          aria-label="New choice name"
          className="flex-1 font-body focus:outline-none"
          style={nameInputStyle}
        />
        <Button size="sm" variant="secondary" icon={Plus} onClick={add} disabled={busy || !newLabel.trim()}>
          Add
        </Button>
      </div>

      {restorable && (
        <Button
          size="sm"
          variant="secondary"
          icon={RotateCcw}
          disabled={busy}
          onClick={() => {
            const opt = options.find((o) => String(o.id) === String(restorable));
            setNewLabel('');
            if (opt) restore(opt);
          }}
        >
          Bring the retired one back instead
        </Button>
      )}

      {error && (
        <p className="font-body" style={{ fontSize: 11, color: 'var(--color-status-stuck)' }}>
          {error}
        </p>
      )}

      {!loaded && (
        <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          Checking which goals use these…
        </p>
      )}
    </div>
  );
};

export default GoalColumnOptionsEditor;

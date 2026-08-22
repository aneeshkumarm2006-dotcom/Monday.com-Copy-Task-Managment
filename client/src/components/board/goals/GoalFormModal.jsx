import { useMemo, useState } from 'react';
import {
  TrendingUp, CheckCircle2, ListChecks, Shield, CalendarClock, Star, ChevronLeft, ChevronDown,
} from 'lucide-react';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import { SegmentedControl } from '../../ui/FormControls';
import { WEIGHT_PRESETS, describeGoal } from '../../../utils/goalDisplay';
import useBoardMembers from '../../../hooks/useBoardMembers';
import { formatDateInput } from '../columns/cellShared';
import { dateInputToISO } from '../../../utils/dateUtils';

/**
 * Add or edit a goal.
 *
 * THE DESIGN CONSTRAINT, stated by the user: a non-technical person has to be
 * able to set this up. So:
 *
 *  - Step one is CARDS with real examples, not a `<select>` of type names. You
 *    pick "Move a number — website visits: 4,200 → 6,000", not `numeric`.
 *  - The internal type key never appears on screen. Neither do the words
 *    baseline, metric, KPI, weight, direction or threshold.
 *  - Every field is a question in plain English with a worked example under it.
 *  - Direction is never asked. It is inferred from the two numbers and stated
 *    back in the preview: "Higher is better — you're aiming to move by 1,800."
 *  - Importance is four words, not a number.
 *  - A LIVE PREVIEW assembles the sentence as you fill the form in, and it is
 *    the identical sentence you will read on the row afterwards — the same
 *    trick TrackersModal uses, and the thing that makes "anybody can understand
 *    it" true rather than aspirational.
 *
 * WHAT THE PICKER LEADS WITH, and why it is `answerShape` rather than the label:
 * six labels alone do not separate the kinds, because "Move a number" and "Keep
 * it above or below" and "Tick off a list" all sound like numbers to somebody
 * who has not used this before. What actually separates them is the SHAPE OF THE
 * ANSWER you will be asked for at the end of the month — a number, a Yes/No, a
 * count, a date, one of three ratings. So every card states that, and the
 * "How these differ" panel lays the six side by side with the two other facts
 * people get wrong: what you have to set up now, and whether half counts.
 *
 * EVERY WORD OF THAT COPY IS THE SERVER'S — `hint`, `useWhen`, `notWhen`,
 * `setupShape`, `answerShape`, `partialCredit`, `examples`, `namePlaceholder`,
 * all from `GET /api/goal-types`. This file maps a type key to an icon and to
 * nothing else. Same reason the inputs are generated rather than switch-cased:
 * a seventh goal type should arrive here complete, and copy that lives next to
 * the scoring rule cannot describe a rule that has since changed.
 */
const TYPE_ICONS = {
  numeric: TrendingUp,
  boolean: CheckCircle2,
  checklist: ListChecks,
  threshold: Shield,
  deadline: CalendarClock,
  rating: Star,
};

const UNIT_OPTIONS = [
  { value: 'none', label: 'Just a number' },
  { value: 'percent', label: 'Percent %' },
  { value: 'currency', label: 'Money (USD)' },
  { value: 'custom', label: 'Something else' },
];

/**
 * A goal column value counts as unfilled by the SAME rule the server uses in
 * `checkRequiredColumns`. Deliberately identical: a stricter client would block
 * a save the server would have accepted, and a looser one hands back the exact
 * 422 this section exists to prevent.
 */
const isBlank = (v) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

const columnLabel = (col) => (
  <span className="block mb-2 font-body font-medium text-[color:var(--color-text-secondary)] text-xs uppercase tracking-wide">
    {col.name}
    {col.required && <span className="text-[color:var(--color-status-stuck)] ml-1">*</span>}
  </span>
);

const columnMessage = (message) =>
  (message ? (
    <p className="mt-1.5 text-xs font-body text-[color:var(--color-status-stuck)]">{message}</p>
  ) : null);

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const GoalFormModal = ({
  open,
  onClose,
  onSubmit,
  boardId = null,
  types = [],
  columns = [],
  groupName,
  monthLabel,
  initial = null,
  saving = false,
  serverErrors = [],
}) => {
  const editing = !!initial;
  const [typeKey, setTypeKey] = useState(initial?.type || null);
  const [draft, setDraft] = useState(() => ({
    name: initial?.name || '',
    unit: initial?.unit || 'none',
    unitLabel: initial?.unitLabel || '',
    weight: initial?.weight ?? 1,
    config: { ...(initial?.config || {}) },
  }));
  const [columnValues, setColumnValues] = useState(() => ({ ...(initial?.columnValues || {}) }));
  const [touched, setTouched] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [showOptional, setShowOptional] = useState(false);

  const typeSpec = useMemo(
    () => types.find((t) => t.key === typeKey) || null,
    [types, typeKey]
  );

  // Options for a `person` goal column: the people on THIS board, not the whole
  // workspace. Same rule as every other picker — on a private board the org
  // roster named people who cannot open it.
  const members = useBoardMembers(boardId, { enabled: open });

  // The board's own goal columns, split by whether they have to be answered.
  const liveColumns = useMemo(() => (columns || []).filter((c) => !c.archived), [columns]);
  const requiredColumns = useMemo(() => liveColumns.filter((c) => c.required), [liveColumns]);
  const optionalColumns = useMemo(() => liveColumns.filter((c) => !c.required), [liveColumns]);

  /**
   * Mandatory columns are blocked HERE only when adding.
   *
   * On an edit the server grandfathers rows written before the column became
   * required (`requiredSince`), and it is the only side that knows when the row
   * was written — so an edit sends what changed and lets the server decide,
   * rather than refusing to save a goal the server would have accepted.
   */
  const missingRequired = editing
    ? []
    : requiredColumns.filter((c) => isBlank(columnValues[String(c._id)]));

  const setConfig = (key, value) =>
    setDraft((d) => ({ ...d, config: { ...d.config, [key]: value } }));

  const preview = describeGoal({ ...draft, type: typeKey }, typeSpec);

  const localError = !draft.name.trim() ? 'Give this goal a name.' : null;
  const errorFor = (field) => serverErrors.find((e) => e.field === field)?.message;

  /**
   * What to send: everything filled in when adding, only what actually changed
   * when editing. The narrower edit payload matters — the server validates
   * required columns only when `columnValues` is present, so an edit that never
   * touched them must not mention them.
   */
  const columnValuesPatch = () => {
    const before = initial?.columnValues || {};
    const out = {};
    for (const col of liveColumns) {
      const key = String(col._id);
      const next = columnValues[key];
      if (editing) {
        if (!sameValue(next, before[key])) out[key] = next ?? null;
      } else if (!isBlank(next)) {
        out[key] = next;
      }
    }
    return out;
  };

  const submit = () => {
    setTouched(true);
    if (localError || missingRequired.length > 0) return;
    const values = columnValuesPatch();
    onSubmit({
      type: typeKey,
      name: draft.name.trim(),
      unit: typeSpec?.supportsUnit ? draft.unit : 'none',
      // Money is USD, always — nobody picks a symbol, so nothing to read off the draft.
      unitLabel: draft.unit === 'currency' ? '$' : draft.unit === 'custom' ? draft.unitLabel : '',
      weight: draft.weight,
      config: draft.config,
      ...(Object.keys(values).length > 0 ? { columnValues: values } : {}),
    });
  };

  // --- Step 1: what kind of goal is this? -----------------------------------

  if (!typeKey) {
    return (
      <Modal
        isOpen={open}
        onClose={onClose}
        title={groupName ? `Add a goal to ${groupName}` : 'Add a goal'}
        maxWidth={720}
      >
        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
        >
          What kind of goal is this?
        </p>
        <p
          className="font-body mb-3"
          style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}
        >
          Pick by what you will be asked for at the end of
          {monthLabel ? ` ${monthLabel}` : ' the month'} — a number, a yes or no, a
          count, a date. You can change it later.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {types.map((t) => {
            const Icon = TYPE_ICONS[t.key] || TrendingUp;
            const examples = t.examples?.length ? t.examples : [t.example].filter(Boolean);
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTypeKey(t.key)}
                className="text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
                style={{
                  padding: 12,
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <span className="flex items-center gap-2">
                  <Icon size={16} color="var(--color-accent)" aria-hidden="true" />
                  <span
                    className="font-body font-medium"
                    style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
                  >
                    {t.label}
                  </span>
                </span>
                <span
                  className="font-body block mt-1"
                  style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}
                >
                  {t.hint}
                </span>
                {t.answerShape && (
                  <span
                    className="font-body block mt-2"
                    style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.45 }}
                  >
                    At the end of the month you fill in{' '}
                    <span style={{ color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                      {t.answerShape}
                    </span>
                    .
                  </span>
                )}
                {examples.length > 0 && (
                  <span
                    className="block mt-2"
                    style={{ borderTop: '1px dashed var(--color-border)', paddingTop: 8 }}
                  >
                    {examples.map((ex) => (
                      <span
                        key={ex}
                        className="font-body block"
                        style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.6 }}
                      >
                        {ex}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/*
          The escape hatch for the person who has read six cards and still is not
          sure. Collapsed by default so it never gets in the way of somebody who
          already knows which one they want.
        */}
        <button
          type="button"
          onClick={() => setComparing((v) => !v)}
          className="inline-flex items-center gap-1 font-body mt-3"
          style={{ fontSize: 12, color: 'var(--color-accent)' }}
          aria-expanded={comparing}
        >
          <ChevronDown
            size={13}
            aria-hidden="true"
            style={{
              transform: comparing ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 120ms',
            }}
          />
          {comparing ? 'Hide the comparison' : 'Not sure which one? See how they differ'}
        </button>

        {comparing && (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2"
            style={{
              padding: 12,
              background: 'var(--color-bg-subtle)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            {types.map((t) => (
              <div key={t.key}>
                <p
                  className="font-body font-medium"
                  style={{ fontSize: 12, color: 'var(--color-text-primary)' }}
                >
                  {t.label}
                </p>
                <dl className="font-body mt-1" style={{ fontSize: 11, lineHeight: 1.55 }}>
                  {[
                    ['Pick it when', t.useWhen],
                    ['You set up', t.setupShape],
                    ['You report', t.answerShape],
                    ['Half counts?', t.partialCredit],
                    ['Not this if', t.notWhen],
                  ]
                    .filter(([, value]) => !!value)
                    .map(([term, value]) => (
                      <div key={term} className="flex gap-1">
                        <dt style={{ color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                          {term}:
                        </dt>
                        <dd style={{ color: 'var(--color-text-secondary)' }}>{value}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end mt-4">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </Modal>
    );
  }

  // --- Step 2: fill it in ---------------------------------------------------

  const numberInput = (field) => (
    <Input
      key={field.key}
      label={field.label}
      helperText={field.help}
      type="number"
      value={draft.config[field.key] ?? ''}
      onChange={(e) =>
        setConfig(field.key, e.target.value === '' ? '' : Number(e.target.value))
      }
      error={errorFor(field.key)}
    />
  );

  /**
   * One goal-column field.
   *
   * Deliberately NOT the grid's cell registry, for two reasons that are both
   * about this being a FORM: those cells are click-to-edit divs that render as
   * blank space when empty — the very "nowhere to enter it" this section exists
   * to fix — and their pickers open an absolutely-positioned popover, which the
   * modal body clips because it is an `overflow-y-auto` box.
   *
   * The branches below are the whole of the server's `COLUMN_TYPES`, so an
   * unknown type still lands on a usable text box rather than nothing.
   */
  const renderColumnField = (col) => {
    const key = String(col._id);
    const value = columnValues[key] ?? null;
    const set = (v) => setColumnValues((prev) => ({ ...prev, [key]: v }));
    const unfilled = touched && !editing && col.required && isBlank(value);
    const message = errorFor(key) || (unfilled ? `${col.name} is required.` : null);
    const common = { label: col.name, required: !!col.required, error: message };

    if (col.type === 'number') {
      return (
        <Input
          key={key}
          {...common}
          type="number"
          value={value ?? ''}
          onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    }

    if (col.type === 'date') {
      return (
        <Input
          key={key}
          {...common}
          type="date"
          value={formatDateInput(value)}
          onChange={(e) => set(e.target.value ? dateInputToISO(e.target.value) : null)}
        />
      );
    }

    if (col.type === 'link') {
      // Stored as { url, label } — the label is the grid's to set, so an edit
      // here carries whatever is already on the row rather than dropping it.
      const current = typeof value === 'string' ? { url: value, label: '' } : (value || {});
      return (
        <Input
          key={key}
          {...common}
          type="url"
          placeholder="https://…"
          value={current.url || ''}
          onChange={(e) =>
            set(e.target.value.trim()
              ? { url: e.target.value.trim(), label: current.label || '' }
              : null)}
        />
      );
    }

    if (col.type === 'dropdown') {
      const options = (col.settings?.options || [])
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return (
        <div key={key}>
          {columnLabel(col)}
          <select
            value={value == null ? '' : String(value)}
            onChange={(e) => set(e.target.value || null)}
            className="w-full font-body text-[14px] h-[44px] md:h-[38px] px-3 bg-[color:var(--color-bg-input)]"
            style={{
              border: `1.5px solid ${message ? 'var(--color-status-stuck)' : 'var(--color-border)'}`,
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-primary)',
            }}
          >
            <option value="">Not set</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          {columnMessage(message)}
        </div>
      );
    }

    if (col.type === 'person') {
      // A checklist rather than the grid's popover, and scrolled inside its own
      // box so a large org cannot push the buttons off the modal.
      const selected = Array.isArray(value) ? value.map(String) : [];
      const toggle = (id) => {
        const next = selected.includes(id)
          ? selected.filter((s2) => s2 !== id)
          : [...selected, id];
        set(next.length > 0 ? next : null);
      };
      return (
        <div key={key}>
          {columnLabel(col)}
          <div
            style={{
              maxHeight: 132,
              overflowY: 'auto',
              padding: 4,
              border: `1.5px solid ${message ? 'var(--color-status-stuck)' : 'var(--color-border)'}`,
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-input)',
            }}
          >
            {members.length === 0 ? (
              <p className="font-body px-2 py-1" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                Nobody to pick yet.
              </p>
            ) : (
              members.map((m) => {
                const id = String(m._id || m.id || '');
                return (
                  <label
                    key={id}
                    className="flex items-center gap-2 font-body px-2 py-1 cursor-pointer"
                    style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(id)}
                      onChange={() => toggle(id)}
                    />
                    <span className="truncate">{m.name || m.email || id}</span>
                  </label>
                );
              })
            )}
          </div>
          {columnMessage(message)}
        </div>
      );
    }

    return (
      <Input
        key={key}
        {...common}
        value={value || ''}
        onChange={(e) => set(e.target.value)}
        maxLength={500}
      />
    );
  };

  const renderConfigField = (field) => {
    if (field.type === 'number') return numberInput(field);
    if (field.type === 'date') {
      return (
        <Input
          key={field.key}
          label={field.label}
          helperText={field.help}
          type="date"
          value={draft.config[field.key] || ''}
          onChange={(e) => setConfig(field.key, e.target.value || null)}
        />
      );
    }
    if (field.type === 'choice') {
      return (
        <div key={field.key}>
          <label
            className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {field.label}
          </label>
          <SegmentedControl
            value={draft.config[field.key] ?? field.choices?.[0]?.value}
            onChange={(v) => setConfig(field.key, v)}
            options={(field.choices || []).map((c) => ({ value: c.value, label: c.label }))}
          />
        </div>
      );
    }
    return null;
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={typeSpec?.label || 'Add a goal'}
      maxWidth={560}
    >
      <div className="flex flex-col gap-4">
        {/*
          Which kind you are in, restated. Step one's cards are gone by now, and
          "why is it asking me for a date?" is the question that follows if the
          only reminder is the modal title.
        */}
        <div
          style={{
            padding: 10,
            background: 'var(--color-bg-subtle)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <p
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
            >
              {typeSpec?.hint}
            </p>
            {!editing && (
              <button
                type="button"
                onClick={() => setTypeKey(null)}
                className="inline-flex items-center gap-1 font-body shrink-0"
                style={{ fontSize: 12, color: 'var(--color-accent)' }}
              >
                <ChevronLeft size={13} aria-hidden="true" />
                Pick a different kind
              </button>
            )}
          </div>
          {typeSpec?.answerShape && (
            <p
              className="font-body mt-1"
              style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}
            >
              At the end of {monthLabel || 'the month'} you will be asked for{' '}
              {typeSpec.answerShape}.
            </p>
          )}
        </div>

        <Input
          label="What are you trying to achieve?"
          placeholder={typeSpec?.namePlaceholder || ''}
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          error={touched ? (localError || errorFor('name')) : errorFor('name')}
          autoFocus
        />

        {typeSpec?.supportsUnit && (
          <div>
            <label
              className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              How is it measured?
            </label>
            <SegmentedControl
              value={draft.unit}
              onChange={(v) => setDraft((d) => ({ ...d, unit: v }))}
              options={UNIT_OPTIONS}
            />
            {draft.unit === 'custom' && (
              <div className="mt-2">
                <Input
                  label="What is the unit?"
                  helperText="Whatever you count them in — leads, calls, seconds, posts."
                  placeholder="leads"
                  value={draft.unitLabel}
                  onChange={(e) => setDraft((d) => ({ ...d, unitLabel: e.target.value }))}
                />
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(typeSpec?.configFields || []).map(renderConfigField)}
        </div>

        {/*
          The board's own goal columns. A required one is asked for right here,
          because the server refuses the save without it — before this section
          existed the only way to answer a mandatory column was to create the
          goal first, which was exactly the thing being refused. The rest stay
          folded away: they are editable in the row afterwards, and a board with
          a dozen extras should not bury the goal itself behind them.
        */}
        {requiredColumns.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {requiredColumns.map(renderColumnField)}
          </div>
        )}

        {optionalColumns.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowOptional((v) => !v)}
              className="inline-flex items-center gap-1 font-body"
              style={{ fontSize: 12, color: 'var(--color-accent)' }}
              aria-expanded={showOptional}
            >
              <ChevronDown
                size={13}
                aria-hidden="true"
                style={{
                  transform: showOptional ? 'rotate(0deg)' : 'rotate(-90deg)',
                  transition: 'transform 120ms',
                }}
              />
              {showOptional
                ? 'Hide the other details'
                : `Fill in the other details (${optionalColumns.length})`}
            </button>
            {showOptional && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                {optionalColumns.map(renderColumnField)}
              </div>
            )}
          </div>
        )}

        <div>
          <label
            className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            How much does this one matter?
          </label>
          <SegmentedControl
            value={draft.weight}
            onChange={(v) => setDraft((d) => ({ ...d, weight: v }))}
            options={WEIGHT_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          />
          <p className="font-body mt-1" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            Leave everything on Normal and the month’s score is a plain average.
          </p>
        </div>

        {/* The live preview. This exact sentence becomes the row's tooltip. */}
        {preview && (
          <div
            style={{
              padding: 12,
              background: 'var(--color-bg-subtle)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <p
              className="font-body font-medium mb-1"
              style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-muted)' }}
            >
              In plain English
            </p>
            <p
              className="font-body"
              style={{ fontSize: 13, color: 'var(--color-text-primary)', lineHeight: 1.5 }}
            >
              {preview}
            </p>
          </div>
        )}

        {serverErrors.length > 0 && (
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-status-stuck)' }}>
            {serverErrors[0].message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add this goal'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default GoalFormModal;

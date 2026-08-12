import { useMemo, useState } from 'react';
import {
  TrendingUp, CheckCircle2, ListChecks, Shield, CalendarClock, Star, ChevronLeft,
} from 'lucide-react';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import { SegmentedControl } from '../../ui/FormControls';
import { WEIGHT_PRESETS, describeGoal } from '../../../utils/goalDisplay';

/**
 * Add or edit a goal.
 *
 * THE DESIGN CONSTRAINT, stated by the user: a non-technical person has to be
 * able to set this up. So:
 *
 *  - Step one is CARDS with real examples, not a `<select>` of type names. You
 *    pick "Move a number — get organic traffic from 4,200 to 6,000", not
 *    `numeric`.
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
 * The fields themselves are generated from the server's type catalog, so a new
 * goal type arrives here with correct inputs and no changes to this file.
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
  { value: 'currency', label: 'Money' },
  { value: 'custom', label: 'Something else' },
];

const GoalFormModal = ({
  open,
  onClose,
  onSubmit,
  types = [],
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
  const [touched, setTouched] = useState(false);

  const typeSpec = useMemo(
    () => types.find((t) => t.key === typeKey) || null,
    [types, typeKey]
  );

  const setConfig = (key, value) =>
    setDraft((d) => ({ ...d, config: { ...d.config, [key]: value } }));

  const preview = describeGoal({ ...draft, type: typeKey }, typeSpec);

  const localError = !draft.name.trim() ? 'Give this goal a name.' : null;
  const errorFor = (field) => serverErrors.find((e) => e.field === field)?.message;

  const submit = () => {
    setTouched(true);
    if (localError) return;
    onSubmit({
      type: typeKey,
      name: draft.name.trim(),
      unit: typeSpec?.supportsUnit ? draft.unit : 'none',
      unitLabel: draft.unit === 'currency' || draft.unit === 'custom' ? draft.unitLabel : '',
      weight: draft.weight,
      config: draft.config,
    });
  };

  // --- Step 1: what kind of goal is this? -----------------------------------

  if (!typeKey) {
    return (
      <Modal
        isOpen={open}
        onClose={onClose}
        title={groupName ? `Add a goal to ${groupName}` : 'Add a goal'}
        maxWidth={620}
      >
        <p
          className="font-body mb-3"
          style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
        >
          What kind of goal is this?{monthLabel ? ` It will be tracked for ${monthLabel}.` : ''}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {types.map((t) => {
            const Icon = TYPE_ICONS[t.key] || TrendingUp;
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
                  style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.45 }}
                >
                  {t.example}
                </span>
              </button>
            );
          })}
        </div>
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
        {!editing && (
          <button
            type="button"
            onClick={() => setTypeKey(null)}
            className="inline-flex items-center gap-1 font-body self-start"
            style={{ fontSize: 12, color: 'var(--color-accent)' }}
          >
            <ChevronLeft size={13} aria-hidden="true" />
            Pick a different kind
          </button>
        )}

        <Input
          label="What are you trying to achieve?"
          placeholder="Grow organic traffic"
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
            {(draft.unit === 'currency' || draft.unit === 'custom') && (
              <div className="mt-2">
                <Input
                  label={draft.unit === 'currency' ? 'Currency symbol' : 'What is the unit?'}
                  placeholder={draft.unit === 'currency' ? '₹' : 'seconds'}
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

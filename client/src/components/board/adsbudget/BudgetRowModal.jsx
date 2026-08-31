import { useMemo, useState } from 'react';

import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Modal from '../../ui/Modal';
import { SelectField } from '../../ui/FormControls';

/**
 * Add or edit one budget row — a platform, or a campaign inside one.
 *
 * ---- One modal for both levels ---------------------------------------------
 *
 * A campaign is a platform row with a parent and two extra questions. Splitting
 * them into two dialogs would mean two copies of the money fields, the
 * lifecycle picker and the validation, which is the half that will keep
 * changing.
 *
 * ---- The platform field is a free text input with suggestions ---------------
 *
 * NOT a dropdown of known networks. This tab must never learn the names of the
 * advertising platforms it tracks — a fixed list is vocabulary living in code,
 * and the next network to launch would be a code change. The `datalist` offers
 * what this board already uses, so the common case is one keystroke and the
 * uncommon case is still possible.
 *
 * ---- The parent owns saving and errors -------------------------------------
 *
 * `saving` and `serverErrors` come in as props, matching `GoalFormModal`: the
 * server is the authority on what is valid, and a 422's `errors[]` is routed
 * back into the fields rather than fired as a toast.
 */

const LIFECYCLES = [
  { value: 'active', label: 'Active — being spent' },
  { value: 'draft', label: 'Draft — not activated yet' },
  { value: 'paused', label: 'Paused — temporarily stopped' },
];

/** A number field that keeps '' distinct from 0 while being typed in. */
const MoneyField = ({ label, value, onChange, error, helperText, placeholder }) => (
  <Input
    label={label}
    type="number"
    min="0"
    step="0.01"
    inputMode="decimal"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    error={error}
    helperText={helperText}
    placeholder={placeholder}
  />
);

const blank = {
  platform: '',
  account: '',
  name: '',
  objective: '',
  allocated: '',
  spent: '',
  dailyBudget: '',
  lifecycle: 'active',
  notes: '',
};

const BudgetRowModal = ({
  open,
  onClose,
  onSubmit,
  /** The row being edited, or null to create. */
  initial = null,
  /** Set when creating a campaign; the platform row it belongs to. */
  parent = null,
  /** Groups to choose from. Passed only when opening from the roster. */
  groups = null,
  /** Preselected group, when the client is already known. */
  groupId = null,
  groupName = '',
  monthLabel = '',
  /** Platform names already used on this board, for the suggestion list. */
  platformSuggestions = [],
  saving = false,
  serverErrors = [],
}) => {
  const editing = !!initial;
  const isCampaign = editing ? !!initial.parent : !!parent;

  /**
   * Seeded ONCE, from the props this component mounted with.
   *
   * The parent gives this modal a `key` naming its subject, so opening it on a
   * different row remounts it and these initialisers run again. That is what
   * replaces the obvious `useEffect(() => setDraft(...), [initial])`: syncing
   * props into state inside an effect renders twice on every open and — worse —
   * would overwrite what somebody had already typed the moment an unrelated
   * prop identity changed underneath them.
   */
  const [draft, setDraft] = useState(() =>
    initial
      ? {
        platform: initial.platform || '',
        account: initial.account || '',
        name: initial.name || '',
        objective: initial.objective || '',
        allocated: initial.allocated ?? '',
        spent: initial.spent ?? '',
        dailyBudget: initial.dailyBudget ?? '',
        lifecycle: initial.lifecycle || 'active',
        notes: initial.notes || '',
      }
      // A new campaign inherits its platform's name rather than asking for the
      // channel twice — it is the same channel by construction.
      : { ...blank, platform: parent ? parent.platform : '' }
  );
  const [group, setGroup] = useState(
    () => groupId || (groups && groups[0] ? groups[0]._id : '')
  );
  const [touched, setTouched] = useState(false);

  const set = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));

  const localError = useMemo(() => {
    if (!draft.platform.trim()) return 'Say which platform this budget is for.';
    if (isCampaign && !draft.name.trim()) return 'Give this campaign a name.';
    if (!editing && !parent && groups && !group) return 'Choose which client this is for.';
    return null;
  }, [draft.platform, draft.name, isCampaign, editing, parent, groups, group]);

  const errorFor = (field) => serverErrors.find((e) => e.field === field)?.message;

  const submit = () => {
    setTouched(true);
    if (localError) return;

    // '' means "leave it alone" for an optional number, and 0 means zero. The
    // two are not the same and collapsing them would silently wipe a daily
    // budget every time somebody edited a campaign's name.
    const money = (v) => (v === '' || v === null ? null : Number(v));

    const payload = {
      platform: draft.platform.trim(),
      account: draft.account.trim(),
      name: isCampaign ? draft.name.trim() : '',
      objective: isCampaign ? draft.objective.trim() : '',
      allocated: money(draft.allocated) ?? 0,
      spent: money(draft.spent) ?? 0,
      dailyBudget: money(draft.dailyBudget),
      lifecycle: draft.lifecycle,
      notes: draft.notes.trim(),
    };
    if (!editing) {
      payload.group = parent ? undefined : group;
      if (parent) payload.parent = parent._id;
    }
    onSubmit(payload);
  };

  const title = editing
    ? `Edit ${isCampaign ? 'campaign' : 'platform budget'}`
    : `Add ${isCampaign ? 'a campaign' : 'a platform budget'}`;

  const listId = 'ads-budget-platforms';

  return (
    <Modal isOpen={open} onClose={onClose} title={title} maxWidth={560}>
      <div className="flex flex-col gap-4">
        <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
          {parent
            ? `A campaign on ${parent.platform}, for ${groupName}${monthLabel ? ` in ${monthLabel}` : ''}.`
            : `${groupName ? `${groupName}, ` : ''}${monthLabel || 'this month'}. Budgets are per month — next month starts fresh.`}
        </p>

        {/* Only when opening from the roster, where no client is implied yet. */}
        {!editing && !parent && groups ? (
          <SelectField
            label="Client"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            options={groups.map((g) => ({ value: g._id, label: g.name }))}
          />
        ) : null}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Input
              label="Platform"
              required
              value={draft.platform}
              onChange={(e) => set('platform')(e.target.value)}
              placeholder="Meta Ads"
              list={listId}
              error={touched ? errorFor('platform') || (!draft.platform.trim() ? localError : null) : errorFor('platform')}
              helperText="Any advertising channel — type a new one and it is remembered for this board."
            />
            <datalist id={listId}>
              {platformSuggestions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>
          <Input
            label="Account"
            value={draft.account}
            onChange={(e) => set('account')(e.target.value)}
            placeholder="Optional"
            error={errorFor('account')}
          />
        </div>

        {isCampaign ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Campaign"
              required
              value={draft.name}
              onChange={(e) => set('name')(e.target.value)}
              placeholder="Summer Launch"
              error={touched && !draft.name.trim() ? localError : errorFor('name')}
            />
            <Input
              label="Objective"
              value={draft.objective}
              onChange={(e) => set('objective')(e.target.value)}
              placeholder="Conversion"
              error={errorFor('objective')}
              helperText="However this network names it."
            />
          </div>
        ) : null}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <MoneyField
            label="Budget"
            value={draft.allocated}
            onChange={set('allocated')}
            error={errorFor('allocated')}
            placeholder="0"
            helperText="What has been committed for the month."
          />
          <MoneyField
            label="Spend so far"
            value={draft.spent}
            onChange={set('spent')}
            error={errorFor('spent')}
            placeholder="0"
            helperText="Updated as the month runs."
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <MoneyField
            label="Daily budget"
            value={draft.dailyBudget}
            onChange={set('dailyBudget')}
            error={errorFor('dailyBudget')}
            placeholder="Optional"
            helperText="The cap set at the platform, if there is one."
          />
          <SelectField
            label="Status"
            value={draft.lifecycle}
            onChange={(e) => set('lifecycle')(e.target.value)}
            options={LIFECYCLES}
          />
        </div>

        {/* Said in plain English rather than left for somebody to discover from
            a total that does not add up. */}
        {draft.lifecycle === 'draft' ? (
          <div style={{ padding: 12, background: 'var(--color-bg-subtle)', borderRadius: 'var(--radius-md)' }}>
            <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              A draft budget is kept here but left out of this client&rsquo;s totals and pacing, the way an
              unsent invoice is not revenue. Set it to Active when the money is committed.
            </p>
          </div>
        ) : null}

        <Input
          label="Notes"
          multiline
          rows={3}
          value={draft.notes}
          onChange={(e) => set('notes')(e.target.value)}
          placeholder="Anything worth remembering about this budget."
          error={errorFor('notes')}
        />

        {serverErrors.length > 0 ? (
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-status-stuck)' }}>
            {serverErrors[0].message}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add it'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default BudgetRowModal;

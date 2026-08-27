import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, Pencil, Plus, Trash2 } from 'lucide-react';

import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Spinner from '../../ui/Spinner';
import { NumberField, SegmentedControl, Toggle, WeekdayChips } from '../../ui/FormControls';
import useToastStore from '../../../store/toastStore';
import * as trackerService from '../../../services/trackerService';
import {
  CADENCE_TYPES,
  STARTER_TRACKERS,
  browserTimezone,
  describeBackfill,
  describeScope,
  describeTracker,
  firstOfThisMonth,
  todayDayKey,
} from '../../../utils/deliveryTrackers';
import GroupMultiSelect from './GroupMultiSelect';
import RequirementRows from './RequirementRows';

/**
 * Create and edit trackers. Follows AutomationsModal's shape — one <Modal> with
 * a `view` of 'list' | 'form', swapping both body and footer — with two
 * deliberate additions.
 *
 *   1. A LIVE PREVIEW STRIP above the footer, rendering describeTracker() over
 *      the in-progress form. The user watches the English sentence assemble as
 *      they click, and the sentence they approve is byte-identical to the one
 *      they read in the list a month later. That is what makes "anybody should
 *      be able to understand it" true rather than aspirational.
 *   2. GroupMultiSelect, because a single <select> does not scale to 20 clients.
 */

const emptyForm = () => ({
  name: '',
  enabled: true,
  timezone: browserTimezone(),
  startDate: firstOfThisMonth(),
  endDate: '',
  cadenceType: 'everyNDays',
  n: 1,
  weekStartsOn: 1,
  // Sunday off by default — the common case here, and easy to change.
  weekdays: [1, 2, 3, 4, 5, 6],
  graceDays: 0,
  targetCount: 1,
  showTargetCount: false,
  requirements: ['TASK_EXISTS', 'UPDATE_POSTED'],
  requireSameTask: true,
  observesOrgHolidays: true,
  allGroups: true,
  groups: [],
  nameContains: '',
  excludeNameContains: '',
});

const formFromSeed = (seed) => {
  const base = emptyForm();
  return {
    ...base,
    name: seed.name,
    cadenceType: seed.cadence.type,
    n: seed.cadence.n || 1,
    weekStartsOn: seed.cadence.weekStartsOn ?? 1,
    weekdays: seed.cadence.weekdays || base.weekdays,
    graceDays: seed.cadence.graceDays || 0,
    targetCount: seed.targetCount || 1,
    showTargetCount: (seed.targetCount || 1) > 1,
    requirements: seed.requirements,
    requireSameTask: seed.requireSameTask !== false,
    observesOrgHolidays: seed.observesOrgHolidays !== false,
    allGroups: (seed.groups || []).length === 0,
    groups: seed.groups || [],
    nameContains: seed.match?.nameContains || '',
    excludeNameContains: seed.match?.excludeNameContains || '',
  };
};

const formFromTracker = (t) => ({
  name: t.name,
  enabled: t.enabled,
  timezone: t.timezone,
  startDate: t.startDate,
  endDate: t.endDate || '',
  cadenceType: t.cadence?.type || 'everyNDays',
  n: t.cadence?.n || 1,
  weekStartsOn: t.cadence?.weekStartsOn ?? 1,
  weekdays: t.cadence?.weekdays?.length ? t.cadence.weekdays : [0, 1, 2, 3, 4, 5, 6],
  graceDays: t.cadence?.graceDays || 0,
  targetCount: t.targetCount || 1,
  showTargetCount: (t.targetCount || 1) > 1,
  requirements: t.requirements?.length ? t.requirements : ['TASK_EXISTS'],
  requireSameTask: t.requireSameTask !== false,
  observesOrgHolidays: t.observesOrgHolidays !== false,
  allGroups: (t.groups || []).length === 0,
  groups: (t.groups || []).map(String),
  nameContains: t.match?.nameContains || '',
  excludeNameContains: t.match?.excludeNameContains || '',
});

/** Form → the shape both the preview and the API expect. Single source of truth. */
const trackerFromForm = (form) => ({
  name: form.name,
  enabled: form.enabled,
  timezone: form.timezone,
  startDate: form.startDate,
  endDate: form.endDate || null,
  cadence: {
    type: form.cadenceType,
    ...(form.cadenceType === 'everyNDays' ? { n: form.n || 1 } : {}),
    ...(form.cadenceType === 'everyNDays' && (form.n || 1) > 1
      ? { anchorDate: form.startDate }
      : {}),
    ...(form.cadenceType === 'weekly' ? { weekStartsOn: form.weekStartsOn } : {}),
    weekdays: form.weekdays,
    graceDays: form.graceDays || 0,
  },
  groups: form.allGroups ? [] : form.groups,
  match: {
    nameContains: form.nameContains,
    excludeNameContains: form.excludeNameContains,
    labels: [],
  },
  requirements: form.requirements,
  requireSameTask: form.requireSameTask,
  observesOrgHolidays: form.observesOrgHolidays,
  targetCount: form.showTargetCount ? form.targetCount || 1 : 1,
  // NOT sent: `skipDates` / `daysOff`. Update is partial, so omitting them leaves
  // them alone — sending `[]` here would silently wipe every day off the team
  // marked from the grid the moment somebody renamed the tracker.
});

const validateLocal = (form) => {
  if (!form.name.trim()) return 'Give the tracker a name.';
  if (!form.startDate) return 'Pick a date to start tracking from.';
  if (form.requirements.length === 0) return 'Pick at least one thing that has to happen.';
  if (form.weekdays.length === 0) return 'At least one weekday has to be a working day.';
  if (!form.allGroups && form.groups.length === 0) return 'Pick at least one client.';
  if (form.endDate && form.endDate < form.startDate) {
    return 'The end date cannot be before the start date.';
  }
  return null;
};

const labelClass = 'block mb-2 font-body font-medium text-xs uppercase tracking-wide';
const labelStyle = { color: 'var(--color-text-secondary)' };

const TrackersModal = ({ isOpen, onClose, boardId, groups = [], canManage, initialView, onChanged }) => {
  const [view, setView] = useState('list');
  const [editingId, setEditingId] = useState(null);
  const [trackers, setTrackers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      setTrackers(await trackerService.listTrackers(boardId));
    } catch (err) {
      setListError(err?.response?.data?.error || 'Could not load trackers. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    if (!isOpen || !boardId) return;
    setView(initialView === 'form' ? 'form' : 'list');
    setEditingId(null);
    setForm(emptyForm());
    setFormError(null);
    refresh();
  }, [isOpen, boardId, initialView, refresh]);

  const setField = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const openCreate = (seed) => {
    setEditingId(null);
    setForm(seed ? formFromSeed(seed) : emptyForm());
    setFormError(null);
    setView('form');
  };

  const openEdit = (tracker) => {
    setEditingId(tracker._id);
    setForm(formFromTracker(tracker));
    setFormError(null);
    setView('form');
  };

  const handleSave = async () => {
    const problem = validateLocal(form);
    if (problem) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = trackerFromForm(form);
      if (editingId) await trackerService.updateTracker(editingId, payload);
      else await trackerService.createTracker(boardId, payload);
      toastSuccess(editingId ? 'Tracker updated' : 'Tracker created');
      await refresh();
      onChanged?.();
      setView('list');
    } catch (err) {
      setFormError(err?.response?.data?.error || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (tracker, enabled) => {
    setBusyId(tracker._id);
    try {
      await trackerService.updateTracker(tracker._id, { enabled });
      await refresh();
      onChanged?.();
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not update the tracker.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (tracker) => {
    if (!window.confirm(`Delete "${tracker.name}"? Its confirmations go with it.`)) return;
    setBusyId(tracker._id);
    try {
      await trackerService.deleteTracker(tracker._id);
      await refresh();
      onChanged?.();
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not delete the tracker.');
    } finally {
      setBusyId(null);
    }
  };

  const preview = useMemo(() => trackerFromForm(form), [form]);

  const footer = view === 'list' ? (
    <Button variant="secondary" onClick={onClose}>Close</Button>
  ) : (
    <>
      <Button variant="secondary" onClick={() => setView('list')} disabled={saving}>Cancel</Button>
      <Button variant="primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create tracker'}
      </Button>
    </>
  );

  const renderList = () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
          A tracker is a promise you make — a task every working day, a report every month.
        </p>
        {canManage && (
          <Button variant="primary" size="sm" icon={Plus} onClick={() => openCreate()}>
            New tracker
          </Button>
        )}
      </div>

      {loading && (
        <div className="flex justify-center" style={{ padding: 24 }}>
          <Spinner label="Loading trackers" />
        </div>
      )}

      {listError && (
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-status-stuck)' }}>
          {listError}
        </p>
      )}

      {!loading && !listError && trackers.length === 0 && (
        <div className="flex flex-col gap-2">
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            Nothing tracked yet. Start from one of these:
          </p>
          {STARTER_TRACKERS.map((tpl) => {
            const Icon = tpl.icon;
            return (
              <button
                key={tpl.id}
                type="button"
                disabled={!canManage}
                onClick={() => openCreate(tpl.seed)}
                className="w-full flex items-start gap-3 text-left transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                style={{
                  padding: '12px 14px',
                  borderRadius: 'var(--radius-md)',
                  border: '1.5px solid var(--color-border)',
                  background: 'transparent',
                  cursor: canManage ? 'pointer' : 'not-allowed',
                }}
              >
                <Icon size={16} color="var(--color-accent)" aria-hidden="true" style={{ marginTop: 2 }} />
                <span className="min-w-0 flex-1">
                  <span
                    className="font-display font-semibold block"
                    style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
                  >
                    {tpl.title}
                  </span>
                  <span
                    className="font-body block mt-0.5"
                    style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
                  >
                    {describeTracker({ ...tpl.seed, ...tpl.seed })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!loading && trackers.length > 0 && (
        <ul className="flex flex-col gap-2">
          {trackers.map((t) => {
            const isBusy = busyId === t._id;
            return (
              <li
                key={t._id}
                style={{
                  border: '1.5px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px 14px',
                  background: t.enabled ? 'var(--color-bg-surface)' : 'var(--color-bg-subtle)',
                }}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p
                      className="font-display font-semibold truncate"
                      style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
                    >
                      {t.name}
                    </p>
                    <p
                      className="font-body mt-1"
                      style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
                    >
                      {describeTracker(t)}
                    </p>
                    <p
                      className="font-body mt-0.5"
                      style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                    >
                      {describeScope(t, groups)}
                    </p>
                  </div>

                  {canManage && (
                    <div className="flex items-center gap-2 shrink-0">
                      <Toggle
                        checked={t.enabled}
                        disabled={isBusy}
                        onChange={(v) => handleToggle(t, v)}
                      />
                      <button
                        type="button"
                        onClick={() => openEdit(t)}
                        aria-label={`Edit ${t.name}`}
                        title="Edit"
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 4 }}
                      >
                        <Pencil size={14} color="var(--color-text-secondary)" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(t)}
                        aria-label={`Delete ${t.name}`}
                        title="Delete"
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 4 }}
                      >
                        <Trash2 size={14} color="#DC2626" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  const renderForm = () => (
    <div className="flex flex-col gap-4">
      <Input
        label="Name"
        placeholder="Daily activity"
        value={form.name}
        onChange={(e) => setField('name')(e.target.value)}
        disabled={saving}
        autoFocus
      />

      <div>
        <label className={labelClass} style={labelStyle} htmlFor="tracker-start">
          Start tracking from
        </label>
        <input
          id="tracker-start"
          type="date"
          value={form.startDate}
          max={todayDayKey()}
          disabled={saving}
          onChange={(e) => setField('startDate')(e.target.value)}
          className="w-full font-body"
          style={{
            height: 38,
            padding: '0 10px',
            borderRadius: 'var(--radius-md)',
            border: '1.5px solid var(--color-border)',
            background: 'var(--color-bg-input)',
            color: 'var(--color-text-primary)',
            fontSize: 14,
          }}
        />
        <p className="font-body mt-1" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          {describeBackfill(form.startDate, todayDayKey())}
          {' '}Nothing before this date is scored.
        </p>
      </div>

      <div>
        <label className={labelClass} style={labelStyle}>How often</label>
        <SegmentedControl
          options={CADENCE_TYPES}
          value={form.cadenceType}
          onChange={setField('cadenceType')}
          disabled={saving}
        />
      </div>

      {form.cadenceType === 'everyNDays' && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
            Every
          </span>
          <NumberField
            value={form.n}
            onChange={setField('n')}
            min={1}
            max={90}
            disabled={saving}
            suffix={form.n === 1 ? 'day' : 'days'}
            ariaLabel="Repeat every how many days"
          />
        </div>
      )}

      <div>
        <label className={labelClass} style={labelStyle}>
          {form.cadenceType === 'everyNDays' ? 'Working days' : 'Working days (for days off)'}
        </label>
        <WeekdayChips value={form.weekdays} onChange={setField('weekdays')} disabled={saving} />
        <p className="font-body mt-1.5" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          Periods with no working day in them show as “day off” and are left out of the score.
        </p>
      </div>

      {/*
        The escape hatch for the workspace holiday calendar. On for everything
        by default — a shared calendar that had to be switched on tracker by
        tracker would be no better than marking each day by hand.
      */}
      <div>
        <Toggle
          checked={form.observesOrgHolidays}
          onChange={setField('observesOrgHolidays')}
          disabled={saving}
          label="Follow the company holiday calendar"
        />
        <p className="font-body mt-1.5" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          {form.observesOrgHolidays
            ? 'Days marked in Settings → Holidays count as days off here too.'
            : 'This tracker is scored on public holidays like any other day.'}
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
          Allow
        </span>
        <NumberField
          value={form.graceDays}
          onChange={setField('graceDays')}
          min={0}
          max={90}
          disabled={saving}
          suffix="days grace after the period ends"
          ariaLabel="Grace days"
        />
      </div>

      <div>
        <Toggle
          checked={form.showTargetCount}
          onChange={(v) => setForm((f) => ({ ...f, showTargetCount: v, targetCount: v ? Math.max(2, f.targetCount) : 1 }))}
          disabled={saving}
          label="More than once per period"
        />
        {form.showTargetCount && (
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <span className="font-body" style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
              Needs
            </span>
            <NumberField
              value={form.targetCount}
              onChange={setField('targetCount')}
              min={1}
              max={50}
              disabled={saving}
              suffix="times per period"
              ariaLabel="How many per period"
            />
          </div>
        )}
      </div>

      <GroupMultiSelect
        groups={groups}
        value={form.groups}
        allGroups={form.allGroups}
        onChange={setField('groups')}
        onAllGroupsChange={setField('allGroups')}
        disabled={saving}
      />

      <RequirementRows
        value={form.requirements}
        onChange={setField('requirements')}
        disabled={saving}
      />

      <Toggle
        checked={form.requireSameTask}
        onChange={setField('requireSameTask')}
        disabled={saving}
        label="The update has to be on the same task"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          label="Only count tasks named…"
          placeholder="e.g. Report"
          value={form.nameContains}
          onChange={(e) => setField('nameContains')(e.target.value)}
          disabled={saving}
        />
        <Input
          label="Ignore tasks named…"
          placeholder="e.g. Report"
          value={form.excludeNameContains}
          onChange={(e) => setField('excludeNameContains')(e.target.value)}
          disabled={saving}
        />
      </div>

      {formError && (
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-status-stuck)' }}>
          {formError}
        </p>
      )}

      {/* The live preview. Same describer the list row uses, so what you approve
          here is verbatim what you read tomorrow. */}
      <div
        className="flex items-start gap-2"
        style={{
          padding: '10px 12px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-accent-light)',
          border: '1.5px solid var(--color-accent)',
        }}
      >
        <Eye size={14} color="var(--color-accent-text)" aria-hidden="true" style={{ marginTop: 2 }} />
        <p
          className="font-body"
          style={{ fontSize: 12.5, color: 'var(--color-accent-text)', lineHeight: 1.45 }}
        >
          <strong>{form.name || 'This tracker'}</strong>
          {' — '}
          {describeTracker(preview)}
          {' · '}
          {describeScope(preview, groups)}
        </p>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={view === 'list' ? 'Trackers' : editingId ? 'Edit tracker' : 'New tracker'}
      maxWidth={640}
      footer={footer}
    >
      {view === 'list' ? renderList() : renderForm()}
    </Modal>
  );
};

export default TrackersModal;

import { useState, useEffect } from 'react';
import Modal from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';
import DatePickerPopover from '../ui/DatePickerPopover';
import { createTask, updateTask } from '../../services/taskService';
import { dateInputToISO } from '../../utils/dateUtils';

/**
 * PersonalTaskModal — simplified create/edit form for personal (non-board) tasks.
 *
 * Personal tasks have no group, board, or assignee. The current user is always
 * the creator and sole viewer. See Macan_PDR.md Section 4.4 and
 * Macan_TechStack.md Section 8.9.
 *
 * Props:
 *   isOpen    — boolean
 *   onClose   — () => void
 *   onCreated — (task) => void — called after a new task is saved
 *   task      — task object — when provided, the modal edits this task
 *   onUpdated — (task) => void — called after an existing task is saved
 */

const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const STATUSES = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'working_on_it', label: 'Working on it' },
  { value: 'done', label: 'Done' },
  { value: 'stuck', label: 'Stuck' },
];

const INITIAL_FORM = {
  name: '',
  priority: 'medium',
  status: 'not_started',
  dueDate: '',
  note: '',
};

const SelectField = ({ label, value, onChange, options, disabled }) => (
  <div>
    <label
      className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
      style={{ color: 'var(--color-text-secondary)' }}
    >
      {label}
    </label>
    <select
      value={value}
      onChange={onChange}
      disabled={disabled}
      className="w-full font-body"
      style={{
        height: 38,
        padding: '0 10px',
        borderRadius: 'var(--radius-md)',
        border: '1.5px solid var(--color-border)',
        background: 'var(--color-bg-input)',
        color: 'var(--color-text-primary)',
        fontSize: 14,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  </div>
);

const toDateInput = (val) => (val ? String(val).slice(0, 10) : '');

const PersonalTaskModal = ({ isOpen, onClose, onCreated, task, onUpdated }) => {
  const isEdit = Boolean(task);
  const [form, setForm] = useState(INITIAL_FORM);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Populate the form when opening in edit mode (or reset for create mode).
  useEffect(() => {
    if (!isOpen) return;
    if (task) {
      setForm({
        name: task.name || '',
        priority: task.priority || 'medium',
        status: task.status || 'not_started',
        dueDate: toDateInput(task.dueDate),
        note: task.note || '',
      });
    } else {
      setForm(INITIAL_FORM);
    }
    setError('');
  }, [isOpen, task]);

  const set = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const reset = () => {
    setForm(INITIAL_FORM);
    setError('');
  };

  const handleClose = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setError('Task name is required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        priority: form.priority,
        status: form.status,
        dueDate: dateInputToISO(form.dueDate),
        note: form.note.trim() || '',
      };
      if (isEdit) {
        const updated = await updateTask(task._id, payload);
        onUpdated?.(updated);
      } else {
        const created = await createTask({ ...payload, isPersonal: true });
        onCreated?.(created);
      }
      reset();
      onClose();
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          `Failed to ${isEdit ? 'update' : 'create'} task. Please try again.`
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={isEdit ? 'Edit Personal Task' : 'Create Personal Task'}
      maxWidth={480}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={saving}>
            {saving
              ? isEdit
                ? 'Saving…'
                : 'Creating…'
              : isEdit
                ? 'Save Changes'
                : 'Create Task'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Task Name"
          placeholder="What needs to get done?"
          value={form.name}
          onChange={set('name')}
          required
          disabled={saving}
          autoFocus
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SelectField
            label="Priority"
            value={form.priority}
            onChange={set('priority')}
            options={PRIORITIES}
            disabled={saving}
          />
          <SelectField
            label="Status"
            value={form.status}
            onChange={set('status')}
            options={STATUSES}
            disabled={saving}
          />
        </div>

        <div>
          <label
            className="font-body font-semibold block"
            style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}
          >
            Due Date
          </label>
          <DatePickerPopover
            value={form.dueDate}
            onChange={(val) => setForm((f) => ({ ...f, dueDate: val }))}
            disabled={saving}
            placeholder="Set due date"
          />
        </div>

        <Input
          label="Note"
          placeholder="Any additional context…"
          value={form.note}
          onChange={set('note')}
          disabled={saving}
          multiline
          rows={3}
        />

        {error && (
          <p
            className="text-xs font-body"
            style={{ color: 'var(--color-status-stuck)' }}
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
};

export default PersonalTaskModal;

import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';

/**
 * BoardFormModal — used for both creating and editing a board.
 * Matches Design doc Section 11 (Create Board form).
 *
 * Props:
 *   isOpen        — whether the modal is shown
 *   onClose       — fired when user cancels / closes
 *   onSubmit      — async ({ name, visibility, description }) => void
 *   initialValues — pre-fill values when editing
 *   mode          — "create" | "edit" (affects title + submit label)
 */
const DEFAULTS = {
  name: '',
  visibility: 'private',
  description: '',
  boardType: 'standard',
  portalCategoriesText: '',
};

const BoardFormModal = ({
  isOpen,
  onClose,
  onSubmit,
  initialValues,
  mode = 'create',
}) => {
  const [values, setValues] = useState(DEFAULTS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Reset / hydrate form whenever the modal opens or initialValues change
  useEffect(() => {
    if (!isOpen) return;
    setValues({
      name: initialValues?.name || '',
      visibility: initialValues?.visibility || 'private',
      description: initialValues?.description || '',
      boardType: initialValues?.boardType || 'standard',
      portalCategoriesText: Array.isArray(initialValues?.portalCategories)
        ? initialValues.portalCategories.join(', ')
        : '',
    });
    setError(null);
    setSubmitting(false);
  }, [isOpen, initialValues]);

  const isClient = values.boardType === 'client';
  const isMonthly = values.boardType === 'monthly';
  // In the create dialog the user picks one of four: Public, Private, Client
  // Portal, or Monthly. The last two are board TYPES; Public/Private are
  // visibilities on a standard board. `kind` collapses these into one radio
  // group.
  //
  // A monthly board is pinned to private the same way a client board is —
  // not because the type requires it (a monthly board is an ordinary internal
  // board that happens to be partitioned) but because retainer boards are
  // client work by default and defaulting them public would be a surprise.
  const kind = isClient ? 'client' : isMonthly ? 'monthly' : values.visibility;
  const setKind = (next) => {
    setValues((v) => {
      if (next === 'client') return { ...v, boardType: 'client', visibility: 'private' };
      if (next === 'monthly') return { ...v, boardType: 'monthly', visibility: 'private' };
      return { ...v, boardType: 'standard', visibility: next };
    });
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    const trimmed = values.name.trim();
    if (!trimmed) {
      setError('Board name is required');
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      await onSubmit({
        name: trimmed,
        visibility: isClient || isMonthly ? 'private' : values.visibility,
        description: values.description.trim(),
        boardType: values.boardType,
        // A monthly board must know whose calendar defines its months. Sending
        // the browser's resolved zone is exactly what TrackersModal already does
        // for a tracker, and for the same reason: a board silently on UTC while
        // the team is on IST files every month-boundary task in the wrong month.
        monthTimezone: isMonthly
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : undefined,
        portalCategories: isClient
          ? values.portalCategoriesText
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean)
          : [],
      });
    } catch (err) {
      const msg =
        err?.response?.data?.error || err?.message || 'Something went wrong';
      setError(msg);
      setSubmitting(false);
    }
  };

  const title = mode === 'edit' ? 'Edit Board' : 'Create Board';
  const submitLabel = mode === 'edit' ? 'Save Changes' : 'Create Board →';

  return (
    <Modal
      isOpen={isOpen}
      onClose={submitting ? undefined : onClose}
      title={title}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Saving…' : submitLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <Input
          label="Board Name"
          required
          placeholder="e.g. DAVNOOT SEO"
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          autoFocus
        />

        {/* Type / visibility selector. In edit mode an existing Client Portal
            board's type can't be changed, so we show a static note instead. */}
        {mode === 'edit' && (isClient || isMonthly) ? (
          <div>
            <label
              className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              Board type
            </label>
            <span
              className="font-body inline-flex items-center gap-2"
              style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
            >
              <span
                style={{
                  width: 8, height: 8, borderRadius: 'var(--radius-full)',
                  background: 'var(--color-accent)',
                }}
              />
              {isClient ? 'Client Portal' : 'Monthly'}
            </span>
          </div>
        ) : (
          <div>
            <label
              className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {mode === 'create' ? 'Type' : 'Visibility'}
            </label>
            <div className="flex items-center gap-5 flex-wrap">
              {(mode === 'create'
                ? [
                    { value: 'public', label: 'Public' },
                    { value: 'private', label: 'Private' },
                    { value: 'client', label: 'Client Portal' },
                    { value: 'monthly', label: 'Monthly' },
                  ]
                : [
                    { value: 'public', label: 'Public' },
                    { value: 'private', label: 'Private' },
                  ]
              ).map((opt) => {
                const checked = kind === opt.value;
                return (
                  <label
                    key={opt.value}
                    className="flex items-center gap-2 cursor-pointer select-none"
                  >
                    <span
                      className="flex items-center justify-center"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 'var(--radius-full)',
                        border: `1.5px solid ${
                          checked
                            ? 'var(--color-accent)'
                            : 'var(--color-border-strong)'
                        }`,
                        background: checked
                          ? 'var(--color-accent-light)'
                          : 'var(--color-bg-surface)',
                        transition:
                          'border-color 150ms ease, background 150ms ease',
                      }}
                    >
                      {checked && (
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 'var(--radius-full)',
                            background: 'var(--color-accent)',
                          }}
                        />
                      )}
                    </span>
                    <input
                      type="radio"
                      name="boardKind"
                      value={opt.value}
                      checked={checked}
                      onChange={() => setKind(opt.value)}
                      className="sr-only"
                    />
                    <span
                      className="font-body"
                      style={{
                        fontSize: 14,
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {opt.label}
                    </span>
                  </label>
                );
              })}
            </div>
            {mode === 'create' && isClient && (
              <p
                className="font-body mt-2"
                style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
              >
                A private board where each group is a client. You'll generate a
                shareable link per group so clients can raise issues.
              </p>
            )}
            {mode === 'create' && isMonthly && (
              <p
                className="font-body mt-2"
                style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
              >
                Work organised month by month. You get a month picker at the top,
                a Delivery view for recurring commitments, and a Goals tab for the
                numbers you're promising. Built for retainers.
              </p>
            )}
          </div>
        )}

        {/* Client categories — optional, client boards only */}
        {mode === 'create' && isClient && (
          <Input
            label="Client issue categories (optional)"
            placeholder="e.g. Bug, Concern, Request"
            value={values.portalCategoriesText}
            onChange={(e) =>
              setValues((v) => ({ ...v, portalCategoriesText: e.target.value }))
            }
            helperText="Comma-separated. Clients can optionally tag an issue with one."
          />
        )}

        <Input
          label="Description (optional)"
          multiline
          rows={3}
          placeholder="What is this board for?"
          value={values.description}
          onChange={(e) =>
            setValues((v) => ({ ...v, description: e.target.value }))
          }
        />

        {error && (
          <p
            className="font-body text-xs"
            style={{ color: 'var(--color-status-stuck)' }}
          >
            {error}
          </p>
        )}

        {/* Hidden submit so <Enter> in inputs submits the form */}
        <button type="submit" className="hidden" aria-hidden="true" />
      </form>
    </Modal>
  );
};

export default BoardFormModal;

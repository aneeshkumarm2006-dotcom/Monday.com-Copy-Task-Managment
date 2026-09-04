import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';
import Spinner from '../ui/Spinner';
import MonthSplitPreview from './MonthSplitPreview';
import { previewBoardConversion } from '../../services/monthService';

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
 *   canChangeVisibility — edit mode only: may this user flip public/private?
 *                   Ignored on create (choosing the visibility of a board that
 *                   does not exist yet is `board.create`, not a change).
 */
import ClientSignInMethodField from './ClientSignInMethodField';

const DEFAULTS = {
  name: '',
  visibility: 'private',
  description: '',
  boardType: 'standard',
  portalCategoriesText: '',
  // Client boards only. The portal link belongs to the BOARD now, so the client
  // company's name and first contact are collected here — they used to be asked
  // for when creating a group, back when a group was the client.
  clientName: '',
  clientEmail: '',
  clientAuthMethod: 'google',
};

const BoardFormModal = ({
  isOpen,
  onClose,
  onSubmit,
  initialValues,
  mode = 'create',
  canChangeVisibility = true,
}) => {
  const [values, setValues] = useState(DEFAULTS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [convertPreview, setConvertPreview] = useState(null);
  const [convertError, setConvertError] = useState(null);

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
  const isTracker = values.boardType === 'tracker';

  // Whether the visibility radios are live. Only ever false in edit mode: the
  // ⋯ menu that opens this form asks for `board.rename`, and flipping a board
  // public is a lifecycle decision no rung of the access ladder confers — so
  // someone with an edit grant on a board they did not create reaches this form
  // legitimately and must not be shown a control the save would refuse.
  const visibilityEditable = mode === 'create' || canChangeVisibility;

  // Edit mode only: is the user actually changing the board's type, and which
  // way? `initialValues.boardType` is what it is now; `values.boardType` is what
  // they have selected.
  const originalType = initialValues?.boardType || 'standard';
  const typeChanging = mode === 'edit' && values.boardType !== originalType;
  const toTracker = typeChanging && values.boardType === 'tracker';

  // The browser's own zone, sent when converting. It decides where months begin
  // and end; changeable afterwards from the board's month picker.
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Price the conversion as soon as Tracker is selected, so the user sees the
  // real month split before committing rather than after.
  useEffect(() => {
    if (!toTracker || !initialValues?._id) return undefined;
    let cancelled = false;
    setConvertPreview(null);
    setConvertError(null);
    previewBoardConversion(initialValues._id, {
      to: 'tracker',
      timezone: browserTimezone,
    })
      .then((p) => { if (!cancelled) setConvertPreview(p); })
      .catch((err) => {
        if (cancelled) return;
        setConvertError(
          err?.response?.data?.error || 'Could not work out what would change.'
        );
      });
    return () => { cancelled = true; };
  }, [toTracker, initialValues?._id, browserTimezone]);
  // In the create dialog the user picks one of four: Public, Private, Client
  // Portal, or Tracker. The last two are board TYPES; Public/Private are
  // visibilities on a standard board. `kind` collapses these into one radio
  // group.
  //
  // A tracker board is pinned to private the same way a client board is —
  // not because the type requires it (a tracker board is an ordinary internal
  // board that happens to be partitioned) but because retainer boards are
  // client work by default and defaulting them public would be a surprise.
  const kind = isClient ? 'client' : isTracker ? 'tracker' : values.visibility;
  const setKind = (next) => {
    setValues((v) => {
      if (next === 'client') return { ...v, boardType: 'client', visibility: 'private' };
      if (next === 'tracker') return { ...v, boardType: 'tracker', visibility: 'private' };
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
    // The invitation address is optional — you can create the portal now and
    // share the link yourself — but a typo in one is worth catching here.
    const clientEmail = values.clientEmail.trim();
    if (
      mode === 'create' &&
      isClient &&
      clientEmail &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)
    ) {
      setError('Enter a valid client email, or leave it blank to share the link yourself.');
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      await onSubmit({
        // Converting an EXISTING board must not silently change who can see it,
        // so visibility is only pinned when the type is chosen at create time.
        visibility: mode === 'create' && (isClient || isTracker)
          ? 'private'
          : values.visibility,
        name: trimmed,
        description: values.description.trim(),
        boardType: values.boardType,
        // Only meaningful when the type is actually changing; the caller uses it
        // to decide whether to run a conversion alongside the plain update.
        typeChanged: typeChanging,
        // A tracker board must know whose calendar defines its months. Sending
        // the browser's resolved zone is exactly what TrackersModal already does
        // for a tracker, and for the same reason: a board silently on UTC while
        // the team is on IST files every month-boundary task in the wrong month.
        monthTimezone: isTracker ? browserTimezone : undefined,
        portalCategories: isClient
          ? values.portalCategoriesText
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean)
          : [],
        // The board mints its portal link on create; these decide what the
        // client sees it called and who gets the first invitation.
        ...(mode === 'create' && isClient
          ? {
              clientName: values.clientName.trim(),
              clientEmail: values.clientEmail.trim(),
              clientAuthMethod: values.clientAuthMethod,
            }
          : {}),
      });
    } catch (err) {
      const msg =
        err?.response?.data?.error || err?.message || 'Something went wrong';
      setError(msg);
      setSubmitting(false);
    }
  };

  const title = mode === 'edit' ? 'Edit Board' : 'Create Board';
  // Name the consequence when there is one: "Save Changes" badly undersells an
  // action that re-files every task on the board.
  const submitLabel = mode === 'create'
    ? 'Create Board →'
    : toTracker
      ? 'Make it a tracker board'
      : typeChanging
        ? 'Make it standard'
        : 'Save Changes';

  // Don't let someone commit a conversion the server has already said it will
  // refuse, or one whose preview has not arrived yet.
  const blocked = toTracker && (!convertPreview || !convertPreview.canConvert);

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
            disabled={submitting || blocked}
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
          placeholder="e.g. Acme — Monthly Retainer"
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          autoFocus
        />

        {/* Type / visibility selector, in three shapes:
              1. edit, no `board.change_visibility` — the current visibility, flat
                 and unclickable, because the save would refuse a change;
              2. edit, Client Portal — the type is fixed, since the client plane
                 assumes a group is one client's live queue and the server
                 refuses to convert it in either direction;
              3. everything else — the live radios. */}
        {mode === 'edit' && !visibilityEditable && !isClient ? (
          <div>
            <label
              className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              Visibility
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
              {values.visibility === 'public' ? 'Public' : 'Private'}
            </span>
            <p
              className="font-body mt-2"
              style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            >
              Only the board’s owner and the workspace owner can change this.
            </p>
          </div>
        ) : mode === 'edit' && isClient ? (
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
              Client Portal
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
                    { value: 'tracker', label: 'Tracker' },
                  ]
                : [
                    { value: 'public', label: 'Public' },
                    { value: 'private', label: 'Private' },
                  ]
              ).map((opt) => {
                // In EDIT mode this group is visibility only — the board type
                // has its own section below, because for an existing board the
                // two are genuinely separate questions (a tracker board can be
                // public). In create mode they stay collapsed into one choice.
                const checked =
                  mode === 'create' ? kind === opt.value : values.visibility === opt.value;
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
                      onChange={() =>
                        (mode === 'create'
                          ? setKind(opt.value)
                          : setValues((v) => ({ ...v, visibility: opt.value })))}
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
            {mode === 'create' && isTracker && (
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

        {/* Board type, edit mode. Its own section rather than folded into the
            radios above, because changing it is not an edit — it re-files every
            task on the board — so it needs to show what it will do first. */}
        {mode === 'edit' && !isClient && (
          <div>
            <label
              className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              Board type
            </label>
            <div className="flex items-center gap-5 flex-wrap">
              {[
                { value: 'standard', label: 'Standard' },
                { value: 'tracker', label: 'Tracker' },
              ].map((opt) => {
                const checked = values.boardType === opt.value;
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
                        border: `1.5px solid ${checked ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
                        background: checked
                          ? 'var(--color-accent-light)'
                          : 'var(--color-bg-surface)',
                        transition: 'border-color 150ms ease, background 150ms ease',
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
                      name="boardTypeEdit"
                      value={opt.value}
                      checked={checked}
                      onChange={() =>
                        setValues((v) => ({ ...v, boardType: opt.value }))}
                      className="sr-only"
                    />
                    <span
                      className="font-body"
                      style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
                    >
                      {opt.label}
                    </span>
                  </label>
                );
              })}
            </div>

            {/* Nothing below renders unless the type is actually changing. */}
            {typeChanging && (
              <div className="mt-3 flex flex-col gap-3">
                {toTracker ? (
                  <>
                    <p
                      className="font-body"
                      style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
                    >
                      Every task will be filed into the month it was created in.
                      Nothing is deleted and nothing moves between groups — you’ll
                      just see one month at a time, plus a Delivery tab and a Goals
                      tab.
                    </p>

                    {convertPreview === null && !convertError && (
                      <span
                        className="flex items-center gap-2 font-body"
                        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                      >
                        <Spinner size={13} /> Working out how the tasks would split…
                      </span>
                    )}

                    {convertPreview?.canConvert && (
                      <>
                        <MonthSplitPreview preview={convertPreview} compact />
                        <p
                          className="font-body"
                          style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}
                        >
                          Filed by creation date, in {convertPreview.timezone}. A task
                          created at the end of one month for the next month’s work
                          lands in the earlier one — move those afterwards with “Move
                          to month”. You can change the timezone later from the board.
                        </p>
                      </>
                    )}

                    {convertPreview && !convertPreview.canConvert && (
                      <p
                        className="font-body"
                        style={{ fontSize: 12, color: 'var(--color-status-stuck)' }}
                      >
                        {convertPreview.refusals?.[0] || 'This board cannot be converted.'}
                      </p>
                    )}
                  </>
                ) : (
                  <p
                    className="font-body"
                    style={{ fontSize: 12, color: 'var(--color-status-working)', lineHeight: 1.5 }}
                  >
                    The Delivery and Goals tabs will be hidden and every task will
                    show at once again. Nothing is deleted — tasks keep their month
                    and your goals are kept, so switching back restores this board
                    exactly as it is now.
                  </p>
                )}
              </div>
            )}

            {convertError && (
              <p
                className="font-body mt-2"
                style={{ fontSize: 12, color: 'var(--color-status-stuck)' }}
              >
                {convertError}
              </p>
            )}
          </div>
        )}

        {/* The client themselves — client boards only, at create time. This
            board IS one company: it gets one portal link, and its groups become
            that company's workstreams (SEO, Ads, Web Development). */}
        {mode === 'create' && isClient && (
          <>
            <Input
              label="Client company name (optional)"
              placeholder={values.name.trim() || 'e.g. Acme Corp'}
              value={values.clientName}
              onChange={(e) =>
                setValues((v) => ({ ...v, clientName: e.target.value }))
              }
              helperText="What the client sees at the top of their portal. Defaults to the board name."
            />
            <Input
              label="Client email (we'll send the invitation)"
              type="email"
              placeholder="client@company.com"
              value={values.clientEmail}
              onChange={(e) =>
                setValues((v) => ({ ...v, clientEmail: e.target.value }))
              }
              helperText="Optional — leave blank to copy the link and share it yourself."
            />
            {/* Only asked once there is someone to ask about. */}
            {values.clientEmail.trim() && (
              <ClientSignInMethodField
                value={values.clientAuthMethod}
                onChange={(next) =>
                  setValues((v) => ({ ...v, clientAuthMethod: next }))
                }
                disabled={submitting}
              />
            )}
            <Input
              label="Client issue categories (optional)"
              placeholder="e.g. Bug, Concern, Request"
              value={values.portalCategoriesText}
              onChange={(e) =>
                setValues((v) => ({ ...v, portalCategoriesText: e.target.value }))
              }
              helperText="Comma-separated. Clients can optionally tag a request with one."
            />
          </>
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

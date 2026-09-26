import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';
import Spinner from '../ui/Spinner';
import MonthSplitPreview from './MonthSplitPreview';
import { previewBoardConversion } from '../../services/monthService';
import TemplatePicker from './TemplatePicker';
import GroupCompletedLabel from './GroupCompletedLabel';
import LogoUploader from '../ui/LogoUploader';
import { SelectField } from '../ui/FormControls';
import BoardCurrencyControl from './BoardCurrencyControl';
import useBoardStore from '../../store/boardStore';
import useOrgStore from '../../store/orgStore';
import { currencyByCode, currencyOptions } from '../../utils/money';

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

const DEFAULTS = {
  name: '',
  visibility: 'private',
  description: '',
  boardType: 'standard',
  // Client boards only, and a LABEL only. There is no contact field here: the
  // client's invitation goes out with the first SERVICE, not with the board,
  // because a portal with no services is an empty page.
  clientName: '',
  // Which template seeds the board. Create-only — a template has no meaning
  // once a board exists, so editing never shows this.
  template: 'blank',
  // CREATE ONLY, and only asked when the picked template carries money
  // columns (`templateHasMoney`, reported by the picker). '' means FOLLOW the
  // workspace currency — the default, and the select's first row — and sends
  // no currency at all, so the board is born following and moves with the
  // workspace. A code is an explicit override the board keeps.
  currency: '',
  templateHasMoney: false,
  // EDIT ONLY. What a finished group says in place of its status bar. Empty is
  // the off switch and the default, so a board nobody has set this on keeps the
  // bar. Not offered on create: you cannot judge the wording before you can see
  // which groups the board holds.
  groupCompletedLabel: '',
};

/** Mirrors `Board.groupCompletedLabel`'s maxlength, which the server clamps to. */
const MAX_COMPLETED_LABEL = 22;

const BoardFormModal = ({
  isOpen,
  onClose,
  onSubmit,
  initialValues,
  mode = 'create',
  canChangeVisibility = true,
  /** The workspace's boards, for the "copy an existing board" option. */
  existingBoards = [],
}) => {
  const [values, setValues] = useState(DEFAULTS);
  // EDIT ONLY. The logo saves the moment it is picked — it is a file upload, not
  // a form field, and holding it until "Save" would mean a Cancel had to undo
  // an upload. Read from the store (not `initialValues`, a snapshot taken when
  // the dialog opened) so the preview follows the upload.
  const editingId = mode === 'edit' ? initialValues?._id : null;
  const liveLogo = useBoardStore(
    (st) => (editingId ? st.boards.find((b) => b._id === editingId)?.logo : '') || ''
  );
  const setBoardLogo = useBoardStore((st) => st.setBoardLogo);
  // EDIT ONLY. The board as the store holds it NOW, for the currency control:
  // its Change menu relabels through the store, and a snapshot taken when the
  // dialog opened would keep saying the old unit after the change landed.
  const liveBoard = useBoardStore(
    (st) => (editingId ? st.boards.find((b) => b._id === editingId) : null) || null
  );
  // What a new board's money starts in when nobody picks. The same two copies
  // `useMoney` reads, so the default shown here is the one the server applies.
  // The fetched copy counts only once it belongs to the workspace in view:
  // creating or joining a workspace swaps `currentOrg` without clearing it, and
  // until the new one lands it still holds the PREVIOUS workspace's unit.
  const workspaceCurrency = useOrgStore(
    (st) =>
      (st.currencyLoadedFor && st.currencyLoadedFor === st.currentOrg?._id
        ? st.currency?.baseCurrency
        : null) ||
      st.currentOrg?.baseCurrency ||
      null
  );
  // CREATE ONLY: the code the submit will send, or '' for "none — follow the
  // workspace". The select's value is exactly this, and '' is always one of
  // its options (the first), so the picker never falls back to a placeholder
  // or to the first code in the list while the payload sends something else.
  //
  // '' is NOT resolved to the workspace's code before sending. A board created
  // with an explicit code is pinned to it and stops following, so copying the
  // workspace's code in would quietly turn every new board into an override
  // that the next workspace change leaves behind.
  const currencyToSend = currencyByCode(values.currency)?.code || '';
  const workspaceCode = currencyByCode(workspaceCurrency)?.code || null;
  const currencyChoices = [
    {
      value: '',
      label: workspaceCode ? `Workspace currency (${workspaceCode})` : 'Workspace currency',
    },
    ...currencyOptions(),
  ];

  // CREATE ONLY. There is no board to upload against yet, so the picked file is
  // held here and shown from a local object URL; the caller uploads it once the
  // board exists (`logoFile` in the submit payload).
  //
  // The object URL is revoked when it is REPLACED, not from an effect cleanup:
  // StrictMode's mount/unmount/mount would revoke it and leave a broken preview.
  const [pending, setPending] = useState({ file: null, url: '' });
  const pendingLogo = pending.file;
  const pendingLogoUrl = pending.url;
  const setPendingLogo = (file) =>
    setPending((prev) => {
      if (prev.url) URL.revokeObjectURL(prev.url);
      return { file, url: file ? URL.createObjectURL(file) : '' };
    });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [convertPreview, setConvertPreview] = useState(null);
  const [convertError, setConvertError] = useState(null);

  // Reset / hydrate form whenever the modal opens or initialValues change
  useEffect(() => {
    if (!isOpen) return;
    setValues({
      // Spread the defaults first: the client fields below are only rendered
      // once Client Portal is picked, so leaving them out here would leave them
      // undefined and any `values.clientName.trim()` would throw the moment the
      // type was selected.
      ...DEFAULTS,
      name: initialValues?.name || '',
      visibility: initialValues?.visibility || 'private',
      description: initialValues?.description || '',
      boardType: initialValues?.boardType || 'standard',
      groupCompletedLabel: initialValues?.groupCompletedLabel || '',
    });
    setError(null);
    setSubmitting(false);
    setPendingLogo(null);
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
        // Edit only — the field is not rendered on create, so this is '' there
        // and the caller's "only when changed" test never fires.
        groupCompletedLabel: values.groupCompletedLabel.trim(),
        // Create only. The server refuses an unknown key, and 'blank' is the
        // no-op that reproduces the old behaviour exactly.
        template: mode === 'create' ? values.template : undefined,
        // Create only, and only when the question was actually on screen AND
        // a specific currency was picked — that is an override the board
        // keeps. "Workspace currency" (the default), a template with no money
        // columns, or a copy of a board (which keeps its source's currencies)
        // sends nothing, and the board follows the workspace. Undefined rather
        // than null so a caller that spreads this payload does not post an
        // explicit "no currency".
        currency:
          mode === 'create' && values.templateHasMoney
            ? currencyToSend || undefined
            : undefined,
        // Create only: uploaded by the caller after the board is created.
        logoFile: mode === 'create' ? pendingLogo : undefined,
        // Only meaningful when the type is actually changing; the caller uses it
        // to decide whether to run a conversion alongside the plain update.
        typeChanged: typeChanging,
        // A tracker board must know whose calendar defines its months. Sending
        // the browser's resolved zone is exactly what TrackersModal already does
        // for a tracker, and for the same reason: a board silently on UTC while
        // the team is on IST files every month-boundary task in the wrong month.
        monthTimezone: isTracker ? browserTimezone : undefined,
        // A LABEL, and nothing else. Creating a client board no longer mints a
        // portal link or invites anybody — both happen when the first SERVICE
        // is added, because a portal with no services on it is an empty page
        // and a link to one is worse than no link at all.
        ...(mode === 'create' && isClient
          ? { clientName: values.clientName.trim() }
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
      // Wide on CREATE, because the template grid is three across and a 480px
      // dialog turns that into a single tall column — which is the layout the
      // design exists to avoid. Edit has no template step and keeps the
      // ordinary width.
      maxWidth={mode === 'create' ? 880 : 480}
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

        {mode === 'create' && (
          <LogoUploader
            label="Board logo (optional)"
            hint="Shown on the board card and beside the board name. PNG, JPG, SVG or WEBP · up to 2MB."
            size={60}
            value={pendingLogoUrl}
            name={values.name}
            onUpload={(file) => setPendingLogo(file)}
            onRemove={() => setPendingLogo(null)}
          />
        )}

        {editingId && (
          <LogoUploader
            label="Board logo"
            hint="Shown on the board card and beside the board name. PNG, JPG, SVG or WEBP · up to 2MB."
            size={60}
            value={liveLogo}
            name={values.name || initialValues?.name}
            onUpload={(file) => setBoardLogo(editingId, file)}
            onRemove={() => setBoardLogo(editingId, null)}
          />
        )}

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
                A private board that IS one client. Each group on it is a service
                you deliver, and adding the first one creates the client&rsquo;s
                portal link and sends their invitation.
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
            board IS one company, and its groups become that company's SERVICES
            (SEO, Ads, Web Development).

            THERE IS NO EMAIL FIELD HERE ANY MORE. It used to invite the first
            contact the moment the board existed, which meant a client opened
            their portal on "Your portal is being set up" — nothing to see, no
            request to raise. Adding the first service is what creates the link
            and sends the invitation now. */}
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
            <p
              className="font-body"
              style={{
                fontSize: 12,
                lineHeight: 1.55,
                color: 'var(--color-text-muted)',
                margin: 0,
              }}
            >
              Next you&rsquo;ll add a service &mdash; SEO, Ads, Web Development.
              That&rsquo;s when the client&rsquo;s portal link is created and
              their invitation goes out, so they arrive to something worth
              looking at.
            </p>
          </>
        )}

        {/* Template — CREATE ONLY. A template seeds content and then has no
            further existence: nothing stores which one a board came from, so
            offering it on edit would be offering to re-seed a board that
            already has work on it. Placed after the type and before the
            description because it is a decision about the board's SHAPE, and
            the description is a note about it. */}
        {mode === 'create' && (
          <div>
            <p
              className="font-body mb-2"
              style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}
            >
              Start from
            </p>
            <TemplatePicker
              value={values.template}
              onChange={(key, meta) =>
                setValues((v) => ({ ...v, template: key, templateHasMoney: !!meta?.money }))}
              boards={existingBoards}
            />
          </div>
        )}

        {/* The unit this board's money is in — CREATE, money templates only.

            Asked here because the alternative was never asking: every money
            column used to be born in rupees, and a workspace billing in CAD
            found out from a "₹" on its first invoice. The default FOLLOWS the
            workspace's currency (and keeps following it when that changes), so
            the common case is no decision at all; the select is for the agency
            whose one client pays in another. */}
        {mode === 'create' && values.templateHasMoney && (
          <div>
            <div style={{ maxWidth: 320 }}>
              <SelectField
                label="Currency"
                value={currencyToSend}
                onChange={(e) => setValues((v) => ({ ...v, currency: e.target.value }))}
                options={currencyChoices}
              />
            </div>
            <p
              className="font-body mt-2"
              style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}
            >
              {/* The workspace's own code picked from the catalog is still
                  following: the server pins only a code DIFFERENT from the
                  workspace's at creation (planNewBoardCurrency). */}
              {currencyToSend && currencyToSend !== workspaceCode
                ? `Amounts on this board are entered in ${currencyToSend}, and it stays ${currencyToSend} if the workspace currency changes. You can change it later from the board's settings.`
                : `Amounts on this board are entered in the workspace currency${
                  workspaceCode ? ` (${workspaceCode})` : ''
                }, and follow it if the workspace currency changes — relabelled, never converted.`}
            </p>
          </div>
        )}

        {/* The board's currency — EDIT. So a board's unit can be changed from
            its own settings on any device, not only from a column header menu
            in Table view on a desktop. The control relabels and says so in its
            confirm; `column.manage` is the same gate the server enforces. */}
        {mode === 'edit' && liveBoard && (
          <div>
            <p
              className="block mb-2 font-body font-medium text-xs uppercase tracking-wide"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              Currency
            </p>
            <BoardCurrencyControl
              board={liveBoard}
              canManage={(liveBoard.permissions?.capabilities || []).includes('column.manage')}
            />
            <p
              className="font-body mt-2"
              style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}
            >
              &ldquo;Workspace currency&rdquo; keeps this board in step with Settings &rarr; Currency;
              any other choice gives it its own. Either way, changing it relabels every money
              column on this board. Amounts already entered are not converted.
            </p>
          </div>
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

        {/* What a FINISHED group says instead of its status bar. Edit only:
            on create there are no groups yet, so there is nothing to judge the
            wording against.

            Typed, never derived. "{GROUP} COMPLETED" would read as nonsense on
            a Backlog or a Templates group, which is exactly why the board says
            one thing in its own words instead. */}
        {mode === 'edit' && (
          <div>
            <Input
              label="When a group is finished (optional)"
              placeholder="e.g. ONBOARDING COMPLETED"
              maxLength={MAX_COMPLETED_LABEL}
              value={values.groupCompletedLabel}
              onChange={(e) =>
                setValues((v) => ({ ...v, groupCompletedLabel: e.target.value }))
              }
              helperText="Replaces the status bar once every task in a group is done. Leave empty to keep the bar."
            />
            {/* The real component at the real slot width, so any truncation is
                visible while you type rather than discovered on the board. */}
            {values.groupCompletedLabel.trim() && (
              <div className="mt-2 flex items-center gap-2">
                <div
                  className="flex items-center"
                  // The board header's slot width exactly, so what truncates
                  // here is what truncates there.
                  style={{ width: 184 }}
                >
                  <GroupCompletedLabel
                    label={values.groupCompletedLabel.trim()}
                  />
                </div>
                <span
                  className="font-body"
                  style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                >
                  {values.groupCompletedLabel.length}/{MAX_COMPLETED_LABEL}
                </span>
              </div>
            )}
          </div>
        )}

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

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  AtSign,
  Paperclip,
  Smile,
  Send,
  CornerDownLeft,
  X,
  Pencil,
  Trash2,
} from 'lucide-react';
import RichEditor from './RichEditor';
import * as updateService from '../../services/updateService';
import useToastStore from '../../store/toastStore';
import useNotificationStore from '../../store/notificationStore';
import useOrgStore from '../../store/orgStore';
import {
  clearDraft,
  loadDraft,
  pruneStaleDrafts,
  replyToDraft,
  saveDraft,
} from '../../utils/updateDrafts';
import { replyPreview } from '../../utils/updatePreview';

const COMMON_EMOJIS = ['👍', '🎉', '🙌', '🔥', '❤️', '✅', '🚀', '😄', '👀', '💡', '🤔', '😅'];

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — matches server limit

/** How long typing pauses before the draft is written to storage. */
const DRAFT_DEBOUNCE_MS = 400;

const ToolbarIconButton = ({ children, onClick, title }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    className="inline-flex items-center justify-center rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      width: 28,
      height: 28,
      background: 'transparent',
      border: 'none',
      color: 'var(--color-text-secondary)',
      cursor: 'pointer',
    }}
  >
    {children}
  </button>
);

/**
 * UpdateComposer — the write half of an Updates thread.
 *
 * Split out of UpdatesTab for one reason: everything in here belongs to ONE
 * thread, and a thread is task + audience. The parent mounts this under a `key`
 * of exactly that pair, so switching task — or switching between the team and
 * client tabs — gives a fresh composer instead of carrying the previous thread's
 * half-typed message across.
 *
 * Whatever has been typed but not posted is kept as a draft (see
 * utils/updateDrafts.js): saved as you type, restored on the way back in, and
 * dropped the moment the update is actually posted. A draft is never sent —
 * nothing leaves the browser until Send is pressed, which is the whole point on
 * a client thread, where posting is what emails the client.
 *
 * Props:
 *   taskId, visibility, isClientThread — the thread being written to
 *   draftKey — storage key from draftKeyFor(); null disables drafting
 *   onPosted(update) — the created update, for the parent to prepend to the feed
 *
 * Ref: { startReply(update), focus() }
 */
const UpdateComposer = forwardRef(
  (
    {
      taskId,
      visibility,
      isClientThread,
      draftKey,
      onPosted,
      // Chat reuses this whole composer — editor, drafts, attachments,
      // mentions, reply strip — by swapping ONLY where the payload goes.
      // When set, `submitMessage` receives the assembled payload instead of
      // updateService.addUpdate, and `uploadFile` receives each File instead
      // of updateService.uploadAttachment. Task callers pass neither.
      submitMessage = null,
      uploadFile = null,
      placeholder = null,
      // Chat again: the button says "Send" there, and the Task/Goal share
      // chips render inside the action row (mock: "@ 📎 Task Goal … Send").
      submitLabel = null,
      actionsExtra = null,
      // Chat: the page provides the bordered container, so the form drops its
      // own outer padding down to a snug fit.
      compact = false,
    },
    ref
  ) => {
    const toast = useToastStore.getState();
    const refreshNotifications = useNotificationStore((s) => s.fetchNotifications);
    const currentOrgId = useOrgStore((s) => s.currentOrg?._id);

    // Read the stored draft once, at mount, and seed the composer from it. A
    // lazy initialiser rather than an effect because TipTap only reads its
    // `content` when it initialises — restoring later would be too late.
    const [initialDraft] = useState(() => {
      pruneStaleDrafts();
      return loadDraft(draftKey);
    });

    const [bodyJson, setBodyJson] = useState(() => initialDraft?.body || null);
    const [bodyText, setBodyText] = useState(() => initialDraft?.bodyText || '');
    const [bodyMentions, setBodyMentions] = useState(() => initialDraft?.mentions || []);
    const [bodyEmpty, setBodyEmpty] = useState(() => initialDraft?.isEmpty !== false);
    const [attachments, setAttachments] = useState(() => initialDraft?.attachments || []);
    const [replyingTo, setReplyingTo] = useState(() => initialDraft?.replyTo || null);
    const [draftSavedAt, setDraftSavedAt] = useState(() => initialDraft?.savedAt || null);
    const [submitting, setSubmitting] = useState(false);
    const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
    const [error, setError] = useState('');

    const editorRef = useRef(null);
    const fileInputRef = useRef(null);

    // Latest composer contents, kept in a ref so the draft can still be written
    // from an unmount cleanup or a beforeunload handler, where state is already
    // out of reach.
    const snapshotRef = useRef(null);
    useEffect(() => {
      snapshotRef.current = {
        body: bodyJson,
        bodyText,
        mentions: bodyMentions,
        isEmpty: bodyEmpty,
        attachments,
        replyTo: replyingTo ? replyToDraft(replyingTo) : null,
      };
    });

    const persistDraft = useCallback(() => {
      if (!draftKey) return;
      setDraftSavedAt(saveDraft(draftKey, snapshotRef.current));
    }, [draftKey]);

    // Keep the write off the keystroke path — a pause in typing is soon enough,
    // and the flushes below cover the moments a debounce would otherwise lose.
    useEffect(() => {
      if (!draftKey) return undefined;
      const timer = setTimeout(persistDraft, DRAFT_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }, [draftKey, persistDraft, bodyJson, bodyText, bodyEmpty, attachments, replyingTo]);

    // Closing the tab, backgrounding it, and unmounting (task switch, panel
    // close) all skip the pending debounce, so each flushes the draft outright.
    const persistRef = useRef(persistDraft);
    persistRef.current = persistDraft;
    useEffect(() => {
      const flush = () => persistRef.current?.();
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') flush();
      };
      window.addEventListener('beforeunload', flush);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        window.removeEventListener('beforeunload', flush);
        document.removeEventListener('visibilitychange', onVisibility);
        flush();
      };
    }, []);

    const handleEditorChange = useCallback(({ json, text, mentions, isEmpty }) => {
      setBodyJson(json);
      setBodyText(text);
      setBodyMentions(mentions);
      setBodyEmpty(isEmpty);
    }, []);

    const resetComposer = useCallback(() => {
      editorRef.current?.commands?.clearContent?.();
      setBodyJson(null);
      setBodyText('');
      setBodyMentions([]);
      setBodyEmpty(true);
      setAttachments([]);
      setReplyingTo(null);
      // Clear the snapshot too: the unmount flush reads the ref, not state, and
      // would otherwise write the just-posted message straight back as a draft.
      snapshotRef.current = null;
      clearDraft(draftKey);
      setDraftSavedAt(null);
    }, [draftKey]);

    const handleSubmit = useCallback(async () => {
      if (!taskId && !submitMessage) return;
      const hasContent = !bodyEmpty || attachments.length > 0;
      if (!hasContent || submitting) return;
      setSubmitting(true);
      setError('');
      try {
        const mentionIds = bodyMentions.map((m) => m._id);
        const payload = {
          body: bodyJson,
          bodyText,
          mentions: mentionIds,
          attachments,
          replyTo: replyingTo?._id || null,
          visibility,
        };
        const created = submitMessage
          ? await submitMessage(payload)
          : await updateService.addUpdate(taskId, payload);
        onPosted?.(created);
        resetComposer();
        refreshNotifications(currentOrgId || undefined);
      } catch (err) {
        console.error('Failed to post update:', err);
        // The draft deliberately survives a failed post — that is precisely the
        // moment the typed message must not disappear.
        setError(
          err?.response?.data?.error ||
            'Failed to post update. Please try again.'
        );
      } finally {
        setSubmitting(false);
      }
    }, [
      taskId,
      bodyEmpty,
      bodyJson,
      bodyText,
      bodyMentions,
      attachments,
      submitting,
      replyingTo,
      refreshNotifications,
      currentOrgId,
      visibility,
      onPosted,
      resetComposer,
      submitMessage,
    ]);

    const handleDiscardDraft = useCallback(() => {
      const hasTyped = !bodyEmpty || attachments.length > 0;
      if (hasTyped && !window.confirm('Discard this draft? It hasn’t been sent.')) return;
      resetComposer();
      editorRef.current?.commands?.focus?.();
    }, [bodyEmpty, attachments.length, resetComposer]);

    const handleFilesSelected = useCallback(
      async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length || (!taskId && !uploadFile)) return;
        for (const f of files) {
          if (f.size > MAX_FILE_SIZE) {
            toast.error(`${f.name} is too big. Please attach a file under 25MB.`);
            continue;
          }
          try {
            const attachment = uploadFile
              ? await uploadFile(f)
              : await updateService.uploadAttachment(taskId, f);
            setAttachments((prev) => [...prev, attachment]);
          } catch (err) {
            console.error('Upload failed:', err);
            toast.error(
              err?.response?.data?.error || `Couldn't attach ${f.name}. Please try again.`
            );
          }
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
      },
      [taskId, toast, uploadFile]
    );

    const insertEmoji = useCallback((emoji) => {
      const editor = editorRef.current;
      if (editor) editor.chain().focus().insertContent(emoji).run();
      setEmojiPickerOpen(false);
    }, []);

    const focusMention = useCallback(() => {
      const editor = editorRef.current;
      if (editor) editor.chain().focus().insertContent('@').run();
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        startReply: (update) => {
          setReplyingTo(update);
          // Bring the composer into focus so the reply can be typed immediately.
          editorRef.current?.commands?.focus?.();
        },
        focus: () => editorRef.current?.commands?.focus?.(),
      }),
      []
    );

    const hasDraft = !!draftSavedAt && (!bodyEmpty || attachments.length > 0);

    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        style={{
          padding: compact ? '4px 10px 8px 10px' : '8px 16px 16px 16px',
          background: compact ? 'transparent' : '#FFFFFF',
          borderTop: '1px solid transparent',
        }}
      >
        {error ? (
          <p
            className="font-body"
            role="alert"
            style={{
              fontSize: 12,
              color: 'var(--color-status-stuck)',
              marginBottom: 6,
            }}
          >
            {error}
          </p>
        ) : null}

        {/* Draft marker. The one thing it has to say is that this is still
            unsent — on a client thread the difference between a draft and a
            post is whether the client has been emailed. */}
        {hasDraft && (
          <div
            className="flex items-center gap-2 font-body"
            style={{
              fontSize: 11.5,
              color: 'var(--color-text-muted)',
              marginBottom: 6,
            }}
          >
            <Pencil size={11} style={{ flexShrink: 0 }} aria-hidden="true" />
            <span>
              Draft saved on this device &mdash; <strong>not sent yet</strong>.
            </span>
            <button
              type="button"
              onClick={handleDiscardDraft}
              className="ml-auto inline-flex items-center gap-1 transition-colors hover:text-[color:var(--color-status-stuck)]"
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                fontSize: 11.5,
                fontWeight: 600,
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              <Trash2 size={11} aria-hidden="true" />
              Discard draft
            </button>
          </div>
        )}

        {/* Replying-to banner */}
        {replyingTo && (
          <div
            className="flex items-center gap-2 font-body"
            style={{
              fontSize: 12,
              color: 'var(--color-text-secondary)',
              background: 'var(--color-bg-subtle, #F3F4F6)',
              borderRadius: 'var(--radius-md)',
              padding: '5px 10px',
              marginBottom: 8,
            }}
          >
            <CornerDownLeft size={12} style={{ color: 'var(--color-accent)', flexShrink: 0 }} aria-hidden="true" />
            <span
              className="min-w-0 flex items-center gap-1"
              style={{ overflow: 'hidden' }}
            >
              <span style={{ flexShrink: 0 }}>
                Replying to{' '}
                <strong style={{ color: 'var(--color-text-primary)' }}>
                  {replyingTo.author?.name || 'Unknown'}
                </strong>
              </span>
              {(() => {
                const preview = replyPreview(replyingTo);
                if (!preview.label) return null;
                return (
                  <>
                    <span style={{ color: 'var(--color-border-strong)', flexShrink: 0 }}>|</span>
                    {preview.kind === 'file' ? (
                      <Paperclip size={11} style={{ flexShrink: 0 }} aria-hidden="true" />
                    ) : null}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {preview.label}
                    </span>
                  </>
                );
              })()}
            </span>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              aria-label="Cancel reply"
              className="ml-auto flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-border)]"
              style={{ width: 18, height: 18, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
            >
              <X size={11} style={{ color: 'var(--color-text-muted)' }} aria-hidden="true" />
            </button>
          </div>
        )}

        <RichEditor
          placeholder={
            placeholder ||
            (isClientThread
              ? 'Write a message to the client…'
              : 'Write an update and mention others with @')
          }
          onChange={handleEditorChange}
          editorRef={editorRef}
          initialContent={initialDraft?.body || ''}
        />

        {/* Attachment chips (pending submission) */}
        {attachments.length > 0 && (
          <ul
            className="flex flex-wrap gap-2"
            style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}
          >
            {attachments.map((a, i) => (
              <li
                key={`${a.url}-${i}`}
                className="inline-flex items-center gap-1 font-body"
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-secondary)',
                  background: 'var(--color-bg-subtle, #F3F4F6)',
                  borderRadius: 'var(--radius-md)',
                  padding: '3px 6px 3px 10px',
                }}
              >
                <Paperclip size={11} aria-hidden="true" />
                <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.name || 'file'}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, idx) => idx !== i))
                  }
                  style={{
                    width: 16,
                    height: 16,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--color-text-muted)',
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Inline composer toolbar + send */}
        <div className="mt-2 flex items-center gap-2">
          <ToolbarIconButton onClick={focusMention} title="Mention someone">
            <AtSign size={14} aria-hidden="true" />
          </ToolbarIconButton>
          <ToolbarIconButton
            onClick={() => fileInputRef.current?.click()}
            title="Attach a file"
          >
            <Paperclip size={14} aria-hidden="true" />
          </ToolbarIconButton>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFilesSelected}
            style={{ display: 'none' }}
          />

          <div style={{ position: 'relative' }}>
            <ToolbarIconButton
              onClick={() => setEmojiPickerOpen((v) => !v)}
              title="Insert emoji"
            >
              <Smile size={14} aria-hidden="true" />
            </ToolbarIconButton>
            {emojiPickerOpen && (
              <div
                role="menu"
                onMouseLeave={() => setEmojiPickerOpen(false)}
                style={{
                  position: 'absolute',
                  bottom: '110%',
                  left: 0,
                  background: '#FFFFFF',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-md)',
                  padding: 4,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(6, 1fr)',
                  gap: 2,
                  zIndex: 120,
                }}
              >
                {COMMON_EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => insertEmoji(e)}
                    style={{
                      width: 28,
                      height: 28,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      fontSize: 16,
                      borderRadius: 4,
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>

          {actionsExtra}

          <button
            type="submit"
            disabled={(bodyEmpty && attachments.length === 0) || submitting}
            className="ml-auto inline-flex items-center justify-center gap-2 font-body whitespace-nowrap transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              height: 32,
              padding: '0 14px',
              background: 'var(--color-accent)',
              color: '#FFFFFF',
              fontWeight: 600,
              fontSize: 13,
              border: 'none',
              borderRadius: 'var(--radius-md)',
              cursor:
                !bodyEmpty || attachments.length > 0 ? 'pointer' : 'not-allowed',
            }}
          >
            <Send size={13} aria-hidden="true" />
            {submitting
              ? submitLabel
                ? 'Sending…'
                : isClientThread
                  ? 'Sending…'
                  : 'Posting…'
              : submitLabel ||
                (isClientThread ? 'Send to client' : 'Update')}
          </button>
        </div>
      </form>
    );
  }
);
UpdateComposer.displayName = 'UpdateComposer';

export default UpdateComposer;

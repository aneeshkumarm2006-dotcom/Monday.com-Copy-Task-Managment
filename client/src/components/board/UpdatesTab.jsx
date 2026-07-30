import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AtSign,
  Paperclip,
  Smile,
  Send,
  Mail,
  MessageSquare,
  Trash2,
  Pencil,
  CornerDownLeft,
  X,
  Check,
  Lock,
  Users,
} from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Mention from '@tiptap/extension-mention';
import RichEditor from './RichEditor';
import AttachmentList from './AttachmentList';
import { DriveChip, driveChipify } from './driveChipExtension';
import * as updateService from '../../services/updateService';
import * as taskAttachmentService from '../../services/taskAttachmentService';
import useAuthStore from '../../store/authStore';
import useToastStore from '../../store/toastStore';
import useNotificationStore from '../../store/notificationStore';
import useOrgStore from '../../store/orgStore';
import { timeAgo, formatDate } from '../../utils/dateUtils';

const COMMON_EMOJIS = ['👍', '🎉', '🙌', '🔥', '❤️', '✅', '🚀', '😄', '👀', '💡', '🤔', '😅'];

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — matches server limit

// Request types + priorities a portal client can pick, labelled exactly as their
// own portal labels them so both sides are talking about the same thing.
const REQUEST_TYPES = {
  meta_ads: { label: 'Meta Ads', color: '#1877F2' },
  google_ads: { label: 'Google Ads', color: '#EA4335' },
  email_marketing: { label: 'Email Marketing', color: '#059669' },
  website_development: { label: 'Website Development', color: '#7C3AED' },
  bug: { label: 'Bug', color: '#DC2626' },
  feature: { label: 'Feature request', color: '#F59E0B' },
  requirement: { label: 'Requirement', color: '#2563EB' },
  question: { label: 'Question', color: '#0891B2' },
};
const REQUEST_PRIORITIES = {
  low: { label: 'Low', color: '#64748B' },
  medium: { label: 'Medium', color: '#2563EB' },
  high: { label: 'High', color: '#EA580C' },
  critical: { label: 'Urgent', color: '#DC2626' },
};

/**
 * Build a short preview of the update being replied to, so a reply shows *which*
 * message it answers — not just who wrote it. Prefers the text body; when the
 * parent has no text (e.g. a file-only update) it falls back to the attachment
 * name so attachment-only messages are still identifiable.
 *
 * Returns { kind: 'text' | 'file' | 'empty', label }.
 */
const replyPreview = (parent) => {
  const text = (parent?.bodyText || '').trim();
  if (text) {
    return {
      kind: 'text',
      label: text.length > 60 ? text.slice(0, 60).trimEnd() + '…' : text,
    };
  }
  const attachments = Array.isArray(parent?.attachments) ? parent.attachments : [];
  if (attachments.length > 0) {
    const extra = attachments.length > 1 ? ` +${attachments.length - 1}` : '';
    return { kind: 'file', label: (attachments[0].name || 'attachment') + extra };
  }
  return { kind: 'empty', label: '' };
};

/**
 * UpdatesTab — full Updates panel mounted inside CommentPanel.
 *
 * Renders ONE of the task's threads, chosen by `audience`. They are the same feed
 * and the same composer; only who can read it differs, so this component is
 * shared rather than duplicated:
 *
 *   'default' — a standard board. One thread, no client anywhere near it.
 *   'team'    — the team thread on a CLIENT board. Stored `visibility: 'internal'`,
 *               so the portal never renders it and the client is never emailed it.
 *   'client'  — the client-facing thread on a client board. Stored
 *               `visibility: 'shared'`; the client reads this in their portal and
 *               is emailed every post. The one thread that needs a warning.
 *
 * The stored field describes CLIENT VISIBILITY, not which tab you are looking at —
 * that is why 'team' maps to 'internal' and both other audiences map to 'shared'.
 * See models/Update.js.
 *
 * Props:
 *   task — populated task
 *   audience — 'default' (default) | 'team' | 'client'
 *   onCountChange(n) — bubbles the current count up so the tab badge stays in
 *                     sync as posts are added/removed
 */
const UpdatesTab = ({ task, audience = 'default', onCountChange }) => {
  const taskId = task?._id || null;
  const isClientThread = audience === 'client';
  // Only the dedicated team thread is stored internal; 'default' and 'client'
  // are both the shared thread.
  const visibility = audience === 'team' ? 'internal' : 'shared';
  const isInternal = visibility === 'internal';
  const currentUser = useAuthStore((s) => s.user);
  const toast = useToastStore.getState();
  const refreshNotifications = useNotificationStore((s) => s.fetchNotifications);
  const currentOrgId = useOrgStore((s) => s.currentOrg?._id);

  const [updates, setUpdates] = useState([]);
  const [loading, setLoading] = useState(false);
  // Distinct from `!loading`: true only after a fetch has actually returned, so
  // the count is never reported from the empty pre-load state.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  // The Client Portal request this thread is about — title, details and the
  // files the client attached when raising it. Only the client thread shows it;
  // everywhere else there is no request, and the fetch is skipped.
  const [clientRequest, setClientRequest] = useState(null);

  // Composer state
  const [bodyJson, setBodyJson] = useState(null);
  const [bodyText, setBodyText] = useState('');
  const [bodyMentions, setBodyMentions] = useState([]);
  const [bodyEmpty, setBodyEmpty] = useState(true);
  const [attachments, setAttachments] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [highlightId, setHighlightId] = useState(null);

  const highlightTimer = useRef(null);

  const editorRef = useRef(null);
  const fileInputRef = useRef(null);

  // Report the count only once the feed has actually come back. Before that
  // `updates` is an empty array because nothing has loaded, not because there is
  // nothing there, and forwarding that 0 puts a wrong number on the tab badge.
  useEffect(() => {
    if (!loaded) return;
    onCountChange?.(updates.length);
  }, [loaded, updates.length, onCountChange]);

  // Initial load + refetch when the task switches
  useEffect(() => {
    if (!taskId) {
      setUpdates([]);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError('');
    updateService
      .getUpdates(taskId, visibility)
      .then((list) => {
        if (!cancelled) {
          setUpdates(list || []);
          setLoaded(true);
        }
      })
      .catch((err) => {
        console.error('Failed to load updates:', err);
        if (!cancelled) {
          setError(
            err?.response?.data?.error ||
              'Failed to load updates. Please try again.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, visibility]);

  // The request that started the thread. Fetched separately because it isn't an
  // Update — a portal request arrives as the Task itself, which is exactly why
  // its screenshots were invisible here until now. Failure is silent: the thread
  // is still perfectly usable without the opening card.
  useEffect(() => {
    if (!taskId || !isClientThread) {
      setClientRequest(null);
      return;
    }
    let cancelled = false;
    taskAttachmentService
      .getClientRequest(taskId)
      .then((request) => {
        if (!cancelled) setClientRequest(request);
      })
      .catch((err) => {
        console.error('Failed to load the client request:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, isClientThread]);

  const handleEditorChange = useCallback(({ json, text, mentions, isEmpty }) => {
    setBodyJson(json);
    setBodyText(text);
    setBodyMentions(mentions);
    setBodyEmpty(isEmpty);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!taskId) return;
    const hasContent = !bodyEmpty || attachments.length > 0;
    if (!hasContent || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const mentionIds = bodyMentions.map((m) => m._id);
      const created = await updateService.addUpdate(taskId, {
        body: bodyJson,
        bodyText,
        mentions: mentionIds,
        attachments,
        replyTo: replyingTo?._id || null,
        visibility,
      });
      setUpdates((prev) => [created, ...prev]);
      // Reset composer
      editorRef.current?.commands?.clearContent?.();
      setBodyJson(null);
      setBodyText('');
      setBodyMentions([]);
      setBodyEmpty(true);
      setAttachments([]);
      setReplyingTo(null);
      refreshNotifications(currentOrgId || undefined);
    } catch (err) {
      console.error('Failed to post update:', err);
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
    visibility,
  ]);

  const handleDelete = useCallback(
    async (updateId) => {
      if (!taskId) return;
      const ok = window.confirm(
        isClientThread
          ? 'Delete this message? The client may already have seen or been emailed it.'
          : 'Delete this update?'
      );
      if (!ok) return;
      try {
        await updateService.deleteUpdate(taskId, updateId);
        setUpdates((prev) => prev.filter((u) => u._id !== updateId));
      } catch (err) {
        console.error('Failed to delete update:', err);
        toast.error(
          err?.response?.data?.error || 'Failed to delete update.'
        );
      }
    },
    [taskId, toast, isClientThread]
  );

  const handleEdit = useCallback(
    async (updateId, payload) => {
      if (!taskId) return null;
      try {
        const updated = await updateService.editUpdate(taskId, updateId, payload);
        setUpdates((prev) => prev.map((u) => (u._id === updateId ? updated : u)));
        return updated;
      } catch (err) {
        console.error('Failed to edit update:', err);
        toast.error(
          err?.response?.data?.error || 'Failed to edit update.'
        );
        throw err;
      }
    },
    [taskId, toast]
  );

  const handleReply = useCallback((update) => {
    setReplyingTo(update);
    // Bring the composer into focus so the reply can be typed immediately.
    editorRef.current?.commands?.focus?.();
  }, []);

  // Jump from a "Replying to" reference back to the original update, scrolling
  // it into view and briefly highlighting it so you can see *which* message a
  // reply answers. No-op if the parent has since been deleted from the list.
  const handleJumpToParent = useCallback((parentId) => {
    if (!parentId) return;
    const el = document.getElementById(`update-${parentId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightId(parentId);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 1600);
  }, []);

  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    []
  );

  // Toggle the current user's read marker on an update they're mentioned in.
  const handleToggleRead = useCallback(
    async (updateId, read) => {
      if (!taskId) return;
      try {
        const updated = await updateService.setMentionRead(taskId, updateId, read);
        setUpdates((prev) => prev.map((u) => (u._id === updateId ? updated : u)));
      } catch (err) {
        console.error('Failed to update read state:', err);
        toast.error(
          err?.response?.data?.error || 'Failed to update read state.'
        );
      }
    },
    [taskId, toast]
  );

  const handleFilesSelected = useCallback(
    async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length || !taskId) return;
      for (const f of files) {
        if (f.size > MAX_FILE_SIZE) {
          toast.error(`${f.name} is too big. Please attach a file under 25MB.`);
          continue;
        }
        try {
          const attachment = await updateService.uploadAttachment(taskId, f);
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
    [taskId, toast]
  );

  // "Update via email" uses Gmail plus-addressing: VITE_INBOUND_EMAIL_ADDRESS is
  // the inbox base (e.g. automations@davnoot.com) and each task gets a tagged
  // reply address `<local>+task-<id>@<domain>` that the inbound poller reads.
  // The internal thread has its own tag, `task-<id>-int`, which files the reply
  // team-only — see server/src/services/inboundEmail.js.
  // Empty env → the button is hidden (nothing to copy).
  const inboundAddress = import.meta.env.VITE_INBOUND_EMAIL_ADDRESS;
  const feedbackEmail = import.meta.env.VITE_FEEDBACK_EMAIL;
  const [emailInfoOpen, setEmailInfoOpen] = useState(false);

  const taskEmail = (() => {
    if (!taskId || !inboundAddress) return null;
    const [local, domain] = String(inboundAddress).split('@');
    if (!local || !domain) return null;
    return `${local}+task-${taskId}${isInternal ? '-int' : ''}@${domain}`;
  })();

  const handleCopyEmail = useCallback(async () => {
    if (!taskEmail) return;
    try {
      await navigator.clipboard.writeText(taskEmail);
      toast.success(
        isClientThread
          ? `Copied ${taskEmail} — email this address to reply to the client.`
          : `Copied ${taskEmail} — reply to this address to post an update.`
      );
    } catch {
      toast.info(taskEmail);
    }
  }, [taskEmail, toast, isClientThread]);

  const insertEmoji = useCallback((emoji) => {
    const editor = editorRef.current;
    if (editor) editor.chain().focus().insertContent(emoji).run();
    setEmojiPickerOpen(false);
  }, []);

  const focusMention = useCallback(() => {
    const editor = editorRef.current;
    if (editor) editor.chain().focus().insertContent('@').run();
  }, []);

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 0 }}>
      {/* Standing reminder of who can read this thread, because the risk is not
          symmetric: posting to the client thread is the irreversible mistake, so
          it gets the loud banner. The team thread gets a quiet reassurance — it
          has to be visible at the moment of typing, not remembered from whichever
          tab was clicked. */}
      {isClientThread && (
        <div
          className="flex items-start gap-2 font-body"
          style={{
            margin: '12px 24px 0 24px',
            padding: '8px 10px',
            borderRadius: 'var(--radius-md)',
            background: '#FEF3C7',
            border: '1px solid #FDE68A',
            color: '#92400E',
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          <Users size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <span>
            <strong>The client sees this thread.</strong> They read it in their
            portal and are emailed every message. For team-only discussion, use
            the Updates tab.
          </span>
        </div>
      )}
      {isInternal && (
        <p
          className="flex items-center gap-1.5 font-body"
          style={{
            margin: '12px 24px 0 24px',
            fontSize: 11.5,
            color: 'var(--color-text-muted)',
          }}
        >
          <Lock size={11} style={{ flexShrink: 0 }} aria-hidden="true" />
          Team only &mdash; the client can&rsquo;t see this thread.
        </p>
      )}

      {/* Updates feed */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ padding: '12px 24px', minHeight: 0 }}
      >
        {loading ? (
          <p
            className="font-body text-center"
            style={{
              fontSize: 13,
              color: 'var(--color-text-muted)',
              padding: '24px 0',
            }}
          >
            {isClientThread ? 'Loading messages…' : 'Loading updates…'}
          </p>
        ) : (
          <>
            {updates.length === 0 && (
              <p
                className="font-body text-center"
                style={{
                  fontSize: 13,
                  color: 'var(--color-text-muted)',
                  padding: clientRequest ? '8px 0 16px' : '32px 0',
                }}
              >
                {isClientThread
                  ? 'No replies yet. Anything you post here goes to the client.'
                  : 'No updates yet. Post the first one.'}
              </p>
            )}

            {updates.length > 0 && (
              <ul
                className="flex flex-col"
                style={{ padding: 0, margin: 0, listStyle: 'none', gap: 12 }}
              >
                {updates.map((u) => (
                  <li key={u._id} id={`update-${u._id}`}>
                    <UpdateCard
                      update={u}
                      currentUserId={currentUser?._id}
                      highlighted={highlightId === u._id}
                      onDelete={() => handleDelete(u._id)}
                      onEdit={(payload) => handleEdit(u._id, payload)}
                      onReply={() => handleReply(u)}
                      onJumpToParent={handleJumpToParent}
                      onToggleMentionRead={(read) => handleToggleRead(u._id, read)}
                    />
                  </li>
                ))}
              </ul>
            )}

            {/* The request that started all this, pinned at the foot of the feed
                — the feed runs newest-first, so oldest-last puts it exactly where
                it belongs. */}
            {clientRequest && (
              <div style={{ marginTop: updates.length > 0 ? 12 : 0 }}>
                <ClientRequestCard request={clientRequest} />
              </div>
            )}
          </>
        )}
      </div>

      {/* Sub-toolbar action buttons (above composer) */}
      <div
        style={{
          borderTop: '1px solid var(--color-border)',
          padding: '8px 16px 0 16px',
          background: '#FFFFFF',
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          {taskEmail && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setEmailInfoOpen((v) => !v)}
                className="inline-flex items-center gap-1 font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: emailInfoOpen ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                  background: 'transparent',
                  border: `1px solid ${emailInfoOpen ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-md)',
                  padding: '4px 10px',
                  cursor: 'pointer',
                }}
                title={
                  isClientThread
                    ? 'Email a reply to the client on this task'
                    : 'Email an update to this task'
                }
              >
                <Mail size={12} aria-hidden="true" />
                {isClientThread ? 'Reply via email' : 'Update via email'}
              </button>
              {emailInfoOpen && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% + 6px)',
                    left: 0,
                    zIndex: 50,
                    width: 320,
                    maxWidth: '80vw',
                    background: 'var(--color-bg-surface, #fff)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-lg, 12px)',
                    boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.14))',
                    padding: 14,
                  }}
                >
                  <p style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
                    {isInternal ? (
                      <>
                        Email this address from your work email and it posts here
                        within ~1&ndash;2 min. Only teammates who can open this
                        board can post &mdash; the client cannot.
                      </>
                    ) : isClientThread ? (
                      <>
                        Email this address and it posts to the client thread within
                        ~1&ndash;2 min &mdash; <strong>the client will see it</strong>.
                        Their own replies arrive here the same way.
                      </>
                    ) : (
                      <>
                        Email this address from your team or client email and it posts to this thread within ~1&ndash;2 min.
                      </>
                    )}
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                    <code
                      style={{
                        flex: 1,
                        fontSize: 11.5,
                        background: 'var(--color-bg-subtle, #f3f4f6)',
                        borderRadius: 6,
                        padding: '6px 8px',
                        color: 'var(--color-text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {taskEmail}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopyEmail}
                      style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-accent)', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                    >
                      Copy
                    </button>
                  </div>
                  <a
                    href={`mailto:${taskEmail}?subject=${encodeURIComponent(
                      isClientThread ? 'Re: your request' : 'Update'
                    )}`}
                    onClick={() => setEmailInfoOpen(false)}
                    className="inline-flex items-center gap-1"
                    style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-accent)', textDecoration: 'none' }}
                  >
                    <Mail size={12} aria-hidden="true" /> Open in email app
                  </a>
                </div>
              )}
            </div>
          )}
          {feedbackEmail && !isClientThread && (
            <a
              href={`mailto:${feedbackEmail}?subject=Macan%20Updates%20Feedback`}
              className="inline-flex items-center gap-1 font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--color-text-secondary)',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                padding: '4px 10px',
                cursor: 'pointer',
                textDecoration: 'none',
              }}
            >
              <MessageSquare size={12} aria-hidden="true" />
              Give feedback
            </a>
          )}
        </div>
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        style={{
          padding: '8px 16px 16px 16px',
          background: '#FFFFFF',
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
            isClientThread
              ? 'Write a message to the client…'
              : 'Write an update and mention others with @'
          }
          onChange={handleEditorChange}
          editorRef={editorRef}
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
              ? isClientThread
                ? 'Sending…'
                : 'Posting…'
              : isClientThread
                ? 'Send to client'
                : 'Update'}
          </button>
        </div>
      </form>
    </div>
  );
};

/**
 * ClientRequestCard — the request as the client actually raised it, sitting at
 * the foot of the Client thread as its opening message.
 *
 * A portal request is a Task, not an Update, so none of it — not the details the
 * client typed, and not the screenshots they attached — was ever part of the
 * feed the team reads. The files were reachable only by remembering to click
 * into the Files tab, which meant that in practice nobody saw them. This card is
 * where they surface, and it carries the whole intake: reference, type, priority,
 * needed-by date, the description, and the attachments.
 *
 * Styled apart from the reply cards (tinted, left rule) so it reads as the thing
 * being discussed rather than as another message in the discussion.
 */
const ClientRequestCard = ({ request }) => {
  const type = REQUEST_TYPES[request.type];
  const priority = REQUEST_PRIORITIES[request.priority];
  const submitterName = request.submitter?.name || 'Client';
  const attachments = Array.isArray(request.attachments) ? request.attachments : [];

  return (
    <article
      aria-label="The client's original request"
      style={{
        background: 'var(--color-bg-subtle, #F9FAFB)',
        border: '1px solid var(--color-border)',
        borderLeft: '3px solid var(--color-accent)',
        borderRadius: 'var(--radius-md)',
        padding: 12,
      }}
    >
      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 8 }}>
        <span
          className="font-body"
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--color-text-muted)',
          }}
        >
          Original request
        </span>
        {request.ref && (
          <span
            className="font-body"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--color-accent)',
              background: 'var(--color-accent-light, #EFF6FF)',
              padding: '1px 6px',
              borderRadius: 'var(--radius-full)',
            }}
          >
            {request.ref}
          </span>
        )}
      </div>

      <header className="flex items-center gap-2" style={{ marginBottom: 8 }}>
        <Avatar user={{ name: submitterName }} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-body"
              style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}
            >
              {submitterName}
            </span>
            {request.submitter?.email && (
              <span
                className="font-body"
                style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                title={request.submitter.email}
              >
                {request.submitter.email}
              </span>
            )}
            <span
              className="font-body"
              title={formatDate(request.createdAt)}
              style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
            >
              {timeAgo(request.createdAt)}
            </span>
          </div>
        </div>
      </header>

      {/* The heading the client gave it — the task name can be renamed by the
          team later, so this is the request as it was submitted. */}
      <h4
        className="font-body"
        style={{
          fontSize: 14.5,
          fontWeight: 700,
          color: 'var(--color-text-primary)',
          margin: '0 0 6px 0',
          lineHeight: 1.35,
          wordBreak: 'break-word',
        }}
      >
        {request.name}
      </h4>

      {(type || priority || request.category || request.dueDate) && (
        <div className="flex items-center gap-1.5 flex-wrap" style={{ marginBottom: 8 }}>
          {type && <RequestChip label={type.label} color={type.color} />}
          {priority && (
            <RequestChip label={`${priority.label} priority`} color={priority.color} />
          )}
          {request.category && (
            <RequestChip label={request.category} color="var(--color-text-secondary)" />
          )}
          {request.dueDate && (
            <RequestChip
              label={`Needed by ${formatDate(request.dueDate)}`}
              color="var(--color-text-secondary)"
            />
          )}
        </div>
      )}

      {request.note ? (
        <p
          className="font-body"
          style={{
            fontSize: 13,
            lineHeight: 1.55,
            color: 'var(--color-text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            margin: 0,
          }}
        >
          {request.note}
        </p>
      ) : (
        <p
          className="font-body"
          style={{ fontSize: 12.5, color: 'var(--color-text-muted)', fontStyle: 'italic', margin: 0 }}
        >
          No further details were given.
        </p>
      )}

      {attachments.length > 0 && (
        <>
          <p
            className="flex items-center gap-1.5 font-body"
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              margin: '12px 0 0 0',
            }}
          >
            <Paperclip size={11} aria-hidden="true" />
            {attachments.length === 1
              ? '1 file attached to this request'
              : `${attachments.length} files attached to this request`}
          </p>
          <AttachmentList attachments={attachments} />
        </>
      )}
    </article>
  );
};

/** A small labelled pill for one facet of the request (type, priority, …). */
const RequestChip = ({ label, color }) => (
  <span
    className="font-body"
    style={{
      fontSize: 11,
      fontWeight: 600,
      color,
      border: `1px solid ${color}`,
      borderRadius: 'var(--radius-full)',
      padding: '1px 8px',
      whiteSpace: 'nowrap',
    }}
  >
    {label}
  </span>
);

/**
 * Single update card — author, timestamp, rich body, attachments, edit, delete.
 *
 * Author can toggle edit mode, which swaps the read-only body for a RichEditor
 * pre-loaded with the existing TipTap document. Attachments aren't editable
 * here — they were uploaded once and stay attached.
 */
const UpdateCard = ({ update, currentUserId, highlighted, onDelete, onEdit, onReply, onJumpToParent, onToggleMentionRead }) => {
  // Client Portal: an update can be authored by an external client (authorType
  // 'client', no `author` User) rather than a team member. Fall back to the
  // portalAuthor identity so the card renders their name instead of crashing on
  // a null author, and tag it so the team knows it came from the client.
  const isClientAuthor = update.authorType === 'client';
  const author = (isClientAuthor ? update.portalAuthor : update.author) || {};
  const isAuthor = author._id && currentUserId && author._id === currentUserId;
  // The "Mark as read" affordance belongs only to a user who was mentioned.
  const idOf = (u) => (u && typeof u === 'object' ? u._id : u);
  const isMentioned =
    !!currentUserId &&
    Array.isArray(update.mentions) &&
    update.mentions.some((m) => idOf(m) === currentUserId);
  const isRead =
    Array.isArray(update.mentionReads) &&
    update.mentionReads.some((u) => idOf(u) === currentUserId);
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBodyJson, setEditBodyJson] = useState(update.body || null);
  const [editBodyText, setEditBodyText] = useState(update.bodyText || '');
  const [editMentions, setEditMentions] = useState(
    Array.isArray(update.mentions)
      ? update.mentions.map((m) => ({ _id: m._id, name: m.name }))
      : []
  );
  const [editEmpty, setEditEmpty] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const editEditorRef = useRef(null);

  const handleEditorChange = useCallback(({ json, text, mentions, isEmpty }) => {
    setEditBodyJson(json);
    setEditBodyText(text);
    setEditMentions(mentions);
    setEditEmpty(isEmpty);
  }, []);

  const startEdit = () => {
    setEditBodyJson(update.body || null);
    setEditBodyText(update.bodyText || '');
    setEditMentions(
      Array.isArray(update.mentions)
        ? update.mentions.map((m) => ({ _id: m._id, name: m.name }))
        : []
    );
    setEditEmpty(false);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const saveEdit = async () => {
    const hasAttachments =
      Array.isArray(update.attachments) && update.attachments.length > 0;
    if (editEmpty && !hasAttachments) return;
    setSavingEdit(true);
    try {
      await onEdit?.({
        body: editBodyJson,
        bodyText: editBodyText,
        mentions: editMentions.map((m) => m._id),
        attachments: update.attachments || [],
      });
      setEditing(false);
    } catch {
      // toast surfaced by parent
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <article
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: highlighted
          ? 'var(--color-accent-light, rgba(37,99,235,0.1))'
          : 'var(--color-bg-surface, #FFFFFF)',
        border: `1px solid ${highlighted ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-md)',
        padding: 12,
        position: 'relative',
        transition: 'background 0.3s ease, border-color 0.3s ease',
      }}
    >
      {/* "Replying to" reference block — click to jump back to the original
          message so you can see exactly which one this reply answers. */}
      {update.replyTo && (() => {
        const preview = replyPreview(update.replyTo);
        const parentAuthor = update.replyTo.author?.name || 'Unknown';
        return (
          <button
            type="button"
            onClick={() => onJumpToParent?.(update.replyTo._id)}
            title="Go to the message this replies to"
            className="flex items-center gap-1 font-body transition-colors hover:bg-[color:var(--color-bg-subtle)]"
            style={{
              fontSize: 11,
              color: 'var(--color-text-muted)',
              marginBottom: 8,
              maxWidth: '100%',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm, 4px)',
              padding: '2px 4px',
              margin: '-2px -4px 6px -4px',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <CornerDownLeft size={11} style={{ color: 'var(--color-accent)', flexShrink: 0 }} aria-hidden="true" />
            <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
              {parentAuthor}
            </span>
            {preview.label ? (
              <>
                <span style={{ color: 'var(--color-border-strong)', flexShrink: 0 }}>|</span>
                {preview.kind === 'file' ? (
                  <Paperclip size={10} style={{ flexShrink: 0 }} aria-hidden="true" />
                ) : null}
                <span style={{ color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {preview.label}
                </span>
              </>
            ) : null}
          </button>
        );
      })()}
      <header className="flex items-center gap-2">
        <Avatar user={author} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-body"
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--color-text-primary)',
              }}
            >
              {author.name || (isClientAuthor ? 'Client' : 'Unknown')}
            </span>
            {isClientAuthor && (
              <span
                className="font-body"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--color-accent)',
                  background: 'var(--color-accent-light, #EFF6FF)',
                  padding: '1px 6px',
                  borderRadius: 'var(--radius-full)',
                }}
              >
                Client
              </span>
            )}
            <span
              className="font-body"
              title={formatDate(update.createdAt)}
              style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
            >
              {timeAgo(update.createdAt)}
            </span>
            {update.editedAt ? (
              <span
                className="font-body"
                title={`Edited ${formatDate(update.editedAt)}`}
                style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic' }}
              >
                (edited)
              </span>
            ) : null}
          </div>
        </div>
        {/* Mention read marker — only the mentioned user sees this */}
        {isMentioned && (
          <button
            type="button"
            onClick={() => onToggleMentionRead?.(!isRead)}
            aria-pressed={isRead}
            title={isRead ? 'Marked as read — click to undo' : 'Mark this mention as read'}
            className="inline-flex items-center gap-1 font-body transition-colors"
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: isRead ? 'var(--color-status-done)' : 'var(--color-accent)',
              background: 'transparent',
              border: `1px solid ${isRead ? 'var(--color-status-done)' : 'var(--color-border)'}`,
              borderRadius: 9999,
              cursor: 'pointer',
              padding: '1px 8px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <Check size={11} aria-hidden="true" />
            {isRead ? 'Read' : 'Mark as read'}
          </button>
        )}
        {hovered && !editing ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onReply}
              aria-label={`Reply to ${author.name || 'this update'}`}
              className="inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-bg-subtle)]"
              style={{
                width: 24,
                height: 24,
                background: 'transparent',
                border: 'none',
                color: 'var(--color-accent)',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <CornerDownLeft size={13} aria-hidden="true" />
            </button>
            {isAuthor ? (
              <>
                <button
                  type="button"
                  onClick={startEdit}
                  aria-label="Edit update"
                  className="inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-bg-subtle)]"
                  style={{
                    width: 24,
                    height: 24,
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--color-text-muted)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <Pencil size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label="Delete update"
                  className="inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-bg-subtle)]"
                  style={{
                    width: 24,
                    height: 24,
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--color-text-muted)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      <div style={{ marginTop: 8 }}>
        {editing ? (
          <>
            <RichEditor
              placeholder="Edit your update…"
              onChange={handleEditorChange}
              editorRef={editEditorRef}
              initialContent={update.body || (update.bodyText || '')}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelEdit}
                disabled={savingEdit}
                className="font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                style={{
                  height: 30,
                  padding: '0 12px',
                  background: 'transparent',
                  color: 'var(--color-text-secondary)',
                  fontWeight: 500,
                  fontSize: 13,
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  cursor: savingEdit ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={
                  savingEdit ||
                  (editEmpty &&
                    (!Array.isArray(update.attachments) ||
                      update.attachments.length === 0))
                }
                className="font-body transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent-hover"
                style={{
                  height: 30,
                  padding: '0 12px',
                  background: 'var(--color-accent)',
                  color: '#FFFFFF',
                  fontWeight: 600,
                  fontSize: 13,
                  border: 'none',
                  borderRadius: 'var(--radius-md)',
                  cursor: savingEdit ? 'not-allowed' : 'pointer',
                }}
              >
                {savingEdit ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        ) : (
          <ReadOnlyRichBody body={update.body} fallbackText={update.bodyText} />
        )}
      </div>

      {/* Files render as thumbnails, not filename chips — a client sending a
          screenshot is showing you something, and a bare "Screenshot.png" button
          buried the whole point of the message. */}
      <AttachmentList attachments={update.attachments} compact />
    </article>
  );
};

/**
 * Read-only renderer for a TipTap doc. Uses `useEditor` in editable:false
 * mode — that way mentions, task lists, and other custom nodes render with
 * the same plugins the composer uses, without pulling in @tiptap/html.
 */
export const ReadOnlyRichBody = ({ body, fallbackText }) => {
  // Google Drive/Docs links are swapped for icon+title chips at display time —
  // both stored updates (URL as plain text) and new ones render the same way.
  const content = driveChipify(
    body ||
      (fallbackText
        ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: fallbackText }] }] }
        : '')
  );

  const editor = useEditor(
    {
      editable: false,
      content,
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Mention.configure({
          HTMLAttributes: { class: 'macan-mention' },
          renderText: ({ node }) => `@${node.attrs.label || node.attrs.id}`,
        }),
        DriveChip,
      ],
    },
    [body, fallbackText]
  );

  if (!editor) return null;

  return (
    <div className="macan-rich-readonly">
      <EditorContent editor={editor} />
      <style>{`
        .macan-rich-readonly .ProseMirror {
          outline: none;
          font-size: 14px;
          line-height: 1.55;
          color: var(--color-text-primary);
        }
        .macan-rich-readonly .ProseMirror p {
          margin: 0 0 4px 0;
        }
        .macan-rich-readonly .ProseMirror p:last-child { margin-bottom: 0; }
        .macan-rich-readonly .ProseMirror h1 { font-size: 18px; font-weight: 700; margin: 4px 0; }
        .macan-rich-readonly .ProseMirror h2 { font-size: 16px; font-weight: 700; margin: 4px 0; }
        .macan-rich-readonly .ProseMirror h3 { font-size: 14px; font-weight: 700; margin: 4px 0; }
        .macan-rich-readonly .ProseMirror ul,
        .macan-rich-readonly .ProseMirror ol {
          padding-left: 20px;
          margin: 4px 0;
        }
        .macan-rich-readonly .ProseMirror ul[data-type="taskList"] {
          list-style: none;
          padding-left: 0;
        }
        .macan-rich-readonly .ProseMirror ul[data-type="taskList"] li {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          margin: 2px 0;
        }
        .macan-rich-readonly .ProseMirror ul[data-type="taskList"] li > label {
          flex-shrink: 0;
          margin-top: 2px;
        }
        .macan-rich-readonly .ProseMirror ul[data-type="taskList"] li > div {
          flex: 1;
        }
        .macan-rich-readonly .ProseMirror .macan-mention {
          color: var(--color-accent);
          background: var(--color-accent-light, rgba(37,99,235,0.1));
          padding: 1px 4px;
          border-radius: 4px;
          font-weight: 600;
        }
        .macan-rich-readonly .ProseMirror .drive-link-chip {
          margin: 3px 0;
          transition: background 120ms, border-color 120ms;
        }
        .macan-rich-readonly .ProseMirror .drive-link-chip:hover {
          background: var(--color-bg-subtle, #F3F4F6);
          border-color: var(--color-border-strong);
        }
      `}</style>
    </div>
  );
};

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

const Avatar = ({ user, size = 28 }) => {
  const [imgError, setImgError] = useState(false);
  const name = user?.name || '';
  const initial = name.charAt(0).toUpperCase() || '?';
  const hasPic = !!user?.profilePic && !imgError;
  const base = { width: size, height: size, borderRadius: '50%', flexShrink: 0 };
  if (hasPic) {
    return (
      <img
        src={user.profilePic}
        alt={name}
        style={{ ...base, objectFit: 'cover' }}
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <span
      aria-label={name}
      className="inline-flex items-center justify-center font-body font-semibold"
      style={{
        ...base,
        background: 'var(--color-accent-light)',
        color: 'var(--color-accent-text)',
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initial}
    </span>
  );
};

export default UpdatesTab;

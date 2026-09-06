import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2, Mail, ArrowLeft, PenSquare, Inbox, ChevronDown, Lock,
} from 'lucide-react';
import {
  getPortalThreads, getPortalMessages, createPortalThread,
  sendPortalMessage, markPortalThreadRead,
} from '../../services/portalService';
import PortalComposer from './PortalComposer';
import { PortalAvatar, PortalAttachments, PortalMessageBody } from './PortalChat';

/**
 * The client's mailbox. Gmail-SHAPED, over our own messages: nothing here is
 * sent to or received from an email server, and no address is exposed. It is a
 * subject-led reading surface for people who think in threads rather than in a
 * scrolling room — which is most clients most of the time.
 *
 * Same delivery contract as PortalChat: the poll is what makes it correct, SSE
 * only makes it feel instant.
 */
const MAIL_POLL = 20000;
const THREAD_POLL = 12000;

const relativeTime = (iso) => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const d = new Date(t);
  if (hours < 24 * 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }
  );
};

const formatStamp = (iso) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
};

/** Up to three names, then "+N" — a long CC list must not eat the subject. */
const participantLabel = (list) => {
  const names = (Array.isArray(list) ? list : [])
    .map((p) => (p?.name || '').trim())
    .filter(Boolean);
  if (!names.length) return 'The team';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
};

/**
 * Fold a freshly-fetched FIRST page of thread rows into the list on screen.
 *
 * The poll — and every SSE frame, and every "Back to messages" — re-reads only
 * the newest page. Replacing the list with it threw away every page "Load older
 * conversations" had fetched, which put older mail out of reach entirely. So the
 * page wins for the rows it contains (it is the authority on their order, their
 * unread flags and their reply counts) and the rows it does not contain are kept
 * behind it, in the order they were paged in.
 *
 * A row that has since moved up into the newest page is dropped from that tail
 * rather than appearing twice, which is what keying on `_id` buys.
 */
const mergeThreadRows = (prev, page) => {
  const fresh = Array.isArray(page) ? page : [];
  const ids = new Set(fresh.map((t) => String(t._id)));
  return [...fresh, ...(prev || []).filter((t) => !ids.has(String(t._id)))];
};

const mergeById = (prev, incoming) => {
  const byId = new Map();
  prev.forEach((m) => byId.set(m.id, m));
  (incoming || []).forEach((m) => byId.set(m.id, { ...byId.get(m.id), ...m }));
  return [...byId.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
};

/* ---- one message inside a thread ------------------------------------------ */
const MailMessage = ({ message, open, onToggle }) => {
  const snippet = (message.bodyText || '').replace(/\s+/g, ' ').trim();

  if (!open) {
    return (
      <button type="button" className="mcp-mail-msg mcp-mail-msg--collapsed" onClick={onToggle}>
        <PortalAvatar url={message.authorAvatar} name={message.authorName} />
        <span className="mcp-mail-msg-who">{message.mine ? 'You' : message.authorName}</span>
        <span className="mcp-mail-msg-peek">{snippet || 'Attachment'}</span>
        <span className="mcp-mail-msg-when">{relativeTime(message.createdAt)}</span>
      </button>
    );
  }

  return (
    <div className="mcp-mail-msg">
      <button type="button" className="mcp-mail-msg-head" onClick={onToggle}>
        <PortalAvatar url={message.authorAvatar} name={message.authorName} />
        <span className="mcp-mail-msg-who">{message.mine ? 'You' : message.authorName}</span>
        <span className="mcp-mail-msg-when">{formatStamp(message.createdAt)}</span>
      </button>
      <div className={`mcp-mail-msg-body ${message.body ? 'mcp-bubble--rich' : ''}`}>
        <PortalMessageBody body={message.body} bodyText={message.bodyText} />
        <PortalAttachments items={message.attachments} />
      </div>
    </div>
  );
};

/* ========================================================================== */
const PortalMail = ({ channel, onUnreadChange, liveMessage }) => {
  const channelId = channel?.id;

  const [view, setView] = useState('list'); // list | thread | compose
  const [threads, setThreads] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [canPost, setCanPost] = useState(true);

  const [threadId, setThreadId] = useState('');
  const [thread, setThread] = useState({ parent: null, replies: [] });
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');
  // Which messages the CLIENT has opened or closed, keyed by id. An id that is
  // absent is left to the thread's own habit — see `openAt` in the thread view.
  const [openOverrides, setOpenOverrides] = useState(() => new Map());

  // Local mirror of this channel's unread count. Opening ONE thread decrements
  // it — it must never zero the channel, or every other unread thread silently
  // loses its dot without anyone having read it.
  const unreadRef = useRef(channel?.unread || 0);
  useEffect(() => { unreadRef.current = channel?.unread || 0; }, [channel?.unread]);

  // The open thread, for handlers that must see it without being rebuilt every
  // time it changes.
  const threadIdRef = useRef('');
  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);

  // Files staged in the compose box that have not finished uploading — the one
  // part of a half-written message the composer's draft cannot carry.
  const pendingFilesRef = useRef(0);

  /* ---- list ---- */
  const loadList = useCallback(async ({ initial = false } = {}) => {
    if (!channelId) return;
    try {
      const data = await getPortalThreads(channelId);
      // Rendered in the order the server sends: sorted by LAST ACTIVITY, which
      // is not the same order as the roots' createdAt. Never re-sort here.
      setThreads((prev) => mergeThreadRows(initial ? [] : prev, data.threads));
      // ONLY the first load owns the cursor. This request always asks for the
      // newest page, so its `nextBefore` is that page's oldest `lastAt`: letting
      // the poll write it would rewind past every page already fetched and, as
      // threads gain replies and move, skip the rows in between.
      if (initial) setNextBefore(data.nextBefore || null);
      if (typeof data.canPost === 'boolean') setCanPost(data.canPost);
      setError('');
    } catch (err) {
      if (initial) setError(err.response?.data?.error || 'Couldn’t load your messages.');
    } finally {
      if (initial) setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    setView('list');
    setThreads([]);
    setThreadId('');
    setThread({ parent: null, replies: [] });
    setThreadError('');
    setOpenOverrides(new Map());
    setLoading(true);
    setError('');
    pendingFilesRef.current = 0;
    loadList({ initial: true });
  }, [loadList]);

  // Polling backstop — see the note in usePortalStream: SSE alone loses frames.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') loadList(); };
    const id = setInterval(tick, MAIL_POLL);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [loadList]);

  const loadOlderThreads = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await getPortalThreads(channelId, { before: nextBefore });
      setThreads((prev) => {
        const seen = new Set(prev.map((t) => String(t._id)));
        return [...prev, ...(data.threads || []).filter((t) => !seen.has(String(t._id)))];
      });
      // Paging is the other half of the cursor's ownership: it is the only
      // response whose `nextBefore` points further back than the one we hold.
      setNextBefore(data.nextBefore || null);
    } catch { /* the button stays */ }
    finally { setLoadingMore(false); }
  };

  /* ---- one thread ---- */
  const loadThread = useCallback(async (id, { initial = false } = {}) => {
    try {
      const data = await getPortalMessages(channelId, { thread: id });
      setThread((prev) => ({
        parent: data.parent || prev.parent,
        replies: mergeById(initial ? [] : prev.replies, data.replies || []),
      }));
      setThreadError('');
    } catch (err) {
      // A failed FIRST load leaves nothing under the subject line but a reply
      // box, which reads as an empty conversation rather than as a failure — and
      // invites a reply into a thread the client cannot see. A failed poll keeps
      // whatever is already on screen.
      if (initial) setThreadError(err.response?.data?.error || 'Couldn’t load this conversation.');
    } finally { if (initial) setThreadLoading(false); }
  }, [channelId]);

  const openThread = (row) => {
    setThreadId(row._id);
    setThread({ parent: null, replies: [] });
    setOpenOverrides(new Map());
    setThreadError('');
    setThreadLoading(true);
    setView('thread');

    if (row.unread) {
      setThreads((prev) => prev.map((t) => (t._id === row._id ? { ...t, unread: false } : t)));
      unreadRef.current = Math.max(0, unreadRef.current - 1);
      onUnreadChange?.(unreadRef.current);
    }
    markPortalThreadRead(row._id).catch(() => { /* the poll re-reads it */ });
    loadThread(row._id, { initial: true });
  };

  useEffect(() => {
    if (view !== 'thread' || !threadId) return undefined;
    const tick = () => { if (document.visibilityState === 'visible') loadThread(threadId); };
    const id = setInterval(tick, THREAD_POLL);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [view, threadId, loadThread]);

  /* ---- live frames ---- */
  // `threadId` is read from a ref rather than being a dependency: opening a
  // thread is not a new frame, and re-running this on it fired a second full
  // mailbox aggregation for every thread the client clicked into.
  useEffect(() => {
    if (!liveMessage || liveMessage.channelId !== channelId) return;
    const m = liveMessage.message;
    if (!m?.id) return;
    const openId = threadIdRef.current;
    if (openId && m.replyTo === openId) {
      setThread((prev) => ({ ...prev, replies: mergeById(prev.replies, [m]) }));
    }
    // The list's order and unread flags are the server's business; ask it.
    loadList();
  }, [liveMessage, channelId, loadList]);

  /* ---- writes ---- */
  const startThread = async ({ subject, bodyText, attachments }) => {
    const data = await createPortalThread(channelId, { subject, bodyText, attachments });
    const created = data?.message;
    pendingFilesRef.current = 0;
    await loadList();
    if (created?.id) {
      setThreadId(created.id);
      setThread({ parent: created, replies: [] });
      setOpenOverrides(new Map());
      setThreadError('');
      setView('thread');
    } else {
      setView('list');
    }
  };

  const reply = async ({ bodyText, attachments }) => {
    if (!threadId) return;
    const { message } = await sendPortalMessage(channelId, {
      bodyText, attachments, replyTo: threadId,
    });
    setThread((prev) => ({ ...prev, replies: mergeById(prev.replies, [message]) }));
    setThreads((prev) => prev.map((t) => (
      t._id === threadId ? { ...t, replyCount: (t.replyCount || 0) + 1, lastAt: message.createdAt } : t
    )));
  };

  if (!channel) return null;

  /* ---- compose ---- */
  if (view === 'compose') {
    /**
     * "Back to messages" reads as navigation, not as the "Discard" beside it, so
     * it must not behave like it. The composer keeps the subject, the body and
     * every finished upload as a draft and hands them back when it remounts; a
     * file still uploading is the only thing that genuinely dies here, and that
     * is the only thing worth stopping the client to ask about.
     */
    const leaveCompose = () => {
      const n = pendingFilesRef.current;
      if (n > 0) {
        const what = n === 1 ? 'A file has' : `${n} files have`;
        if (!window.confirm(`${what} not finished uploading and will be lost. Leave anyway?`)) return;
      }
      pendingFilesRef.current = 0;
      setView('list');
    };

    return (
      <div className="mcp-card-lg mcp-mail mcp-rise" style={{ padding: 20 }}>
        <div className="mcp-mail-head">
          <button type="button" className="mcp-linkbtn" onClick={leaveCompose}>
            <ArrowLeft size={15} /> Back to messages
          </button>
        </div>
        <div className="mcp-mail-compose-title">New message</div>
        <p className="mcp-mail-compose-sub">
          Start a new thread with the team. Give it a clear subject so it is easy to find later.
        </p>
        <PortalComposer
          channelId={channelId}
          withSubject
          autoFocus
          subjectPlaceholder="Subject (required)"
          placeholder="Write your message…"
          submitLabel="Send"
          minHeight={150}
          draftKey={`mailCompose:${channelId}`}
          onPendingFilesChange={(n) => { pendingFilesRef.current = n; }}
          onSubmit={startThread}
          onCancel={() => { pendingFilesRef.current = 0; setView('list'); }}
          cancelLabel="Discard"
        />
      </div>
    );
  }

  /* ---- one thread ---- */
  if (view === 'thread') {
    const all = [thread.parent, ...thread.replies].filter(Boolean);
    // Gmail's habit: the newest two stay open, everything before them folds
    // away behind a single row. A short thread is never folded at all.
    const autoFrom = all.length > 3 ? all.length - 2 : 0;

    /**
     * Openness is that habit UNLESS the client has said otherwise. It used to be
     * `i >= autoFrom || expanded.has(id)`, which made the header of each of the
     * two newest messages a button that could not do anything: they were open by
     * position whatever the set said. An explicit override per id lets a toggle
     * work in both directions without giving up the default.
     */
    const openAt = (m, i) => (openOverrides.has(m.id) ? openOverrides.get(m.id) : i >= autoFrom);
    const hiddenCount = all.slice(0, autoFrom).filter((m, i) => !openAt(m, i)).length;
    const subject = thread.parent?.subject
      || threads.find((t) => t._id === threadId)?.subject
      || 'Message';

    const toggle = (m, i) => setOpenOverrides((prev) => {
      const next = new Map(prev);
      next.set(m.id, !openAt(m, i));
      return next;
    });

    return (
      <div className="mcp-card-lg mcp-mail mcp-rise" style={{ padding: 20 }}>
        <div className="mcp-mail-head">
          <button type="button" className="mcp-linkbtn" onClick={() => { setView('list'); loadList(); }}>
            <ArrowLeft size={15} /> Back to messages
          </button>
        </div>

        <h2 className="mcp-mail-subject-lg">{subject}</h2>

        {threadLoading ? (
          <div className="mcp-chat-center"><Loader2 size={22} color="#2563EB" className="mcp-spin" /></div>
        ) : threadError ? (
          <div className="mcp-chat-center">
            <p className="mcp-chat-empty-text">{threadError}</p>
            <button
              type="button"
              className="mcp-btn mcp-btn--ghost"
              style={{ height: 34, fontSize: 12.5 }}
              onClick={() => {
                setThreadError('');
                setThreadLoading(true);
                loadThread(threadId, { initial: true });
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            {hiddenCount > 0 && (
              <button
                type="button"
                className="mcp-mail-expand"
                onClick={() => setOpenOverrides(new Map(all.map((m) => [m.id, true])))}
              >
                <ChevronDown size={14} /> Show {hiddenCount} earlier {hiddenCount === 1 ? 'message' : 'messages'}
              </button>
            )}

            <div className="mcp-mail-thread">
              {all.map((m, i) => (
                <MailMessage
                  key={m.id}
                  message={m}
                  open={openAt(m, i)}
                  onToggle={() => toggle(m, i)}
                />
              ))}
            </div>
          </>
        )}

        {canPost ? (
          <div className="mcp-mail-reply">
            <PortalComposer
              // Remounted per thread so the draft below is read for THIS one,
              // and so a half-written reply never follows the client into
              // another conversation.
              key={threadId}
              channelId={channelId}
              placeholder="Reply…"
              submitLabel="Reply"
              minHeight={90}
              // "Back to messages" is one click away above; the draft is what
              // makes taking it recoverable.
              draftKey={`mailReply:${threadId}`}
              // Replying into a thread we failed to read means replying blind.
              disabled={!!threadError}
              onSubmit={reply}
            />
          </div>
        ) : (
          <p className="mcp-chat-readonly"><Lock size={13} /> This mailbox is read-only.</p>
        )}
      </div>
    );
  }

  /* ---- list ---- */
  const unreadRows = threads.filter((t) => t.unread).length;

  return (
    <div className="mcp-card-lg mcp-mail mcp-rise">
      <div className="mcp-mail-bar">
        <span className="mcp-chat-head-ico"><Mail size={16} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="mcp-chat-title">{channel.name || 'Messages'}</div>
          <div className="mcp-chat-sub">
            {unreadRows > 0
              ? `${unreadRows} unread`
              : `${threads.length} ${threads.length === 1 ? 'conversation' : 'conversations'}`}
          </div>
        </div>
        {canPost && (
          <button type="button" className="mcp-btn mcp-btn--primary" style={{ height: 38 }}
            onClick={() => { pendingFilesRef.current = 0; setView('compose'); }}>
            <PenSquare size={15} /> New message
          </button>
        )}
      </div>

      {loading ? (
        <div className="mcp-chat-center"><Loader2 size={22} color="#2563EB" className="mcp-spin" /></div>
      ) : error ? (
        <div className="mcp-chat-center mcp-chat-empty-text">{error}</div>
      ) : threads.length === 0 ? (
        <div className="mcp-chat-center">
          <div className="mcp-chat-empty-ico"><Inbox size={22} /></div>
          <p className="mcp-chat-empty-text">
            No messages yet.{canPost ? ' Start one and the team will reply here.' : ''}
          </p>
        </div>
      ) : (
        <div className="mcp-mail-list">
          {threads.map((t) => (
            <button
              key={t._id}
              type="button"
              className="mcp-mail-row"
              data-unread={t.unread || undefined}
              onClick={() => openThread(t)}
            >
              <span className="mcp-mail-dot" aria-hidden="true" />
              <span className="mcp-mail-people">{participantLabel(t.participants)}</span>
              <span className="mcp-mail-text">
                <span className="mcp-mail-subject">{t.subject || '(no subject)'}</span>
                {t.snippet && <span className="mcp-mail-snippet"> — {t.snippet}</span>}
              </span>
              <span className="mcp-mail-side">
                {t.replyCount > 0 && <span className="mcp-mail-count">{t.replyCount + 1}</span>}
                <span className="mcp-mail-time">{relativeTime(t.lastAt)}</span>
              </span>
            </button>
          ))}

          {nextBefore && (
            <div className="mcp-mail-more">
              <button type="button" className="mcp-btn mcp-btn--ghost" style={{ height: 34, fontSize: 12.5 }}
                disabled={loadingMore} onClick={loadOlderThreads}>
                {loadingMore
                  ? <><Loader2 size={13} className="mcp-spin" /> Loading…</>
                  : 'Load older conversations'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PortalMail;

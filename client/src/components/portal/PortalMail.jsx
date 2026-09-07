import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2, ArrowLeft, PenSquare, Inbox, Lock, Search, RefreshCw, MailOpen,
  CornerUpLeft, X, MoreHorizontal,
} from 'lucide-react';
import {
  getPortalThreads, getPortalMessages, createPortalThread,
  sendPortalMessage, markPortalThreadRead,
} from '../../services/portalService';
import PortalComposer from './PortalComposer';
import { PortalMessageBody } from './PortalChat';
import {
  gmailListDate, gmailStamp, gmailStampLong, gmailAgo,
} from '../../utils/conversationFormat';
import {
  GmAvatar, GmailRowChips, GmailAttachments,
} from '../chat/conversationSkins';

/**
 * The client's mailbox — GMAIL, as closely as an interface can be copied that
 * is not talking to a mail server.
 *
 * Nothing here is sent to or received from SMTP and no address is exposed; the
 * messages are our own. What is Gmail's is every single thing about how they
 * are READ, because a client who has used Gmail every day for fifteen years
 * should not have to learn a mailbox from us:
 *
 *   - a 40px row whose read state is a blue-grey wash and whose unread state is
 *     white and bold. No unread dot: Gmail has never had one.
 *   - the subject and the snippet sharing one clipped line, date hard right.
 *   - a conversation where only the newest messages are open and everything
 *     earlier folds behind one counted pill.
 *   - a compose window docked to the bottom-right corner, so the list stays
 *     readable behind it.
 *
 * Two Gmail controls are deliberately ABSENT. The star, because nothing here
 * could persist it and a star that forgets is worse than no star. And the
 * hover-swap of the date for archive/snooze icons, because a client cannot
 * archive or snooze anything in this mailbox. The checkbox stayed: it drives a
 * real "Mark as read", which is the one bulk action we can honestly offer.
 *
 * Delivery contract is unchanged from before the reskin: the poll is what makes
 * the mailbox CORRECT, SSE only makes it feel instant. See usePortalStream.
 */
const MAIL_POLL = 20000;
const THREAD_POLL = 12000;

/** Up to three names, then "+N" — a long thread must not eat the subject. */
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
 * The poll — and every SSE frame, and every "Back" — re-reads only the newest
 * page. Replacing the list with it threw away every page "Load older" had
 * fetched, which put older mail out of reach entirely. So the page wins for the
 * rows it contains (it is the authority on their order, their unread flags and
 * their reply counts) and the rows it does not contain are kept behind it, in
 * the order they were paged in.
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

/**
 * Who a message went to. The portal never receives an email address — that is a
 * deliberate boundary in `utils/portalMessage.js` — so Gmail's `<name@host>`
 * line is replaced by the only recipient fact that is true and useful here.
 */
const recipientLine = (message) =>
  message.authorType === 'client' ? 'to the team' : 'to me';

/* ---- one message inside a conversation ------------------------------------ */
const MailMessage = ({ message, open, onToggle }) => {
  const snippet = (message.bodyText || '').replace(/\s+/g, ' ').trim();
  const who = message.mine ? 'me' : message.authorName;

  if (!open) {
    return (
      <button type="button" className="gm-fold-msg" onClick={onToggle}>
        <GmAvatar url={message.authorAvatar} name={message.authorName} className="gm-fold-av" />
        <span className="gm-fold-who">{who}</span>
        <span className="gm-fold-peek">{snippet || 'Attachment'}</span>
        <span className="gm-fold-when">{gmailListDate(message.createdAt)}</span>
      </button>
    );
  }

  const ago = gmailAgo(message.createdAt);
  return (
    <div className="gm-msg">
      <div className="gm-msg-head">
        <GmAvatar url={message.authorAvatar} name={message.authorName} className="gm-msg-av" />
        <button
          type="button"
          className="gm-msg-who"
          onClick={onToggle}
          style={{ textAlign: 'left' }}
          aria-label={`Collapse the message from ${who}`}
        >
          <span className="gm-msg-from">{who}</span>
          <span className="gm-msg-to">
            {recipientLine(message)}
            {message.editedAt ? ' · edited' : ''}
          </span>
        </button>
        <span className="gm-msg-when" title={gmailStampLong(message.createdAt)}>
          {gmailStamp(message.createdAt)}{ago ? ` (${ago})` : ''}
        </span>
      </div>
      <div className={`gm-msg-body ${message.body ? 'gm-msg-body--rich' : ''}`}>
        <PortalMessageBody body={message.body} bodyText={message.bodyText} />
      </div>
      <GmailAttachments items={message.attachments} />
    </div>
  );
};

/* ========================================================================== */
const PortalMail = ({ channel, onUnreadChange, liveMessage }) => {
  const channelId = channel?.id;

  const [view, setView] = useState('list'); // list | thread
  const [threads, setThreads] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [canPost, setCanPost] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [composing, setComposing] = useState(false);

  const [threadId, setThreadId] = useState('');
  const [thread, setThread] = useState({ parent: null, replies: [] });
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [replying, setReplying] = useState(false);
  // Which messages the CLIENT has opened or closed, keyed by id. An id that is
  // absent is left to the conversation's own habit — see `openAt` below.
  const [openOverrides, setOpenOverrides] = useState(() => new Map());

  // Local mirror of this channel's unread count. Opening ONE conversation
  // decrements it — it must never zero the channel, or every other unread
  // conversation silently loses its bold without anyone having read it.
  const unreadRef = useRef(channel?.unread || 0);
  useEffect(() => { unreadRef.current = channel?.unread || 0; }, [channel?.unread]);

  // The open conversation, for handlers that must see it without being rebuilt
  // every time it changes.
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
      // conversations gain replies and move, skip the rows in between.
      if (initial) setNextBefore(data.nextBefore || null);
      if (typeof data.canPost === 'boolean') setCanPost(data.canPost);
      setError('');
    } catch (err) {
      if (initial) setError(err.response?.data?.error || 'Couldn’t load your mail.');
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
    setSelected(new Set());
    setQuery('');
    setComposing(false);
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

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await loadList(); } finally { setRefreshing(false); }
  };

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

  /* ---- one conversation ---- */
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

  const markRead = useCallback((ids) => {
    const rows = ids.filter(Boolean);
    if (!rows.length) return;
    setThreads((prev) => prev.map((t) => (rows.includes(String(t._id)) ? { ...t, unread: false } : t)));
    rows.forEach((id) => markPortalThreadRead(id).catch(() => { /* the poll re-reads it */ }));
  }, []);

  const openThread = (row) => {
    setThreadId(row._id);
    setThread({ parent: null, replies: [] });
    setOpenOverrides(new Map());
    setThreadError('');
    setThreadLoading(true);
    setReplying(false);
    setView('thread');

    if (row.unread) {
      unreadRef.current = Math.max(0, unreadRef.current - 1);
      onUnreadChange?.(unreadRef.current);
    }
    markRead([String(row._id)]);
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
  // conversation is not a new frame, and re-running this on it fired a second
  // full mailbox aggregation for every row the client clicked into.
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
    setComposing(false);
    await loadList();
    if (created?.id) {
      setThreadId(created.id);
      setThread({ parent: created, replies: [] });
      setOpenOverrides(new Map());
      setThreadError('');
      setReplying(false);
      setView('thread');
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
    setReplying(false);
  };

  /* ---- selection ---- */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => {
      const people = (t.participants || []).map((p) => p?.name || '').join(' ');
      return `${t.subject || ''} ${t.snippet || ''} ${people}`.toLowerCase().includes(q);
    });
  }, [threads, query]);

  const toggleRow = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const allVisibleSelected = visible.length > 0 && visible.every((t) => selected.has(String(t._id)));

  const toggleAll = () => setSelected(
    allVisibleSelected ? new Set() : new Set(visible.map((t) => String(t._id)))
  );

  const markSelectedRead = () => {
    const ids = [...selected];
    const wasUnread = threads.filter((t) => ids.includes(String(t._id)) && t.unread).length;
    markRead(ids);
    if (wasUnread) {
      unreadRef.current = Math.max(0, unreadRef.current - wasUnread);
      onUnreadChange?.(unreadRef.current);
    }
    setSelected(new Set());
  };

  if (!channel) return null;

  /**
   * "Close" on the compose window reads as putting it away, not as discarding,
   * so it must not behave like Discard. The composer keeps the subject, the body
   * and every finished upload as a draft and hands them back when it remounts; a
   * file still uploading is the only thing that genuinely dies here, and that is
   * the only thing worth stopping the client to ask about.
   */
  const closeCompose = () => {
    const n = pendingFilesRef.current;
    if (n > 0) {
      const what = n === 1 ? 'A file has' : `${n} files have`;
      if (!window.confirm(`${what} not finished uploading and will be lost. Close anyway?`)) return;
    }
    pendingFilesRef.current = 0;
    setComposing(false);
  };

  const composeWindow = composing && (
    <div className="gm-compose" role="dialog" aria-label="New message">
      <div className="gm-compose-head">
        <span className="gm-compose-title">New message</span>
        <button type="button" className="gm-compose-x" onClick={closeCompose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="gm-compose-body">
        <div className="gm-compose-to">To <b>{channel.name || 'the team'}</b></div>
        <PortalComposer
          variant="gm"
          channelId={channelId}
          withSubject
          autoFocus
          subjectPlaceholder="Subject"
          placeholder=""
          submitLabel="Send"
          minHeight={200}
          draftKey={`mailCompose:${channelId}`}
          onPendingFilesChange={(n) => { pendingFilesRef.current = n; }}
          onSubmit={startThread}
          onCancel={() => { pendingFilesRef.current = 0; setComposing(false); }}
          cancelLabel="Discard draft"
        />
      </div>
    </div>
  );

  /* ---- one conversation ---- */
  if (view === 'thread') {
    const all = [thread.parent, ...thread.replies].filter(Boolean);
    // Gmail's habit: the newest two stay open, everything before them folds away
    // behind a single row. A short conversation is never folded at all.
    const autoFrom = all.length > 3 ? all.length - 2 : 0;

    /**
     * Openness is that habit UNLESS the client has said otherwise. An explicit
     * override per id lets a header toggle work in BOTH directions without
     * giving up the default — the earlier `i >= autoFrom || expanded.has(id)`
     * made the two newest headers buttons that could not close anything.
     */
    const openAt = (m, i) => (openOverrides.has(m.id) ? openOverrides.get(m.id) : i >= autoFrom);
    const hidden = all.slice(0, autoFrom).filter((m, i) => !openAt(m, i));
    const subject = thread.parent?.subject
      || threads.find((t) => t._id === threadId)?.subject
      || '(no subject)';

    const toggle = (m, i) => setOpenOverrides((prev) => {
      const next = new Map(prev);
      next.set(m.id, !openAt(m, i));
      return next;
    });

    return (
      <div className="gm gm-pane" style={{ height: 'min(76vh, 780px)' }}>
        <div className="gm-read-head">
          <button
            type="button"
            className="gm-iconbtn"
            onClick={() => { setView('list'); setReplying(false); loadList(); }}
            aria-label="Back to the mailbox"
            title="Back to the mailbox"
          >
            <ArrowLeft size={20} />
          </button>
          <button
            type="button"
            className="gm-iconbtn"
            onClick={refresh}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw size={18} className={refreshing ? 'mcp-spin' : undefined} />
          </button>
        </div>

        <div className="gm-thread">
          <h2 className="gm-subject">
            {subject}
            {all.length > 1 && <span className="gm-subject-n">{all.length}</span>}
          </h2>

          {threadLoading ? (
            <div className="gm-loading"><Loader2 size={24} className="mcp-spin" /></div>
          ) : threadError ? (
            <div className="gm-empty">
              <p className="gm-empty-t">This conversation didn’t load</p>
              <p style={{ margin: '0 0 16px' }}>{threadError}</p>
              <button
                type="button"
                className="gm-morebtn"
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
              {hidden.length > 0 && (
                <div className="gm-fold">
                  <button
                    type="button"
                    className="gm-fold-btn"
                    onClick={() => setOpenOverrides(new Map(all.map((m) => [m.id, true])))}
                    aria-label={`Show ${hidden.length} earlier ${hidden.length === 1 ? 'message' : 'messages'}`}
                    title="Show trimmed content"
                  >
                    <MoreHorizontal size={14} /> {hidden.length}
                  </button>
                  <span className="gm-fold-rule" />
                </div>
              )}

              {all.map((m, i) => (
                <MailMessage
                  key={m.id}
                  message={m}
                  open={openAt(m, i)}
                  onToggle={() => toggle(m, i)}
                />
              ))}

              {canPost && !replying && (
                <div className="gm-actions">
                  <button type="button" className="gm-pill" onClick={() => setReplying(true)}>
                    <CornerUpLeft size={18} /> Reply
                  </button>
                </div>
              )}

              {canPost && replying && (
                <div className="gm-replybox">
                  <div className="gm-replybox-head">
                    <CornerUpLeft size={16} />
                    <span>Reply to {channel.name || 'the team'}</span>
                    <button
                      type="button"
                      className="gm-iconbtn"
                      style={{ marginLeft: 'auto', width: 28, height: 28 }}
                      onClick={() => setReplying(false)}
                      aria-label="Close the reply"
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <PortalComposer
                    variant="gm"
                    // Remounted per conversation so the draft below is read for
                    // THIS one, and so a half-written reply never follows the
                    // client into another conversation.
                    key={threadId}
                    channelId={channelId}
                    autoFocus
                    placeholder=""
                    submitLabel="Send"
                    minHeight={110}
                    // "Back" is one click away above; the draft is what makes
                    // taking it recoverable.
                    draftKey={`mailReply:${threadId}`}
                    // Replying into a conversation we failed to read means
                    // replying blind.
                    disabled={!!threadError}
                    onSubmit={reply}
                  />
                </div>
              )}

              {!canPost && (
                <p className="gm-note"><Lock size={14} /> This mailbox is read-only.</p>
              )}
            </>
          )}
        </div>

        {composeWindow}
      </div>
    );
  }

  /* ---- the mailbox ---- */
  const selCount = selected.size;
  const unreadRows = threads.filter((t) => t.unread).length;

  return (
    <div className="gm">
      <div className="gm-search">
        <Search size={20} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="Search this mailbox"
          aria-label="Search this mailbox"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button type="button" className="gm-iconbtn" onClick={() => setQuery('')} aria-label="Clear the search">
            <X size={18} />
          </button>
        )}
      </div>

      <div className="gm-pane" style={{ height: 'min(72vh, 740px)' }}>
        <div className="gm-bar">
          {selCount > 0 ? (
            <>
              <input
                type="checkbox"
                className="gm-check"
                checked={allVisibleSelected}
                onChange={toggleAll}
                aria-label="Select every conversation shown"
              />
              <span className="gm-bar-sel">{selCount} selected</span>
              <button type="button" className="gm-textbtn" onClick={markSelectedRead}>
                <MailOpen size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
                Mark as read
              </button>
              <button type="button" className="gm-textbtn" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          ) : (
            <>
              {canPost && (
                <button
                  type="button"
                  className="gm-compose-btn"
                  style={{ marginRight: 10 }}
                  onClick={() => { pendingFilesRef.current = 0; setComposing(true); }}
                >
                  <PenSquare size={18} /> Compose
                </button>
              )}
              <input
                type="checkbox"
                className="gm-check"
                checked={false}
                onChange={toggleAll}
                disabled={visible.length === 0}
                aria-label="Select every conversation shown"
              />
              <button
                type="button"
                className="gm-iconbtn"
                onClick={refresh}
                aria-label="Refresh"
                title="Refresh"
              >
                <RefreshCw size={18} className={refreshing ? 'mcp-spin' : undefined} />
              </button>
              <span className="gm-bar-count">
                {loading
                  ? ' '
                  : visible.length === 0
                    ? 'No conversations'
                    : nextBefore
                      ? `1–${visible.length}`
                      : `1–${visible.length} of ${visible.length}`}
                {unreadRows > 0 && !query ? ` · ${unreadRows} unread` : ''}
              </span>
            </>
          )}
        </div>

        {loading ? (
          <div className="gm-loading"><Loader2 size={24} className="mcp-spin" /></div>
        ) : error ? (
          <div className="gm-empty">
            <p className="gm-empty-t">Your mail didn’t load</p>
            <p>{error}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="gm-empty">
            <Inbox size={40} style={{ opacity: 0.35, marginBottom: 12 }} aria-hidden="true" />
            {query ? (
              <>
                <p className="gm-empty-t">No conversations match “{query}”</p>
                <p>Search looks at the conversations already loaded here.</p>
              </>
            ) : (
              <>
                <p className="gm-empty-t">Nothing in this mailbox yet</p>
                <p>{canPost ? 'Write one and the team will reply here.' : 'The team will start the first one.'}</p>
              </>
            )}
          </div>
        ) : (
          <div className="gm-list">
            {visible.map((t) => {
              const id = String(t._id);
              const isSel = selected.has(id);
              const chips = t.attachments || [];
              return (
                <div
                  key={id}
                  role="button"
                  tabIndex={0}
                  className={`gm-row ${chips.length ? 'gm-row--tall' : ''}`}
                  data-unread={t.unread || undefined}
                  data-selected={isSel || undefined}
                  onClick={() => openThread(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openThread(t); }
                  }}
                >
                  <span className="gm-cell">
                    {/* Stops at the checkbox: ticking a row is not opening it. */}
                    <input
                      type="checkbox"
                      className="gm-check"
                      checked={isSel}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleRow(id)}
                      aria-label={`Select “${t.subject || 'no subject'}”`}
                    />
                    <GmAvatar name={participantLabel(t.participants)} />
                  </span>

                  <span className="gm-from">
                    {participantLabel(t.participants)}
                    {t.replyCount > 0 && <span className="gm-from-n">{t.replyCount + 1}</span>}
                  </span>

                  <span className="gm-mid">
                    <span className="gm-line1">
                      {t.subject || '(no subject)'}
                      {t.snippet && <span className="gm-snip"> - {t.snippet}</span>}
                    </span>
                    <GmailRowChips items={chips} extra={(t.attachmentCount || 0) - chips.length} />
                  </span>

                  <span className="gm-date" title={gmailStampLong(t.lastAt)}>
                    {gmailListDate(t.lastAt)}
                  </span>
                </div>
              );
            })}

            {nextBefore && !query && (
              <div className="gm-more">
                <button type="button" className="gm-morebtn" disabled={loadingMore} onClick={loadOlderThreads}>
                  {loadingMore ? 'Loading…' : 'Load older conversations'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {composeWindow}
    </div>
  );
};

export default PortalMail;

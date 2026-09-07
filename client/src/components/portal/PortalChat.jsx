import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2, ChevronDown, X, CornerUpLeft, Lock, Search, MoreVertical, Check,
} from 'lucide-react';
import {
  getPortalMessages, sendPortalMessage, markPortalChannelRead,
} from '../../services/portalService';
import PortalComposer from './PortalComposer';
// The ONE app component that is portal-safe. Imported directly and never via
// `UpdatesTab`, which drags `updateService`/`authStore`/`toastStore` — and with
// them `services/api.js`, whose 401 handler would drop a team member's
// `macan_token` — into a page an external client loads. See its header comment.
import ReadOnlyRichBody from '../board/ReadOnlyRichBody';
import { mergeMessages } from '../../utils/portalChatRows';
import { waClock, waDayLabel, dayKey, initialOf } from '../../utils/conversationFormat';
import { WhatsAppAttachments } from '../chat/conversationSkins';

/**
 * The client's chat room — WHATSAPP, as closely as a web app can copy it.
 *
 * The brief was not "make chat feel casual", it was "make it WhatsApp", so the
 * things that are actually WhatsApp are all here and measured: the doodled
 * wallpaper, the 7.5px bubbles at #d9fdd3 and white, the little tail on the
 * first bubble of a run, the timestamp that floats INTO the last line of text
 * rather than sitting under it, the capsule date dividers, the flat grey
 * composer bar with a green disc on the end, and Enter to send.
 *
 * What is deliberately NOT copied: the blue double tick. We know a message
 * reached the server and nothing more — there is no per-message read receipt in
 * this data model — so every outgoing message gets ONE grey tick, which is
 * exactly what that state means in WhatsApp. Inventing the blue one would be
 * telling a client their message had been read when we have no idea.
 *
 * Delivery is deliberately belt-and-braces: `usePortalStream` pushes new
 * messages in instantly when the SSE connection is up, and this poll is what
 * makes the room CORRECT when it isn't (the server registry is in-memory and
 * single-process, so frames are simply lost across a restart or a second node).
 * The same interval runs for an open thread panel, which is reachable over SSE
 * alone and just as wrong without it.
 */
const CHAT_POLL = 12000;

/** A run of messages from one person breaks after this long. WhatsApp's own
 *  grouping window, near enough that nobody could tell the difference. */
const RUN_GAP_MS = 5 * 60 * 1000;

const replyLabel = (n) => `${n} ${n === 1 ? 'reply' : 'replies'}`;

/* ---- shared message anatomy ----------------------------------------------
 * `PortalMessageBody` is exported because the mailbox renders the exact same
 * body. The avatar and attachment helpers that used to live here went with the
 * reskin: Gmail and WhatsApp draw a file completely differently, so a shared
 * renderer would have had to be neither.
 * -------------------------------------------------------------------------- */

/**
 * A message body. Rich TipTap docs go through the read-only renderer; a plain
 * `bodyText` is rendered as text rather than wrapped into a throwaway doc,
 * because mounting an editor per message down a long room is not free and the
 * result is pixel-identical.
 */
export const PortalMessageBody = ({ body, bodyText }) => {
  if (body) return <ReadOnlyRichBody body={body} fallbackText={bodyText} />;
  return <>{bodyText || ''}</>;
};

/* ---- one bubble ----------------------------------------------------------- */
/**
 * @param {boolean} tail   first of a run — the only bubble that gets the tail
 * @param {boolean} showName first of a run from someone else
 */
const ChatMessage = ({ message, onOpenThread, tail = true, showName = true }) => {
  // `onOpenThread` absent = we are already inside a thread; a reply-to-a-reply
  // would need a second level the data model does not have.
  const mine = !!message.mine;

  if (message.authorType === 'system') {
    return <div className="wa-sys">{message.bodyText}</div>;
  }

  const side = mine ? 'out' : 'in';
  return (
    <div className={`wa-row ${side} ${tail ? 'wa-row--new' : ''}`}>
      <div
        className={[
          'wa-b', side,
          tail ? 'wa-b--tail' : '',
          message.body ? 'wa-b--rich' : '',
        ].filter(Boolean).join(' ')}
      >
        {!mine && showName && <span className="wa-name">{message.authorName}</span>}
        <WhatsAppAttachments items={message.attachments} />
        <PortalMessageBody body={message.body} bodyText={message.bodyText} />
        {/* AFTER the text, always: the float only lands on the last line if the
            text is already there. Move it above and every bubble grows a row. */}
        <span className="wa-meta">
          {message.editedAt && <span>edited</span>}
          {waClock(message.createdAt)}
          {/* One tick: sent. See this file's header for why never two. */}
          {mine && <Check size={14} className="wa-tick" aria-label="Sent" />}
        </span>
      </div>

      {onOpenThread && (
        // The button hands itself to the opener, so closing the panel can put
        // focus back exactly where the client left it.
        <button
          type="button"
          className="wa-reply"
          data-always={message.replyCount > 0 || undefined}
          onClick={(e) => onOpenThread(message, e.currentTarget)}
        >
          <CornerUpLeft size={11} />
          {message.replyCount > 0 ? replyLabel(message.replyCount) : 'Reply'}
        </button>
      )}
    </div>
  );
};

/* ========================================================================== */
const PortalChat = ({ channel, onUnreadChange, liveMessage }) => {
  const channelId = channel?.id;

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nextBefore, setNextBefore] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [canPost, setCanPost] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [query, setQuery] = useState(null); // null = the search bar is closed

  // The open thread: { parent, replies } — null when the room is showing.
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');

  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const markedRef = useRef('');
  const landedRef = useRef(false);
  const threadHeadRef = useRef(null);
  // The button a thread was opened from, so closing gives focus back to it.
  const threadOpenerRef = useRef(null);

  /* ---- loading ---- */
  const refresh = useCallback(async ({ initial = false } = {}) => {
    if (!channelId) return;
    try {
      const data = await getPortalMessages(channelId);
      // The API answers newest-first; the room reads oldest-first.
      setMessages((prev) => mergeMessages(initial ? [] : prev, data.messages || []));
      // ONLY the first load owns the cursor. `refresh` always asks for the
      // newest page, so its `nextBefore` is that page's oldest message: letting
      // the poll write it would rewind past every page `loadOlder` fetched and,
      // once new messages have arrived, skip the ones in between. The poll needs
      // no cursor of its own — it merges into what is already loaded.
      if (initial) setNextBefore(data.nextBefore || null);
      if (typeof data.canPost === 'boolean') setCanPost(data.canPost);
      setError('');
    } catch (err) {
      if (initial) setError(err.response?.data?.error || 'Couldn’t load this conversation.');
    } finally {
      if (initial) setLoading(false);
    }
  }, [channelId]);

  // A different room is a different conversation — reset everything, including
  // the read marker, or the new room inherits the old one's "already read".
  useEffect(() => {
    setMessages([]);
    setThread(null);
    setThreadError('');
    setNextBefore(null);
    setLoading(true);
    setError('');
    setQuery(null);
    threadOpenerRef.current = null;
    markedRef.current = '';
    atBottomRef.current = true;
    landedRef.current = false;
    setAtBottom(true);
    refresh({ initial: true });
  }, [refresh]);

  // Polling backstop. SSE is an optimisation on top of this, never a substitute.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') refresh(); };
    const id = setInterval(tick, CHAT_POLL);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [refresh]);

  /* ---- live frames ---- */
  useEffect(() => {
    if (!liveMessage || liveMessage.channelId !== channelId) return;
    const m = liveMessage.message;
    if (!m?.id) return;
    if (m.replyTo) {
      // A thread reply never joins the room's own flow — it bumps the parent's
      // count, and lands in the thread panel if that thread happens to be open.
      setMessages((prev) => prev.map((x) => (
        x.id === m.replyTo ? { ...x, replyCount: (x.replyCount || 0) + 1 } : x
      )));
      setThread((t) => (
        t && t.parent?.id === m.replyTo ? { ...t, replies: mergeMessages(t.replies, [m]) } : t
      ));
      return;
    }
    setMessages((prev) => mergeMessages(prev, [m]));
  }, [liveMessage, channelId]);

  /* ---- scroll ---- */
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  };

  const jumpToBottom = useCallback((behavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  const lastId = messages.length ? messages[messages.length - 1].id : '';

  useEffect(() => {
    if (!lastId || !atBottomRef.current) return;
    // The very first paint jumps; everything after it glides, so a message
    // arriving mid-read is visibly an arrival rather than a repaint.
    jumpToBottom(landedRef.current ? 'smooth' : 'auto');
    landedRef.current = true;
  }, [lastId, jumpToBottom]);

  /**
   * An image finishing its download AFTER the room has scrolled to the bottom
   * pushes everything below it off screen — which, since the newest message is
   * at the bottom, is exactly the message the client came to read. `load` does
   * not bubble, hence the capture phase; and it only re-pins when the reader was
   * already at the bottom, so it can never yank someone out of the history they
   * had scrolled back to.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onLoad = () => { if (atBottomRef.current) jumpToBottom('auto'); };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
  }, [jumpToBottom]);

  /* ---- read receipts ----
   * Only when the pane is on screen AND parked at the bottom: a client who has
   * scrolled up to re-read something has not seen what arrived below them. */
  useEffect(() => {
    if (!channelId || !lastId || !atBottom) return;
    if (markedRef.current === lastId) return;
    markedRef.current = lastId;
    markPortalChannelRead(channelId).catch(() => { /* the poll re-reads it */ });
    onUnreadChange?.(0);
  }, [channelId, lastId, atBottom, onUnreadChange]);

  /* ---- older pages ---- */
  const loadOlder = async () => {
    if (!nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight || 0;
    try {
      const data = await getPortalMessages(channelId, { before: nextBefore });
      setMessages((prev) => mergeMessages(prev, data.messages || []));
      // Paging is the other half of the cursor's ownership: this is the only
      // response whose `nextBefore` points further back than the one we hold.
      setNextBefore(data.nextBefore || null);
      // Hold the reading position: without this, prepending a page throws the
      // client back to a message they had already read.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch { /* the button stays; they can try again */ }
    finally { setLoadingOlder(false); }
  };

  /* ---- threads ---- */
  const loadThread = useCallback(async (parentId, { initial = false } = {}) => {
    if (!parentId) return;
    try {
      const data = await getPortalMessages(channelId, { thread: parentId });
      // Guarded on the id: a poll that lands after the client has moved to
      // another thread must not repaint the one they are now reading.
      setThread((t) => (t && t.parent?.id === parentId
        ? {
          parent: data.parent || t.parent,
          replies: mergeMessages(initial ? [] : t.replies, data.replies || []),
        }
        : t));
      setThreadError('');
    } catch (err) {
      // A failed FIRST load must not read as "No replies yet" — that tells the
      // client there is no conversation here and invites them to reply into a
      // thread they cannot see. A failed poll keeps what is on screen.
      if (initial) setThreadError(err.response?.data?.error || 'Couldn’t load these replies.');
    } finally {
      if (initial) setThreadLoading(false);
    }
  }, [channelId]);

  const openThread = (parent, opener) => {
    threadOpenerRef.current = opener || null;
    setThread({ parent, replies: [] });
    setThreadError('');
    setThreadLoading(true);
    loadThread(parent.id, { initial: true });
  };

  const closeThread = useCallback(() => {
    setThread(null);
    setThreadError('');
    const opener = threadOpenerRef.current;
    threadOpenerRef.current = null;
    // The room stays mounted underneath, so the button we came from is still
    // there to take focus back.
    if (opener && document.contains(opener)) opener.focus();
  }, []);

  const openThreadId = thread?.parent?.id || '';

  // The same backstop the room has, for the same reason: SSE is the only other
  // way a reply reaches an open thread, and frames are lost across a restart or
  // a second node. Without this the panel says "No replies yet" indefinitely
  // while the team is answering.
  useEffect(() => {
    if (!openThreadId) return undefined;
    const tick = () => { if (document.visibilityState === 'visible') loadThread(openThreadId); };
    const id = setInterval(tick, CHAT_POLL);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [openThreadId, loadThread]);

  // Under 900px the panel stacks BELOW the room, so opening one can move nothing
  // into view at all. Scroll it up and put focus on its heading.
  useEffect(() => {
    if (!openThreadId) return;
    const el = threadHeadRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    el.focus({ preventScroll: true });
  }, [openThreadId]);

  useEffect(() => {
    if (!openThreadId) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeThread(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openThreadId, closeThread]);

  const send = async ({ bodyText, attachments }) => {
    const { message } = await sendPortalMessage(channelId, { bodyText, attachments });
    setMessages((prev) => mergeMessages(prev, [message]));
    atBottomRef.current = true;
    setAtBottom(true);
  };

  const sendReply = async ({ bodyText, attachments }) => {
    const parentId = thread?.parent?.id;
    if (!parentId) return;
    const { message } = await sendPortalMessage(channelId, {
      bodyText, attachments, replyTo: parentId,
    });
    setThread((t) => (t ? { ...t, replies: mergeMessages(t.replies, [message]) } : t));
    setMessages((prev) => prev.map((x) => (
      x.id === parentId ? { ...x, replyCount: (x.replyCount || 0) + 1 } : x
    )));
  };

  if (!channel) return null;

  /**
   * WhatsApp's in-chat search filters the room down to matching messages. Ours
   * searches what is LOADED, which is why it says so when it finds nothing —
   * a client who has not paged back has not searched their whole history and
   * should not be told otherwise.
   */
  const q = (query || '').trim().toLowerCase();
  const shown = q
    ? messages.filter((m) => (m.bodyText || '').toLowerCase().includes(q))
    : messages;

  let lastDay = '';
  let prev = null;

  const roomTitle = channel.name || 'Messages';

  return (
    <div className="wa mcp-rise">
      <div className="wa-shell">
        <div className="wa-main">
          <div className="wa-head">
            <span className="wa-head-av" aria-hidden="true">{initialOf(roomTitle)}</span>
            <div className="wa-head-t">
              <div className="wa-head-name">{roomTitle}</div>
              <div className="wa-head-sub">You and the team</div>
            </div>
            <button
              type="button"
              className="wa-head-btn"
              aria-label={query === null ? 'Search this chat' : 'Close the search'}
              aria-expanded={query !== null}
              onClick={() => setQuery((v) => (v === null ? '' : null))}
            >
              {query === null ? <Search size={20} /> : <X size={20} />}
            </button>
            <span className="wa-head-btn" aria-hidden="true"><MoreVertical size={20} /></span>
          </div>

          {query !== null && (
            <div style={{ padding: '8px 16px', background: '#f0f2f5' }}>
              <div className="wa-input">
                <input
                  type="search"
                  autoFocus
                  value={query}
                  placeholder="Search loaded messages"
                  aria-label="Search loaded messages"
                  onChange={(e) => setQuery(e.target.value)}
                  style={{
                    width: '100%', border: 0, background: 'none', outline: 'none',
                    font: 'inherit', fontSize: 15,
                  }}
                />
              </div>
            </div>
          )}

          <div className="wa-scroll" ref={scrollRef} onScroll={onScroll}>
            {loading ? (
              <div className="wa-center"><Loader2 size={22} className="mcp-spin" /></div>
            ) : error ? (
              <div className="wa-center"><span className="wa-center-card">{error}</span></div>
            ) : (
              <>
                {nextBefore && !q && (
                  <div className="wa-older">
                    <button type="button" disabled={loadingOlder} onClick={loadOlder}>
                      {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                    </button>
                  </div>
                )}

                {messages.length === 0 && (
                  <div className="wa-center">
                    <span className="wa-center-card">
                      No messages yet. Say hello — the team replies right here.
                    </span>
                  </div>
                )}

                {messages.length > 0 && shown.length === 0 && (
                  <div className="wa-center">
                    <span className="wa-center-card">
                      Nothing loaded here matches “{query}”.
                    </span>
                  </div>
                )}

                {shown.map((m) => {
                  const key = dayKey(m.createdAt);
                  const divider = key && key !== lastDay;
                  lastDay = key || lastDay;

                  // A run is the same person, on the same side, within five
                  // minutes, uninterrupted by a date divider.
                  const run =
                    !divider &&
                    !q &&
                    prev &&
                    prev.authorType !== 'system' &&
                    m.authorType !== 'system' &&
                    !!prev.mine === !!m.mine &&
                    prev.authorName === m.authorName &&
                    new Date(m.createdAt) - new Date(prev.createdAt) < RUN_GAP_MS;
                  prev = m;

                  return (
                    <div key={m.id}>
                      {divider && <div className="wa-day">{waDayLabel(m.createdAt)}</div>}
                      <ChatMessage
                        message={m}
                        onOpenThread={openThread}
                        tail={!run}
                        showName={!run}
                      />
                    </div>
                  );
                })}
              </>
            )}

            {/* Sticky rather than absolutely positioned: it lives inside the
                scrollport, so it pins itself above the composer whatever height
                the composer has grown to. */}
            {!atBottom && messages.length > 0 && (
              <button type="button" className="wa-jump" onClick={() => jumpToBottom()} aria-label="Jump to the latest message">
                <ChevronDown size={22} />
              </button>
            )}
          </div>

          {canPost ? (
            <div className="wa-foot">
              <PortalComposer
                variant="wa"
                channelId={channelId}
                placeholder="Type a message"
                onSubmit={send}
              />
            </div>
          ) : (
            <p className="wa-readonly"><Lock size={14} /> This conversation is read-only.</p>
          )}
        </div>

        {thread && (
          <aside className="wa-panel" aria-label="Replies">
            <div className="wa-panel-head">
              <button type="button" onClick={closeThread} aria-label="Close the replies" style={{ display: 'flex' }}>
                <X size={22} />
              </button>
              <span ref={threadHeadRef} tabIndex={-1}>
                {threadError
                  ? 'Replies didn’t load'
                  : thread.replies.length ? replyLabel(thread.replies.length) : 'Replies'}
              </span>
            </div>

            <div className="wa-scroll">
              {/* WhatsApp quotes what you are replying to, above the replies. */}
              <div className="wa-panel-quoted">
                <b>{thread.parent.mine ? 'You' : thread.parent.authorName}</b>
                {(thread.parent.bodyText || 'Attachment').slice(0, 300)}
              </div>

              {threadLoading ? (
                <div className="wa-center"><Loader2 size={18} className="mcp-spin" /></div>
              ) : threadError ? (
                <div className="wa-center">
                  <span className="wa-center-card">{threadError}</span>
                  <div style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      className="gm-morebtn"
                      onClick={() => {
                        setThreadError('');
                        setThreadLoading(true);
                        loadThread(openThreadId, { initial: true });
                      }}
                    >
                      Try again
                    </button>
                  </div>
                </div>
              ) : thread.replies.length === 0 ? (
                <div className="wa-center"><span className="wa-center-card">No replies yet.</span></div>
              ) : (
                thread.replies.map((r) => <ChatMessage key={r.id} message={r} />)
              )}
            </div>

            {canPost ? (
              <div className="wa-foot">
                <PortalComposer
                  variant="wa"
                  // Remounted per thread so the draft below is read for THIS one,
                  // and so a half-written reply never follows the client into
                  // another thread.
                  key={openThreadId}
                  channelId={channelId}
                  placeholder="Reply"
                  submitLabel="Reply"
                  // Escape and the close button both take this panel away mid
                  // sentence; the draft is what makes that recoverable.
                  draftKey={`chatThread:${openThreadId}`}
                  // Replying into a thread we failed to read means replying blind.
                  disabled={!!threadError}
                  onSubmit={sendReply}
                />
              </div>
            ) : (
              <p className="wa-readonly"><Lock size={14} /> This conversation is read-only.</p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
};

export default PortalChat;

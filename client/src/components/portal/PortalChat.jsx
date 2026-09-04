import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2, Paperclip, MessageSquare, ArrowDown, X, CornerUpLeft, Lock,
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

/**
 * The client's side of a Slack-style room, in the portal's own visual language
 * (`mcp-*` / `--p-*`) rather than the app's Tailwind — the client sees this, so
 * it has to look like the rest of their portal, not like our admin tool.
 *
 * Delivery is deliberately belt-and-braces: `usePortalStream` pushes new
 * messages in instantly when the SSE connection is up, and this poll is what
 * makes the room CORRECT when it isn't (the server registry is in-memory and
 * single-process, so frames are simply lost across a restart or a second node).
 */
const CHAT_POLL = 12000;

/* ---- shared message anatomy ----------------------------------------------
 * Exported because PortalMail renders the exact same message body, avatar and
 * attachment treatment — a client should not be able to tell that chat and mail
 * are two components. Kept here, with the busier of the two surfaces.
 * -------------------------------------------------------------------------- */

const initialsOf = (name) => (name || '?').trim().charAt(0).toUpperCase();

const isImage = (a) =>
  (a?.mime && a.mime.startsWith('image/')) ||
  /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a?.name || '') ||
  /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(a?.url || '');

const formatBytes = (n) => {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  const mb = b / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const replyLabel = (n) => `${n} ${n === 1 ? 'reply' : 'replies'}`;

const formatClock = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
};
const formatStamp = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
};
const dayKey = (iso) => {
  try { return new Date(iso).toDateString(); } catch { return ''; }
};
const dayLabel = (iso) => {
  try {
    const d = new Date(iso);
    const today = new Date();
    const yest = new Date(today);
    yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch { return ''; }
};

export const PortalAvatar = ({ url, name }) =>
  url
    ? <img className="mcp-avatar" src={url} alt="" />
    : <span className="mcp-avatar-fallback">{initialsOf(name)}</span>;

/** Attachments exactly as the portal already renders them on an issue thread. */
export const PortalAttachments = ({ items }) => {
  const arr = (Array.isArray(items) ? items : []).filter((a) => a && a.url);
  if (!arr.length) return null;
  return (
    <div className="mcp-att-wrap">
      <span className="mcp-att-count"><Paperclip size={11} /> {plural(arr.length, 'attachment')}</span>
      {arr.map((a, i) => (
        <a key={i} href={a.url} target="_blank" rel="noreferrer" className="mcp-att-item">
          {isImage(a) && <img className="mcp-thumb" src={a.url} alt={a.name || 'attachment'} />}
          <span className="mcp-attach">
            <Paperclip size={12} />
            <span className="mcp-att-name">{a.name || 'Attachment'}</span>
            {formatBytes(a.size) && <span className="mcp-att-size">· {formatBytes(a.size)}</span>}
          </span>
        </a>
      ))}
    </div>
  );
};

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

/* ---- message list --------------------------------------------------------- */


const ChatMessage = ({ message, onOpenThread }) => {
  // `onOpenThread` absent = we are already inside a thread; a reply-to-a-reply
  // would need a second level the data model does not have.
  const mine = !!message.mine;
  const system = message.authorType === 'system';

  if (system) {
    return <div className="mcp-sys">{message.bodyText}</div>;
  }

  return (
    <div className={`mcp-msg-row ${mine ? 'mine' : ''}`}>
      {mine ? (
        <span className="mcp-msg-author">{message.authorName || 'You'}</span>
      ) : (
        <div className="mcp-msg-head">
          <PortalAvatar url={message.authorAvatar} name={message.authorName} />
          <span className="mcp-msg-author" style={{ margin: 0 }}>{message.authorName}</span>
        </div>
      )}

      <div className={`mcp-bubble ${mine ? 'mine' : 'them'} ${message.body ? 'mcp-bubble--rich' : ''}`}>
        <PortalMessageBody body={message.body} bodyText={message.bodyText} />
        <PortalAttachments items={message.attachments} />
      </div>

      <div className="mcp-msg-foot">
        <span className="mcp-msg-time">{formatClock(message.createdAt)}</span>
        {onOpenThread && (
          <button type="button" className="mcp-msg-reply" onClick={() => onOpenThread(message)}>
            <CornerUpLeft size={11} />
            {message.replyCount > 0 ? replyLabel(message.replyCount) : 'Reply'}
          </button>
        )}
      </div>
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

  // The open thread: { parent, replies } — null when the room is showing.
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);

  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const markedRef = useRef('');
  const landedRef = useRef(false);

  /* ---- loading ---- */
  const refresh = useCallback(async ({ initial = false } = {}) => {
    if (!channelId) return;
    try {
      const data = await getPortalMessages(channelId);
      // The API answers newest-first; the room reads oldest-first.
      setMessages((prev) => mergeMessages(initial ? [] : prev, data.messages || []));
      setNextBefore(data.nextBefore || null);
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
    setNextBefore(null);
    setLoading(true);
    setError('');
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
  const openThread = async (parent) => {
    setThread({ parent, replies: [] });
    setThreadLoading(true);
    try {
      const data = await getPortalMessages(channelId, { thread: parent.id });
      setThread({ parent: data.parent || parent, replies: data.replies || [] });
    } catch {
      setThread({ parent, replies: [] });
    } finally {
      setThreadLoading(false);
    }
  };

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

  let lastDay = '';

  return (
    <div className="mcp-chat mcp-rise">
      <div className="mcp-chat-main">
        <div className="mcp-chat-head">
          <span className="mcp-chat-head-ico"><MessageSquare size={16} /></span>
          <div style={{ minWidth: 0 }}>
            <div className="mcp-chat-title">{channel.name || 'Messages'}</div>
            <div className="mcp-chat-sub">Chat directly with the team working on this.</div>
          </div>
        </div>

        <div className="mcp-chat-scroll" ref={scrollRef} onScroll={onScroll}>
          {loading ? (
            <div className="mcp-chat-center"><Loader2 size={22} color="#2563EB" className="mcp-spin" /></div>
          ) : error ? (
            <div className="mcp-chat-center mcp-chat-empty-text">{error}</div>
          ) : (
            <>
              {nextBefore && (
                <div className="mcp-chat-older">
                  <button type="button" className="mcp-btn mcp-btn--ghost" style={{ height: 32, fontSize: 12.5 }}
                    disabled={loadingOlder} onClick={loadOlder}>
                    {loadingOlder
                      ? <><Loader2 size={13} className="mcp-spin" /> Loading…</>
                      : 'Load earlier messages'}
                  </button>
                </div>
              )}

              {messages.length === 0 && (
                <div className="mcp-chat-center">
                  <div className="mcp-chat-empty-ico"><MessageSquare size={22} /></div>
                  <p className="mcp-chat-empty-text">
                    No messages yet. Say hello — the team replies right here.
                  </p>
                </div>
              )}

              {messages.map((m) => {
                const key = dayKey(m.createdAt);
                const divider = key && key !== lastDay;
                lastDay = key || lastDay;
                return (
                  <div key={m.id}>
                    {divider && (
                      <div className="mcp-chat-day"><span>{dayLabel(m.createdAt)}</span></div>
                    )}
                    <ChatMessage message={m} onOpenThread={openThread} />
                  </div>
                );
              })}
            </>
          )}

          {/* Sticky rather than absolutely positioned: it lives inside the
              scrollport, so it pins itself above the composer whatever height
              the composer has grown to. */}
          {!atBottom && messages.length > 0 && (
            <button type="button" className="mcp-chat-jump" onClick={() => jumpToBottom()}>
              <ArrowDown size={14} /> Latest
            </button>
          )}
        </div>

        <div className="mcp-chat-foot">
          {canPost ? (
            <PortalComposer
              channelId={channelId}
              placeholder="Message the team…"
              onSubmit={send}
            />
          ) : (
            <p className="mcp-chat-readonly"><Lock size={13} /> This conversation is read-only.</p>
          )}
        </div>
      </div>

      {thread && (
        <aside className="mcp-chat-thread">
          <div className="mcp-chat-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mcp-chat-title">Thread</div>
              <div className="mcp-chat-sub">
                {thread.replies.length ? replyLabel(thread.replies.length) : 'No replies yet'}
              </div>
            </div>
            <button type="button" className="mcp-linkbtn" style={{ padding: 4 }}
              onClick={() => setThread(null)} aria-label="Close thread">
              <X size={17} />
            </button>
          </div>

          <div className="mcp-chat-scroll">
            <div className="mcp-thread-parent">
              <div className="mcp-msg-head">
                <PortalAvatar url={thread.parent.authorAvatar} name={thread.parent.authorName} />
                <span className="mcp-msg-author" style={{ margin: 0 }}>
                  {thread.parent.authorName}
                  <span style={{ opacity: 0.7 }}> · {formatStamp(thread.parent.createdAt)}</span>
                </span>
              </div>
              <div className={`mcp-bubble them ${thread.parent.body ? 'mcp-bubble--rich' : ''}`}>
                <PortalMessageBody body={thread.parent.body} bodyText={thread.parent.bodyText} />
                <PortalAttachments items={thread.parent.attachments} />
              </div>
            </div>

            {threadLoading ? (
              <div className="mcp-chat-center"><Loader2 size={18} color="#2563EB" className="mcp-spin" /></div>
            ) : (
              thread.replies.map((r) => <ChatMessage key={r.id} message={r} />)
            )}
          </div>

          {canPost && (
            <div className="mcp-chat-foot">
              <PortalComposer
                channelId={channelId}
                placeholder="Reply in thread…"
                submitLabel="Reply"
                minHeight={58}
                onSubmit={sendReply}
              />
            </div>
          )}
        </aside>
      )}
    </div>
  );
};

export default PortalChat;

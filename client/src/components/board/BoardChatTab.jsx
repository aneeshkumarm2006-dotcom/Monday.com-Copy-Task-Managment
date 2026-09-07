import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, Eye, Hash, Lock, Mail, MessageCircle, PenSquare, RefreshCw, Search,
  X, CornerUpLeft, MoreHorizontal, Inbox,
} from 'lucide-react';
import MessageItem from '../chat/MessageItem';
import { GmAvatar, GmailRowChips } from '../chat/conversationSkins';
import {
  gmailListDate, gmailStampLong, waDayLabel, dayKey,
} from '../../utils/conversationFormat';
import UpdateComposer from './UpdateComposer';
import SetUpCommunicationModal from './SetUpCommunicationModal';
import useAuthStore from '../../store/authStore';
import useToastStore from '../../store/toastStore';
import useBoardMembers from '../../hooks/useBoardMembers';
import * as chatService from '../../services/chatService';
import { getBoardPortalConfig } from '../../services/boardService';
import { keyForSurface, surfaceByKey } from '../../utils/chatSurfaces';
import useChatStore from '../../store/chatStore';

/**
 * A client board's Chat tab — every conversation this client company has with
 * us, grouped by workstream.
 *
 * ---- Why this is not the /chat page ----------------------------------------
 *
 * `utils/chatChannels.js` keeps a client board's rooms OUT of the global
 * sidebar on purpose: they are conversations with an outside company, and
 * mixing them into the same list as internal team chat is how someone answers
 * the wrong room. This tab is where they live instead, and being board-local is
 * what makes the client's name and the workstream permanently on screen.
 *
 * It follows the board tabs' component-state doctrine rather than joining
 * `chatStore` — the store exists because the unread badge and live delivery are
 * needed on every page, and neither is true of a tab you have to navigate to.
 *
 * ---- Two shapes of conversation --------------------------------------------
 *
 * A `mode:'chat'` surface is one running stream: newest at the bottom, a docked
 * composer. A `mode:'mail'` surface is a LIST of subjects, opened one at a time.
 * Same messages, same `Message` collection, same `MessageItem` — the difference
 * is entirely in the navigation, which is the point of offering both.
 *
 * ---- Loading without a synchronous setState --------------------------------
 *
 * Every pane below is keyed by the id it was loaded FOR, and "loading" is that
 * id not matching the selection yet, rather than a flag flipped in an effect
 * body. That is deliberate: clearing state synchronously in an effect causes
 * the cascading render React warns about, and the sentinel reads the same on
 * screen with none of it.
 */

const RailLabel = ({ children }) => (
  <p
    className="font-body font-bold px-3 pt-3 pb-1 uppercase text-[color:var(--color-text-muted)]"
    style={{ fontSize: 10, letterSpacing: '0.08em' }}
  >
    {children}
  </p>
);

/** The "this one is client-facing" marker. The single most important thing a
 *  row can say, because it decides what may be typed into it. */
const ClientPill = () => (
  <span
    className="font-body font-semibold shrink-0"
    style={{
      fontSize: 9,
      letterSpacing: '0.04em',
      color: '#1E40AF',
      background: '#EFF6FF',
      border: '1px solid #BFDBFE',
      borderRadius: 999,
      padding: '1px 6px',
    }}
  >
    Client
  </span>
);

/**
 * One surface in the rail.
 *
 * The TITLE is the surface's kind ("Chat", "Mail", "Team room"), not the stored
 * channel name: chat and mail on one workstream deliberately share a name, so
 * under a heading that already says "Ads" a pair of identical rows would be
 * unreadable. The full name stays as the row's `title` for anyone who wants it.
 */
const SurfaceRow = ({ channel, active, onClick }) => {
  const key = keyForSurface(channel.mode, channel.audience);
  const label = surfaceByKey(key)?.label || channel.name;
  const Icon = channel.mode === 'mail' ? Mail : Hash;
  const hasUnread = channel.unread > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      title={channel.name}
      className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
      style={{ background: active ? 'var(--color-bg-subtle)' : 'transparent' }}
    >
      <Icon
        size={13}
        aria-hidden="true"
        className="shrink-0"
        color={active ? 'var(--color-accent)' : 'var(--color-text-muted)'}
      />
      <span
        className="font-body flex-1 min-w-0 truncate"
        style={{
          fontSize: 12.5,
          fontWeight: hasUnread ? 700 : 600,
          color: active ? 'var(--color-accent)' : 'var(--color-text-primary)',
        }}
      >
        {label}
      </span>
      {channel.audience === 'client' && <ClientPill />}
      {hasUnread && (
        <span
          className="flex items-center justify-center font-body font-bold text-white shrink-0"
          style={{
            minWidth: 17,
            height: 17,
            padding: '0 5px',
            borderRadius: 999,
            fontSize: 10,
            background: 'var(--color-accent)',
          }}
        >
          {channel.unread > 99 ? '99+' : channel.unread}
        </span>
      )}
    </button>
  );
};

/**
 * One conversation in a mailbox — GMAIL'S ROW, and the same one the client sees
 * in their portal. 40px, sender in a fixed column, subject and snippet sharing
 * one clipped line, date hard right; read is the blue-grey wash and unread is
 * white and bold. See styles/conversations.css.
 */
const ThreadRow = ({ thread, active, onClick }) => {
  const people = (thread.participants || []).map((p) => p?.name).filter(Boolean);
  const label = people.length
    ? (people.length <= 3 ? people.join(', ') : `${people.slice(0, 3).join(', ')} +${people.length - 3}`)
    : 'No one yet';
  const chips = thread.attachments || [];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
      className={`gm-row ${chips.length ? 'gm-row--tall' : ''}`}
      data-unread={thread.unread || undefined}
      data-selected={active || undefined}
    >
      <span className="gm-cell">
        <GmAvatar url={thread.participants?.[0]?.profilePic} name={label} />
      </span>

      <span className="gm-from">
        {label}
        {thread.replyCount > 0 && <span className="gm-from-n">{thread.replyCount + 1}</span>}
      </span>

      <span className="gm-mid">
        <span className="gm-line1">
          {thread.subject || '(no subject)'}
          {thread.snippet && <span className="gm-snip"> - {thread.snippet}</span>}
        </span>
        <GmailRowChips items={chips} extra={(thread.attachmentCount || 0) - chips.length} />
      </span>

      <span className="gm-date" title={gmailStampLong(thread.lastAt || thread.createdAt)}>
        {gmailListDate(thread.lastAt || thread.createdAt)}
      </span>
    </div>
  );
};

/**
 * @param {string}  boardId
 * @param {string} [onlyGroupId] — scope to ONE service. Set by the client
 *   workspace, where the service is already chosen by the rail on the left, so
 *   a second vertical rail listing every service again would be the duplication
 *   this redesign exists to remove. With it set the surfaces render as a
 *   horizontal room switcher, split by who is in the room.
 * @param {string} [clientName] — the company, for the audience banner.
 */
const BoardChatTab = ({ boardId, onlyGroupId = null, clientName = '' }) => {
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const toast = useToastStore.getState();
  // The board's own roster, never the workspace's — a private board's @ list
  // must not leak names of people who cannot open it. See useBoardMembers.
  const boardMembers = useBoardMembers(boardId);

  const [data, setData] = useState(null); // { board, canManage, workstreams, extras }
  const [loadError, setLoadError] = useState('');
  const [activeId, setActiveId] = useState(null);
  // Each pane records the id it was loaded FOR; a mismatch IS the loading state.
  const [pane, setPane] = useState(null);
  const [threadId, setThreadId] = useState(null);
  const [threadPane, setThreadPane] = useState(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [subject, setSubject] = useState('');
  // Gmail folds everything but the newest two messages of a conversation behind
  // one counted pill. This is the per-message override on that default: absent
  // means "however the fold wants it", present means the reader has said.
  const [foldOverrides, setFoldOverrides] = useState(() => new Map());
  // Client-side, over the conversations already paged in — see the placeholder.
  const [mailQuery, setMailQuery] = useState('');
  const [replyOpen, setReplyOpen] = useState(false);
  const [setupGroup, setSetupGroup] = useState(null);
  /**
   * Is this board's client portal actually LIVE? `null` means "not known".
   *
   * The server refuses client-facing surfaces on anything that is not a live
   * client board — `isLiveClientBoard` is `boardType:'client'` AND
   * `portalEnabled` — and it refuses the WHOLE plan when one is asked for,
   * private team room included. So the setup modal has to be told the same
   * thing or it offers a choice that cannot succeed, and takes a legal choice
   * down with it.
   *
   * `boardType` alone is not that answer: a client board whose link was
   * switched off is still `boardType:'client'`. The channels payload does not
   * carry `portalEnabled`, so this reads it from the portal config endpoint,
   * which does. That endpoint is board-MANAGER only, a stricter bar than the
   * `group.manage` that opens the setup modal, so a refusal here leaves this
   * `null` — unknown, and the modal stays exactly as permissive as it was
   * before, with the server as the enforcement it always was.
   */
  const [portalLive, setPortalLive] = useState(null);

  const feedRef = useRef(null);
  const stickToBottom = useRef(true);

  const allWorkstreams = data?.workstreams || [];
  const workstreams = onlyGroupId
    ? allWorkstreams.filter((w) => String(w.group?._id) === String(onlyGroupId))
    : allWorkstreams;
  // "Other" holds board-level rooms that belong to no service, so scoping to one
  // service must not show them.
  const extras = onlyGroupId ? [] : data?.extras || [];
  const allSurfaces = [...workstreams.flatMap((w) => w.surfaces || []), ...extras];
  const activeChannel =
    allSurfaces.find((c) => String(c._id) === String(activeId)) || null;
  const activeMode = activeChannel?.mode || null;

  const loadChannels = useCallback(
    async ({ select = false } = {}) => {
      try {
        const res = await chatService.getBoardChannels(boardId);
        setData(res);
        setLoadError('');
        if (select) {
          // Land on something rather than an empty pane. The first surface of
          // the first workstream that has one — a board whose workstreams are
          // all unset stays on the empty state, which is the correct screen.
          const pool = onlyGroupId
            ? (res.workstreams || []).filter(
              (w) => String(w.group?._id) === String(onlyGroupId)
            )
            : res.workstreams || [];
          const surfaces = pool
            .flatMap((w) => w.surfaces || [])
            .concat(onlyGroupId ? [] : res.extras || []);
          // Prefer a CLIENT-facing room: on a service the client conversation is
          // the one the team came here for, and landing in the private team room
          // by accident is exactly the confusion the framing below guards against.
          const first = surfaces.find((c) => c.audience === 'client') || surfaces[0];
          if (first) setActiveId(String(first._id));
        }
        return res;
      } catch (err) {
        console.error('Failed to load board channels:', err);
        setLoadError(
          err?.response?.data?.error || 'Could not load this board’s conversations.'
        );
        return null;
      }
    },
    [boardId, onlyGroupId]
  );

  useEffect(() => {
    loadChannels({ select: true });
  }, [loadChannels]);

  const isClientBoard = data?.board?.boardType === 'client';
  // If the channels payload ever grows `portalEnabled`, it wins and no second
  // request is made. Today it carries only `_id, name, boardType,
  // portalClientName`, so this is `null` and the fetch below runs.
  const portalLiveFromPayload =
    typeof data?.board?.portalEnabled === 'boolean' ? data.board.portalEnabled : null;

  // One small read, only for the person who can act on the answer, and only on
  // a client board. Nothing else on this tab needs it: `allowClientSurfaces` is
  // the single consumer.
  useEffect(() => {
    setPortalLive(null);
    if (!isClientBoard || !data?.canManage || portalLiveFromPayload !== null) {
      return undefined;
    }
    let cancelled = false;
    getBoardPortalConfig(boardId)
      .then((cfg) => {
        if (!cancelled) setPortalLive(!!cfg?.portalEnabled);
      })
      .catch(() => {
        // 403 for a group manager who is not a board manager, or a blip.
        // Either way this stays unknown, never "off" — see `portalLive`.
      });
    return () => {
      cancelled = true;
    };
  }, [boardId, isClientBoard, data?.canManage, portalLiveFromPayload]);

  // ---- Live delivery -------------------------------------------------------
  //
  // The app already holds ONE EventSource (`useNotificationStream`), and every
  // `chat.message` frame lands in `chatStore.receiveMessage`. This tab keeps its
  // own state rather than joining that store, so it subscribes to the beacon
  // that publishes instead — no second connection, no second subscriber on the
  // server, and the board-tab doctrine intact.
  //
  // Without this, a chat surface would need a manual refresh to show a message
  // that arrived thirty seconds ago, which for the client-facing room is the
  // whole point of the feature not working.
  const live = useChatStore((s) => s.liveMessage);
  useEffect(() => {
    if (!live?.seq) return;
    const { channelId, message } = live;

    // In the open CHAT pane: append it, and mark read, because looking at a
    // message is reading it. Mail is deliberately excluded — a mail thread list
    // is not a live feed, and its unread dot is per-thread.
    setPane((prev) => {
      if (!prev || prev.mode !== 'chat') return prev;
      if (String(prev.channelId) !== String(channelId)) return prev;
      if (message.replyTo) {
        return {
          ...prev,
          messages: (prev.messages || []).map((m) =>
            String(m._id) === String(message.replyTo)
              ? { ...m, replyCount: (m.replyCount || 0) + 1 }
              : m
          ),
        };
      }
      if ((prev.messages || []).some((m) => String(m._id) === String(message._id))) {
        return prev; // already have it — the frame arrived twice
      }
      stickToBottom.current = true;
      return { ...prev, messages: [...(prev.messages || []), message] };
    });

    // In the rail: bump the surface's unread, unless it is the one on screen.
    const isOpen = String(activeId) === String(channelId);
    if (isOpen) chatService.markChannelRead(channelId).catch(() => {});
    setData((prev) => {
      if (!prev) return prev;
      const bump = (c) =>
        String(c._id) !== String(channelId)
          ? c
          : {
              ...c,
              unread: isOpen ? 0 : (c.unread || 0) + 1,
              lastMessage: {
                at: message.createdAt,
                text: (message.bodyText || '').slice(0, 140),
                authorName:
                  message.authorType === 'system'
                    ? 'Macan'
                    : message.portalAuthor?.name || message.author?.name || '',
              },
            };
      return {
        ...prev,
        workstreams: (prev.workstreams || []).map((w) => ({
          ...w,
          surfaces: (w.surfaces || []).map(bump),
        })),
        extras: (prev.extras || []).map(bump),
      };
    });
    // `activeId` is read, not depended on: re-running this effect when the user
    // merely switches surface would replay the last frame into the new pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.seq]);

  // The conversation pane. One effect for both modes: the request differs, the
  // "which id am I holding" bookkeeping does not.
  useEffect(() => {
    if (!activeId || !activeMode) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        if (activeMode === 'mail') {
          const res = await chatService.getThreads(activeId);
          if (cancelled) return;
          setPane({ channelId: activeId, mode: 'mail', ...res });
        } else {
          const res = await chatService.getMessages(activeId);
          if (cancelled) return;
          setPane({
            channelId: activeId,
            mode: 'chat',
            // The server returns newest-first; a stream reads oldest-first.
            messages: [...res.messages].reverse(),
            nextBefore: res.nextBefore,
            canPost: res.canPost,
            canManage: res.canManage,
          });
          stickToBottom.current = true;
          chatService.markChannelRead(activeId).catch(() => {
            // Non-fatal: the next channels fetch re-reports the true count.
          });
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  workstreams: (prev.workstreams || []).map((w) => ({
                    ...w,
                    surfaces: (w.surfaces || []).map((c) =>
                      String(c._id) === String(activeId) ? { ...c, unread: 0 } : c
                    ),
                  })),
                  extras: (prev.extras || []).map((c) =>
                    String(c._id) === String(activeId) ? { ...c, unread: 0 } : c
                  ),
                }
              : prev
          );
        }
      } catch (err) {
        console.error('Failed to load conversation:', err);
        if (!cancelled) {
          setPane({
            channelId: activeId,
            mode: activeMode,
            error: err?.response?.data?.error || 'Could not load this conversation.',
          });
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [activeId, activeMode]);

  // A different conversation starts folded again, and with no half-open reply
  // box carried over from the last one.
  useEffect(() => {
    setFoldOverrides(new Map());
    setReplyOpen(false);
  }, [threadId]);

  // One open mail thread.
  useEffect(() => {
    if (!threadId || !activeId) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await chatService.getThread(activeId, threadId);
        if (cancelled) return;
        setThreadPane({ threadId, parent: res.parent, replies: res.replies || [] });
        chatService.markThreadRead(activeId, threadId).catch(() => {});
      } catch (err) {
        console.error('Failed to load thread:', err);
        if (!cancelled) {
          setThreadPane({ threadId, error: 'Could not load this thread.' });
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [threadId, activeId]);

  // Pin the stream to the newest message unless the reader scrolled up.
  const paneReady = pane && String(pane.channelId) === String(activeId);
  const messages = paneReady && pane.mode === 'chat' ? pane.messages || [] : [];
  useEffect(() => {
    const el = feedRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const handleFeedScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const openSurface = (channel) => {
    setActiveId(String(channel._id));
    setThreadId(null);
    setThreadPane(null);
    setComposeOpen(false);
    setSubject('');
    setFoldOverrides(new Map());
    setMailQuery('');
    setReplyOpen(false);
  };

  const loadOlder = async () => {
    if (!paneReady || pane.mode !== 'chat' || !pane.nextBefore) return;
    try {
      const page = await chatService.getMessages(activeId, { before: pane.nextBefore });
      setPane((prev) =>
        prev && String(prev.channelId) === String(activeId)
          ? {
              ...prev,
              messages: [...[...page.messages].reverse(), ...(prev.messages || [])],
              nextBefore: page.nextBefore,
            }
          : prev
      );
    } catch (err) {
      console.error('Failed to load older messages:', err);
    }
  };

  /* --- The composer seams ------------------------------------------------- */

  const uploadFile = (file) => chatService.uploadChatAttachment(activeId, file);

  const submitStreamMessage = async (payload) => {
    const message = await chatService.sendMessage(activeId, { ...payload, replyTo: null });
    stickToBottom.current = true;
    setPane((prev) =>
      prev && String(prev.channelId) === String(activeId)
        ? { ...prev, messages: [...(prev.messages || []), message] }
        : prev
    );
    return message;
  };

  const submitThreadReply = async (payload) => {
    const message = await chatService.sendMessage(activeId, {
      ...payload,
      replyTo: threadId,
    });
    setThreadPane((prev) =>
      prev && String(prev.threadId) === String(threadId)
        ? { ...prev, replies: [...(prev.replies || []), message] }
        : prev
    );
    // Keep the list's reply count honest without a refetch.
    setPane((prev) =>
      prev && prev.mode === 'mail'
        ? {
            ...prev,
            threads: (prev.threads || []).map((t) =>
              String(t._id) === String(threadId)
                ? { ...t, replyCount: (t.replyCount || 0) + 1, lastAt: message.createdAt }
                : t
            ),
          }
        : prev
    );
    return message;
  };

  const submitNewThread = async (payload) => {
    const trimmed = subject.trim();
    if (!trimmed) {
      // The server refuses a subjectless thread; saying so here keeps the typed
      // body rather than spending it on a 400.
      throw new Error('A subject is required.');
    }
    const message = await chatService.createThread(activeId, {
      ...payload,
      subject: trimmed,
      replyTo: null,
    });
    setComposeOpen(false);
    setSubject('');
    setPane((prev) =>
      prev && String(prev.channelId) === String(activeId) && prev.mode === 'mail'
        ? {
            ...prev,
            threads: [
              {
                _id: message._id,
                subject: trimmed,
                snippet: (message.bodyText || '').slice(0, 120),
                participants: message.author ? [{ name: message.author.name }] : [],
                replyCount: 0,
                lastAt: message.createdAt,
                createdAt: message.createdAt,
                unread: false,
              },
              ...(prev.threads || []),
            ],
          }
        : prev
    );
    return message;
  };

  /* --- Message actions ---------------------------------------------------- */

  const handleDelete = async (message) => {
    if (!window.confirm('Delete this message?')) return;
    try {
      await chatService.deleteMessage(activeId, message._id);
      setPane((prev) =>
        prev && prev.mode === 'chat'
          ? {
              ...prev,
              messages: (prev.messages || []).filter(
                (m) => String(m._id) !== String(message._id)
              ),
            }
          : prev
      );
      setThreadPane((prev) =>
        prev
          ? {
              ...prev,
              replies: (prev.replies || []).filter(
                (r) => String(r._id) !== String(message._id)
              ),
            }
          : prev
      );
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not delete the message.');
    }
  };

  const handleMakeTask = async (message) => {
    try {
      const { task } = await chatService.makeTaskFromMessage(activeId, message._id);
      toast.success(`Task created: ${task.name}`);
      // Cheapest correct refresh of the chip: re-read the conversation the
      // message is in, rather than patching a populated shape by hand.
      const res = await chatService.getMessages(activeId);
      setPane((prev) =>
        prev && String(prev.channelId) === String(activeId) && prev.mode === 'chat'
          ? { ...prev, messages: [...res.messages].reverse(), nextBefore: res.nextBefore }
          : prev
      );
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not create the task.');
    }
  };

  const handleOpenChip = (kind, item) => {
    if (kind !== 'task') return;
    navigate(`/boards/${boardId}?highlightTask=${item._id}`);
  };

  /* --- Setup ------------------------------------------------------------- */

  const handleCreateSurfaces = async (selection) => {
    const res = await chatService.createSurfaces(boardId, setupGroup._id, selection);
    const fresh = await loadChannels();
    setSetupGroup(null);
    const first = (res.created || [])[0] || (res.existing || [])[0];
    if (first && fresh) openSurface(first);
  };

  /* --- Render ------------------------------------------------------------- */

  const canManage = !!data?.canManage;
  // Mirrors the server's `isLiveClientBoard` (utils/clientBoard.js): a client
  // board AND a portal that is switched on. Unknown counts as allowed, because
  // hiding a legal choice from someone we simply could not ask is worse than
  // the round trip the server would refuse anyway.
  const allowClientSurfaces =
    isClientBoard && (portalLiveFromPayload ?? portalLive) !== false;
  const canPost = paneReady ? pane.canPost !== false : false;
  const composerProps = {
    uploadFile,
    mentionUsers: boardMembers,
    compact: true,
  };

  /**
   * The rich composer keeps its own body in every skin; only the box around it
   * changes. WhatsApp's is a white pill sitting on the grey bar. Gmail's two
   * boxes — the reply card and the docked window — draw their own chrome in
   * `conversations.css`, so this is the only shell that needs a helper.
   */
  const waShell = (children) => (
    <div style={{ background: '#ffffff', borderRadius: 8, overflow: 'visible' }}>{children}</div>
  );
  /** Gmail's "to" line. The message knows who wrote it; only the room knows who
   *  it went to, which is why this is resolved here and passed down. */
  const clientLabel =
    (clientName || data?.board?.portalClientName || '').trim() || 'the client';
  const recipientFor = (m) => {
    if (m?.authorType === 'client') return 'to me';
    return activeChannel?.audience === 'client' ? `to ${clientLabel}` : 'to the team';
  };

  if (loadError) {
    return (
      <p className="font-body py-8 text-center text-[13px] text-[color:var(--color-status-stuck)]">
        {loadError}
      </p>
    );
  }

  if (!data) {
    return (
      <p className="font-body py-8 text-center text-[13px] text-[color:var(--color-text-muted)]">
        Loading conversations…
      </p>
    );
  }

  return (
    <div
      className="flex"
      style={{
        height: 'clamp(440px, 66vh, 760px)',
        border:
          onlyGroupId && activeChannel
            ? `2px solid ${
              activeChannel.audience === 'client'
                ? 'var(--color-accent)'
                : 'var(--color-border-strong)'
            }`
            : '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        background: '#FFFFFF',
        overflow: 'hidden',
      }}
    >
      {/* Rail — full width on a phone until a surface is opened */}
      <div
        className={[
          'flex-col overflow-y-auto shrink-0 w-full md:w-[240px]',
          activeId ? 'hidden md:flex' : 'flex',
        ].join(' ')}
        style={{ borderRight: '1px solid var(--color-border)' }}
      >
        {workstreams.length === 0 && (
          <p className="font-body px-3 py-6 text-[12.5px] text-[color:var(--color-text-muted)]">
            This board has no workstreams yet. Add a group and its conversations
            can be set up here.
          </p>
        )}
        {workstreams.map((ws) => (
          <div key={ws.group._id}>
            {/* Scoped to one service, the SERVICE name is already the pane
                title, so the rail labels by AUDIENCE instead — which is the
                distinction that actually matters here. */}
            {onlyGroupId ? (
              <RailLabel>
                {(clientName || '').trim() || 'The client'} is in these
              </RailLabel>
            ) : (
              <RailLabel>{ws.group.name}</RailLabel>
            )}
            {(ws.surfaces || []).length > 0 ? (
              (onlyGroupId
                ? [
                  ...ws.surfaces.filter((c) => c.audience === 'client'),
                  ...ws.surfaces.filter((c) => c.audience !== 'client'),
                ]
                : ws.surfaces
              ).map((c, i, arr) => (
                <React.Fragment key={c._id}>
                  {/* The one genuinely dangerous confusion on a client board is
                      posting in the client room believing it is the team room.
                      A labelled break is the first of four redundant signals;
                      the pane's border, its banner and the composer placeholder
                      are the others. */}
                  {onlyGroupId
                    && c.audience !== 'client'
                    && (i === 0 || arr[i - 1].audience === 'client') && (
                    <RailLabel>Private to us</RailLabel>
                  )}
                  <SurfaceRow
                    channel={c}
                    active={String(c._id) === String(activeId)}
                    onClick={() => openSurface(c)}
                  />
                </React.Fragment>
              ))
            ) : canManage ? (
              <button
                type="button"
                onClick={() => setSetupGroup(ws.group)}
                className="font-body flex items-center gap-1.5 mx-3 mb-1 transition-colors hover:bg-[color:var(--color-accent-light)]"
                style={{
                  height: 28,
                  padding: '0 8px',
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: 'var(--color-accent)',
                  border: '1px dashed var(--color-accent)',
                  borderRadius: 'var(--radius-md)',
                  background: 'transparent',
                  width: 'calc(100% - 24px)',
                }}
              >
                <Plus size={12} aria-hidden="true" className="shrink-0" />
                Set up communication
              </button>
            ) : (
              <p
                className="font-body px-3 pb-1"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
              >
                No conversations yet.
              </p>
            )}
          </div>
        ))}
        {extras.length > 0 && (
          <>
            <RailLabel>Other</RailLabel>
            {extras.map((c) => (
              <SurfaceRow
                key={c._id}
                channel={c}
                active={String(c._id) === String(activeId)}
                onClick={() => openSurface(c)}
              />
            ))}
          </>
        )}
      </div>

      {/* Conversation */}
      <div
        className={[
          'flex-1 min-w-0 flex-col',
          activeId ? 'flex' : 'hidden md:flex',
        ].join(' ')}
        style={{ minHeight: 0 }}
      >
        {!activeChannel ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
            <div
              className="flex items-center justify-center"
              style={{
                width: 52,
                height: 52,
                borderRadius: 'var(--radius-full)',
                background: 'var(--color-accent-light)',
              }}
            >
              <MessageCircle size={24} color="var(--color-accent)" aria-hidden="true" />
            </div>
            <p className="font-body font-medium text-[14px] text-[color:var(--color-text-primary)]">
              Pick a workstream to start talking
            </p>
            <p
              className="font-body text-[12.5px] text-[color:var(--color-text-muted)] text-center"
              style={{ maxWidth: 340 }}
            >
              Each workstream can have a client chat, a client mailbox, and a
              private team room — whichever the work actually needs.
            </p>
          </div>
        ) : (
          <>
            {/* WHO IS IN THIS ROOM — stated before anything else, and repeated
                by the composer placeholder further down. A team member scanning
                for "can the client see this?" must not have to look for it. */}
            <div
              className="font-body flex items-center gap-2 px-3 shrink-0"
              style={{
                height: 30,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.04em',
                color:
                  activeChannel.audience === 'client'
                    ? 'var(--color-accent-text)'
                    : 'var(--color-text-secondary)',
                background:
                  activeChannel.audience === 'client'
                    ? 'var(--color-accent-light)'
                    : 'var(--color-bg-subtle)',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              {activeChannel.audience === 'client' ? (
                <>
                  <Eye size={12} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">
                    {((clientName || data.board?.portalClientName || 'THE CLIENT') + '')
                      .toUpperCase()}{' '}
                    IS IN THIS {activeChannel.mode === 'mail' ? 'MAILBOX' : 'ROOM'}
                  </span>
                </>
              ) : (
                <>
                  <Lock size={12} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">
                    PRIVATE — THE CLIENT IS NEVER IN THIS ROOM
                  </span>
                </>
              )}
            </div>

            {/* Header */}
            <div
              className="flex items-center gap-2 px-3 shrink-0"
              style={{ height: 46, borderBottom: '1px solid var(--color-border)' }}
            >
              <button
                type="button"
                onClick={() => setActiveId(null)}
                aria-label="Back to workstreams"
                className="md:hidden flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
                style={{ width: 30, height: 30 }}
              >
                <ChevronLeft size={18} color="var(--color-text-secondary)" aria-hidden="true" />
              </button>
              {activeChannel.mode === 'mail' ? (
                <Mail size={13} color="var(--color-text-muted)" aria-hidden="true" className="shrink-0" />
              ) : (
                <Hash size={13} color="var(--color-text-muted)" aria-hidden="true" className="shrink-0" />
              )}
              <p className="font-body font-bold text-[14px] text-[color:var(--color-text-primary)] truncate">
                {activeChannel.name}
              </p>
              {activeChannel.audience === 'client' && <ClientPill />}
              <span className="flex-1" />
            </div>

            {!paneReady ? (
              <p className="font-body text-center py-8 text-[13px] text-[color:var(--color-text-muted)]">
                Loading…
              </p>
            ) : pane.error ? (
              <p className="font-body text-center py-8 text-[13px] text-[color:var(--color-status-stuck)]">
                {pane.error}
              </p>
            ) : pane.mode === 'mail' ? (
              /* ---- The mailbox: GMAIL, the team's side of the same view the
                     client is looking at in their portal ---- */
              threadId ? (() => {
                const ready = threadPane && String(threadPane.threadId) === String(threadId);
                const all = ready && !threadPane.error
                  ? [threadPane.parent, ...(threadPane.replies || [])].filter(Boolean)
                  : [];
                // Gmail's habit: the newest two stay open, everything before
                // them folds behind one counted pill. A short conversation is
                // never folded at all.
                const autoFrom = all.length > 3 ? all.length - 2 : 0;
                const openAt = (m, i) => {
                  const k = String(m._id);
                  return foldOverrides.has(k) ? foldOverrides.get(k) : i >= autoFrom;
                };
                const hidden = all.slice(0, autoFrom).filter((m, i) => !openAt(m, i));
                const toggle = (m, i) => setFoldOverrides((prev) => {
                  const next = new Map(prev);
                  next.set(String(m._id), !openAt(m, i));
                  return next;
                });
                const subjectText =
                  threadPane?.parent?.subject
                  || (pane.threads || []).find((t) => String(t._id) === String(threadId))?.subject
                  || '(no subject)';

                return (
                  <div className="gm" style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}>
                    <div className="gm-read-head">
                      <button
                        type="button"
                        onClick={() => { setThreadId(null); setThreadPane(null); }}
                        aria-label="Back to the mailbox"
                        title="Back to the mailbox"
                        className="gm-iconbtn"
                      >
                        <ChevronLeft size={20} aria-hidden="true" />
                      </button>
                    </div>

                    <div className="gm-thread">
                      <h2 className="gm-subject">
                        {subjectText}
                        {all.length > 1 && <span className="gm-subject-n">{all.length}</span>}
                      </h2>

                      {!ready ? (
                        <div className="gm-empty">Loading…</div>
                      ) : threadPane.error ? (
                        <div className="gm-empty">
                          <p className="gm-empty-t">This conversation didn’t load</p>
                          <p>{threadPane.error}</p>
                        </div>
                      ) : (
                        <>
                          {hidden.length > 0 && (
                            <div className="gm-fold">
                              <button
                                type="button"
                                className="gm-fold-btn"
                                title="Show trimmed content"
                                aria-label={`Show ${hidden.length} earlier ${hidden.length === 1 ? 'message' : 'messages'}`}
                                onClick={() => setFoldOverrides(
                                  new Map(all.map((m) => [String(m._id), true]))
                                )}
                              >
                                <MoreHorizontal size={14} aria-hidden="true" /> {hidden.length}
                              </button>
                              <span className="gm-fold-rule" />
                            </div>
                          )}

                          {all.map((m, i) => (
                            <MessageItem
                              key={m._id}
                              variant="gmail"
                              collapsed={!openAt(m, i)}
                              onToggle={() => toggle(m, i)}
                              recipient={recipientFor(m)}
                              message={m}
                              currentUserId={currentUser?._id}
                              canManage={pane.canManage}
                              canMakeTask={canPost && i === 0}
                              onReply={null}
                              onDelete={handleDelete}
                              onMakeTask={handleMakeTask}
                              onOpenChip={handleOpenChip}
                            />
                          ))}

                          {canPost && !replyOpen && (
                            <div className="gm-actions">
                              <button type="button" className="gm-pill" onClick={() => setReplyOpen(true)}>
                                <CornerUpLeft size={18} aria-hidden="true" /> Reply
                              </button>
                            </div>
                          )}

                          {canPost && replyOpen && (
                            <div className="gm-replybox">
                              <div className="gm-replybox-head">
                                <CornerUpLeft size={16} aria-hidden="true" />
                                <span>
                                  {activeChannel.audience === 'client'
                                    ? `Reply to ${clientLabel}`
                                    : 'Reply (private to the team)'}
                                </span>
                                <button
                                  type="button"
                                  className="gm-iconbtn"
                                  style={{ marginLeft: 'auto', width: 28, height: 28 }}
                                  onClick={() => setReplyOpen(false)}
                                  aria-label="Close the reply"
                                >
                                  <X size={16} aria-hidden="true" />
                                </button>
                              </div>
                              <UpdateComposer
                                key={`board-mail-reply:${threadId}`}
                                draftKey={`board-mail-reply:${threadId}`}
                                submitMessage={submitThreadReply}
                                placeholder=""
                                submitLabel="Send"
                                {...composerProps}
                              />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })() : (() => {
                const q = mailQuery.trim().toLowerCase();
                const rows = q
                  ? (pane.threads || []).filter((t) => {
                    const people = (t.participants || []).map((p) => p?.name || '').join(' ');
                    return `${t.subject || ''} ${t.snippet || ''} ${people}`.toLowerCase().includes(q);
                  })
                  : (pane.threads || []);

                return (
                  <div className="gm" style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}>
                    <div className="gm-bar">
                      {canPost && (
                        <button
                          type="button"
                          className="gm-compose-btn"
                          style={{ marginRight: 10 }}
                          onClick={() => setComposeOpen(true)}
                        >
                          <PenSquare size={18} aria-hidden="true" /> Compose
                        </button>
                      )}
                      {/* Client-side, over what is loaded — which is what the
                          placeholder says, so nobody reads an empty result as
                          "this conversation does not exist". */}
                      <div className="gm-search" style={{ flex: '1 1 160px', minWidth: 140, margin: 0 }}>
                        <Search size={18} aria-hidden="true" />
                        <input
                          type="search"
                          value={mailQuery}
                          placeholder="Search this mailbox"
                          aria-label="Search this mailbox"
                          onChange={(e) => setMailQuery(e.target.value)}
                        />
                        {mailQuery && (
                          <button
                            type="button"
                            className="gm-iconbtn"
                            onClick={() => setMailQuery('')}
                            aria-label="Clear the search"
                          >
                            <X size={18} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        className="gm-iconbtn"
                        onClick={() => loadChannels()}
                        aria-label="Refresh"
                        title="Refresh"
                      >
                        <RefreshCw size={18} aria-hidden="true" />
                      </button>
                    </div>

                    {rows.length === 0 ? (
                      <div className="gm-empty">
                        <Inbox size={40} style={{ opacity: 0.35, marginBottom: 12 }} aria-hidden="true" />
                        {q ? (
                          <>
                            <p className="gm-empty-t">No conversations match “{mailQuery}”</p>
                            <p>Search looks at the conversations already loaded here.</p>
                          </>
                        ) : (
                          <>
                            <p className="gm-empty-t">Nothing in this mailbox yet</p>
                            <p>Compose the first one — it needs a subject line.</p>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="gm-list">
                        {rows.map((t) => (
                          <ThreadRow
                            key={t._id}
                            thread={t}
                            active={String(t._id) === String(threadId)}
                            onClick={() => {
                              setThreadId(String(t._id));
                              setThreadPane(null);
                              setPane((prev) =>
                                prev && prev.mode === 'mail'
                                  ? {
                                    ...prev,
                                    threads: (prev.threads || []).map((x) =>
                                      String(x._id) === String(t._id)
                                        ? { ...x, unread: false }
                                        : x
                                    ),
                                  }
                                  : prev
                              );
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()
            ) : (
              /* ---- One running room: WHATSAPP, the same bubbles the client
                     sees on their side of it ---- */
              <div className="wa" style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <div ref={feedRef} onScroll={handleFeedScroll} className="wa-scroll">
                  {pane.nextBefore && (
                    <div className="wa-older">
                      <button type="button" onClick={loadOlder}>Load earlier messages</button>
                    </div>
                  )}

                  {messages.length === 0 ? (
                    <div className="wa-center">
                      <span className="wa-center-card">Nothing here yet — say hello.</span>
                    </div>
                  ) : (
                    (() => {
                      let lastDay = '';
                      let previous = null;
                      return messages.map((m) => {
                        const key = dayKey(m.createdAt);
                        const divider = key && key !== lastDay;
                        lastDay = key || lastDay;

                        // A run is the same person, on the same side, within
                        // five minutes, uninterrupted by a date divider. Only
                        // the first bubble of one gets the tail and the name.
                        const sameAuthor =
                          previous &&
                          previous.authorType === m.authorType &&
                          String(previous.author?._id || previous.portalAuthor?._id || '') ===
                            String(m.author?._id || m.portalAuthor?._id || '');
                        const run =
                          !divider &&
                          sameAuthor &&
                          m.authorType !== 'system' &&
                          new Date(m.createdAt) - new Date(previous.createdAt) < 5 * 60 * 1000;
                        previous = m;

                        return (
                          <div key={m._id}>
                            {divider && <div className="wa-day">{waDayLabel(m.createdAt)}</div>}
                            <MessageItem
                              variant="whatsapp"
                              tail={!run}
                              message={m}
                              currentUserId={currentUser?._id}
                              canManage={pane.canManage}
                              canMakeTask={canPost}
                              onReply={null}
                              onDelete={handleDelete}
                              onMakeTask={handleMakeTask}
                              onOpenChip={handleOpenChip}
                            />
                          </div>
                        );
                      });
                    })()
                  )}
                </div>

                {canPost && (
                  <div className="wa-foot">
                    {waShell(
                      <UpdateComposer
                        key={`board-chat:${activeId}`}
                        draftKey={`board-chat:${activeId}`}
                        submitMessage={submitStreamMessage}
                        // The fourth redundant "who sees this" signal, and the
                        // one that is under the cursor at the moment it matters.
                        placeholder={
                          activeChannel.audience === 'client'
                            ? `Message ${clientLabel} here…`
                            : 'Message the team (private)…'
                        }
                        submitLabel="Send"
                        {...composerProps}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>


      {/* GMAIL'S COMPOSE WINDOW: docked to the bottom-right of the viewport,
          not inlined above the list, so the conversations stay readable behind
          whatever is being written. Same window the client gets in their
          portal. Fixed positioning is deliberate — it is what makes it a
          window rather than a panel. */}
      {composeOpen && activeChannel?.mode === 'mail' && canPost && (
        <div className="gm gm-compose" role="dialog" aria-label="New message">
          <div className="gm-compose-head">
            <span className="gm-compose-title">New message</span>
            <button
              type="button"
              className="gm-compose-x"
              onClick={() => setComposeOpen(false)}
              aria-label="Close"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="gm-compose-body">
            <div className="gm-compose-to">
              To <b>{activeChannel.audience === 'client' ? clientLabel : 'the team'}</b>
            </div>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              maxLength={200}
              aria-label="Subject"
              className="gm-subject-field"
            />
            <UpdateComposer
              key={`board-mail-new:${activeId}`}
              draftKey={`board-mail-new:${activeId}`}
              submitMessage={submitNewThread}
              placeholder=""
              submitLabel="Send"
              {...composerProps}
            />
          </div>
        </div>
      )}

      {/* Mounted only while open, so each visit starts from a clean selection
          rather than whatever was ticked and abandoned last time. */}
      {setupGroup && (
        <SetUpCommunicationModal
          isOpen
          onClose={() => setSetupGroup(null)}
          groupName={setupGroup.name}
          clientName={data.board?.portalClientName || data.board?.name}
          existingKeys={
            workstreams.find((w) => String(w.group._id) === String(setupGroup._id))
              ?.surfaceKeys || []
          }
          allowClientSurfaces={allowClientSurfaces}
          onCreate={handleCreateSurfaces}
        />
      )}
    </div>
  );
};

export default BoardChatTab;

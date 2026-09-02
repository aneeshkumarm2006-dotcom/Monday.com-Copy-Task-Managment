import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Hash,
  ChevronLeft,
  MessageSquare,
  MessageCircle,
  Plus,
  X,
  Trash2,
  CheckSquare,
  Target,
  Archive,
} from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import UpdateComposer from '../components/board/UpdateComposer';
import { ReadOnlyRichBody } from '../components/board/UpdatesTab';
import AttachmentList from '../components/board/AttachmentList';
import Avatar from '../components/ui/Avatar';
import Modal from '../components/ui/Modal';
import useChatStore from '../store/chatStore';
import useOrgStore from '../store/orgStore';
import useAuthStore from '../store/authStore';
import useToastStore from '../store/toastStore';
import usePermissions from '../hooks/usePermissions';
import * as chatService from '../services/chatService';
import * as taskService from '../services/taskService';
import * as goalService from '../services/goalService';
import { timeAgo } from '../utils/dateUtils';

/**
 * Chat — Phase 1. Channels sectioned by board (one per client, auto-created
 * from the tracker roster) plus workspace-wide rooms.
 *
 * Desktop is two panes plus a thread panel; a phone shows exactly one screen
 * at a time — list, conversation, or thread — with the composer docked at the
 * bottom, per the mobile design.
 *
 * The composer is the SAME UpdateComposer the task panel uses (editor,
 * drafts, attachments, @mentions), pointed at the chat API through its
 * submitMessage/uploadFile seams. One editor everywhere, one set of habits.
 *
 * Chat never writes a score: the share chips let a room point at a task or a
 * goal, and pointing is all they do.
 */

/* ------------------------------------------------------------------ */
/* Channel sidebar                                                     */
/* ------------------------------------------------------------------ */

const ChannelRow = ({ channel, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline-none focus-visible:bg-[color:var(--color-bg-subtle)]"
    style={{
      borderRadius: 'var(--radius-md)',
      background: active ? 'var(--color-accent-light)' : 'transparent',
    }}
  >
    <Hash
      size={15}
      color={active ? 'var(--color-accent)' : 'var(--color-text-muted)'}
      aria-hidden="true"
      className="shrink-0"
    />
    <span className="flex-1 min-w-0">
      <span
        className="font-body block truncate"
        style={{
          fontSize: 13.5,
          fontWeight: channel.unread > 0 || active ? 600 : 500,
          color: active
            ? 'var(--color-accent)'
            : 'var(--color-text-primary)',
        }}
      >
        {channel.name}
      </span>
      {channel.lastMessage?.text ? (
        <span
          className="font-body block truncate"
          style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
        >
          {channel.lastMessage.authorName
            ? `${channel.lastMessage.authorName}: `
            : ''}
          {channel.lastMessage.text}
        </span>
      ) : null}
    </span>
    {channel.unread > 0 && (
      <span
        className="shrink-0 flex items-center justify-center font-body font-bold text-white"
        style={{
          minWidth: 18,
          height: 18,
          padding: '0 5px',
          borderRadius: 999,
          fontSize: 10.5,
          background: 'var(--color-accent)',
        }}
      >
        {channel.unread > 99 ? '99+' : channel.unread}
      </span>
    )}
  </button>
);

const ChannelSidebar = ({ channels, activeChannelId, onOpen, onCreate, canCreate, loading }) => {
  // Sections: workspace rooms first, then one section per board.
  const sections = useMemo(() => {
    const workspace = channels.filter((c) => !c.board);
    const byBoard = new Map();
    channels
      .filter((c) => c.board)
      .forEach((c) => {
        const key = c.board._id;
        if (!byBoard.has(key)) byBoard.set(key, { name: c.board.name, channels: [] });
        byBoard.get(key).channels.push(c);
      });
    return { workspace, boards: [...byBoard.values()] };
  }, [channels]);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <span className="font-display font-bold text-[16px] text-[color:var(--color-text-primary)]">
          Chat
        </span>
        {canCreate && (
          <button
            type="button"
            onClick={onCreate}
            aria-label="New channel"
            title="New workspace channel"
            className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{ width: 28, height: 28 }}
          >
            <Plus size={16} color="var(--color-text-secondary)" aria-hidden="true" />
          </button>
        )}
      </div>

      {loading && channels.length === 0 ? (
        <p className="font-body px-4 py-6 text-[13px] text-[color:var(--color-text-muted)]">
          Loading channels…
        </p>
      ) : channels.length === 0 ? (
        <p className="font-body px-4 py-6 text-[13px] text-[color:var(--color-text-muted)]">
          No channels yet. Client channels appear automatically when a tracker
          board has groups.
        </p>
      ) : (
        <div className="px-2 py-2 flex flex-col gap-0.5">
          {sections.workspace.length > 0 && (
            <>
              <p className="font-body font-semibold px-3 pt-2 pb-1 uppercase tracking-wide text-[11px] text-[color:var(--color-text-muted)]">
                Workspace
              </p>
              {sections.workspace.map((c) => (
                <ChannelRow
                  key={c._id}
                  channel={c}
                  active={String(c._id) === String(activeChannelId)}
                  onClick={() => onOpen(c)}
                />
              ))}
            </>
          )}
          {sections.boards.map((section) => (
            <div key={section.name}>
              <p className="font-body font-semibold px-3 pt-3 pb-1 uppercase tracking-wide text-[11px] text-[color:var(--color-text-muted)] truncate">
                {section.name}
              </p>
              {section.channels.map((c) => (
                <ChannelRow
                  key={c._id}
                  channel={c}
                  active={String(c._id) === String(activeChannelId)}
                  onClick={() => onOpen(c)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Share chips                                                         */
/* ------------------------------------------------------------------ */

/** A rendered task/goal reference on a message. Pointing is all it does. */
const ShareChip = ({ icon: Icon, label, sub, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center gap-2 max-w-full text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
    style={{
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      padding: '6px 10px',
      background: 'var(--color-bg-surface)',
      cursor: onClick ? 'pointer' : 'default',
    }}
  >
    <Icon size={14} color="var(--color-accent)" aria-hidden="true" className="shrink-0" />
    <span className="min-w-0">
      <span
        className="font-body block truncate"
        style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}
      >
        {label}
      </span>
      {sub ? (
        <span className="font-body block truncate" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {sub}
        </span>
      ) : null}
    </span>
  </button>
);

/**
 * The picker behind the composer's "Share task / Share goal" buttons.
 * Board channels only; lists the channel's own board (scoped to the client's
 * group when the channel is a client channel).
 */
const SharePicker = ({ kind, channel, onPick, onClose }) => {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (kind === 'task') {
          const tasks = await taskService.getTasks(channel.board._id, {
            group: channel.group || undefined,
          });
          if (!cancelled) setItems(tasks.filter((t) => !t.parent));
        } else {
          const goals = await goalService.getGoals(channel.board._id);
          if (!cancelled) {
            const list = Array.isArray(goals) ? goals : [];
            setItems(
              channel.group
                ? list.filter((g) => String(g.group?._id || g.group) === String(channel.group))
                : list
            );
          }
        }
      } catch (err) {
        console.error('Share picker load failed:', err);
        if (!cancelled) setError('Could not load the list.');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [kind, channel]);

  return (
    <div
      className="absolute bottom-full left-0 mb-2 bg-white overflow-y-auto z-20"
      style={{
        width: 320,
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 280,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 sticky top-0 bg-white"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <span className="font-body font-semibold text-[12px] text-[color:var(--color-text-primary)]">
          {kind === 'task' ? 'Share a task' : 'Share a goal'}
        </span>
        <button type="button" onClick={onClose} aria-label="Close">
          <X size={14} color="var(--color-text-muted)" />
        </button>
      </div>
      {error ? (
        <p className="font-body px-3 py-4 text-[12.5px] text-[color:var(--color-text-muted)]">{error}</p>
      ) : items === null ? (
        <p className="font-body px-3 py-4 text-[12.5px] text-[color:var(--color-text-muted)]">Loading…</p>
      ) : items.length === 0 ? (
        <p className="font-body px-3 py-4 text-[12.5px] text-[color:var(--color-text-muted)]">
          Nothing to share here yet.
        </p>
      ) : (
        items.map((item) => (
          <button
            key={item._id}
            type="button"
            onClick={() => onPick(item)}
            className="w-full text-left px-3 py-2 font-body text-[13px] text-[color:var(--color-text-primary)] truncate transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
          >
            {item.name}
          </button>
        ))
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

const MessageItem = ({ message, currentUserId, canManage, onReply, onDelete, onOpenChip }) => {
  const isOwn = String(message.author?._id) === String(currentUserId);
  return (
    <div className="group flex items-start gap-3 px-4 py-2 hover:bg-[color:var(--color-bg-subtle)] rounded-lg">
      <span className="mt-0.5 shrink-0">
        <Avatar user={message.author} size={30} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="font-body font-semibold truncate"
            style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
          >
            {message.author?.name || 'Unknown'}
          </span>
          <span className="font-body shrink-0" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
            {timeAgo(message.createdAt)}
            {message.editedAt ? ' · edited' : ''}
          </span>
        </div>

        <div className="font-body text-[13.5px] text-[color:var(--color-text-primary)]">
          <ReadOnlyRichBody body={message.body} fallbackText={message.bodyText} />
        </div>

        {(message.task || message.goal) && (
          <div className="flex flex-wrap gap-2 mt-1.5">
            {message.task && (
              <ShareChip
                icon={CheckSquare}
                label={message.task.name}
                sub="Task"
                onClick={() => onOpenChip('task', message.task)}
              />
            )}
            {message.goal && (
              <ShareChip
                icon={Target}
                label={message.goal.name}
                sub={`Goal${message.goal.monthKey ? ` · ${message.goal.monthKey}` : ''}`}
                onClick={() => onOpenChip('goal', message.goal)}
              />
            )}
          </div>
        )}

        {message.attachments?.length > 0 && (
          <div className="mt-1.5">
            <AttachmentList attachments={message.attachments} compact />
          </div>
        )}

        <div className="flex items-center gap-3 mt-1">
          {onReply && (
            <button
              type="button"
              onClick={() => onReply(message)}
              className="font-body inline-flex items-center gap-1 transition-colors hover:text-[color:var(--color-accent)]"
              style={{
                fontSize: 12,
                fontWeight: message.replyCount > 0 ? 600 : 500,
                color:
                  message.replyCount > 0
                    ? 'var(--color-accent)'
                    : 'var(--color-text-muted)',
              }}
            >
              <MessageSquare size={12} aria-hidden="true" />
              {message.replyCount > 0
                ? `${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}`
                : 'Reply'}
            </button>
          )}
          {(isOwn || canManage) && (
            <button
              type="button"
              onClick={() => onDelete(message)}
              aria-label="Delete message"
              className="font-body inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity hover:text-[color:var(--color-status-stuck)]"
              style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            >
              <Trash2 size={12} aria-hidden="true" />
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

const ChatPage = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentUser = useAuthStore((s) => s.user);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const orgId = currentOrg?._id || null;
  const { can } = usePermissions();
  const toast = useToastStore.getState();

  const channels = useChatStore((s) => s.channels);
  const channelsLoading = useChatStore((s) => s.channelsLoading);
  const fetchChannels = useChatStore((s) => s.fetchChannels);
  const activeChannelId = useChatStore((s) => s.activeChannelId);
  const messages = useChatStore((s) => s.messages);
  const messagesLoading = useChatStore((s) => s.messagesLoading);
  const nextBefore = useChatStore((s) => s.nextBefore);
  const canPost = useChatStore((s) => s.canPost);
  const canManage = useChatStore((s) => s.canManage);
  const thread = useChatStore((s) => s.thread);
  const threadLoading = useChatStore((s) => s.threadLoading);
  const openChannel = useChatStore((s) => s.openChannel);
  const closeChannel = useChatStore((s) => s.closeChannel);
  const openThread = useChatStore((s) => s.openThread);
  const closeThread = useChatStore((s) => s.closeThread);
  const loadOlder = useChatStore((s) => s.loadOlder);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [sharePicker, setSharePicker] = useState(null); // 'task' | 'goal' | null
  const [pendingChip, setPendingChip] = useState(null); // { kind, item }

  const feedRef = useRef(null);
  const stickToBottom = useRef(true);

  const activeChannel = useMemo(
    () => channels.find((c) => String(c._id) === String(activeChannelId)) || null,
    [channels, activeChannelId]
  );

  // Load the sidebar for the current workspace.
  useEffect(() => {
    if (orgId) fetchChannels(orgId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // Deep link: /chat?channel=<id> (from a mention notification, or a refresh).
  const channelParam = searchParams.get('channel');
  useEffect(() => {
    if (channelParam && String(channelParam) !== String(activeChannelId)) {
      openChannel(channelParam);
    }
    if (!channelParam && activeChannelId) {
      closeChannel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelParam]);

  // Leaving the page closes the conversation (so live messages badge again).
  useEffect(() => () => closeChannel(), [closeChannel]);

  // Keep the feed pinned to the newest message unless the user scrolled up.
  useEffect(() => {
    const el = feedRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, messagesLoading]);

  const handleFeedScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && nextBefore) loadOlder();
  };

  const handleOpenChannel = (channel) => {
    stickToBottom.current = true;
    setSearchParams({ channel: channel._id });
  };

  const handleBackToList = () => {
    setSearchParams({});
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      await chatService.createChannel(orgId, { name });
      setCreateOpen(false);
      setNewName('');
      fetchChannels(orgId);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not create the channel.');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (message) => {
    if (!window.confirm('Delete this message?')) return;
    try {
      await deleteMessage(message._id);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not delete the message.');
    }
  };

  const handleOpenChip = (kind, item) => {
    const boardId = activeChannel?.board?._id;
    if (!boardId) return;
    if (kind === 'task') {
      navigate(`/boards/${boardId}?highlightTask=${item._id}`);
    } else {
      navigate(`/boards/${boardId}?view=goals`);
    }
  };

  // The composer seams: the same editor as task updates, posting to chat.
  const submitTopLevel = async (payload) => {
    const message = await sendMessage({
      ...payload,
      replyTo: null,
      taskId: pendingChip?.kind === 'task' ? pendingChip.item._id : null,
      goalId: pendingChip?.kind === 'goal' ? pendingChip.item._id : null,
    });
    setPendingChip(null);
    stickToBottom.current = true;
    return message;
  };
  const submitReply = (parentId) => async (payload) =>
    sendMessage({ ...payload, replyTo: parentId, taskId: null, goalId: null });
  const uploadFile = (file) => chatService.uploadChatAttachment(activeChannelId, file);

  const isBoardChannel = !!activeChannel?.board;
  const canCreateChannel = can('org.manage_settings');

  const conversationOpen = !!activeChannelId;
  const threadOpen = !!thread;

  // !pb-0: chat sizes its own bottom edge (the docked composer already clears
  // the tab bar), so PageWrapper's mobile spacer would just add a dead strip
  // of scroll under the conversation.
  return (
    <PageWrapper padded={false} className="!pb-0">
      <div className="macan-chat-shell flex" style={{ minHeight: 0 }}>
        {/* Sidebar — full-screen list on phones until a channel is opened */}
        <div
          className={[
            'macan-chat-sidebar shrink-0',
            conversationOpen ? 'hidden md:flex' : 'flex',
          ].join(' ')}
          style={{
            flexDirection: 'column',
            borderRight: '1px solid var(--color-border)',
            background: 'var(--color-bg-surface)',
          }}
        >
          <ChannelSidebar
            channels={channels}
            activeChannelId={activeChannelId}
            onOpen={handleOpenChannel}
            onCreate={() => setCreateOpen(true)}
            canCreate={canCreateChannel}
            loading={channelsLoading}
          />
        </div>

        {/* Conversation */}
        <div
          className={[
            'flex-1 min-w-0 flex-col',
            conversationOpen ? 'flex' : 'hidden md:flex',
            threadOpen ? 'hidden lg:flex' : '',
          ].join(' ')}
          style={{ background: 'var(--color-bg-base)', minHeight: 0 }}
        >
          {!conversationOpen ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
              <div
                className="flex items-center justify-center"
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 'var(--radius-full)',
                  background: 'var(--color-accent-light)',
                }}
              >
                <MessageCircle size={26} color="var(--color-accent)" aria-hidden="true" />
              </div>
              <p className="font-body font-medium text-[14px] text-[color:var(--color-text-primary)]">
                Pick a channel to start talking
              </p>
              <p className="font-body text-[12.5px] text-[color:var(--color-text-muted)] text-center" style={{ maxWidth: 320 }}>
                Every client on a tracker board has a channel here automatically.
              </p>
            </div>
          ) : (
            <>
              {/* Header */}
              <div
                className="flex items-center gap-2 px-4 shrink-0 bg-surface"
                style={{ height: 52, borderBottom: '1px solid var(--color-border)' }}
              >
                <button
                  type="button"
                  onClick={handleBackToList}
                  aria-label="Back to channels"
                  className="md:hidden flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
                  style={{ width: 32, height: 32 }}
                >
                  <ChevronLeft size={18} color="var(--color-text-secondary)" aria-hidden="true" />
                </button>
                <Hash size={16} color="var(--color-text-muted)" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="font-body font-semibold text-[14px] text-[color:var(--color-text-primary)] truncate">
                    {activeChannel?.name || 'Channel'}
                  </p>
                  {activeChannel?.board?.name && (
                    <p className="font-body text-[11px] text-[color:var(--color-text-muted)] truncate">
                      {activeChannel.board.name}
                    </p>
                  )}
                </div>
                {canManage && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!window.confirm(`Archive #${activeChannel?.name}? Its history is kept.`)) return;
                      try {
                        await chatService.updateChannel(activeChannelId, { archived: true });
                        handleBackToList();
                        fetchChannels(orgId);
                      } catch (err) {
                        toast.error(err?.response?.data?.error || 'Could not archive the channel.');
                      }
                    }}
                    aria-label="Archive channel"
                    title="Archive channel"
                    className="flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
                    style={{ width: 32, height: 32 }}
                  >
                    <Archive size={15} color="var(--color-text-muted)" aria-hidden="true" />
                  </button>
                )}
              </div>

              {/* Feed */}
              <div
                ref={feedRef}
                onScroll={handleFeedScroll}
                className="flex-1 overflow-y-auto py-3"
                style={{ minHeight: 0 }}
              >
                {messagesLoading ? (
                  <p className="font-body text-center py-8 text-[13px] text-[color:var(--color-text-muted)]">
                    Loading messages…
                  </p>
                ) : messages.length === 0 ? (
                  <p className="font-body text-center py-10 text-[13px] text-[color:var(--color-text-muted)]">
                    Nothing here yet — say hello.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1 px-2">
                    {nextBefore && (
                      <button
                        type="button"
                        onClick={loadOlder}
                        className="font-body self-center py-2 text-[12.5px] font-medium text-[color:var(--color-accent)]"
                      >
                        Load earlier messages
                      </button>
                    )}
                    {messages.map((m) => (
                      <MessageItem
                        key={m._id}
                        message={m}
                        currentUserId={currentUser?._id}
                        canManage={canManage}
                        onReply={openThread}
                        onDelete={handleDelete}
                        onOpenChip={handleOpenChip}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Composer — docked at the bottom, like a chat app should be */}
              {canPost && (
                <div
                  className="shrink-0 px-3 pb-3 pt-2 bg-surface relative"
                  style={{ borderTop: '1px solid var(--color-border)' }}
                >
                  {sharePicker && isBoardChannel && (
                    <SharePicker
                      kind={sharePicker}
                      channel={activeChannel}
                      onClose={() => setSharePicker(null)}
                      onPick={(item) => {
                        setPendingChip({ kind: sharePicker, item });
                        setSharePicker(null);
                      }}
                    />
                  )}

                  {/* The chip queued to ride the next message */}
                  {pendingChip && (
                    <div className="flex items-center gap-2 mb-2">
                      <ShareChip
                        icon={pendingChip.kind === 'task' ? CheckSquare : Target}
                        label={pendingChip.item.name}
                        sub={pendingChip.kind === 'task' ? 'Task — sends with this message' : 'Goal — sends with this message'}
                      />
                      <button
                        type="button"
                        onClick={() => setPendingChip(null)}
                        aria-label="Remove"
                        className="shrink-0"
                      >
                        <X size={14} color="var(--color-text-muted)" />
                      </button>
                    </div>
                  )}

                  {isBoardChannel && (
                    <div className="flex items-center gap-2 mb-2">
                      <button
                        type="button"
                        onClick={() => setSharePicker(sharePicker === 'task' ? null : 'task')}
                        className="font-body inline-flex items-center gap-1.5 transition-colors hover:bg-[color:var(--color-bg-subtle)]"
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: 'var(--color-text-secondary)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          padding: '4px 10px',
                        }}
                      >
                        <CheckSquare size={12} aria-hidden="true" />
                        Share task
                      </button>
                      <button
                        type="button"
                        onClick={() => setSharePicker(sharePicker === 'goal' ? null : 'goal')}
                        className="font-body inline-flex items-center gap-1.5 transition-colors hover:bg-[color:var(--color-bg-subtle)]"
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: 'var(--color-text-secondary)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          padding: '4px 10px',
                        }}
                      >
                        <Target size={12} aria-hidden="true" />
                        Share goal
                      </button>
                    </div>
                  )}

                  <UpdateComposer
                    key={`chat:${activeChannelId}`}
                    draftKey={`chat:${activeChannelId}`}
                    submitMessage={submitTopLevel}
                    uploadFile={uploadFile}
                    placeholder={`Message #${activeChannel?.name || 'channel'}`}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Thread panel */}
        {threadOpen && (
          <div
            className="macan-chat-thread flex flex-col shrink-0"
            style={{
              borderLeft: '1px solid var(--color-border)',
              background: 'var(--color-bg-surface)',
              minHeight: 0,
            }}
          >
            <div
              className="flex items-center gap-2 px-4 shrink-0"
              style={{ height: 52, borderBottom: '1px solid var(--color-border)' }}
            >
              <button
                type="button"
                onClick={closeThread}
                aria-label="Close thread"
                className="lg:hidden flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
                style={{ width: 32, height: 32 }}
              >
                <ChevronLeft size={18} color="var(--color-text-secondary)" aria-hidden="true" />
              </button>
              <p className="font-body font-semibold flex-1 text-[14px] text-[color:var(--color-text-primary)]">
                Thread
              </p>
              <button
                type="button"
                onClick={closeThread}
                aria-label="Close thread"
                className="hidden lg:flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
                style={{ width: 32, height: 32 }}
              >
                <X size={16} color="var(--color-text-secondary)" aria-hidden="true" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-3 px-2" style={{ minHeight: 0 }}>
              <MessageItem
                message={thread.parent}
                currentUserId={currentUser?._id}
                canManage={canManage}
                onReply={null}
                onDelete={handleDelete}
                onOpenChip={handleOpenChip}
              />
              <div
                className="my-2 mx-4"
                style={{ borderTop: '1px solid var(--color-border)' }}
              />
              {threadLoading ? (
                <p className="font-body text-center py-4 text-[12.5px] text-[color:var(--color-text-muted)]">
                  Loading replies…
                </p>
              ) : (
                thread.replies.map((r) => (
                  <MessageItem
                    key={r._id}
                    message={r}
                    currentUserId={currentUser?._id}
                    canManage={canManage}
                    onReply={null}
                    onDelete={handleDelete}
                    onOpenChip={handleOpenChip}
                  />
                ))
              )}
            </div>

            {canPost && (
              <div
                className="shrink-0 px-3 pb-3 pt-2 bg-surface"
                style={{ borderTop: '1px solid var(--color-border)' }}
              >
                <UpdateComposer
                  key={`chat-thread:${thread.parent?._id}`}
                  draftKey={`chat-thread:${thread.parent?._id}`}
                  submitMessage={submitReply(thread.parent?._id)}
                  uploadFile={uploadFile}
                  placeholder="Reply in thread"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* New workspace channel */}
      {createOpen && (
        <Modal isOpen title="New workspace channel" onClose={() => setCreateOpen(false)}>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <p className="font-body text-[12.5px] text-[color:var(--color-text-muted)]">
              A room for the whole workspace. Client channels are created
              automatically from your tracker boards.
            </p>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. announcements"
              autoFocus
              maxLength={80}
              className="w-full h-9 px-3 font-body text-[13px] text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-input)] focus:outline-none"
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
              }}
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="h-9 font-body font-semibold text-[13px] text-white bg-accent hover:bg-accent-hover disabled:opacity-60 transition-colors"
              style={{ borderRadius: 'var(--radius-md)' }}
            >
              {creating ? 'Creating…' : 'Create channel'}
            </button>
          </form>
        </Modal>
      )}

      <style>{`
        /* Chat owns the viewport below the navbar; the tab bar takes its slice
           back on phones. PageWrapper's own mobile bottom padding is cancelled
           here because chat manages its own bottom edge (the composer). */
        .macan-chat-shell {
          height: calc(100vh - 56px);
        }
        .macan-chat-sidebar { width: 280px; }
        .macan-chat-thread { width: 360px; }
        @media (max-width: 1023px) {
          .macan-chat-thread { width: 100%; }
        }
        @media (max-width: 767px) {
          .macan-chat-shell {
            height: calc(100vh - 56px - 64px - env(safe-area-inset-bottom));
          }
          .macan-chat-sidebar { width: 100%; }
        }
      `}</style>
    </PageWrapper>
  );
};

export default ChatPage;

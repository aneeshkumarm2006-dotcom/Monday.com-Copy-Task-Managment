import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ChevronLeft,
  MessageCircle,
  X,
  CheckSquare,
  Target,
  Archive,
} from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import UpdateComposer from '../components/board/UpdateComposer';
import ChannelSidebar from '../components/chat/ChannelSidebar';
import MessageItem, { NewDivider } from '../components/chat/MessageItem';
import SharePicker from '../components/chat/SharePicker';
import Avatar from '../components/ui/Avatar';
import Modal from '../components/ui/Modal';
import useChatStore from '../store/chatStore';
import useOrgStore from '../store/orgStore';
import useAuthStore from '../store/authStore';
import useToastStore from '../store/toastStore';
import usePermissions from '../hooks/usePermissions';
import * as chatService from '../services/chatService';
import { workspaceChannels } from '../utils/chatChannels';
import macanMark from '../assets/macan-mark.svg';

/**
 * Chat — the design's three screens, faithfully. Channels sectioned by board
 * (one per client, auto-created from the tracker roster) plus workspace-wide
 * rooms; desktop is panes, a phone shows one screen at a time.
 *
 * The visual contract comes from the mobile design mock, Part 5:
 *   - list rows: avatar tile · name+preview · time + blue unread pill
 *   - conversation: white ground, red NEW divider at first unread, amber wash
 *     on messages that mention you, goal/task chips as bordered cards
 *   - composer: ONE bordered container — editor on top, action row below
 *     (@ · attach · Task · Goal · Send), docked to the bottom
 *
 * The composer itself is the task panel's UpdateComposer pointed at the chat
 * API. System messages (automations, alerts) render as "Macan" with the brand
 * mark — never as a person. And chat never writes a score: chips point.
 *
 * ---- What this file is NOT any more ----------------------------------------
 *
 * The list row, the message, the share picker and the time formats now live in
 * `components/chat/`, because a client board's Chat tab draws the same
 * conversation and two copies of a message row is how they start to differ.
 * This page is the /chat SCREEN: which pane is visible at which width, the deep
 * link, the composer seams and the New-message modal.
 *
 * ---- Which channels this screen shows --------------------------------------
 *
 * `workspaceChannels` filters out anything living on a Client Portal board.
 * Those rooms are conversations WITH an outside company and belong only on that
 * board's Chat tab; mixing them into this list is how someone answers the wrong
 * room. The lookup for the OPEN channel deliberately still searches the
 * unfiltered list, so a notification deep link to a client room still resolves
 * rather than dead-ending on a channel the page pretends not to have.
 */
/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

const ChatPage = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentUser = useAuthStore((s) => s.user);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const orgMembers = useOrgStore((s) => s.members);
  const fetchMembers = useOrgStore((s) => s.fetchMembers);
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
  const unreadAtOpen = useChatStore((s) => s.unreadAtOpen);
  const thread = useChatStore((s) => s.thread);
  const threadLoading = useChatStore((s) => s.threadLoading);
  const openChannel = useChatStore((s) => s.openChannel);
  const closeChannel = useChatStore((s) => s.closeChannel);
  const openThread = useChatStore((s) => s.openThread);
  const closeThread = useChatStore((s) => s.closeThread);
  const loadOlder = useChatStore((s) => s.loadOlder);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const makeTask = useChatStore((s) => s.makeTask);
  const openDm = useChatStore((s) => s.openDm);

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

  // What the sidebar lists. See the note at the top of the file: a client
  // board's rooms are reachable only from that board, so they are filtered out
  // HERE rather than inside the sidebar, which stays a dumb list.
  const sidebarChannels = useMemo(() => workspaceChannels(channels), [channels]);

  useEffect(() => {
    if (orgId) fetchChannels(orgId);
    // The New-message list needs the roster; RichEditor's @mentions use the
    // same store, so this is usually already warm.
    if (orgId && (!orgMembers || orgMembers.length === 0)) fetchMembers(orgId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // Deep link: /chat?channel=<id> (mention notifications, refreshes).
  const channelParam = searchParams.get('channel');
  useEffect(() => {
    if (channelParam && String(channelParam) !== String(activeChannelId)) {
      openChannel(channelParam);
    }
    if (!channelParam && activeChannelId) {
      closeChannel();
    }
    // `activeChannelId` is a dep on purpose: if anything clears the store out
    // from under an open deep link (a login-hydration race did exactly that),
    // this re-opens the channel the URL still names instead of stranding the
    // user on the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelParam, activeChannelId]);

  useEffect(() => () => closeChannel(), [closeChannel]);

  // Pin the feed to the newest message unless the user scrolled up.
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
    setSharePicker(null);
    setPendingChip(null);
    setSearchParams({ channel: channel._id });
  };

  const handleBackToList = () => setSearchParams({});

  const handleStartDm = async (member) => {
    try {
      const channel = await openDm(orgId, member._id);
      setCreateOpen(false);
      setSearchParams({ channel: channel._id });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not start the conversation.');
    }
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

  const handleMakeTask = async (message) => {
    try {
      const task = await makeTask(message._id);
      toast.success(`Task created: ${task.name}`);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not create the task.');
    }
  };

  const handleOpenChip = (kind, item) => {
    const boardId = activeChannel?.board?._id;
    if (!boardId) return;
    if (kind === 'task') {
      navigate(`/boards/${boardId}?highlightTask=${item._id}`);
    } else {
      navigate(`/boards/${boardId}?view=goals${item.monthKey ? `&month=${item.monthKey}` : ''}`);
    }
  };

  // The composer seams: same editor as task updates, posting to chat.
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

  // Where the NEW divider sits: above the first of the messages that were
  // unread when the channel was opened. Frozen for the visit.
  const newDividerIndex =
    unreadAtOpen > 0 && messages.length > 0
      ? Math.max(messages.length - unreadAtOpen, 0)
      : -1;

  // The mock's composer action row: Task · Goal chips beside the built-ins.
  const shareActions = isBoardChannel ? (
    <>
      <button
        type="button"
        onClick={() => setSharePicker(sharePicker === 'task' ? null : 'task')}
        className="font-body inline-flex items-center transition-colors hover:bg-[#E4EEFF]"
        style={{
          height: 24,
          padding: '0 9px',
          fontSize: 11,
          fontWeight: 600,
          color: '#1E40AF',
          background: pendingChip?.kind === 'task' ? '#DBEAFE' : '#F5F9FF',
          border: '1px solid #DCE6F8',
          borderRadius: 6,
        }}
      >
        Task
      </button>
      <button
        type="button"
        onClick={() => setSharePicker(sharePicker === 'goal' ? null : 'goal')}
        className="font-body inline-flex items-center transition-colors hover:bg-[#E4EEFF]"
        style={{
          height: 24,
          padding: '0 9px',
          fontSize: 11,
          fontWeight: 600,
          color: '#1E40AF',
          background: pendingChip?.kind === 'goal' ? '#DBEAFE' : '#F5F9FF',
          border: '1px solid #DCE6F8',
          borderRadius: 6,
        }}
      >
        Goal
      </button>
    </>
  ) : null;

  const composerFor = (key, submit, ph) => (
    <div
      style={{
        border: '1.5px solid var(--color-border)',
        borderRadius: 12,
        background: '#FBFAF8',
        overflow: 'visible',
      }}
    >
      <UpdateComposer
        key={key}
        draftKey={key}
        submitMessage={submit}
        uploadFile={uploadFile}
        placeholder={ph}
        submitLabel="Send"
        compact
        actionsExtra={key.startsWith('chat:') ? shareActions : null}
        // In a DM, @ offers only the person you're talking to — nobody a
        // private conversation can't reach.
        mentionUsers={
          activeChannel?.kind === 'dm' && activeChannel?.otherUser
            ? [activeChannel.otherUser]
            : null
        }
      />
    </div>
  );

  return (
    <PageWrapper padded={false} className="!pb-0" hideNavOnMobile fullWidth>
      <div className="macan-chat-shell flex" style={{ minHeight: 0 }}>
        {/* Channel list — full-screen on phones until a channel is opened */}
        <div
          className={[
            'macan-chat-sidebar shrink-0',
            conversationOpen ? 'hidden md:flex' : 'flex',
          ].join(' ')}
          style={{ flexDirection: 'column', borderRight: '1px solid var(--color-border)' }}
        >
          <ChannelSidebar
            channels={sidebarChannels}
            activeChannelId={activeChannelId}
            onOpen={handleOpenChannel}
            onCreate={() => setCreateOpen(true)}
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
          style={{ background: '#FFFFFF', minHeight: 0 }}
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
              <p
                className="font-body text-[12.5px] text-[color:var(--color-text-muted)] text-center"
                style={{ maxWidth: 320 }}
              >
                Every client on a tracker board has a channel here automatically.
              </p>
            </div>
          ) : (
            <>
              {/* Header — back chevron, mark, name, board pill */}
              <div
                className="flex items-center gap-2 px-3 shrink-0"
                style={{ height: 50, borderBottom: '1px solid var(--color-border)', background: '#FFFFFF' }}
              >
                <button
                  type="button"
                  onClick={handleBackToList}
                  aria-label="Back to channels"
                  className="md:hidden flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
                  style={{ width: 32, height: 32 }}
                >
                  <ChevronLeft size={19} color="var(--color-text-secondary)" aria-hidden="true" />
                </button>
                {activeChannel?.kind === 'dm' ? (
                  <span className="shrink-0">
                    <Avatar user={activeChannel.otherUser} size={26} />
                  </span>
                ) : (
                  <img src={macanMark} alt="" aria-hidden="true" width={14} height={14} className="shrink-0" />
                )}
                <p className="font-body font-bold text-[14.5px] text-[color:var(--color-text-primary)] truncate">
                  {activeChannel?.name || 'Channel'}
                </p>
                {activeChannel?.board?.name && (
                  <span
                    className="font-body font-semibold shrink-0"
                    style={{
                      fontSize: 10.5,
                      color: '#1E40AF',
                      background: '#EFF6FF',
                      border: '1px solid #BFDBFE',
                      borderRadius: 999,
                      padding: '2px 9px',
                      maxWidth: 140,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {activeChannel.board.name}
                  </span>
                )}
                <span className="flex-1" />
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
                className="flex-1 overflow-y-auto py-2 px-2"
                style={{ minHeight: 0, background: '#FFFFFF' }}
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
                  <div className="flex flex-col gap-0.5">
                    {nextBefore && (
                      <button
                        type="button"
                        onClick={loadOlder}
                        className="font-body self-center py-2 text-[12px] font-semibold text-[color:var(--color-accent)]"
                      >
                        Load earlier messages
                      </button>
                    )}
                    {messages.map((m, i) => (
                      <div key={m._id}>
                        {i === newDividerIndex && <NewDivider />}
                        <MessageItem
                          message={m}
                          currentUserId={currentUser?._id}
                          canManage={canManage}
                          canMakeTask={isBoardChannel && canPost}
                          onReply={openThread}
                          onDelete={handleDelete}
                          onMakeTask={handleMakeTask}
                          onOpenChip={handleOpenChip}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Composer — one bordered container, docked to the bottom */}
              {canPost && (
                <div
                  className="shrink-0 px-3 pb-3 pt-2 relative"
                  style={{ borderTop: '1px solid var(--color-bg-subtle)', background: '#FFFFFF' }}
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

                  {pendingChip && (
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="font-body inline-flex items-center gap-1.5 min-w-0"
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: '#1E40AF',
                          background: '#EFF6FF',
                          border: '1px solid #BFDBFE',
                          borderRadius: 999,
                          padding: '3px 10px',
                        }}
                      >
                        {pendingChip.kind === 'task' ? (
                          <CheckSquare size={11} aria-hidden="true" className="shrink-0" />
                        ) : (
                          <Target size={11} aria-hidden="true" className="shrink-0" />
                        )}
                        <span className="truncate">{pendingChip.item.name}</span>
                        <span style={{ fontWeight: 400 }}>· sends with this message</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setPendingChip(null)}
                        aria-label="Remove"
                        className="shrink-0"
                      >
                        <X size={13} color="var(--color-text-muted)" />
                      </button>
                    </div>
                  )}

                  {composerFor(
                    `chat:${activeChannelId}`,
                    submitTopLevel,
                    activeChannel?.kind === 'dm'
                      ? `Message ${activeChannel?.name || ''}`.trim()
                      : `Message #${activeChannel?.name || 'channel'}`
                  )}
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
              background: '#FFFFFF',
              minHeight: 0,
            }}
          >
            <div
              className="flex items-center gap-2 px-3 shrink-0"
              style={{ height: 50, borderBottom: '1px solid var(--color-border)' }}
            >
              <button
                type="button"
                onClick={closeThread}
                aria-label="Close thread"
                className="lg:hidden flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
                style={{ width: 32, height: 32 }}
              >
                <ChevronLeft size={19} color="var(--color-text-secondary)" aria-hidden="true" />
              </button>
              <p className="font-body font-bold text-[14.5px] text-[color:var(--color-text-primary)]">
                Thread
              </p>
              <p className="font-body flex-1 truncate" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                {activeChannel?.name}
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

            <div className="flex-1 overflow-y-auto py-2 px-2" style={{ minHeight: 0 }}>
              <div style={{ borderBottom: '1px solid var(--color-bg-subtle)', paddingBottom: 4, marginBottom: 4 }}>
                <MessageItem
                  message={thread.parent}
                  currentUserId={currentUser?._id}
                  canManage={canManage}
                  canMakeTask={isBoardChannel && canPost}
                  onReply={null}
                  onDelete={handleDelete}
                  onMakeTask={handleMakeTask}
                  onOpenChip={handleOpenChip}
                />
              </div>
              {threadLoading ? (
                <p className="font-body text-center py-4 text-[12.5px] text-[color:var(--color-text-muted)]">
                  Loading replies…
                </p>
              ) : (
                <>
                  {thread.replies.length > 0 && (
                    <p
                      className="font-body font-bold uppercase px-3 pt-1 pb-1"
                      style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-text-muted)' }}
                    >
                      {thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}
                    </p>
                  )}
                  {thread.replies.map((r) => (
                    <MessageItem
                      key={r._id}
                      message={r}
                      currentUserId={currentUser?._id}
                      canManage={canManage}
                      canMakeTask={false}
                      onReply={null}
                      onDelete={handleDelete}
                      onMakeTask={handleMakeTask}
                      onOpenChip={handleOpenChip}
                    />
                  ))}
                </>
              )}
            </div>

            {canPost && (
              <div className="shrink-0 px-3 pb-3 pt-2" style={{ borderTop: '1px solid var(--color-bg-subtle)' }}>
                {composerFor(
                  `chat-thread:${thread.parent?._id}`,
                  submitReply(thread.parent?._id),
                  'Reply…'
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* New message: DM anyone in the workspace; admins can also open a room */}
      {createOpen && (
        <Modal isOpen title="New message" onClose={() => setCreateOpen(false)}>
          <div className="flex flex-col" style={{ maxHeight: 300, overflowY: 'auto' }}>
            {(orgMembers || [])
              .filter((m) => String(m._id) !== String(currentUser?._id))
              .map((m) => (
                <button
                  key={m._id}
                  type="button"
                  onClick={() => handleStartDm(m)}
                  className="w-full flex items-center gap-3 px-2 py-2 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] rounded-lg"
                >
                  <Avatar user={m} size={30} />
                  <span className="min-w-0 flex-1">
                    <span className="font-body block truncate text-[13px] font-semibold text-[color:var(--color-text-primary)]">
                      {m.name}
                    </span>
                    <span className="font-body block truncate text-[11.5px] text-[color:var(--color-text-muted)]">
                      {m.email}
                    </span>
                  </span>
                </button>
              ))}
            {(orgMembers || []).filter((m) => String(m._id) !== String(currentUser?._id))
              .length === 0 && (
              <p className="font-body px-2 py-3 text-[12.5px] text-[color:var(--color-text-muted)]">
                Nobody else is in this workspace yet.
              </p>
            )}
          </div>

          {canCreateChannel && (
          <form
            onSubmit={handleCreate}
            className="flex flex-col gap-3 mt-3 pt-3"
            style={{ borderTop: '1px solid var(--color-border)' }}
          >
            <p className="font-body text-[12.5px] text-[color:var(--color-text-muted)]">
              Or create a room for the whole workspace. Client channels are
              created automatically from your tracker boards.
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
          )}
        </Modal>
      )}

      <style>{`
        /* Chat owns the viewport below the navbar; the tab bar takes its slice
           back on phones. PageWrapper's mobile spacer is cancelled (!pb-0)
           because the docked composer is chat's own bottom edge. */
        .macan-chat-shell {
          height: calc(100vh - 56px);
        }
        .macan-chat-sidebar { width: 300px; }
        .macan-chat-thread { width: 380px; }
        @media (max-width: 1023px) {
          .macan-chat-thread { width: 100%; }
        }
        @media (max-width: 767px) {
          /* Full-bleed: the global bar is hidden here (chat's own headers are
             the top chrome), so the shell spans from the very top down to the
             tab bar. dvh tracks the browser UI so the composer never hides. */
          .macan-chat-shell {
            height: calc(100dvh - 56px - env(safe-area-inset-bottom));
          }
          .macan-chat-sidebar { width: 100%; border-right: none; }
        }
      `}</style>
    </PageWrapper>
  );
};

export default ChatPage;

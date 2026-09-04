import { create } from 'zustand';
import * as chatService from '../services/chatService';
import { workspaceChannels } from '../utils/chatChannels';

/**
 * Chat state. One store because chat is cross-page state: the tab-bar badge
 * needs the unread total everywhere, and a live message must land whether or
 * not the chat page is mounted. (Board tabs keep their component-state
 * doctrine — chat is a peer of notifications, not a board tab.)
 *
 * Live delivery: useNotificationStream feeds `receiveMessage` for every
 * `chat.message` SSE frame. If the message's channel is open, it's appended
 * and the read marker rides forward; otherwise its channel's unread count
 * bumps. The always-on channels refetch when opening the page covers stream
 * gaps — the same belt-and-braces the notification bell uses.
 */
const useChatStore = create((set, get) => ({
  channels: [],
  channelsLoading: false,
  channelsLoadedForOrg: null,

  activeChannelId: null,
  messages: [],
  messagesLoading: false,
  nextBefore: null,
  canPost: false,
  canManage: false,

  // The most recent SSE frame, for surfaces that keep their own state — see
  // `receiveMessage`. `{ channelId, message, seq }` or null.
  liveMessage: null,

  // One open thread at a time: { parent, replies } or null.
  thread: null,
  threadLoading: false,

  // How many unread the channel had at the moment it was opened — the anchor
  // for the red NEW divider. Frozen for the visit; live arrivals don't move it.
  unreadAtOpen: 0,

  /**
   * The badge number, and the ONE place it is computed.
   *
   * Client-board rooms are excluded (see `utils/chatChannels.js`): they are
   * reachable only from that board's Chat tab, so counting them here would
   * advertise unread messages the Chat tab cannot open — a badge that never
   * clears no matter what the user reads.
   *
   * Anything drawing that number calls THIS rather than summing `channels`
   * itself. The mobile TabBar used to re-implement the reduce inline, which is
   * exactly how one of the two would have kept counting client rooms.
   */
  totalUnread: () =>
    workspaceChannels(get().channels).reduce((sum, c) => sum + (c.unread || 0), 0),

  fetchChannels: async (orgId) => {
    if (!orgId) return;
    set({ channelsLoading: true });
    try {
      const channels = await chatService.getChannels(orgId);
      set({ channels, channelsLoadedForOrg: orgId });
    } catch (err) {
      console.error('Failed to load channels:', err);
    } finally {
      set({ channelsLoading: false });
    }
  },

  openChannel: async (channelId) => {
    const known = get().channels.find((c) => String(c._id) === String(channelId));
    set({
      activeChannelId: channelId,
      messages: [],
      messagesLoading: true,
      nextBefore: null,
      thread: null,
      unreadAtOpen: known?.unread || 0,
    });
    try {
      const { messages, nextBefore, canPost, canManage } =
        await chatService.getMessages(channelId);
      // Ignore a slow response for a channel the user has since left.
      if (get().activeChannelId !== channelId) return;
      set({
        // Server returns newest-first; the view renders oldest-first.
        messages: [...messages].reverse(),
        nextBefore,
        canPost,
        canManage,
      });
      get().markRead(channelId);
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      if (get().activeChannelId === channelId) set({ messagesLoading: false });
    }
  },

  closeChannel: () => {
    set({ activeChannelId: null, messages: [], thread: null, nextBefore: null });
  },

  loadOlder: async () => {
    const { activeChannelId, nextBefore, messages } = get();
    if (!activeChannelId || !nextBefore) return;
    try {
      const page = await chatService.getMessages(activeChannelId, { before: nextBefore });
      if (get().activeChannelId !== activeChannelId) return;
      set({
        messages: [...[...page.messages].reverse(), ...messages],
        nextBefore: page.nextBefore,
      });
    } catch (err) {
      console.error('Failed to load older messages:', err);
    }
  },

  openThread: async (message) => {
    const { activeChannelId } = get();
    if (!activeChannelId) return;
    set({ threadLoading: true, thread: { parent: message, replies: [] } });
    try {
      const { parent, replies } = await chatService.getThread(activeChannelId, message._id);
      set({ thread: { parent, replies } });
    } catch (err) {
      console.error('Failed to load thread:', err);
    } finally {
      set({ threadLoading: false });
    }
  },

  closeThread: () => set({ thread: null }),

  /** Send into the open channel (or its open thread when `replyTo` set). */
  sendMessage: async (payload) => {
    const { activeChannelId } = get();
    if (!activeChannelId) throw new Error('No channel open');
    const message = await chatService.sendMessage(activeChannelId, payload);
    set((s) => {
      const next = { };
      if (message.replyTo) {
        if (s.thread && String(s.thread.parent?._id) === String(message.replyTo)) {
          next.thread = { ...s.thread, replies: [...s.thread.replies, message] };
        }
        // Bump the parent's visible reply count in the main feed.
        next.messages = s.messages.map((m) =>
          String(m._id) === String(message.replyTo)
            ? { ...m, replyCount: (m.replyCount || 0) + 1 }
            : m
        );
      } else {
        next.messages = [...s.messages, message];
      }
      // Own sends refresh the channel preview too.
      next.channels = s.channels.map((c) =>
        String(c._id) === String(activeChannelId)
          ? {
              ...c,
              lastMessage: {
                at: message.createdAt,
                text: (message.bodyText || '').slice(0, 140),
                authorName: message.author?.name || '',
              },
            }
          : c
      );
      return next;
    });
    return message;
  },

  deleteMessage: async (messageId) => {
    const { activeChannelId } = get();
    if (!activeChannelId) return;
    await chatService.deleteMessage(activeChannelId, messageId);
    set((s) => ({
      messages: s.messages.filter((m) => String(m._id) !== String(messageId)),
      thread:
        s.thread && String(s.thread.parent?._id) === String(messageId)
          ? null
          : s.thread
            ? {
                ...s.thread,
                replies: s.thread.replies.filter(
                  (r) => String(r._id) !== String(messageId)
                ),
              }
            : null,
    }));
  },

  /** Swap one message for its fresh copy (make-a-task returns the message
   *  re-populated with its new chip). Feed and thread both checked. */
  replaceMessage: (message) => {
    const id = String(message._id);
    set((s) => ({
      messages: s.messages.map((m) => (String(m._id) === id ? { ...m, ...message, replyCount: m.replyCount } : m)),
      thread: s.thread
        ? {
            parent:
              String(s.thread.parent?._id) === id
                ? { ...s.thread.parent, ...message }
                : s.thread.parent,
            replies: s.thread.replies.map((r) =>
              String(r._id) === id ? { ...r, ...message } : r
            ),
          }
        : null,
    }));
  },

  makeTask: async (messageId, payload = {}) => {
    const { activeChannelId } = get();
    if (!activeChannelId) throw new Error('No channel open');
    const { task, message } = await chatService.makeTaskFromMessage(
      activeChannelId,
      messageId,
      payload
    );
    get().replaceMessage(message);
    return task;
  },

  /** Find-or-create the DM with one person, refresh the sidebar, and hand
   *  back the channel so the caller can navigate into it. */
  openDm: async (orgId, userId) => {
    const channel = await chatService.openDm(orgId, userId);
    await get().fetchChannels(orgId);
    return channel;
  },

  markRead: async (channelId) => {
    set((s) => ({
      channels: s.channels.map((c) =>
        String(c._id) === String(channelId) ? { ...c, unread: 0 } : c
      ),
    }));
    try {
      await chatService.markChannelRead(channelId);
    } catch {
      // Non-fatal — the next channels fetch re-reports the true count.
    }
  },

  /**
   * A live `chat.message` frame from the SSE stream. Never the sender's own
   * message — the server excludes the author from the fan-out.
   */
  receiveMessage: (channelId, message) => {
    set((s) => {
      const isActive = String(s.activeChannelId) === String(channelId);
      const next = {};

      // The live beacon. Everything below this line updates `channels` and
      // `messages`, which only describe the GLOBAL chat page — and the global
      // sidebar deliberately excludes client boards, so a message in a client
      // room updates nothing and reaches nobody.
      //
      // A board's Chat tab keeps its own component state (the board-tab
      // doctrine this store's own header states), so it cannot read those
      // fields either. Rather than pull a whole second surface into this store
      // to fix that, every frame is published here as a beacon any self-stated
      // surface can subscribe to.
      //
      // `seq` is what makes it observable. The same message can legitimately
      // arrive twice, and two identical objects would not re-fire an effect
      // keyed on the value — a monotonic counter always does.
      next.liveMessage = {
        channelId: String(channelId),
        message,
        seq: (s.liveMessage?.seq || 0) + 1,
      };

      if (isActive) {
        if (message.replyTo) {
          if (s.thread && String(s.thread.parent?._id) === String(message.replyTo)) {
            next.thread = { ...s.thread, replies: [...s.thread.replies, message] };
          }
          next.messages = s.messages.map((m) =>
            String(m._id) === String(message.replyTo)
              ? { ...m, replyCount: (m.replyCount || 0) + 1 }
              : m
          );
        } else if (!s.messages.some((m) => String(m._id) === String(message._id))) {
          next.messages = [...s.messages, message];
        }
      }

      next.channels = s.channels.map((c) =>
        String(c._id) === String(channelId)
          ? {
              ...c,
              unread: isActive ? 0 : (c.unread || 0) + 1,
              lastMessage: {
                at: message.createdAt,
                text: (message.bodyText || '').slice(0, 140),
                authorName: message.author?.name || '',
              },
            }
          : c
      );
      return next;
    });
    // Reading happens by looking: an open channel absorbs the message and
    // reports it read so the badge and other devices agree.
    const { activeChannelId, markRead } = get();
    if (String(activeChannelId) === String(channelId)) markRead(channelId);
  },

  clear: () =>
    set({
      channels: [],
      channelsLoadedForOrg: null,
      activeChannelId: null,
      messages: [],
      thread: null,
      nextBefore: null,
    }),
}));

export default useChatStore;

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

  // The open room's pinned messages. Loaded with the room rather than lazily,
  // because the pin bar is chrome — it is either there when the room paints or
  // it lands late and shoves the conversation down under the reader's eyes.
  pins: [],

  // The caller's saved messages. Loaded on demand — it is its own destination,
  // not something every room needs.
  saved: [],
  savedLoading: false,

  // The mentions page. `mentionCount` is the UNANSWERED total across the whole
  // workspace and is what the sidebar row and the mobile badge read — it stays
  // put when the filter changes, because a badge that moves when you switch a
  // tab is a badge nobody believes.
  mentions: [],
  mentionsLoading: false,
  mentionCount: 0,
  mentionFilter: 'unanswered',

  // Message search. `searchQuery` is what was actually SEARCHED, not what is
  // being typed — the input keeps its own state, so a slow response cannot
  // overwrite the box under the reader's fingers.
  searchResults: [],
  searchLoading: false,
  searchQuery: '',
  // Message ids the caller has saved, so a row can render its own state
  // without the list being open. Kept as a Set for the per-message lookup.
  savedIds: new Set(),

  // The signed-in user's id. Set by ChatPage from the auth store; the chat
  // store deliberately does not reach into another store to get it.
  myUserId: null,

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
      pins: [],
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
      // Best-effort and unawaited: a room whose pin bar failed to load is a
      // room, but a room that will not open because its pin bar 500'd is not.
      chatService
        .getPins(channelId)
        .then((pins) => {
          if (get().activeChannelId === channelId) set({ pins });
        })
        .catch(() => {});
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      if (get().activeChannelId === channelId) set({ messagesLoading: false });
    }
  },

  closeChannel: () => {
    set({ activeChannelId: null, messages: [], thread: null, nextBefore: null, pins: [] });
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

  /**
   * Open a thread by ID in a NAMED channel, without needing the parent message.
   *
   * What a deep link has: an id out of a URL or a mentions row, and no loaded
   * message to hand over. `openThread` above cannot serve that — it takes the
   * parent (to paint it instantly) and reads the channel from the store, which
   * during a navigation is still the previous one or none at all.
   */
  openThreadById: async (channelId, threadId) => {
    if (!channelId || !threadId) return;
    set({ threadLoading: true, thread: { parent: null, replies: [] } });
    try {
      const { parent, replies } = await chatService.getThread(channelId, threadId);
      // Ignore a slow response for a channel the user has since left.
      if (String(get().activeChannelId) !== String(channelId)) return;
      set({ thread: { parent, replies } });
    } catch (err) {
      console.error('Failed to load thread:', err);
      set({ thread: null });
    } finally {
      set({ threadLoading: false });
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
                // Three kinds of author, same rule the server's own preview
                // builder uses: the product for a system post, the contact for
                // a client's, the user for ours. `author` alone left the newest
                // line in the rail nameless until the next channels fetch.
                authorName:
                  message.authorType === 'system'
                    ? 'Macan'
                    : message.portalAuthor?.name
                      || message.portalAuthor?.email
                      || message.author?.name
                      || '',
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

  /**
   * Apply a reaction array to a message wherever it is on screen — the feed,
   * the open thread, and the pin bar all render the same message and all three
   * must move together or one of them shows a stale count.
   */
  applyReactions: (messageId, reactions) => {
    const id = String(messageId);
    const patch = (m) => (String(m._id) === id ? { ...m, reactions } : m);
    set((s) => ({
      messages: s.messages.map(patch),
      pins: s.pins.map(patch),
      thread: s.thread
        ? {
            parent: patch(s.thread.parent),
            replies: s.thread.replies.map(patch),
          }
        : null,
    }));
  },

  /**
   * Toggle an emoji, optimistically.
   *
   * Optimistic because a reaction is the one interaction where the round-trip
   * is longer than the intent — you press 👍 and look away. The server's answer
   * overwrites the guess when it lands, and on failure the guess is rolled back
   * to exactly what was there before rather than being re-derived, so a
   * concurrent reaction from somebody else is not clobbered by our undo.
   */
  /**
   * Toggle in a NAMED channel, for surfaces that act on a message outside the
   * open room — the mentions list, saved messages. No optimistic patch: those
   * lists refetch, and there is nothing on screen to patch.
   */
  toggleReactionIn: async (channelId, messageId, emoji) => {
    const reactions = await chatService.toggleReaction(channelId, messageId, emoji);
    get().applyReactions(messageId, reactions);
    return reactions;
  },

  toggleSaveIn: async (channelId, messageId, saved) => {
    await chatService.toggleSave(channelId, messageId, saved);
    set((s) => {
      const next = new Set(s.savedIds);
      if (saved) next.add(String(messageId));
      else next.delete(String(messageId));
      return {
        savedIds: next,
        saved: saved ? s.saved : s.saved.filter((r) => String(r.message?._id) !== String(messageId)),
      };
    });
  },

  toggleReaction: async (messageId, emoji) => {
    const { activeChannelId, messages, thread, pins, myUserId } = get();
    if (!activeChannelId) return;

    const found =
      messages.find((m) => String(m._id) === String(messageId)) ||
      thread?.replies?.find((m) => String(m._id) === String(messageId)) ||
      (String(thread?.parent?._id) === String(messageId) ? thread.parent : null) ||
      pins.find((m) => String(m._id) === String(messageId));
    const before = found?.reactions ? found.reactions.map((r) => ({ ...r, users: [...r.users] })) : [];

    if (myUserId) {
      const next = before.map((r) => ({ ...r, users: [...r.users] }));
      const row = next.find((r) => r.emoji === emoji);
      if (!row) {
        next.push({ emoji, users: [myUserId] });
      } else if (row.users.some((u) => String(u) === String(myUserId))) {
        row.users = row.users.filter((u) => String(u) !== String(myUserId));
      } else {
        row.users.push(myUserId);
      }
      get().applyReactions(messageId, next.filter((r) => r.users.length > 0));
    }

    try {
      const reactions = await chatService.toggleReaction(activeChannelId, messageId, emoji);
      get().applyReactions(messageId, reactions);
    } catch (err) {
      get().applyReactions(messageId, before);
      throw err;
    }
  },

  /** Pin or unpin, and keep the pin bar in step without a refetch. */
  togglePin: async (messageId, pinned) => {
    const { activeChannelId } = get();
    if (!activeChannelId) return;
    const message = await chatService.togglePin(activeChannelId, messageId, pinned);
    get().replaceMessage(message);
    set((s) => ({
      pins: pinned
        ? [message, ...s.pins.filter((m) => String(m._id) !== String(messageId))]
        : s.pins.filter((m) => String(m._id) !== String(messageId)),
    }));
    return message;
  },

  /** Save or unsave. Private — no event, nobody told, no optimistic drama. */
  toggleSave: async (messageId, saved) => {
    const { activeChannelId } = get();
    if (!activeChannelId) return;
    await chatService.toggleSave(activeChannelId, messageId, saved);
    set((s) => {
      const next = new Set(s.savedIds);
      if (saved) next.add(String(messageId));
      else next.delete(String(messageId));
      return {
        savedIds: next,
        saved: saved ? s.saved : s.saved.filter((r) => String(r.message?._id) !== String(messageId)),
      };
    });
  },

  runSearch: async (orgId, q, filters = {}) => {
    const query = (q || '').trim();
    if (query.length < 2) {
      set({ searchResults: [], searchQuery: query, searchLoading: false });
      return;
    }
    set({ searchLoading: true, searchQuery: query });
    try {
      const results = await chatService.searchMessages(orgId, query, filters);
      // Drop a slow answer for a query the reader has moved on from.
      if (get().searchQuery !== query) return;
      set({ searchResults: results });
    } catch (err) {
      console.error('Search failed:', err);
      set({ searchResults: [] });
    } finally {
      set({ searchLoading: false });
    }
  },

  clearSearch: () => set({ searchResults: [], searchQuery: '', searchLoading: false }),

  fetchMentions: async (filter) => {
    const next = filter || get().mentionFilter;
    set({ mentionsLoading: true, mentionFilter: next });
    try {
      const { mentions, unansweredCount } = await chatService.getMentions(next);
      set({ mentions, mentionCount: unansweredCount });
    } catch (err) {
      console.error('Failed to load mentions:', err);
    } finally {
      set({ mentionsLoading: false });
    }
  },

  fetchSaved: async () => {
    set({ savedLoading: true });
    try {
      const rows = await chatService.getSaved();
      set({
        saved: rows,
        savedIds: new Set(rows.map((r) => String(r.message?._id)).filter(Boolean)),
      });
    } catch (err) {
      console.error('Failed to load saved messages:', err);
    } finally {
      set({ savedLoading: false });
    }
  },

  /** Who "me" is, so a reaction chip can tell my 👍 from everyone else's. */
  setMyUserId: (id) => set({ myUserId: id ? String(id) : null }),

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
                // Three kinds of author, same rule the server's own preview
                // builder uses: the product for a system post, the contact for
                // a client's, the user for ours. `author` alone left the newest
                // line in the rail nameless until the next channels fetch.
                authorName:
                  message.authorType === 'system'
                    ? 'Macan'
                    : message.portalAuthor?.name
                      || message.portalAuthor?.email
                      || message.author?.name
                      || '',
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
      pins: [],
      saved: [],
      savedIds: new Set(),
    }),
}));

export default useChatStore;

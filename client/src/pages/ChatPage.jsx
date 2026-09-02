import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Hash,
  ChevronLeft,
  Search as SearchIcon,
  MessageSquare,
  MessageCircle,
  Plus,
  X,
  Trash2,
  CheckSquare,
  Target,
  Archive,
  ClipboardPlus,
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
 */

const AVATAR_COLORS = ['#2563EB', '#16A34A', '#EA580C', '#7C3AED', '#D97706', '#DC2626'];

const tileColor = (seed = '') => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const initialsOf = (name = '') => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
};

/** "14:36" today, "Tue" this week, "12 Aug" beyond. The mock's right column. */
const timeShort = (input) => {
  if (!input) return '';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d >= startOfToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const days = (startOfToday - d) / 86400000;
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

/** 'YYYY-MM' for right now in the board's own calendar — what a task or goal
 *  shared in chat today is ABOUT. en-CA formats as YYYY-MM-DD, so slicing is
 *  timezone-correct without a date library. */
const currentMonthKey = (timezone) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .slice(0, 7);
  } catch {
    return new Date().toISOString().slice(0, 7);
  }
};

const monthLabel = (monthKey) => {
  if (!monthKey) return '';
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return '';
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long' }).toUpperCase();
};

/* ------------------------------------------------------------------ */
/* Channel list                                                        */
/* ------------------------------------------------------------------ */

const ChannelRow = ({ channel, active, onClick }) => {
  const isClient = !!channel.group;
  const hasUnread = channel.unread > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline-none focus-visible:bg-[color:var(--color-bg-subtle)]"
      style={{
        borderBottom: '1px solid var(--color-bg-subtle)',
        background: active ? 'var(--color-bg-subtle)' : 'transparent',
      }}
    >
      {/* Avatar tile: the person for DMs, client initials for client
          channels, a # for team rooms */}
      {channel.kind === 'dm' ? (
        <span className="shrink-0">
          <Avatar user={channel.otherUser} size={34} />
        </span>
      ) : (
        <span
          className="flex items-center justify-center font-display font-bold shrink-0"
          style={{
            width: 34,
            height: 34,
            borderRadius: 'var(--radius-full)',
            fontSize: 12,
            background: isClient ? tileColor(channel.name) : 'var(--color-accent-light)',
            color: isClient ? '#FFFFFF' : 'var(--color-accent)',
          }}
          aria-hidden="true"
        >
          {isClient ? initialsOf(channel.name) : '#'}
        </span>
      )}

      <span className="flex-1 min-w-0">
        <span
          className="font-body block truncate"
          style={{
            fontSize: 13.5,
            fontWeight: hasUnread ? 700 : 600,
            color: hasUnread ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
          }}
        >
          {channel.name}
        </span>
        <span
          className="font-body block truncate"
          style={{
            fontSize: 11.5,
            fontWeight: hasUnread ? 600 : 400,
            color: hasUnread ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
          }}
        >
          {channel.lastMessage
            ? `${channel.lastMessage.authorName ? `${channel.lastMessage.authorName}: ` : ''}${channel.lastMessage.text || '(attachment)'}`
            : 'No messages yet'}
        </span>
      </span>

      <span className="flex flex-col items-end gap-1 shrink-0 self-start pt-0.5">
        <span className="font-body" style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>
          {channel.lastMessage ? timeShort(channel.lastMessage.at) : ''}
        </span>
        {hasUnread && (
          <span
            className="flex items-center justify-center font-body font-bold text-white"
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
      </span>
    </button>
  );
};

const SectionLabel = ({ children }) => (
  <p
    className="font-body font-bold px-4 pt-4 pb-1.5 uppercase text-[color:var(--color-text-muted)]"
    style={{ fontSize: 11, letterSpacing: '0.08em' }}
  >
    {children}
  </p>
);

const ChannelSidebar = ({ channels, activeChannelId, onOpen, onCreate, loading }) => {
  // The mock's header search: tap the icon, an input slides in, the list
  // filters as you type — clients, rooms and people alike.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (c) =>
    !q ||
    (c.name || '').toLowerCase().includes(q) ||
    (c.board?.name || '').toLowerCase().includes(q) ||
    (c.lastMessage?.text || '').toLowerCase().includes(q);
  const filtered = q ? channels.filter(matches) : channels;
  const sections = useMemo(() => {
    const dms = filtered.filter((c) => c.kind === 'dm');
    const workspace = filtered.filter((c) => !c.board && c.kind !== 'dm');
    const byBoard = new Map();
    filtered
      .filter((c) => c.board)
      .forEach((c) => {
        const key = c.board._id;
        if (!byBoard.has(key)) byBoard.set(key, { name: c.board.name, channels: [] });
        byBoard.get(key).channels.push(c);
      });
    return { workspace, boards: [...byBoard.values()], dms };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, q]);

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: '#FFFFFF' }}>
      <div
        className="flex items-center gap-2.5 px-4 py-3 shrink-0 sticky top-0 z-[1]"
        style={{ borderBottom: '1px solid var(--color-border)', background: '#FFFFFF' }}
      >
        <img src={macanMark} alt="" aria-hidden="true" width={18} height={18} />
        <span className="font-display font-bold flex-1 text-[17px] text-[color:var(--color-text-primary)]">
          Chat
        </span>
        <button
          type="button"
          onClick={() => {
            setSearchOpen((v) => {
              if (v) setQuery('');
              return !v;
            });
          }}
          aria-label={searchOpen ? 'Close search' : 'Search chat'}
          aria-expanded={searchOpen}
          className="flex items-center justify-center transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            width: 26,
            height: 26,
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--color-border)',
            color: searchOpen ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          }}
        >
          <SearchIcon size={14} aria-hidden="true" />
        </button>
        {(
          <button
            type="button"
            onClick={onCreate}
            aria-label="New message"
            title="New message"
            className="flex items-center justify-center transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              width: 26,
              height: 26,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        )}
      </div>

      {searchOpen && (
        <div
          className="px-3 py-2 shrink-0 sticky z-[1]"
          style={{ top: 49, background: '#FFFFFF', borderBottom: '1px solid var(--color-bg-subtle)' }}
        >
          <div
            className="flex items-center gap-2"
            style={{
              height: 34,
              padding: '0 10px',
              border: '1.5px solid var(--color-border-strong)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-surface, #FFFFFF)',
            }}
          >
            <SearchIcon size={14} color="var(--color-text-muted)" aria-hidden="true" className="shrink-0" />
            <input
              type="text"
              value={query}
              autoFocus
              placeholder="Search clients, rooms, people…"
              aria-label="Search chat"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('');
                  setSearchOpen(false);
                }
              }}
              className="flex-1 min-w-0 font-body focus:outline-none"
              style={{ fontSize: 13, color: 'var(--color-text-primary)', background: 'transparent', border: 'none' }}
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="shrink-0">
                <X size={13} color="var(--color-text-muted)" />
              </button>
            )}
          </div>
        </div>
      )}

      {loading && channels.length === 0 ? (
        <p className="font-body px-4 py-6 text-[13px] text-[color:var(--color-text-muted)]">
          Loading channels…
        </p>
      ) : channels.length === 0 ? (
        <p className="font-body px-4 py-6 text-[13px] text-[color:var(--color-text-muted)]">
          No channels yet. Client channels appear automatically when a tracker
          board has groups.
        </p>
      ) : q && filtered.length === 0 ? (
        <p className="font-body px-4 py-6 text-[13px] text-[color:var(--color-text-muted)]">
          Nothing matches “{query.trim()}”.
        </p>
      ) : (
        <div className="pb-3">
          {sections.boards.map((section) => (
            <div key={section.name}>
              <SectionLabel>Clients · {section.name}</SectionLabel>
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
          {sections.workspace.length > 0 && (
            <>
              <SectionLabel>Team</SectionLabel>
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
          {sections.dms.length > 0 && (
            <>
              <SectionLabel>Direct</SectionLabel>
              {sections.dms.map((c) => (
                <ChannelRow
                  key={c._id}
                  channel={c}
                  active={String(c._id) === String(activeChannelId)}
                  onClick={() => onOpen(c)}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Share chips — the mock's bordered cards                             */
/* ------------------------------------------------------------------ */

/** Task reference: a compact blue pill, per the mock. */
const TaskChip = ({ task, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center gap-1.5 max-w-full transition-colors duration-100 hover:bg-[#E4EEFF]"
    style={{
      border: '1px solid #BFDBFE',
      background: '#EFF6FF',
      color: '#1E40AF',
      borderRadius: 999,
      padding: '3px 12px',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
    }}
  >
    <CheckSquare size={12} aria-hidden="true" className="shrink-0" />
    <span className="font-body truncate">{task.name}</span>
  </button>
);

/** Goal reference: the mock's left-accented card with an Open affordance. */
const GoalCard = ({ goal, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="block w-full max-w-[360px] text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
    style={{
      border: '1px solid var(--color-border)',
      borderLeft: '3px solid var(--color-accent)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-base)',
      padding: '8px 12px',
      cursor: 'pointer',
    }}
  >
    <span
      className="font-body block font-bold uppercase"
      style={{ fontSize: 9.5, letterSpacing: '0.07em', color: 'var(--color-text-muted)' }}
    >
      Goal{goal.monthKey ? ` · ${monthLabel(goal.monthKey)}` : ''}
    </span>
    <span
      className="font-body block truncate mt-0.5"
      style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}
    >
      {goal.name}
    </span>
    <span
      className="font-body block mt-1"
      style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-accent)' }}
    >
      Open →
    </span>
  </button>
);

/** The picker behind the composer's Task / Goal buttons. */
const SharePicker = ({ kind, channel, onPick, onClose }) => {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // Tracker boards refuse an unscoped task read (rightly — every task
        // lives in a month). "This month, in the board's timezone" is what a
        // chat share means, so that's what we ask for.
        const month =
          channel.board.boardType === 'tracker'
            ? currentMonthKey(channel.board.monthTimezone)
            : undefined;
        if (kind === 'task') {
          const tasks = await taskService.getTasks(channel.board._id, {
            group: channel.group || undefined,
            month,
          });
          if (!cancelled) setItems(tasks.filter((t) => !t.parent));
        } else {
          const goals = await goalService.getGoals(channel.board._id, month);
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

/** The red NEW divider, exactly as the mock draws it. */
const NewDivider = () => (
  <div className="flex items-center my-2 px-2" aria-label="New messages">
    <span className="flex-1" style={{ borderTop: '1px solid #F0D4D2' }} />
    <span
      className="font-body font-extrabold text-white"
      style={{
        background: '#DC2626',
        fontSize: 9,
        letterSpacing: '0.09em',
        borderRadius: 999,
        padding: '2px 10px',
        margin: '0 -1px',
      }}
    >
      NEW
    </span>
    <span className="flex-1" style={{ borderTop: '1px solid #F0D4D2' }} />
  </div>
);

const SystemGlyph = () => (
  <span
    className="flex items-center justify-center shrink-0"
    style={{
      width: 30,
      height: 30,
      borderRadius: 'var(--radius-full)',
      background: 'var(--color-accent-light)',
    }}
    aria-hidden="true"
  >
    <img src={macanMark} alt="" width={16} height={16} />
  </span>
);

const MessageItem = ({
  message,
  currentUserId,
  canManage,
  canMakeTask,
  onReply,
  onDelete,
  onMakeTask,
  onOpenChip,
}) => {
  const isSystem = message.authorType === 'system';
  const isOwn = !isSystem && String(message.author?._id) === String(currentUserId);
  const mentionsMe = (message.mentions || []).some(
    (m) => String(m?._id || m) === String(currentUserId)
  );

  return (
    <div
      className="group flex items-start gap-2.5 px-3 py-2"
      style={
        mentionsMe
          ? {
              // The amber mention wash from the mock — the whole surface says
              // "someone called your name", without a rail in sight.
              background: '#FFFBEB',
              border: '1px solid #F1DCA8',
              borderRadius: 12,
            }
          : undefined
      }
    >
      <span className="mt-0.5 shrink-0">
        {isSystem ? <SystemGlyph /> : <Avatar user={message.author} size={30} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="font-body font-bold truncate"
            style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
          >
            {isSystem ? 'Macan' : message.author?.name || 'Unknown'}
          </span>
          <span className="font-body shrink-0" style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>
            {timeShort(message.createdAt)}
            {message.editedAt ? ' · edited' : ''}
          </span>
        </div>

        <div className="font-body text-[13px] text-[color:var(--color-text-primary)]">
          <ReadOnlyRichBody body={message.body} fallbackText={message.bodyText} />
        </div>

        {(message.task || message.goal) && (
          <div className="flex flex-col items-start gap-1.5 mt-1.5">
            {message.task && (
              <TaskChip task={message.task} onClick={() => onOpenChip('task', message.task)} />
            )}
            {message.goal && (
              <GoalCard goal={message.goal} onClick={() => onOpenChip('goal', message.goal)} />
            )}
          </div>
        )}

        {message.attachments?.length > 0 && (
          <div className="mt-1.5">
            <AttachmentList attachments={message.attachments} compact />
          </div>
        )}

        <div className="flex items-center gap-3 mt-1">
          {onReply &&
            (message.replyCount > 0 ? (
              <button
                type="button"
                onClick={() => onReply(message)}
                className="font-body transition-colors hover:underline"
                style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--color-accent)' }}
              >
                {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'} →
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onReply(message)}
                className="font-body inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity hover:text-[color:var(--color-accent)]"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
              >
                <MessageSquare size={11} aria-hidden="true" />
                Reply
              </button>
            ))}
          {canMakeTask && !message.task && (
            <button
              type="button"
              onClick={() => onMakeTask(message)}
              className="font-body inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity hover:text-[color:var(--color-accent)]"
              style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
            >
              <ClipboardPlus size={11} aria-hidden="true" />
              Make a task
            </button>
          )}
          {(isOwn || canManage) && (
            <button
              type="button"
              onClick={() => onDelete(message)}
              aria-label="Delete message"
              className="font-body inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity hover:text-[color:var(--color-status-stuck)]"
              style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
            >
              <Trash2 size={11} aria-hidden="true" />
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
            channels={channels}
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

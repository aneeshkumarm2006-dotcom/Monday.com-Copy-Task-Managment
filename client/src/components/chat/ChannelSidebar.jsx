import { useMemo, useState } from 'react';
import { Plus, Search as SearchIcon, X } from 'lucide-react';
import Avatar from '../ui/Avatar';
import { initialsOf, tileColor, timeShort } from './chatFormat';
import macanMark from '../../assets/macan-mark.svg';

/**
 * The /chat sidebar: search, then the channel list sectioned by board, then the
 * workspace rooms, then DMs.
 *
 * Extracted from `ChatPage.jsx` unchanged. It stays a dumb list — it renders
 * whatever array it is handed and knows nothing about which channels belong
 * here. THAT decision is `utils/chatChannels.js`'s, and the page applies it
 * before passing them down, because a client board's rooms live only on that
 * board's Chat tab and must never appear in this list.
 */

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

export default ChannelSidebar;

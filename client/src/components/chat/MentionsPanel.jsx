import { useEffect } from 'react';
import { AtSign, Check, Lock, MessageSquare, Bookmark } from 'lucide-react';
import Avatar from '../ui/Avatar';
import ReadOnlyRichBody from '../board/ReadOnlyRichBody';
import { REACTION_CHOICES } from './chatFormat';
import useChatStore from '../../store/chatStore';

/**
 * Mentions & reactions — every place somebody called your name, in one list.
 *
 * WHY THIS IS A DESTINATION AND NOT A FILTER ON THE BELL: an @you is a request
 * for something, and the bell mixes those with status changes, due dates and
 * automation output. A page that holds only the things people asked YOU for is
 * a different object from a notification feed, and it is the one a person
 * actually works from.
 *
 * The default tab is "Needs a reply", and what makes the count worth anything
 * is that only ANSWERING clears it — reacting, replying in the thread, or
 * posting in the room after it. Reading it does nothing. See `listMentions` on
 * the server for the exact rule.
 */

const QUICK_REACTIONS = REACTION_CHOICES.slice(0, 4);

const TABS = [
  { key: 'unanswered', label: 'Needs a reply' },
  { key: 'all', label: 'All mentions' },
];

/** Where this mention happened, as a line you can read at a glance. */
const Where = ({ row }) => {
  const { channel, threadId } = row;
  const isDm = channel?.kind === 'dm';
  return (
    <div
      className="flex items-center gap-1.5 flex-wrap font-body mb-1"
      style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
    >
      <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
        {channel?.name || 'Conversation'}
      </span>
      {isDm && (
        <>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <Lock size={10} aria-hidden="true" />
            private
          </span>
        </>
      )}
      {threadId && (
        <>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare size={10} aria-hidden="true" />
            in a thread
          </span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <span>
        {new Date(row.message.createdAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>
    </div>
  );
};

const MentionRow = ({ row, onOpen, onReact, onSave, isSaved }) => {
  const { message, answered } = row;
  const author =
    message.author ||
    (message.authorType === 'client' ? message.portalAuthor : null);

  return (
    <div
      className="flex gap-3 px-4 py-3.5 mb-2.5"
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderLeft: answered ? '1px solid var(--color-border)' : '3px solid var(--color-status-working)',
        borderRadius: 'var(--radius-md)',
        opacity: answered ? 0.72 : 1,
      }}
    >
      <span className="shrink-0 mt-0.5">
        <Avatar user={author} size={28} />
      </span>

      <div className="flex-1 min-w-0">
        <Where row={row} />

        <p
          className="font-body font-semibold mb-0.5"
          style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}
        >
          {author?.name || 'Macan'}
        </p>

        <div style={{ fontSize: 13, color: 'var(--color-text-primary)', lineHeight: 1.5 }}>
          <ReadOnlyRichBody body={message.body} fallbackText={message.bodyText} />
        </div>

        {message.task && (
          <p
            className="font-body mt-1.5 truncate"
            style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}
          >
            Task: <strong style={{ fontWeight: 600 }}>{message.task.name}</strong>
          </p>
        )}

        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          <button
            type="button"
            onClick={() => onOpen(row)}
            className="inline-flex items-center gap-1.5 font-body font-semibold text-white transition-colors hover:bg-accent-hover"
            style={{
              height: 26,
              padding: '0 11px',
              fontSize: 11.5,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-accent)',
            }}
          >
            {row.threadId ? 'Reply in thread' : 'Reply'}
          </button>

          {/* A 👍 IS an answer, and often the whole one — so the quick
              reactions sit here rather than making you open the room to say
              yes. Reacting clears the row, same as replying does. */}
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onReact(row, emoji)}
              aria-label={`React ${emoji}`}
              className="inline-flex items-center justify-center transition-colors hover:bg-[color:var(--color-bg-subtle)]"
              style={{
                height: 26,
                width: 30,
                fontSize: 13,
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg-surface)',
              }}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}

          <button
            type="button"
            onClick={() => onSave(row, !isSaved)}
            className="inline-flex items-center gap-1.5 font-body font-semibold transition-colors hover:bg-[color:var(--color-bg-subtle)]"
            style={{
              height: 26,
              padding: '0 10px',
              fontSize: 11.5,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-surface)',
              color: isSaved ? 'var(--color-accent)' : 'var(--color-text-secondary)',
            }}
          >
            <Bookmark size={11} aria-hidden="true" fill={isSaved ? 'currentColor' : 'none'} />
            {isSaved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>

      {answered && (
        <Check
          size={15}
          color="var(--color-status-done)"
          strokeWidth={2.6}
          aria-label="Answered"
          className="shrink-0 mt-1"
        />
      )}
    </div>
  );
};

const MentionsPanel = ({ onOpen }) => {
  const mentions = useChatStore((s) => s.mentions);
  const loading = useChatStore((s) => s.mentionsLoading);
  const filter = useChatStore((s) => s.mentionFilter);
  const count = useChatStore((s) => s.mentionCount);
  const fetchMentions = useChatStore((s) => s.fetchMentions);
  const savedIds = useChatStore((s) => s.savedIds);

  useEffect(() => {
    fetchMentions();
  }, [fetchMentions]);

  /**
   * React from the list. The row is in another channel than the open one, so
   * this cannot go through the store's channel-scoped toggle — it posts
   * directly and then refetches, which also re-runs the answered rule and
   * drops the row from "Needs a reply" without the client having to guess
   * whether a reaction counts.
   */
  const handleReact = async (row, emoji) => {
    const { toggleReactionIn } = useChatStore.getState();
    await toggleReactionIn(row.channel._id, row.message._id, emoji);
    fetchMentions();
  };

  const handleSave = async (row, saved) => {
    const { toggleSaveIn } = useChatStore.getState();
    await toggleSaveIn(row.channel._id, row.message._id, saved);
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto" style={{ background: 'var(--color-bg-base)' }}>
      <div className="px-5 md:px-7 py-5">
        <div className="flex items-end justify-between gap-4 mb-1">
          <h2
            className="font-display font-extrabold"
            style={{ fontSize: 20, letterSpacing: '-0.015em', color: 'var(--color-text-primary)' }}
          >
            Mentions &amp; reactions
          </h2>
        </div>
        <p
          className="font-body mb-4"
          style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}
        >
          Everywhere someone called your name — rooms, threads and private chats.
        </p>

        <div
          className="flex gap-0.5 mb-4"
          style={{ borderBottom: '1px solid var(--color-border)' }}
          role="tablist"
        >
          {TABS.map((t) => {
            const on = filter === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => fetchMentions(t.key)}
                className="font-body transition-colors"
                style={{
                  padding: '8px 13px',
                  fontSize: 12.5,
                  fontWeight: on ? 700 : 400,
                  color: on ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                  borderBottom: `2px solid ${on ? 'var(--color-accent)' : 'transparent'}`,
                }}
              >
                {t.label}
                {t.key === 'unanswered' && count > 0 && (
                  <span style={{ fontSize: 10.5, color: 'var(--color-text-muted)', marginLeft: 5 }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {loading ? (
          <p className="font-body py-8 text-center" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            Loading mentions…
          </p>
        ) : mentions.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-14">
            <AtSign size={22} color="var(--color-text-muted)" aria-hidden="true" />
            <p
              className="font-display mt-3"
              style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}
            >
              {filter === 'unanswered' ? 'Nothing waiting on you' : 'No mentions yet'}
            </p>
            <p className="font-body mt-1" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              {filter === 'unanswered'
                ? 'Every mention has been answered.'
                : 'When someone @mentions you, it lands here.'}
            </p>
          </div>
        ) : (
          mentions.map((row) => (
            <MentionRow
              key={row.message._id}
              row={row}
              onOpen={onOpen}
              onReact={handleReact}
              onSave={handleSave}
              isSaved={savedIds.has(String(row.message._id))}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default MentionsPanel;

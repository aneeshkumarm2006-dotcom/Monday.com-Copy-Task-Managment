import { useEffect, useRef, useState } from 'react';
import { Search as SearchIcon, X, MessageSquare, Lock, Paperclip } from 'lucide-react';
import Avatar from '../ui/Avatar';
import useChatStore from '../../store/chatStore';

/**
 * Message-history search.
 *
 * The sidebar's box filters ROOM NAMES. This reads what was said, which is the
 * difference between three months of chat being a record and being a stream you
 * lose. Scoping is the server's job and is done BEFORE the query rather than
 * after — see `searchMessages` — so nothing here can widen it.
 */

/** Filters, kept to the five people actually use. The sixth is always dead. */
const TIME_RANGES = [
  { key: '', label: 'Any time' },
  { key: '7', label: 'Past week' },
  { key: '30', label: 'Past month' },
  { key: '90', label: 'Past 3 months' },
];

const sinceFor = (days) => {
  if (!days) return undefined;
  const d = new Date();
  d.setDate(d.getDate() - Number(days));
  return d.toISOString();
};

/**
 * The matched run, marked in place.
 *
 * Split on the query rather than rebuilt with innerHTML: the text comes from
 * other people and must never be interpreted as markup. `escape` here is for
 * the REGEX, not for HTML — React escapes the output on its own.
 */
const Highlighted = ({ text, query }) => {
  if (!query) return <>{text}</>;
  const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Split parts have no identity of their own — their position IS what they
  // are — so the index is the correct key here rather than a smell.
  const parts = String(text || '').split(new RegExp(`(${safe})`, 'ig'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} style={{ background: '#FDE68A', color: '#7A4A05', borderRadius: 2, padding: '0 2px' }}>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
};

const SearchPanel = ({ orgId, onOpen, onClose }) => {
  const results = useChatStore((s) => s.searchResults);
  const loading = useChatStore((s) => s.searchLoading);
  const searched = useChatStore((s) => s.searchQuery);
  const runSearch = useChatStore((s) => s.runSearch);
  const clearSearch = useChatStore((s) => s.clearSearch);

  const [q, setQ] = useState(searched);
  const [days, setDays] = useState('');
  const [threadsOnly, setThreadsOnly] = useState(false);
  const [hasFiles, setHasFiles] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /**
   * Debounced, because the alternative is a database scan per keystroke. 300ms
   * is long enough to skip the middle of a word and short enough that the list
   * feels like it is following you.
   */
  useEffect(() => {
    const id = setTimeout(() => {
      runSearch(orgId, q, {
        since: sinceFor(days),
        threadsOnly: threadsOnly ? 'true' : undefined,
        hasFiles: hasFiles ? 'true' : undefined,
      });
    }, 300);
    return () => clearTimeout(id);
  }, [q, days, threadsOnly, hasFiles, orgId, runSearch]);

  const chip = (on) => ({
    height: 28,
    padding: '0 11px',
    borderRadius: 20,
    fontSize: 11.5,
    border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}`,
    background: on ? 'var(--color-accent-light)' : 'var(--color-bg-surface)',
    color: on ? 'var(--color-accent-text)' : 'var(--color-text-secondary)',
    fontWeight: on ? 600 : 400,
  });

  return (
    <div className="flex-1 min-w-0 overflow-y-auto" style={{ background: 'var(--color-bg-base)' }}>
      <div className="px-5 md:px-7 py-5">
        <div
          className="flex items-center gap-2.5 px-3.5 mb-3"
          style={{
            height: 44,
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 2px 8px var(--color-shadow)',
          }}
        >
          <SearchIcon size={16} color="var(--color-text-secondary)" aria-hidden="true" className="shrink-0" />
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search everything that's been said…"
            aria-label="Search messages"
            className="flex-1 min-w-0 font-body bg-transparent focus:outline-none"
            style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
          />
          {searched && !loading && (
            <span className="font-body shrink-0" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
              {results.length}
              {results.length === 40 ? '+' : ''} result{results.length === 1 ? '' : 's'}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              clearSearch();
              onClose();
            }}
            aria-label="Close search"
            className="shrink-0 flex items-center justify-center rounded hover:bg-[color:var(--color-bg-subtle)]"
            style={{ width: 26, height: 26 }}
          >
            <X size={15} color="var(--color-text-secondary)" aria-hidden="true" />
          </button>
        </div>

        <div className="flex gap-2 flex-wrap mb-4">
          <select
            value={days}
            onChange={(e) => setDays(e.target.value)}
            aria-label="Time range"
            className="font-body"
            style={{ ...chip(!!days), paddingRight: 24 }}
          >
            {TIME_RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setThreadsOnly((v) => !v)} className="font-body" style={chip(threadsOnly)}>
            In threads only
          </button>
          <button type="button" onClick={() => setHasFiles((v) => !v)} className="font-body" style={chip(hasFiles)}>
            Has attachment
          </button>
        </div>

        {q.trim().length < 2 ? (
          <p className="font-body py-10 text-center" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            Type at least two characters.
          </p>
        ) : loading ? (
          <p className="font-body py-10 text-center" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            Searching…
          </p>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-12">
            <SearchIcon size={20} color="var(--color-text-muted)" aria-hidden="true" />
            <p className="font-display mt-3" style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              Nothing found
            </p>
            <p className="font-body mt-1" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              No message in the rooms you can read matches “{searched}”.
            </p>
          </div>
        ) : (
          results.map((row) => {
            const m = row.message;
            const author = m.author || (m.authorType === 'client' ? m.portalAuthor : null);
            return (
              <button
                key={m._id}
                type="button"
                onClick={() => onOpen(row)}
                className="w-full text-left flex gap-3 px-4 py-3.5 mb-2.5 transition-colors hover:bg-[color:var(--color-bg-subtle)]"
                style={{
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <span className="shrink-0 mt-0.5">
                  <Avatar user={author} size={28} />
                </span>
                <span className="flex-1 min-w-0">
                  <span
                    className="flex items-center gap-1.5 flex-wrap font-body mb-1"
                    style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                  >
                    <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
                      {row.channel?.name || 'Conversation'}
                    </span>
                    {row.channel?.kind === 'dm' && (
                      <>
                        <span aria-hidden="true">·</span>
                        <Lock size={10} aria-hidden="true" />
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{author?.name || 'Macan'}</span>
                    {row.threadId && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1">
                          <MessageSquare size={10} aria-hidden="true" />
                          in a thread
                        </span>
                      </>
                    )}
                    {m.attachments?.length > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <Paperclip size={10} aria-hidden="true" />
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>
                      {new Date(m.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </span>
                  <span
                    className="block font-body"
                    style={{ fontSize: 13, color: 'var(--color-text-primary)', lineHeight: 1.5 }}
                  >
                    <Highlighted text={m.bodyText} query={searched} />
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

export default SearchPanel;

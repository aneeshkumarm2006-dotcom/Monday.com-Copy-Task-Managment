import { useMemo, useState } from 'react';
import { Search, TriangleAlert, X } from 'lucide-react';
import { typeMeta, VAULT_ITEM_ORDER, VAULT_ITEM_TYPES } from './itemTypes';

/**
 * The item list.
 *
 * Search and the type filter both run entirely in the browser, over payloads
 * that were decrypted on unlock. They have to: the server holds ciphertext and
 * cannot match a title, let alone rank one. That is a genuine constraint of the
 * design rather than a shortcut, and it is affordable because a vault holds tens
 * of items — the whole set is already in memory.
 *
 * What a row shows is governed by the registry's `preview` contract, which may
 * describe an item and must never reveal one. This list sits on screen for as
 * long as the vault is open, including during screen shares.
 */

const VaultItemList = ({ items, selectedId, onSelect }) => {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  // Which type chips to offer — only the types actually present, so a vault of
  // three credentials does not show four empty filters.
  const presentTypes = useMemo(() => {
    const seen = new Set(items.map((i) => i.type));
    return VAULT_ITEM_ORDER.filter((t) => seen.has(t));
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false;
      if (!q) return true;
      // A broken row has no payload to match on; keep it visible under an empty
      // query and drop it from a search rather than crashing on `null`.
      if (item.broken) return false;
      const meta = typeMeta(item.type);
      return `${meta.heading(item.payload || {})} ${meta.label}`
        .toLowerCase()
        .includes(q);
    });
  }, [items, query, typeFilter]);

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Search */}
      <div className="relative mb-2 shrink-0">
        <Search
          size={15}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--color-text-muted)',
            pointerEvents: 'none',
          }}
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles"
          aria-label="Search vault items"
          className="w-full font-body text-[14px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-muted)] focus:outline-none focus:bg-white focus:border-[color:var(--color-accent)]"
          style={{
            height: 36,
            paddingLeft: 32,
            paddingRight: query ? 32 : 10,
            background: 'var(--color-bg-input)',
            border: '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            style={{
              position: 'absolute',
              right: 6,
              top: '50%',
              transform: 'translateY(-50%)',
              padding: 4,
              color: 'var(--color-text-muted)',
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Type filter */}
      {presentTypes.length > 1 && (
        <div className="flex flex-wrap gap-1 mb-2 shrink-0">
          {['all', ...presentTypes].map((t) => {
            const active = typeFilter === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTypeFilter(t)}
                aria-pressed={active}
                className="font-body transition-colors"
                style={{
                  height: 26,
                  padding: '0 10px',
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  borderRadius: 9999,
                  border: '1px solid var(--color-border)',
                  background: active ? 'var(--color-accent-light)' : 'transparent',
                  color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {t === 'all' ? 'All' : VAULT_ITEM_TYPES[t].label}
              </button>
            );
          })}
        </div>
      )}

      {/* Rows */}
      <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
        {filtered.length === 0 ? (
          <p className="py-6 text-center font-body text-sm text-[color:var(--color-text-muted)]">
            {items.length === 0 ? 'Nothing in here yet.' : 'Nothing matches.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((item) => {
              const meta = typeMeta(item.type);
              const Icon = meta.icon;
              const active = item._id === selectedId;
              return (
                <li key={item._id}>
                  <button
                    type="button"
                    onClick={() => onSelect(item)}
                    aria-current={active ? 'true' : undefined}
                    className="w-full flex items-start gap-2.5 text-left transition-colors hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]"
                    style={{
                      padding: '9px 10px',
                      borderRadius: 'var(--radius-md)',
                      background: active ? 'var(--color-accent-light)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    {item.broken ? (
                      <TriangleAlert
                        size={16}
                        color="var(--color-status-stuck)"
                        aria-hidden="true"
                        className="shrink-0 mt-0.5"
                      />
                    ) : (
                      <Icon
                        size={16}
                        color={active ? 'var(--color-accent)' : 'var(--color-text-muted)'}
                        aria-hidden="true"
                        className="shrink-0 mt-0.5"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className="block font-body text-[14px] truncate"
                        style={{
                          fontWeight: active ? 600 : 500,
                          color: active
                            ? 'var(--color-accent)'
                            : 'var(--color-text-primary)',
                        }}
                      >
                        {item.broken
                          ? 'Could not be decrypted'
                          : meta.heading(item.payload || {})}
                      </span>
                      <span className="block font-body text-xs text-[color:var(--color-text-muted)] truncate">
                        {item.broken
                          ? 'This item will not open with the current key'
                          : meta.preview(item.payload || {})}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default VaultItemList;

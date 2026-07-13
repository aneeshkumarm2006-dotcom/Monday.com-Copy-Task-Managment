import { useEffect, useMemo, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import useOrgStore from '../../store/orgStore';
import useBoardStore from '../../store/boardStore';
import useAuthStore from '../../store/authStore';
import useToastStore from '../../store/toastStore';

/**
 * BoardAccessModal — who can see a PRIVATE board, and at what level:
 *   - Owner     (created the board — always full access, can't be changed)
 *   - Can edit  (full control of board content)
 *   - Read only (view tasks, no edits)
 *   - No access (default — can't see the board at all)
 *
 * Two audiences open this:
 *   - the owner, who always manages the list, and who decides via the switch at
 *     the bottom whether editors may manage it too;
 *   - members with 'edit' access, who can always SEE the list (so the people
 *     running the board know who is on it) and can change it only once the
 *     owner flips that switch.
 *
 * `canManage` / `isOwner` come from the caller; the server enforces the same
 * rules, including the guardrails that nobody may change the owner's access or
 * their own.
 */

const LEVELS = [
  { value: 'none', label: 'No access' },
  { value: 'read', label: 'Read only' },
  { value: 'edit', label: 'Can edit' },
];

const LEVEL_LABEL = {
  owner: 'Owner',
  edit: 'Can edit',
  read: 'Read only',
  none: 'No access',
};

// Owner pinned to the top, then the people who can actually do something on the
// board, so the list reads top-down as "who matters here".
const LEVEL_RANK = { owner: -1, edit: 0, read: 1, none: 2 };

/** Normalise an id that may be a populated object or a raw ObjectId string. */
const idOf = (v) =>
  typeof v === 'object' && v !== null ? v._id || v : v;

const initials = (name = '', email = '') => {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
};

/** Static, non-editable access label — used for rows that can't be changed. */
const AccessPill = ({ children }) => (
  <span
    className="font-body shrink-0"
    style={{
      fontSize: 13,
      fontWeight: 500,
      padding: '6px 10px',
      borderRadius: 'var(--radius-md)',
      border: '1.5px solid transparent',
      background: 'var(--color-bg-subtle)',
      color: 'var(--color-text-secondary)',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);

const BoardAccessModal = ({
  board,
  isOpen,
  onClose,
  canManage = false,
  isOwner = false,
}) => {
  const members = useOrgStore((s) => s.members);
  const fetchMembers = useOrgStore((s) => s.fetchMembers);
  const setBoardAccess = useBoardStore((s) => s.setBoardAccess);
  const setBoardAccessSettings = useBoardStore((s) => s.setBoardAccessSettings);
  const currentUser = useAuthStore((s) => s.user);
  const toastError = useToastStore((s) => s.error);

  const [savingId, setSavingId] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [query, setQuery] = useState('');

  const orgId = board ? idOf(board.organisation) : null;

  // Refresh the member list whenever the modal opens so the picker is current.
  useEffect(() => {
    if (isOpen && orgId) {
      fetchMembers(orgId).catch(() => {});
    }
  }, [isOpen, orgId, fetchMembers]);

  // Clear the search box each time the modal opens.
  useEffect(() => {
    if (isOpen) setQuery('');
  }, [isOpen]);

  // user id -> granted level, derived from the live board record.
  const grantByUser = useMemo(() => {
    const map = new Map();
    (board?.memberAccess || []).forEach((g) =>
      map.set(String(idOf(g.user)), g.level)
    );
    return map;
  }, [board]);

  const currentUserId = currentUser?._id ? String(currentUser._id) : null;
  const ownerId = board?.createdBy ? String(idOf(board.createdBy)) : null;
  const editorsCanManage = !!board?.editorsCanManageAccess;

  // Every workspace member as a row, including the owner and the viewer — a
  // non-owner needs to see both to understand who runs the board.
  const rows = useMemo(() => {
    const list = (members || []).map((m) => {
      const id = String(m._id);
      const owner = id === ownerId;
      return {
        id,
        member: m,
        isOwnerRow: owner,
        isSelf: id === currentUserId,
        level: owner ? 'owner' : grantByUser.get(id) || 'none',
      };
    });
    list.sort((a, b) => {
      const rank = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
      if (rank !== 0) return rank;
      const an = a.member.name || a.member.email || '';
      const bn = b.member.name || b.member.email || '';
      return an.localeCompare(bn);
    });
    return list;
  }, [members, ownerId, currentUserId, grantByUser]);

  // Rows the viewer could conceivably act on — drives the empty state.
  const shareableCount = rows.filter((r) => !r.isOwnerRow && !r.isSelf).length;

  // Members matching the current search query (by name or email).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.member.name || ''} ${r.member.email || ''}`.toLowerCase().includes(q)
    );
  }, [rows, query]);

  const handleChange = async (memberId, level) => {
    if (!board) return;
    setSavingId(memberId);
    try {
      await setBoardAccess(board._id, memberId, level);
    } catch (err) {
      toastError(
        err?.response?.data?.error || 'Failed to update access. Please try again.'
      );
    } finally {
      setSavingId(null);
    }
  };

  const handleDelegateToggle = async (next) => {
    if (!board) return;
    setSavingSettings(true);
    try {
      await setBoardAccessSettings(board._id, next);
    } catch (err) {
      toastError(
        err?.response?.data?.error ||
          'Failed to update the sharing setting. Please try again.'
      );
    } finally {
      setSavingSettings(false);
    }
  };

  const intro = isOwner
    ? 'This board is private. Choose which workspace members can view or edit it.'
    : canManage
      ? 'This board is private. You can manage who can view or edit it.'
      : 'This board is private. Only the board owner can change who has access.';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Share board"
      maxWidth={540}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p
        className="font-body"
        style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}
      >
        {intro}
      </p>

      {shareableCount === 0 ? (
        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
        >
          There are no other members in this workspace to share with yet.
        </p>
      ) : (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members by name or email…"
            className="font-body"
            style={{
              width: '100%',
              fontSize: 13,
              padding: '8px 12px',
              marginBottom: 12,
              borderRadius: 'var(--radius-md)',
              border: '1.5px solid var(--color-border-strong)',
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
            }}
          />

          {filtered.length === 0 ? (
            <p
              className="font-body"
              style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
            >
              No members match “{query.trim()}”.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {filtered.map((row) => {
                // The owner's access is fixed, nobody edits their own level, and
                // viewers without manage rights see the whole list as read-only.
                const locked = row.isOwnerRow || row.isSelf || !canManage;
                return (
                  <div
                    key={row.id}
                    className="flex items-center justify-between gap-3"
                    style={{
                      padding: '8px 4px',
                      borderBottom: '1px solid var(--color-border)',
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className="flex items-center justify-center shrink-0 font-body"
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 'var(--radius-full)',
                          background: 'var(--color-bg-subtle)',
                          color: 'var(--color-text-secondary)',
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                        aria-hidden="true"
                      >
                        {initials(row.member.name, row.member.email)}
                      </span>
                      <div className="min-w-0">
                        <p
                          className="font-body truncate"
                          style={{
                            fontSize: 14,
                            fontWeight: 500,
                            color: 'var(--color-text-primary)',
                          }}
                        >
                          {row.member.name || row.member.email}
                          {row.isSelf && (
                            <span style={{ color: 'var(--color-text-muted)' }}>
                              {' '}
                              (you)
                            </span>
                          )}
                        </p>
                        {row.member.email && (
                          <p
                            className="font-body truncate"
                            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                          >
                            {row.member.email}
                          </p>
                        )}
                      </div>
                    </div>

                    {locked ? (
                      <AccessPill>{LEVEL_LABEL[row.level]}</AccessPill>
                    ) : (
                      <select
                        value={row.level}
                        disabled={savingId === row.id}
                        onChange={(e) => handleChange(row.id, e.target.value)}
                        className="font-body shrink-0"
                        style={{
                          fontSize: 13,
                          padding: '6px 10px',
                          borderRadius: 'var(--radius-md)',
                          border: '1.5px solid var(--color-border-strong)',
                          background: 'var(--color-bg-surface)',
                          color: 'var(--color-text-primary)',
                          cursor: savingId === row.id ? 'wait' : 'pointer',
                        }}
                      >
                        {LEVELS.map((l) => (
                          <option key={l.value} value={l.value}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {isOwner && (
        <div
          className="flex items-start justify-between gap-4"
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <div className="min-w-0">
            <p
              className="font-body"
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--color-text-primary)',
              }}
            >
              Let editors manage sharing
            </p>
            <p
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}
            >
              Members with “Can edit” can grant and remove access for others. They
              can never change your access or their own.
            </p>
          </div>
          <Switch
            checked={editorsCanManage}
            onChange={handleDelegateToggle}
            disabled={savingSettings}
            label="Let editors manage sharing"
          />
        </div>
      )}
    </Modal>
  );
};

export default BoardAccessModal;

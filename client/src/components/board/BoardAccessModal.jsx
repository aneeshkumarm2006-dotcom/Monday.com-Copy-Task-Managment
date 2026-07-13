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
 * Plus a per-member "Full access" toggle: an editor with it on can manage the
 * board's sharing too, exactly like the owner. Only the owner can flip it, so
 * full access can't be chained — a full-access member may hand out read/edit
 * but cannot mint another full-access member or demote one.
 *
 * Two audiences open this: the owner, and members with 'edit' access, who can
 * always SEE the list (so the people running the board know who is on it) and
 * change it only once the owner gives them full access. `canManage` / `isOwner`
 * come from the caller; the server enforces the same rules, including that
 * nobody may change the owner's access or their own.
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

// Fixed column widths so the two headers line up with every row below them.
const LEVEL_COL = 130;
const FULL_COL = 76;

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
    className="font-body flex items-center"
    style={{
      width: LEVEL_COL,
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

const ColumnHeading = ({ width, align = 'left', children }) => (
  <span
    className="font-body shrink-0"
    style={{
      width,
      textAlign: align,
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      color: 'var(--color-text-muted)',
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
  const currentUser = useAuthStore((s) => s.user);
  const toastError = useToastStore((s) => s.error);

  const [savingId, setSavingId] = useState(null);
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

  // user id -> grant, derived from the live board record.
  const grantByUser = useMemo(() => {
    const map = new Map();
    (board?.memberAccess || []).forEach((g) =>
      map.set(String(idOf(g.user)), g)
    );
    return map;
  }, [board]);

  const currentUserId = currentUser?._id ? String(currentUser._id) : null;
  const ownerId = board?.createdBy ? String(idOf(board.createdBy)) : null;

  // Every workspace member as a row, including the owner and the viewer — a
  // non-owner needs to see both to understand who runs the board.
  const rows = useMemo(() => {
    const list = (members || []).map((m) => {
      const id = String(m._id);
      const owner = id === ownerId;
      const grant = grantByUser.get(id);
      return {
        id,
        member: m,
        isOwnerRow: owner,
        isSelf: id === currentUserId,
        level: owner ? 'owner' : grant?.level || 'none',
        fullAccess: owner || grant?.canManage === true,
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

  const save = async (memberId, level, fullAccess) => {
    if (!board) return;
    setSavingId(memberId);
    try {
      await setBoardAccess(board._id, memberId, level, fullAccess);
    } catch (err) {
      toastError(
        err?.response?.data?.error || 'Failed to update access. Please try again.'
      );
    } finally {
      setSavingId(null);
    }
  };

  // Dropping below 'edit' takes full access with it — the flag means nothing
  // for someone who can't edit.
  const handleLevelChange = (row, level) =>
    save(row.id, level, level === 'edit' && row.fullAccess);

  // Full access implies edit, so switching it on promotes them in one step.
  const handleFullAccessChange = (row, next) =>
    save(row.id, next ? 'edit' : row.level, next);

  const intro = isOwner
    ? 'This board is private. Choose which workspace members can view or edit it. Give someone full access and they can manage sharing too.'
    : canManage
      ? 'This board is private. You have full access, so you can manage who can view or edit it.'
      : 'This board is private. Only the board owner, and members with full access, can change who has access.';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Share board"
      maxWidth={600}
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
            <>
              <div
                className="flex items-center justify-end gap-3"
                style={{ padding: '0 4px 6px' }}
              >
                <ColumnHeading width={LEVEL_COL}>Access</ColumnHeading>
                <ColumnHeading width={FULL_COL} align="right">
                  Full access
                </ColumnHeading>
              </div>

              <div className="flex flex-col gap-1">
                {filtered.map((row) => {
                  // The owner's access is fixed, nobody edits their own level,
                  // and viewers without manage rights see the list read-only.
                  const locked = row.isOwnerRow || row.isSelf || !canManage;
                  // Full access is the owner's to give — a delegate can share
                  // the board but cannot create or unmake other managers.
                  const fullLocked = row.isOwnerRow || row.isSelf || !isOwner;
                  const saving = savingId === row.id;
                  const who = row.member.name || row.member.email;

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
                            {who}
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
                              style={{
                                fontSize: 12,
                                color: 'var(--color-text-muted)',
                              }}
                            >
                              {row.member.email}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        {locked ? (
                          <AccessPill>{LEVEL_LABEL[row.level]}</AccessPill>
                        ) : (
                          <select
                            value={row.level}
                            disabled={saving}
                            onChange={(e) => handleLevelChange(row, e.target.value)}
                            aria-label={`Access level for ${who}`}
                            className="font-body"
                            style={{
                              width: LEVEL_COL,
                              fontSize: 13,
                              padding: '6px 10px',
                              borderRadius: 'var(--radius-md)',
                              border: '1.5px solid var(--color-border-strong)',
                              background: 'var(--color-bg-surface)',
                              color: 'var(--color-text-primary)',
                              cursor: saving ? 'wait' : 'pointer',
                            }}
                          >
                            {LEVELS.map((l) => (
                              <option key={l.value} value={l.value}>
                                {l.label}
                              </option>
                            ))}
                          </select>
                        )}

                        <div
                          className="flex justify-end"
                          style={{ width: FULL_COL }}
                          title={
                            row.isOwnerRow
                              ? 'The board owner always has full access'
                              : 'Full access — can also manage who this board is shared with'
                          }
                        >
                          <Switch
                            checked={row.fullAccess}
                            disabled={fullLocked || saving}
                            onChange={(next) => handleFullAccessChange(row, next)}
                            label={`Full access for ${who}`}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
};

export default BoardAccessModal;

import { useEffect, useMemo, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import useOrgStore from '../../store/orgStore';
import useBoardStore from '../../store/boardStore';
import useAuthStore from '../../store/authStore';
import useToastStore from '../../store/toastStore';

/**
 * BoardAccessModal — who can reach this board, and how far.
 *
 * THE LADDER. Each rung adds to the one below it:
 *
 *   No access  — cannot see the board at all (the default on a private board)
 *   View       — read the board
 *   Comment    — + post updates and mention people
 *   Contribute — + create tasks, and edit/complete tasks assigned to them
 *   Can edit   — + any task, groups, columns, statuses, notes, automations
 *   Owner      — created it; always full access, cannot be changed
 *
 * The ladder used to be View and Can-edit and nothing else, which meant the only
 * way to let someone do their own work was to also let them delete your columns.
 * Comment and Contribute are the missing middle, and Contribute is where most of
 * a real team belongs.
 *
 * Plus a per-member "Full access" toggle: an editor with it on can manage the
 * board's sharing too, exactly like the owner. Only the owner can flip it, so
 * full access cannot be chained — a full-access member may hand out lower rungs
 * but cannot mint another full-access member or demote one.
 *
 * Two audiences open this: the owner, and members with edit access, who can
 * always SEE the list (so the people running the board know who is on it) and
 * change it only once the owner gives them full access. `canManage` / `isOwner`
 * come from the caller; the server enforces the same rules, including that nobody
 * may change the owner's access or their own.
 *
 * A member's ORG ROLE still caps everything here — a Viewer handed 'Can edit'
 * still cannot write, because permission is the AND of the two layers. The rung
 * is a ceiling, not a grant.
 *
 * And at the bottom: TRANSFER OWNERSHIP. It lives here rather than in the board's
 * edit form because ownership is the top of this same ladder — the rung that
 * carries the board's lifecycle (delete it, flip its visibility, decide who else
 * gets full access) and that no grant can confer. Handing it over does not evict
 * the outgoing owner: the server leaves them 'Can edit' with full access, so the
 * only thing they lose is the lifecycle.
 *
 * The board's OWNER sees it and nobody else — not a full-access member, not the
 * workspace owner. Anyone else who could move ownership could take the board
 * instead of being given it, which is a different thing entirely.
 */

const LEVELS = [
  { value: 'none', label: 'No access', hint: 'Cannot see this board' },
  { value: 'view', label: 'View', hint: 'Read the board' },
  { value: 'comment', label: 'Comment', hint: 'Read, and post updates' },
  {
    value: 'contribute',
    label: 'Contribute',
    hint: 'Add tasks, and work on tasks assigned to them',
  },
  { value: 'edit', label: 'Can edit', hint: 'Full control of board content' },
];

const LEVEL_LABEL = {
  owner: 'Owner',
  edit: 'Can edit',
  contribute: 'Contribute',
  comment: 'Comment',
  view: 'View',
  // Grants written before the ladder existed carry the old spelling. The server
  // normalises `read` to `view`; label it the same way so the UI never shows a
  // rung that is not on the ladder.
  read: 'View',
  none: 'No access',
};

// Owner pinned to the top, then down the ladder, so the list reads top-down as
// "who matters most here".
const LEVEL_RANK = {
  owner: -1,
  edit: 0,
  contribute: 1,
  comment: 2,
  view: 3,
  read: 3,
  none: 4,
};

/** Fold a stored grant onto the ladder. Mirrors normaliseLevel on the server. */
const normaliseLevel = (level) => {
  if (!level) return 'none';
  if (level === 'read') return 'view';
  return LEVELS.some((l) => l.value === level) ? level : 'none';
};

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
  const transferOwnership = useBoardStore((s) => s.transferBoardOwnership);
  const currentUser = useAuthStore((s) => s.user);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  const [savingId, setSavingId] = useState(null);
  const [query, setQuery] = useState('');
  // Transfer ownership is a two-step control rather than a second modal: pick a
  // member, then confirm in place. Nesting a modal inside this one to ask "are
  // you sure" is more machinery than the question deserves.
  const [transferTo, setTransferTo] = useState('');
  const [confirmingTransfer, setConfirmingTransfer] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const orgId = board ? idOf(board.organisation) : null;

  // Refresh the member list whenever the modal opens so the picker is current.
  useEffect(() => {
    if (isOpen && orgId) {
      fetchMembers(orgId).catch(() => {});
    }
  }, [isOpen, orgId, fetchMembers]);

  // Clear the search box — and any half-finished transfer — each time the modal
  // opens. A confirm state left armed from last time is a click away from giving
  // the board to whoever happened to be selected.
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setTransferTo('');
      setConfirmingTransfer(false);
    }
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
        // Fold the legacy `read` spelling onto the ladder, exactly as the server
        // does. Left raw it would be a <select> value matching no <option>, and
        // the row would render with nothing selected.
        level: owner ? 'owner' : normaliseLevel(grant?.level),
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

  // Who it could be handed to: every member except the owner, who is the viewer
  // whenever this section renders at all.
  const transferCandidates = useMemo(
    () => rows.filter((r) => !r.isOwnerRow),
    [rows]
  );
  const transferTarget = transferCandidates.find((r) => r.id === transferTo);
  const transferName =
    transferTarget?.member.name || transferTarget?.member.email || '';

  const handleTransfer = async () => {
    if (!board || !transferTarget) return;
    setTransferring(true);
    try {
      await transferOwnership(board._id, transferTarget.id);
      toastSuccess(`${transferName} is now the owner of this board.`);
      setConfirmingTransfer(false);
      setTransferTo('');
      // Close, deliberately. The viewer is no longer the owner, so half the
      // controls behind this modal have just changed meaning — reopening it
      // shows the truth rather than leaving a stale owner's view on screen.
      onClose();
    } catch (err) {
      toastError(
        err?.response?.data?.error ||
          'Failed to transfer ownership. Please try again.'
      );
    } finally {
      setTransferring(false);
    }
  };

  // The board's visibility changes what the list MEANS: on a private board a
  // grant is the only way in, on a public one it is an override of the default
  // everyone already has.
  const isPublic = board?.visibility === 'public';
  const intro = isPublic
    ? 'This board is public — every workspace member can already reach it. A grant here overrides that default for one person.'
    : isOwner
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
                              <option key={l.value} value={l.value} title={l.hint}>
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

      {isOwner && transferCandidates.length > 0 && (
        <div
          style={{
            marginTop: 24,
            paddingTop: 16,
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <p
            className="font-body"
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              marginBottom: 4,
            }}
          >
            Transfer ownership
          </p>
          <p
            className="font-body"
            style={{
              fontSize: 12,
              color: 'var(--color-text-muted)',
              marginBottom: 10,
            }}
          >
            You own this board. The new owner can delete it, change its
            visibility, and decide who has full access. You'll keep edit access
            and can still manage sharing.
          </p>

          {confirmingTransfer && transferTarget ? (
            <div
              style={{
                padding: 12,
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-bg-subtle)',
              }}
            >
              <p
                className="font-body"
                style={{
                  fontSize: 13,
                  color: 'var(--color-text-primary)',
                  marginBottom: 10,
                }}
              >
                Make <strong>{transferName}</strong> the owner of “
                {board?.name}”? You will no longer be able to delete this board
                or change its visibility, and only they can move it again.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setConfirmingTransfer(false)}
                  disabled={transferring}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={handleTransfer}
                  disabled={transferring}
                >
                  {transferring ? 'Transferring…' : 'Yes, transfer'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <select
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
                aria-label="New board owner"
                className="font-body"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-md)',
                  border: '1.5px solid var(--color-border-strong)',
                  background: 'var(--color-bg-surface)',
                  color: 'var(--color-text-primary)',
                  cursor: 'pointer',
                }}
              >
                <option value="">Choose a new owner…</option>
                {transferCandidates.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.member.name || r.member.email}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                onClick={() => setConfirmingTransfer(true)}
                disabled={!transferTarget}
              >
                Transfer
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default BoardAccessModal;

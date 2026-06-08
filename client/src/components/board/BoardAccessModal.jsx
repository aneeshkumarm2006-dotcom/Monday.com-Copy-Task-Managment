import { useEffect, useMemo, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import useOrgStore from '../../store/orgStore';
import useBoardStore from '../../store/boardStore';
import useAuthStore from '../../store/authStore';
import useToastStore from '../../store/toastStore';

/**
 * BoardAccessModal — lets the creator of a PRIVATE board grant individual
 * workspace members access. Each member can be set to:
 *   - No access (default — can't see the board)
 *   - Read only (view tasks, no edits)
 *   - Can edit  (full control of board content)
 *
 * Org admins always have full access and are shown as such (not editable).
 * Only rendered for the board creator; the server enforces the same rule.
 */

const LEVELS = [
  { value: 'none', label: 'No access' },
  { value: 'read', label: 'Read only' },
  { value: 'edit', label: 'Can edit' },
];

/** Normalise an id that may be a populated object or a raw ObjectId string. */
const idOf = (v) =>
  typeof v === 'object' && v !== null ? v._id || v : v;

const initials = (name = '', email = '') => {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
};

const BoardAccessModal = ({ board, isOpen, onClose }) => {
  const members = useOrgStore((s) => s.members);
  const adminId = useOrgStore((s) => s.adminId);
  const adminIds = useOrgStore((s) => s.adminIds);
  const fetchMembers = useOrgStore((s) => s.fetchMembers);
  const setBoardAccess = useBoardStore((s) => s.setBoardAccess);
  const currentUser = useAuthStore((s) => s.user);
  const toastError = useToastStore((s) => s.error);

  const [savingId, setSavingId] = useState(null);

  const orgId = board ? idOf(board.organisation) : null;

  // Refresh the member list whenever the modal opens so the picker is current.
  useEffect(() => {
    if (isOpen && orgId) {
      fetchMembers(orgId).catch(() => {});
    }
  }, [isOpen, orgId, fetchMembers]);

  const adminSet = useMemo(() => {
    const set = new Set();
    if (adminId) set.add(String(adminId));
    (adminIds || []).forEach((a) => set.add(String(idOf(a))));
    return set;
  }, [adminId, adminIds]);

  // user id -> granted level, derived from the live board record.
  const grantByUser = useMemo(() => {
    const map = new Map();
    (board?.memberAccess || []).forEach((g) =>
      map.set(String(idOf(g.user)), g.level)
    );
    return map;
  }, [board]);

  const currentUserId = currentUser?._id ? String(currentUser._id) : null;

  // Everyone except the creator themselves (they already own the board).
  const grantable = useMemo(
    () => (members || []).filter((m) => String(m._id) !== currentUserId),
    [members, currentUserId]
  );

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
        This board is private. Choose which workspace members can view or edit it.
      </p>

      {grantable.length === 0 ? (
        <p
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
        >
          There are no other members in this workspace to share with yet.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {grantable.map((m) => {
            const id = String(m._id);
            const isAdminMember = adminSet.has(id);
            const level = isAdminMember ? 'edit' : grantByUser.get(id) || 'none';
            return (
              <div
                key={id}
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
                    {initials(m.name, m.email)}
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
                      {m.name || m.email}
                    </p>
                    {m.email && (
                      <p
                        className="font-body truncate"
                        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                      >
                        {m.email}
                      </p>
                    )}
                  </div>
                </div>

                {isAdminMember ? (
                  <span
                    className="font-body shrink-0"
                    style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                  >
                    Admin · full access
                  </span>
                ) : (
                  <select
                    value={level}
                    disabled={savingId === id}
                    onChange={(e) => handleChange(id, e.target.value)}
                    className="font-body shrink-0"
                    style={{
                      fontSize: 13,
                      padding: '6px 10px',
                      borderRadius: 'var(--radius-md)',
                      border: '1.5px solid var(--color-border-strong)',
                      background: 'var(--color-bg-surface)',
                      color: 'var(--color-text-primary)',
                      cursor: savingId === id ? 'wait' : 'pointer',
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
    </Modal>
  );
};

export default BoardAccessModal;

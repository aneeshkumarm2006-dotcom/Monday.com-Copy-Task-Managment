import { Fragment, useEffect, useMemo, useState } from 'react';
import { Check, Plus, Trash2, Lock, Loader2, Pencil } from 'lucide-react';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import Input from '../ui/Input';
import * as orgService from '../../services/orgService';

/**
 * PermissionsMatrix — the editor for the role system.
 *
 * Rows are capabilities, columns are roles, cells are checkmarks. Because a role
 * is now just a named bundle of capability keys, this table IS the data — there
 * is no translation layer between what you tick here and what the server enforces.
 *
 * The Owner column is locked on by definition. A role that could revoke the
 * owner's rights is a lockout bug waiting to happen, so the server ignores the
 * owner's stored permissions entirely and this renders that fact rather than
 * pretending it is editable.
 */

const ROLE_COLORS = [
  '#2563EB', '#16A34A', '#EA580C', '#7C3AED', '#DC2626', '#0891B2', '#CA8A04',
];

const Tick = ({ checked, locked, disabled, onChange, label }) => (
  <button
    type="button"
    role="checkbox"
    aria-checked={checked}
    aria-label={label}
    disabled={locked || disabled}
    onClick={() => !locked && !disabled && onChange(!checked)}
    className="inline-flex items-center justify-center transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      width: 22,
      height: 22,
      borderRadius: 'var(--radius-sm)',
      border: checked
        ? '1.5px solid transparent'
        : '1.5px solid var(--color-border-strong)',
      background: checked
        ? locked
          ? '#7C3AED'
          : 'var(--color-accent)'
        : 'transparent',
      cursor: locked || disabled ? 'not-allowed' : 'pointer',
      opacity: disabled && !locked ? 0.45 : 1,
    }}
    title={locked ? 'The owner always has every permission' : undefined}
  >
    {checked && <Check size={13} strokeWidth={3} color="#fff" aria-hidden="true" />}
  </button>
);

const RoleEditorModal = ({ open, role, onClose, onSave, saving }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(ROLE_COLORS[0]);

  useEffect(() => {
    if (!open) return;
    setName(role?.name || '');
    setDescription(role?.description || '');
    setColor(role?.color || ROLE_COLORS[0]);
  }, [open, role]);

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={role ? 'Edit role' : 'New role'}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label
            className="font-body font-semibold"
            style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
            htmlFor="role-name"
          >
            Name
          </label>
          <Input
            id="role-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Contractor"
            autoFocus
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            className="font-body font-semibold"
            style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
            htmlFor="role-desc"
          >
            Description
          </label>
          <Input
            id="role-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this role for?"
          />
        </div>

        <div className="flex flex-col gap-2">
          <span
            className="font-body font-semibold"
            style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
          >
            Colour
          </span>
          <div className="flex items-center gap-2">
            {ROLE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                onClick={() => setColor(c)}
                className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 9999,
                  background: c,
                  border:
                    color === c
                      ? '2px solid var(--color-text-primary)'
                      : '2px solid transparent',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        </div>

        <p
          className="font-body"
          style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}
        >
          {role
            ? 'Permissions are edited in the matrix.'
            : 'The new role starts with no permissions. Tick what it may do in the matrix.'}
        </p>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => onSave({ name, description, color })}
            disabled={!name.trim() || saving}
          >
            {saving ? 'Saving…' : role ? 'Save' : 'Create role'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

const PermissionsMatrix = ({ orgId, onRolesChanged }) => {
  const [roles, setRoles] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingRoleId, setSavingRoleId] = useState(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRole, setEditingRole] = useState(null);
  const [savingRole, setSavingRole] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await orgService.listRoles(orgId);
      setRoles(data.roles || []);
      setCatalog(data.catalog || null);
      setCanManage(!!data.canManage);
      setError('');
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load roles');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (orgId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const ownerOnly = useMemo(() => new Set(catalog?.ownerOnly || []), [catalog]);

  /**
   * Capabilities the owner does NOT hold implicitly. Their column is otherwise
   * locked on; these rows stay togglable for them.
   *
   * The server currently sends an EMPTY list, so the owner column is locked on
   * everywhere. `board.view_all_private` used to be here, and withholding it
   * from the owner turned out to strand any private board whose creator had
   * left — see the note on NEVER_IMPLICIT in the server's capabilities.js. The
   * handling stays because the set is meant to be re-populatable.
   */
  const neverImplicit = useMemo(
    () => new Set(catalog?.neverImplicit || []),
    [catalog]
  );

  /**
   * Optimistic toggle: flip the cell, persist, roll back on failure. The matrix
   * is a lot of small independent writes, so a spinner per cell would be noise —
   * but a silently-lost permission change would be dangerous, hence the rollback
   * and the error banner.
   */
  const toggle = async (role, capability, next) => {
    const before = role.permissions;
    const after = next
      ? [...before, capability]
      : before.filter((c) => c !== capability);

    setRoles((rs) =>
      rs.map((r) => (r.id === role.id ? { ...r, permissions: after } : r))
    );
    setSavingRoleId(role.id);
    try {
      await orgService.updateRole(orgId, role.id, { permissions: after });
      setError('');
      onRolesChanged?.();
    } catch (err) {
      setRoles((rs) =>
        rs.map((r) => (r.id === role.id ? { ...r, permissions: before } : r))
      );
      setError(err?.response?.data?.error || 'Could not save that change');
    } finally {
      setSavingRoleId(null);
    }
  };

  const saveRole = async ({ name, description, color }) => {
    setSavingRole(true);
    try {
      if (editingRole) {
        await orgService.updateRole(orgId, editingRole.id, {
          name,
          description,
          color,
        });
      } else {
        await orgService.createRole(orgId, {
          name,
          description,
          color,
          permissions: [],
        });
      }
      setEditorOpen(false);
      setEditingRole(null);
      await load();
      onRolesChanged?.();
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not save the role');
    } finally {
      setSavingRole(false);
    }
  };

  const removeRole = async (role) => {
    try {
      const res = await orgService.deleteRole(orgId, role.id);
      setConfirmDelete(null);
      await load();
      onRolesChanged?.();
      if (res.reassigned > 0) {
        setError('');
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not delete the role');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8" style={{ color: 'var(--color-text-secondary)' }}>
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        <span className="font-body" style={{ fontSize: 14 }}>Loading permissions…</span>
      </div>
    );
  }

  if (!catalog) {
    return (
      <p className="font-body" style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>
        {error || 'Permissions are unavailable.'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <h2
            className="font-display font-bold"
            style={{ fontSize: 18, color: 'var(--color-text-primary)' }}
          >
            Roles &amp; permissions
          </h2>
          <p
            className="font-body"
            style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: '62ch' }}
          >
            A role is whatever you tick here. Board-level access is a second,
            separate gate — someone needs the permission <em>and</em> access to the
            board before they can use it.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setEditingRole(null);
              setEditorOpen(true);
            }}
          >
            <Plus size={15} aria-hidden="true" />
            New role
          </Button>
        )}
      </div>

      {!canManage && (
        <div
          className="flex items-center gap-2 font-body"
          style={{
            fontSize: 13,
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text-secondary)',
          }}
        >
          <Lock size={14} aria-hidden="true" />
          Only the workspace owner can change these. You can see who may do what.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="font-body"
          style={{
            fontSize: 13,
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-status-stuck-bg)',
            color: 'var(--color-status-stuck)',
          }}
        >
          {error}
        </div>
      )}

      <div
        className="overflow-x-auto"
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--color-bg-surface)',
        }}
      >
        <table
          className="w-full"
          style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: 720 }}
        >
          <thead>
            <tr>
              <th
                scope="col"
                className="text-left font-body font-semibold"
                style={{
                  position: 'sticky',
                  left: 0,
                  zIndex: 2,
                  background: 'var(--color-bg-surface)',
                  minWidth: 280,
                  padding: '12px 16px',
                  fontSize: 12,
                  color: 'var(--color-text-secondary)',
                  borderBottom: '1px solid var(--color-border-strong, var(--color-border))',
                }}
              >
                Capability
              </th>
              {roles.map((role) => (
                <th
                  key={role.id}
                  scope="col"
                  style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--color-border-strong, var(--color-border))',
                    minWidth: 96,
                  }}
                >
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className="font-display font-bold"
                      style={{ fontSize: 13, color: role.color }}
                    >
                      {role.name}
                    </span>
                    <span
                      className="font-body"
                      style={{ fontSize: 10, color: 'var(--color-text-muted)' }}
                    >
                      {role.isOwner
                        ? 'locked'
                        : `${role.memberCount} ${role.memberCount === 1 ? 'member' : 'members'}`}
                    </span>
                    {canManage && !role.isOwner && (
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Edit ${role.name}`}
                          onClick={() => {
                            setEditingRole(role);
                            setEditorOpen(true);
                          }}
                          style={{ color: 'var(--color-text-muted)', cursor: 'pointer' }}
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </button>
                        {!role.isSystem && (
                          <button
                            type="button"
                            aria-label={`Delete ${role.name}`}
                            onClick={() => setConfirmDelete(role)}
                            style={{ color: 'var(--color-text-muted)', cursor: 'pointer' }}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catalog.groups.map((group) => (
              <Fragment key={group.key}>
                <tr>
                  <td
                    colSpan={roles.length + 1}
                    className="font-body font-semibold uppercase"
                    style={{
                      padding: '8px 16px',
                      fontSize: 10,
                      letterSpacing: '0.08em',
                      color: 'var(--color-text-secondary)',
                      background: 'var(--color-bg-subtle)',
                      borderBottom: '1px solid var(--color-border)',
                    }}
                  >
                    {group.name}
                  </td>
                </tr>
                {group.capabilities.map((cap) => (
                  <tr key={cap.key}>
                    <td
                      style={{
                        position: 'sticky',
                        left: 0,
                        zIndex: 1,
                        background: 'var(--color-bg-surface)',
                        padding: '9px 16px',
                        borderBottom: '1px solid var(--color-border)',
                      }}
                    >
                      <span
                        className="block font-body"
                        style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                      >
                        {cap.description}
                      </span>
                      <code
                        className="block"
                        style={{
                          fontSize: 11,
                          fontFamily: 'ui-monospace, monospace',
                          color: 'var(--color-text-muted)',
                        }}
                      >
                        {cap.key}
                      </code>
                    </td>
                    {roles.map((role) => {
                      const optIn = neverImplicit.has(cap.key);
                      // The owner column is locked ON everywhere — except the
                      // never-implicit rows, which even they must opt into.
                      const locked = role.isOwner && !optIn;
                      // Owner-only powers can never be granted to another role —
                      // the server strips them on write, so don't pretend here.
                      const forbidden = !role.isOwner && ownerOnly.has(cap.key);
                      const checked =
                        locked || role.permissions.includes(cap.key);
                      return (
                        <td
                          key={role.id}
                          className="text-center"
                          style={{
                            padding: '6px 12px',
                            borderBottom: '1px solid var(--color-border)',
                          }}
                        >
                          <Tick
                            checked={checked && !forbidden}
                            locked={locked}
                            disabled={
                              !canManage ||
                              forbidden ||
                              savingRoleId === role.id
                            }
                            onChange={(next) => toggle(role, cap.key, next)}
                            label={`${role.name} — ${cap.key}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p
        className="font-body"
        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
      >
        <strong>Enter every private board</strong> and <strong>Fully manage every
        private board they can enter</strong> are off for everyone by default,
        admins included. The first lets a role open private boards it was never
        given access to; the second lets it rename, delete, re-share and
        un-private them once inside. Neither applies to the workspace owner, who
        already holds every board in the workspace outright.
      </p>

      <RoleEditorModal
        open={editorOpen}
        role={editingRole}
        saving={savingRole}
        onClose={() => {
          setEditorOpen(false);
          setEditingRole(null);
        }}
        onSave={saveRole}
      />

      <Modal
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={`Delete “${confirmDelete?.name}”?`}
      >
        <div className="flex flex-col gap-4">
          <p className="font-body" style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>
            {confirmDelete?.memberCount > 0
              ? `${confirmDelete.memberCount} ${confirmDelete.memberCount === 1 ? 'person holds' : 'people hold'} this role. They will be moved to Member.`
              : 'Nobody holds this role.'}
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => removeRole(confirmDelete)}>
              Delete role
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default PermissionsMatrix;

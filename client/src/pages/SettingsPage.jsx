import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, Copy, Check, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import SettingsSidebar, { SettingsTabBar } from '../components/settings/SettingsSidebar';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import NotificationPreferences from '../components/notifications/NotificationPreferences';
import ExtraFeaturesTab from '../components/settings/ExtraFeaturesTab';
import ConnectorsTab from '../components/settings/ConnectorsTab';
import CurrencyTab from '../components/settings/CurrencyTab';
import HolidaysTab from '../components/settings/HolidaysTab';
import MyViewTab from '../components/settings/MyViewTab';
import LogoUploader from '../components/ui/LogoUploader';
import { hasAnyExtraFeature } from '../utils/extraFeatures';
import useAuthStore from '../store/authStore';
import useToastStore from '../store/toastStore';
import { SegmentedControl } from '../components/ui/FormControls';
import { DISPLAY_CURRENCIES } from '../utils/money';
import useOrgStore from '../store/orgStore';
import usePermissionStore from '../store/permissionStore';
import useExecutiveViewStore, {
  selectIsExecutive,
} from '../store/executiveViewStore';
import usePermissions from '../hooks/usePermissions';
import * as orgService from '../services/orgService';
import * as profileService from '../services/profileService';
// The deletion preview is read-only and has exactly one consumer — the delete
// account modal below — so it is called straight through the shared axios
// instance rather than growing a service wrapper that nothing else would use.
import api from '../services/api';
/**
 * Settings Page — org and profile.
 * See Macan_Design.md Section 7.8.
 */

const getInitial = (name) => (name ? name.trim().charAt(0).toUpperCase() : '?');

const Avatar = ({ user, size = 40 }) => {
  const [imgError, setImgError] = useState(false);
  if (user?.profilePic && !imgError) {
    return (
      <img
        src={user.profilePic}
        alt={user.name || 'Avatar'}
        className="object-cover"
        style={{ width: size, height: size, borderRadius: 9999 }}
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center font-display font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: 'var(--color-accent-light)',
        color: 'var(--color-accent-text)',
        fontSize: size * 0.4,
      }}
      aria-hidden="true"
    >
      {getInitial(user?.name)}
    </div>
  );
};

const Chip = ({ children, variant = 'grey' }) => {
  const styles =
    variant === 'blue'
      ? {
          background: 'var(--color-accent-light)',
          color: 'var(--color-accent-text)',
        }
      : {
          background: 'var(--color-bg-subtle)',
          color: 'var(--color-text-secondary)',
        };
  return (
    <span
      className="inline-flex items-center font-body font-semibold"
      style={{
        height: 22,
        padding: '0 10px',
        fontSize: 11,
        borderRadius: 'var(--radius-full)',
        letterSpacing: 0.3,
        ...styles,
      }}
    >
      {children}
    </span>
  );
};

/* ------------------------- Workspace tab ------------------------- */

const OrganisationTab = ({ org, isOwner, onRegenerate, onDeleteOrg }) => {
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const confirmMatches =
    org?.name && deleteConfirmText.trim() === org.name.trim();

  // The logo is read from the STORE, not from `org`: `org` is this page's own
  // fetched copy, and the store is what the rail and the switcher draw from —
  // reading the same copy the upload patches keeps all three in step.
  const storeOrg = useOrgStore((st) => st.currentOrg);
  const setOrgLogo = useOrgStore((st) => st.setOrgLogo);
  const orgId = storeOrg?._id || org?._id;
  const orgLogo = storeOrg?.logo || '';

  // Build the invite URL — we surface the raw code so users can paste it
  // into the Join flow. Include origin for convenience.
  const inviteUrl = org?.inviteCode
    ? `${window.location.origin}/onboarding?invite=${org.inviteCode}`
    : '';

  const handleCopy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = inviteUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await onRegenerate();
    } finally {
      setRegenerating(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!confirmMatches) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await onDeleteOrg();
    } catch (err) {
      setDeleteError(err.response?.data?.error || 'Failed to delete workspace. Please try again.');
      setDeleting(false);
    }
  };

  const closeDeleteModal = () => {
    if (deleting) return;
    setShowDeleteModal(false);
    setDeleteConfirmText('');
    setDeleteError('');
  };

  return (
    <div>
      <header className="mb-6">
        <div className="min-w-0">
          <h2
            className="font-display font-bold text-[color:var(--color-text-primary)]"
            style={{ fontSize: 20 }}
          >
            Workspace
          </h2>
          <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)] truncate">
            {org?.name || 'Workspace settings'}
          </p>
        </div>
      </header>

      {/* Workspace logo — shown in the side rail, the workspace switcher and
          the mobile workspace sheet, for everyone in the workspace. */}
      <section>
        <LogoUploader
          label="Workspace logo"
          hint="Shown in the sidebar and workspace switcher for everyone. PNG, JPG, SVG or WEBP · up to 2MB."
          value={orgLogo}
          name={storeOrg?.name || org?.name}
          disabled={!orgId}
          onUpload={(file) => setOrgLogo(orgId, file)}
          onRemove={() => setOrgLogo(orgId, null)}
        />
      </section>

      {/* Invite Link section */}
      <section className="mt-8 pt-8" style={{ borderTop: '1px solid var(--color-border)' }}>
        <h3
          className="font-display font-semibold text-[color:var(--color-text-primary)]"
          style={{ fontSize: 15 }}
        >
          Invite Link
        </h3>
        <p className="mt-1 font-body text-xs text-[color:var(--color-text-muted)]">
          Share this link with teammates to let them join.
        </p>

        <div className="mt-3 flex flex-col sm:flex-row items-stretch gap-2">
          <input
            type="text"
            readOnly
            value={inviteUrl}
            className="flex-1 font-body text-[13px] text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-subtle)] px-3 focus:outline-none"
            style={{
              height: 38,
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
            }}
            aria-label="Invite link"
            onFocus={(e) => e.target.select()}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="default"
              icon={copied ? Check : Copy}
              onClick={handleCopy}
            >
              {copied ? 'Copied' : 'Copy Link'}
            </Button>
            <Button
              variant="secondary"
              size="default"
              icon={RefreshCw}
              onClick={handleRegenerate}
              disabled={regenerating}
            >
              {regenerating ? 'Regenerating…' : 'Regenerate'}
            </Button>
          </div>
        </div>

        <p className="mt-2 font-body text-xs text-[color:var(--color-text-muted)]">
          Invite code:{' '}
          <span
            className="font-mono font-semibold text-[color:var(--color-text-secondary)]"
            style={{ fontSize: 12 }}
          >
            {org?.inviteCode || '—'}
          </span>
        </p>
      </section>

      {/* Danger zone */}
      <section
        className="mt-8 pt-8"
        style={{ borderTop: '1px solid var(--color-border)' }}
      >
        <h3
          className="font-display font-semibold text-[color:var(--color-status-stuck)]"
          style={{ fontSize: 15 }}
        >
          Danger Zone
        </h3>
        <p className="mt-1 font-body text-xs text-[color:var(--color-text-muted)]">
          Irreversible actions for this workspace.
        </p>
        <div
          className="mt-3"
          style={{
            border: '1.5px solid var(--color-status-stuck)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-status-stuck-bg)',
            overflow: 'hidden',
          }}
        >
          <div className="p-4 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="font-body font-semibold text-[13px] text-[color:var(--color-text-primary)]">
                Regenerate invite code
              </p>
              <p className="font-body text-[12px] text-[color:var(--color-text-secondary)]">
                Old invite links will stop working immediately.
              </p>
            </div>
            <Button
              variant="danger"
              size="sm"
              icon={RefreshCw}
              onClick={handleRegenerate}
              disabled={regenerating}
            >
              Regenerate
            </Button>
          </div>

          {/* Deleting the org is reserved to the owner and is deliberately NOT a
              capability — no role may ever be granted it. */}
          {isOwner && (
            <div
              className="p-4 flex items-center justify-between gap-4 flex-wrap"
              style={{ borderTop: '1px solid var(--color-status-stuck)' }}
            >
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-body font-semibold text-[13px] text-[color:var(--color-text-primary)]">
                    Delete this workspace
                  </p>
                  <span
                    className="inline-flex items-center font-body font-semibold"
                    style={{
                      height: 18,
                      padding: '0 8px',
                      fontSize: 10,
                      borderRadius: 'var(--radius-full)',
                      letterSpacing: 0.4,
                      background: 'var(--color-status-stuck)',
                      color: 'white',
                    }}
                  >
                    OWNER ONLY
                  </span>
                </div>
                <p className="font-body text-[12px] text-[color:var(--color-text-secondary)]">
                  Permanently deletes the workspace, all boards, tasks, automations,
                  and removes every member. This cannot be undone.
                </p>
              </div>
              <Button
                variant="danger"
                size="sm"
                icon={Trash2}
                onClick={() => {
                  setDeleteError('');
                  setDeleteConfirmText('');
                  setShowDeleteModal(true);
                }}
              >
                Delete Workspace
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Delete-workspace confirmation modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={closeDeleteModal}
        title={`Delete "${org?.name || 'organisation'}"`}
        closeOnOverlayClick={!deleting}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={closeDeleteModal}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleDeleteConfirm}
              disabled={deleting || !confirmMatches}
            >
              {deleting ? 'Deleting…' : 'Delete Workspace'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div
            className="flex items-start gap-3 rounded-lg p-3"
            style={{ background: '#fff5f5', border: '1px solid #fca5a5' }}
          >
            <AlertTriangle size={18} color="#dc2626" style={{ flexShrink: 0, marginTop: 1 }} />
            <p className="font-body text-[13px]" style={{ color: '#374151' }}>
              <strong>This action is permanent and cannot be undone.</strong>
            </p>
          </div>
          <p className="font-body text-[14px] text-[color:var(--color-text-primary)]">
            Deleting this workspace will:
          </p>
          <ul
            className="font-body text-[13px] text-[color:var(--color-text-secondary)] flex flex-col gap-1"
            style={{ paddingLeft: 16, listStyleType: 'disc' }}
          >
            <li>Delete every board, group, task, comment, and update in this workspace</li>
            <li>Delete all automations configured for this workspace</li>
            <li>Delete all notifications scoped to this workspace</li>
            <li>Remove all {org?.members?.length || ''} members from the workspace</li>
          </ul>
          <div className="mt-1">
            <label
              className="font-body text-[12px] font-semibold text-[color:var(--color-text-secondary)]"
              htmlFor="delete-org-confirm"
            >
              Type <span className="font-mono text-[color:var(--color-text-primary)]">{org?.name}</span> to confirm:
            </label>
            <input
              id="delete-org-confirm"
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              disabled={deleting}
              autoComplete="off"
              className="mt-2 w-full font-body text-[13px] text-[color:var(--color-text-primary)] bg-white px-3 focus:outline-none focus:border-[color:var(--color-accent)]"
              style={{
                height: 38,
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
              }}
            />
          </div>
          {deleteError && (
            <p className="font-body text-[12px] text-[color:var(--color-status-stuck)]">
              {deleteError}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
};

/* ---------------------------- Profile tab ---------------------------- */

const ProfileTab = ({ user, onSaveName, onUploadAvatar, onDeleteAccount }) => {
  const displayCurrency = user?.displayCurrency || null;
  const setDisplayCurrency = useAuthStore((s) => s.setDisplayCurrency);
  const toastError = useToastStore((s) => s.error);

  /**
   * Optimistic, like the avatar-menu toggle it mirrors. Nothing is at risk if
   * the write fails — this only decides how stored numbers are DISPLAYED — so
   * the figures on screen should follow the click rather than the round trip.
   */
  const handleDisplayCurrency = async (code) => {
    try {
      await setDisplayCurrency(code);
    } catch {
      toastError('Could not save that preference.');
    }
  };

  const [name, setName] = useState(user?.name || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [avatarLoadError, setAvatarLoadError] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  /**
   * The blast radius of an account deletion, and the friction in front of it.
   *
   * Deleting your account is a strict SUPERSET of deleting a workspace — it
   * takes every workspace you are alone in with you — yet the workspace modal a
   * few hundred lines up makes you type the workspace's name while this one
   * used to be a plain "Yes, Delete My Account" button in front of four
   * sentences of generic prose that never named a single workspace. The screen
   * could not name them because it never asked; it now does, via
   * `GET /api/profile/deletion-preview`, which returns the same two lists the
   * DELETE handler itself computes, so the warning and the server can never
   * disagree about what is about to happen.
   *
   * `blocking` are workspaces you own that still have other people in them. The
   * server refuses outright in that case (409 OWNED_WORKSPACES_NOT_EMPTY), so
   * the button is disabled rather than letting the user type the confirmation,
   * press it, and be told no.
   */
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    setName(user?.name || '');
  }, [user?.name]);

  // Asked for when the modal opens rather than on mount: this is a page every
  // member visits to change their display name, and nobody should pay for a
  // workspace-ownership scan to do that.
  useEffect(() => {
    if (!showDeleteModal) return undefined;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError('');
    api
      // The modal renders the failure itself; the global interceptor's toast
      // would put the same sentence in two places at once.
      .get('/api/profile/deletion-preview', { suppressErrorToast: true })
      .then(({ data }) => {
        if (!cancelled) setPreview(data);
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewError(
            "Couldn't check which workspaces this would delete. Deleting will "
              + 'still refuse if you own a workspace with other members in it.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showDeleteModal]);

  const effectiveAvatar = previewUrl || user?.profilePic;

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Image must be smaller than 5MB');
      return;
    }
    setError('');

    // Local preview
    const localUrl = URL.createObjectURL(file);
    setPreviewUrl(localUrl);
    setAvatarLoadError(false);
    setUploading(true);
    try {
      await onUploadAvatar(file);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      // Drop the blob preview now that the real Cloudinary URL is on the user
      URL.revokeObjectURL(localUrl);
      setPreviewUrl(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed');
      URL.revokeObjectURL(localUrl);
      setPreviewUrl(null);
    } finally {
      setUploading(false);
      // Reset the input so the same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSaveName = async (e) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === user?.name) return;
    setSaving(true);
    setError('');
    try {
      await onSaveName(name.trim());
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const dirty = name.trim() && name.trim() !== (user?.name || '');

  const blockingOrgs = preview?.blocking || [];
  const soloOrgs = preview?.solo || [];
  // An unreachable preview must not trap someone in an account they want gone:
  // the server is the authority on the refusal and will 409 on its own, so an
  // unknown answer stays clickable while a known "no" does not.
  const canDelete = !preview || preview.canDelete !== false;
  // The same shape as the workspace modal's gate above — an exact, trimmed
  // string match against a word the user has to type out. The word is DELETE
  // rather than an account name because the thing being destroyed has no name
  // to echo back.
  const deleteConfirmMatches = deleteConfirmText.trim() === 'DELETE';

  const closeDeleteModal = () => {
    if (deleting) return;
    setShowDeleteModal(false);
    setDeleteConfirmText('');
    setDeleteError('');
    // The preview goes too. It is a statement about the blast radius RIGHT NOW,
    // and the effect above refetches on every open — so keeping the last run's
    // lists would render a stale set of workspace names, and after a 409 would
    // also carry that refusal's synthesised `canDelete: false` forward and
    // disable the button on a reopen that has not asked the server yet.
    setPreview(null);
    setPreviewError('');
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmMatches || !canDelete) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await onDeleteAccount();
    } catch (err) {
      const body = err.response?.data;
      // The refusal carries the offending workspaces with it. It is also newer
      // than the preview this modal opened with — somebody may have joined a
      // workspace in between — so it replaces that list rather than being shown
      // beside it.
      if (body?.code === 'OWNED_WORKSPACES_NOT_EMPTY') {
        setPreview((prev) => ({
          blocking: body.orgs || [],
          solo: prev?.solo || [],
          canDelete: false,
        }));
      }
      setDeleteError(body?.error || 'Failed to delete account. Please try again.');
      setDeleting(false);
    }
  };

  return (
    <div>
      <header className="mb-6">
        <h2
          className="font-display font-bold text-[color:var(--color-text-primary)]"
          style={{ fontSize: 20 }}
        >
          Profile
        </h2>
        <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)]">
          Manage your personal details
        </p>
      </header>

      {/* Avatar uploader */}
      <div className="flex items-center gap-4 mb-8">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          aria-label="Change profile picture"
          className="relative group focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded-full"
          style={{ width: 80, height: 80 }}
        >
          {effectiveAvatar && !avatarLoadError ? (
            <img
              src={effectiveAvatar}
              alt={user?.name || 'Avatar'}
              className="object-cover"
              style={{ width: 80, height: 80, borderRadius: 9999 }}
              onError={() => setAvatarLoadError(true)}
            />
          ) : (
            <div
              className="flex items-center justify-center font-display font-semibold"
              style={{
                width: 80,
                height: 80,
                borderRadius: 9999,
                background: 'var(--color-accent-light)',
                color: 'var(--color-accent-text)',
                fontSize: 32,
              }}
            >
              {getInitial(user?.name)}
            </div>
          )}
          {/* Hover overlay */}
          <span
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150"
            style={{
              borderRadius: 9999,
              background: 'rgba(0, 0, 0, 0.5)',
            }}
            aria-hidden="true"
          >
            <Camera size={24} color="white" />
          </span>
          {uploading && (
            <span
              className="absolute inset-0 flex items-center justify-center"
              style={{
                borderRadius: 9999,
                background: 'rgba(0, 0, 0, 0.5)',
              }}
            >
              <span className="font-body text-[11px] font-semibold text-white">
                Uploading…
              </span>
            </span>
          )}
        </button>
        <div>
          <p className="font-body font-semibold text-[14px] text-[color:var(--color-text-primary)]">
            Profile picture
          </p>
          <p className="font-body text-[12px] text-[color:var(--color-text-muted)]">
            PNG or JPG, up to 5MB
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="hidden"
            aria-label="Upload avatar"
          />
        </div>
      </div>

      {/* Name + email form */}
      <form onSubmit={handleSaveName} className="flex flex-col gap-4 max-w-[480px]" style={{ maxWidth: 480 }}>
        <Input
          label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          disabled={saving}
          required
        />
        <Input
          label="Email"
          type="email"
          value={user?.email || ''}
          onChange={() => {}}
          disabled
          helperText="Connected via Google — cannot be changed."
        />

        {error && (
          <p className="font-body text-[12px] text-[color:var(--color-status-stuck)]">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 mt-2">
          <Button
            type="submit"
            variant="primary"
            disabled={!dirty || saving}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </Button>
          {saved && (
            <span className="inline-flex items-center gap-1 font-body text-[12px] font-semibold text-[color:var(--color-status-done)]">
              <Check size={14} aria-hidden="true" />
              Saved
            </span>
          )}
        </div>
      </form>

      {/*
        How this person reads money, everywhere in the product.

        Here as well as in the avatar menu, and not instead of it: the menu is
        where you reach for it mid-task, this is where you look when you are
        asking "what are my settings". Every other per-user preference in this
        app lives on this tab, and a site-wide display preference reachable only
        from an avatar dropdown is one most people would never find.
      */}
      <div className="mt-10">
        <h3
          className="font-display font-bold text-[color:var(--color-text-primary)]"
          style={{ fontSize: 15 }}
        >
          Currency
        </h3>
        <p
          className="font-body mt-1"
          style={{ fontSize: 12.5, color: 'var(--color-text-muted)', lineHeight: 1.6 }}
        >
          Show every amount in this currency, converted at the rate that applied when each
          record was dated. This changes nothing about what anything is billed in — only what
          you see.
        </p>
        <div className="mt-3" style={{ maxWidth: 360 }}>
          <SegmentedControl
            value={displayCurrency || 'as-entered'}
            onChange={(v) => handleDisplayCurrency(v === 'as-entered' ? null : v)}
            options={[
              { value: 'as-entered', label: 'As entered' },
              ...DISPLAY_CURRENCIES.map((code) => ({ value: code, label: code })),
            ]}
          />
        </div>
      </div>

      {/* Danger Zone */}
      <div
        className="mt-10"
        style={{
          maxWidth: 480,
          border: '1px solid #fca5a5',
          borderRadius: 'var(--radius-lg)',
          padding: 20,
          background: '#fff5f5',
        }}
      >
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={16} color="#dc2626" aria-hidden="true" />
          <h3
            className="font-display font-semibold"
            style={{ fontSize: 14, color: '#dc2626' }}
          >
            Danger Zone
          </h3>
        </div>
        <p className="font-body text-[13px] mb-4" style={{ color: '#6b7280' }}>
          Permanently delete your account and all associated data. This cannot be undone.
        </p>
        <Button
          type="button"
          variant="danger"
          onClick={() => {
            setDeleteError('');
            setDeleteConfirmText('');
            setShowDeleteModal(true);
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
          Delete Account
        </Button>
      </div>

      {/* Delete confirmation modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={closeDeleteModal}
        title="Delete Account"
        closeOnOverlayClick={!deleting}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={closeDeleteModal}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleDeleteConfirm}
              disabled={
                deleting || previewLoading || !canDelete || !deleteConfirmMatches
              }
            >
              {deleting ? 'Deleting…' : 'Yes, Delete My Account'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div
            className="flex items-start gap-3 rounded-lg p-3"
            style={{ background: '#fff5f5', border: '1px solid #fca5a5' }}
          >
            <AlertTriangle size={18} color="#dc2626" style={{ flexShrink: 0, marginTop: 1 }} />
            <p className="font-body text-[13px]" style={{ color: '#374151' }}>
              <strong>This action is permanent and cannot be undone.</strong>
            </p>
          </div>
          {previewLoading && (
            <p className="font-body text-[13px] text-[color:var(--color-text-secondary)]">
              Checking which workspaces this would delete…
            </p>
          )}
          {previewError && (
            <p className="font-body text-[12px] text-[color:var(--color-status-stuck)]">
              {previewError}
            </p>
          )}

          {/* Workspaces that stop the delete. Shown FIRST, because everything
              below it is moot until they are handed over or emptied. */}
          {blockingOrgs.length > 0 && (
            <div
              className="rounded-lg p-3 flex flex-col gap-2"
              style={{ background: '#fff5f5', border: '1px solid #fca5a5' }}
            >
              <p className="font-body text-[13px]" style={{ color: '#374151' }}>
                <strong>
                  You can&apos;t delete your account yet.
                </strong>{' '}
                {blockingOrgs.length === 1 ? 'This workspace' : 'These workspaces'}{' '}
                {blockingOrgs.length === 1 ? 'is' : 'are'} yours and still
                {blockingOrgs.length === 1 ? ' has' : ' have'} other people in
                {blockingOrgs.length === 1 ? ' it' : ' them'}:
              </p>
              <ul
                className="font-body text-[13px] flex flex-col gap-1"
                style={{ color: '#374151', paddingLeft: 16, listStyleType: 'disc' }}
              >
                {blockingOrgs.map((o) => (
                  <li key={o._id}>
                    <span className="font-semibold">{o.name}</span> —{' '}
                    {o.memberCount} other member{o.memberCount === 1 ? '' : 's'}
                    {o.memberNames?.length
                      ? ` (${o.memberNames.slice(0, 3).join(', ')}${
                          o.memberNames.length > 3
                            ? ` +${o.memberNames.length - 3} more`
                            : ''
                        })`
                      : ''}
                  </li>
                ))}
              </ul>
              <p className="font-body text-[12px]" style={{ color: '#6b7280' }}>
                Hand each one over from its Members page (Transfer ownership),
                or remove everyone from it, then come back here.
              </p>
            </div>
          )}

          <p className="font-body text-[14px] text-[color:var(--color-text-primary)]">
            Deleting your account will:
          </p>
          {/* The workspaces that go WITH you, by name. These are the ones you
              are alone in — there is nobody to hand them to, so they cannot be
              rescued the way a blocking workspace can. */}
          {soloOrgs.length > 0 && (
            <div
              className="rounded-lg p-3"
              style={{
                background: 'var(--color-bg-subtle)',
                border: '1px solid var(--color-border)',
              }}
            >
              <p className="font-body text-[13px] font-semibold text-[color:var(--color-text-primary)]">
                Permanently delete{' '}
                {soloOrgs.length === 1
                  ? 'this workspace'
                  : `these ${soloOrgs.length} workspaces`}
                , and every board, task, comment, file and vault in{' '}
                {soloOrgs.length === 1 ? 'it' : 'them'}:
              </p>
              <ul
                className="mt-1 font-body text-[13px] text-[color:var(--color-text-secondary)] flex flex-col gap-1"
                style={{ paddingLeft: 16, listStyleType: 'disc' }}
              >
                {soloOrgs.map((o) => (
                  <li key={o._id}>{o.name}</li>
                ))}
              </ul>
            </div>
          )}
          <ul className="font-body text-[13px] text-[color:var(--color-text-secondary)] flex flex-col gap-1" style={{ paddingLeft: 16, listStyleType: 'disc' }}>
            {/* The fallback for an unreachable preview. The named list above is
                strictly better, but without this the failure path would say
                LESS than the generic copy it replaced — a modal that cannot
                reach the server must still state that owned workspaces go. */}
            {!preview && (
              <li>
                Permanently delete every workspace you own and are the only
                member of, including all their boards, tasks, files and vaults
              </li>
            )}
            <li>Remove you from every other workspace you are a member of</li>
            <li>Delete all your personal tasks, comments and updates</li>
            <li>Delete your direct messages, saved messages and notifications</li>
            <li>Delete your profile and all account data</li>
          </ul>

          <div className="mt-1">
            <label
              className="font-body text-[12px] font-semibold text-[color:var(--color-text-secondary)]"
              htmlFor="delete-account-confirm"
            >
              Type <span className="font-mono text-[color:var(--color-text-primary)]">DELETE</span> to confirm:
            </label>
            <input
              id="delete-account-confirm"
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              disabled={deleting || !canDelete}
              autoComplete="off"
              className="mt-2 w-full font-body text-[13px] text-[color:var(--color-text-primary)] bg-white px-3 focus:outline-none focus:border-[color:var(--color-accent)]"
              style={{
                height: 38,
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
              }}
            />
          </div>
          {deleteError && (
            <p className="font-body text-[12px] text-[color:var(--color-status-stuck)]">
              {deleteError}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
};

/* ------------------------------ Page ------------------------------ */

const SettingsPage = () => {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const fetchCurrentUser = useAuthStore((s) => s.fetchCurrentUser);
  const logout = useAuthStore((s) => s.logout);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const deleteOrgFromStore = useOrgStore((s) => s.deleteOrg);
  const permissionsLoading = usePermissionStore((s) => s.loading);
  const loadedForOrg = usePermissionStore((s) => s.loadedForOrg);
  const { can, isOwner } = usePermissions();
  const [searchParams] = useSearchParams();

  // The Workspace tab is nothing but org settings — the invite code lives there.
  const canManageOrg = can('org.manage_settings');
  // Extra features only exists if at least one opt-in tool is available to you.
  // Derived from the feature table itself, so a new entry brings its own audience
  // with it rather than needing a capability added to a list over here too.
  const canExtraFeatures = hasAnyExtraFeature(can);
  // The holiday calendar has its own row in the permissions matrix, so this is
  // NOT derived from canManageOrg — a role can hold one without the other.
  const canManageHolidays = can('org.manage_holidays');
  const permissionsResolved =
    !!currentOrg && !permissionsLoading && loadedForOrg === currentOrg._id;

  /**
   * "My view" — the Settings half of the executive view (its rail switches,
   * board order and labels).
   *
   * NOT a capability. `isExecutive` is `profile !== null` and nothing else, and
   * the profile is fetched once per (user, org) from `App.jsx`; a person with no
   * profile has no document for this tab to edit, so the tab is simply not
   * theirs. Everything below that touches it is inside this flag, which is what
   * makes this page byte-identical for everybody else.
   *
   * It has its own "has it resolved yet" test for exactly the reason the
   * permissions one above has: the store starts at `profile: null`, which is
   * indistinguishable from "not an Executive", so a redirect decided before the
   * fetch lands would bounce an Executive off `?tab=myview` on every cold load.
   */
  const isExecutive = useExecutiveViewStore(selectIsExecutive);
  const executiveLoading = useExecutiveViewStore((s) => s.loading);
  const executiveLoadedForOrg = useExecutiveViewStore((s) => s.loadedForOrg);
  const executiveResolved =
    !!currentOrg &&
    !executiveLoading &&
    executiveLoadedForOrg === currentOrg._id;

  // Seeded from `?tab=` so a link can point at one section — the connector OAuth
  // callback returns to `/settings?tab=connectors`, and landing on Workspace
  // instead would leave the user staring at the wrong screen after a consent.
  // Deliberately a SEED, not a source of truth: the tab is state from then on,
  // matching how this page has always worked.
  const [activeTab, setActiveTab] = useState(
    () => searchParams.get('tab') || 'organisation'
  );
  const [orgState, setOrgState] = useState(currentOrg || null);

  // Keep local orgState in sync with currentOrg
  useEffect(() => {
    setOrgState(currentOrg || null);
  }, [currentOrg]);

  // Bounce off an admin-only tab the user can't manage — but only once permissions
  // have actually resolved for this org. Capabilities start empty, so deciding
  // early would strand a manager on Profile and never send them back.
  useEffect(() => {
    if (!permissionsResolved) return;
    if (!canManageOrg && activeTab === 'organisation') setActiveTab('profile');
    if (!canManageOrg && activeTab === 'connectors') setActiveTab('profile');
    if (!canManageOrg && activeTab === 'currency') setActiveTab('profile');
    if (!canManageHolidays && activeTab === 'holidays') setActiveTab('profile');
    if (!canExtraFeatures && activeTab === 'features') setActiveTab('profile');
    // Gated on its OWN resolution, not on the permissions one: the two loads are
    // independent, and deciding this from an unresolved store would bounce every
    // Executive who followed a `?tab=myview` link.
    if (executiveResolved && !isExecutive && activeTab === 'myview') {
      setActiveTab('profile');
    }
  }, [
    permissionsResolved,
    canManageOrg,
    canExtraFeatures,
    canManageHolidays,
    executiveResolved,
    isExecutive,
    activeTab,
  ]);

  // Fetch org details (with inviteCode) for Workspace tab
  useEffect(() => {
    if (activeTab === 'organisation' && currentOrg?._id && !orgState?.inviteCode) {
      orgService
        .getOrg(currentOrg._id)
        .then((o) => setOrgState(o))
        .catch(() => {});
    }
  }, [activeTab, currentOrg?._id, orgState?.inviteCode]);

  const handleRegenerate = async () => {
    if (!currentOrg?._id) return;
    const newCode = await orgService.regenerateInvite(currentOrg._id);
    setOrgState((prev) => (prev ? { ...prev, inviteCode: newCode } : prev));
  };

  const handleSaveName = async (name) => {
    await profileService.updateProfile({ name });
    await fetchCurrentUser();
  };

  const handleUploadAvatar = async (file) => {
    await profileService.uploadAvatar(file);
    await fetchCurrentUser();
  };

  const handleDeleteAccount = async () => {
    await profileService.deleteAccount();
    // `purgeLocal` — the account is gone, so the per-user residue in
    // localStorage (unsent Update drafts) has to go with it. An ordinary sign-out
    // deliberately keeps them; see the comment on `logout`.
    await logout({ purgeLocal: true });
    navigate('/login');
  };

  const handleDeleteOrg = async () => {
    if (!currentOrg?._id) return;
    const nextOrg = await deleteOrgFromStore(currentOrg._id);
    await fetchCurrentUser();
    navigate(nextOrg ? '/dashboard' : '/onboarding');
  };

  const renderTab = () => {
    if (activeTab === 'organisation' && canManageOrg) {
      return (
        <OrganisationTab
          org={orgState}
          isOwner={isOwner}
          onRegenerate={handleRegenerate}
          onDeleteOrg={handleDeleteOrg}
        />
      );
    }
    if (activeTab === 'notifications') {
      return (
        <div>
          <header className="mb-6">
            <h2
              className="font-display font-bold text-[color:var(--color-text-primary)]"
              style={{ fontSize: 20 }}
            >
              Notifications
            </h2>
            <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)]">
              Control which notifications you receive and when
            </p>
          </header>
          <NotificationPreferences />
        </div>
      );
    }
    if (activeTab === 'connectors' && canManageOrg) {
      return <ConnectorsTab />;
    }
    if (activeTab === 'currency' && canManageOrg) {
      return <CurrencyTab />;
    }
    if (activeTab === 'holidays' && canManageHolidays) {
      return <HolidaysTab />;
    }
    if (activeTab === 'features' && canExtraFeatures) {
      return <ExtraFeaturesTab />;
    }
    if (activeTab === 'myview' && isExecutive) {
      return <MyViewTab />;
    }
    // Deliberate fall-through: anything unrecognised lands on Profile, which is
    // the one tab every member can always see.
    return (
      <ProfileTab
        user={user}
        onSaveName={handleSaveName}
        onUploadAvatar={handleUploadAvatar}
        onDeleteAccount={handleDeleteAccount}
      />
    );
  };

  return (
    <PageWrapper>
      <div className="mx-auto" style={{ maxWidth: 900 }}>
        {/* Page header */}
        <header className="mb-6">
          <h1
            className="font-display font-bold text-[color:var(--color-text-primary)] text-[22px] md:text-[28px]"
            style={{ letterSpacing: '-0.01em' }}
          >
            Settings
          </h1>
          <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)]">
            Manage your workspace and profile
          </p>
        </header>

        <div
          className="flex flex-col md:flex-row overflow-hidden bg-surface"
          style={{
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-card)',
            minHeight: 500,
          }}
        >
          <SettingsSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            showAdminTabs={canManageOrg}
            canExtraFeatures={canExtraFeatures}
            canHolidays={canManageHolidays}
            canMyView={isExecutive}
          />
          <SettingsTabBar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            showAdminTabs={canManageOrg}
            canExtraFeatures={canExtraFeatures}
            canHolidays={canManageHolidays}
            canMyView={isExecutive}
          />
          <div className="flex-1 p-5 md:p-8">
            {renderTab()}
          </div>
        </div>
      </div>
    </PageWrapper>
  );
};

export default SettingsPage;

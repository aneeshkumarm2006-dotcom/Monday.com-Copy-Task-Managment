import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, Copy, Check, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import SettingsSidebar, { SettingsTabBar } from '../components/settings/SettingsSidebar';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import useAuthStore from '../store/authStore';
import useOrgStore from '../store/orgStore';
import * as orgService from '../services/orgService';
import * as profileService from '../services/profileService';
/**
 * Settings Page — org and profile.
 * See Macan_Design.md Section 7.8.
 */

const AVATAR_COLORS = [
  '#2563EB', '#16A34A', '#EA580C', '#7C3AED', '#D97706', '#DC2626',
];
const getInitial = (name) => (name ? name.trim().charAt(0).toUpperCase() : '?');
const getAvatarColor = (seed = '') => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

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
  const seed = user?.email || user?.name || '';
  return (
    <div
      className="flex items-center justify-center font-display font-semibold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: getAvatarColor(seed),
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

/* ------------------------- Organisation tab ------------------------- */

const OrganisationTab = ({ org, isMainAdmin, onRegenerate, onDeleteOrg }) => {
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const confirmMatches =
    org?.name && deleteConfirmText.trim() === org.name.trim();

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
      setDeleteError(err.response?.data?.error || 'Failed to delete organisation. Please try again.');
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
        <h2
          className="font-display font-bold text-[color:var(--color-text-primary)]"
          style={{ fontSize: 20 }}
        >
          Organisation
        </h2>
        <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)]">
          {org?.name || 'Workspace settings'}
        </p>
      </header>

      {/* Invite Link section */}
      <section>
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
          Irreversible actions for this organisation.
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

          {isMainAdmin && (
            <div
              className="p-4 flex items-center justify-between gap-4 flex-wrap"
              style={{ borderTop: '1px solid var(--color-status-stuck)' }}
            >
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-body font-semibold text-[13px] text-[color:var(--color-text-primary)]">
                    Delete this organisation
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
                Delete Organisation
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Delete-organisation confirmation modal */}
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
              {deleting ? 'Deleting…' : 'Delete Organisation'}
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
            Deleting this organisation will:
          </p>
          <ul
            className="font-body text-[13px] text-[color:var(--color-text-secondary)] flex flex-col gap-1"
            style={{ paddingLeft: 16, listStyleType: 'disc' }}
          >
            <li>Delete every board, group, task, comment, and update in this workspace</li>
            <li>Delete all automations configured for this workspace</li>
            <li>Delete all notifications scoped to this organisation</li>
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

  useEffect(() => {
    setName(user?.name || '');
  }, [user?.name]);

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

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    setDeleteError('');
    try {
      await onDeleteAccount();
    } catch (err) {
      setDeleteError(err.response?.data?.error || 'Failed to delete account. Please try again.');
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
              className="flex items-center justify-center font-display font-semibold text-white"
              style={{
                width: 80,
                height: 80,
                borderRadius: 9999,
                background: getAvatarColor(user?.email || user?.name || ''),
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
        onClose={() => !deleting && setShowDeleteModal(false)}
        title="Delete Account"
        closeOnOverlayClick={!deleting}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowDeleteModal(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleDeleteConfirm}
              disabled={deleting}
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
          <p className="font-body text-[14px] text-[color:var(--color-text-primary)]">
            Deleting your account will:
          </p>
          <ul className="font-body text-[13px] text-[color:var(--color-text-secondary)] flex flex-col gap-1" style={{ paddingLeft: 16, listStyleType: 'disc' }}>
            <li>Delete all organisations you own (including all their boards, tasks, and members)</li>
            <li>Remove you from all other organisations</li>
            <li>Delete all your personal tasks and comments</li>
            <li>Delete your profile and all account data</li>
          </ul>
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

  // Resolve admin-ness from currentOrg (authoritative for the UI guard)
  const orgAdminId =
    typeof currentOrg?.admin === 'object' && currentOrg?.admin !== null
      ? currentOrg.admin._id || currentOrg.admin
      : currentOrg?.admin;
  const isMainAdmin =
    !!user && !!orgAdminId && String(orgAdminId) === String(user._id);
  const orgAdminsArr = currentOrg?.admins || [];
  const isExtraAdmin =
    !!user &&
    orgAdminsArr.some((a) => {
      const id = typeof a === 'object' && a !== null ? a._id || a : a;
      return String(id) === String(user._id);
    });
  const isAdmin = isMainAdmin || isExtraAdmin;

  const [activeTab, setActiveTab] = useState('organisation');
  const [orgState, setOrgState] = useState(currentOrg || null);

  // Keep local orgState in sync with currentOrg
  useEffect(() => {
    setOrgState(currentOrg || null);
  }, [currentOrg]);

  // If a non-admin has an admin-only tab selected, bounce them to Profile
  useEffect(() => {
    if (!isAdmin && activeTab === 'organisation') {
      setActiveTab('profile');
    }
  }, [isAdmin, activeTab]);

  // Fetch org details (with inviteCode) for Organisation tab
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
    await logout();
    navigate('/login');
  };

  const handleDeleteOrg = async () => {
    if (!currentOrg?._id) return;
    const nextOrg = await deleteOrgFromStore(currentOrg._id);
    await fetchCurrentUser();
    navigate(nextOrg ? '/dashboard' : '/onboarding');
  };

  const renderTab = () => {
    if (activeTab === 'organisation' && isAdmin) {
      return (
        <OrganisationTab
          org={orgState}
          isMainAdmin={isMainAdmin}
          onRegenerate={handleRegenerate}
          onDeleteOrg={handleDeleteOrg}
        />
      );
    }
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
            className="font-display font-bold text-[color:var(--color-text-primary)]"
            style={{ fontSize: 28, letterSpacing: '-0.01em' }}
          >
            Settings
          </h1>
          <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)]">
            Manage your organisation and profile
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
            showAdminTabs={isAdmin}
          />
          <SettingsTabBar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            showAdminTabs={isAdmin}
          />
          <div className="flex-1" style={{ padding: 32 }}>
            {renderTab()}
          </div>
        </div>
      </div>
    </PageWrapper>
  );
};

export default SettingsPage;

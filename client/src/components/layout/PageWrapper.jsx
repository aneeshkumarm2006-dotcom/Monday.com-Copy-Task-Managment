import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Plus,
  Users,
  Check,
  ArrowLeft,
} from 'lucide-react';
import Navbar from './Navbar';
import TabBar from './TabBar';
import useOrgStore from '../../store/orgStore';
import useAuthStore from '../../store/authStore';

const AVATAR_COLORS = ['#2563EB', '#16A34A', '#EA580C', '#7C3AED', '#D97706', '#DC2626'];

const getAvatarColor = (seed = '') => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

/* ----------------------------- Org Sidebar ----------------------------- */

const OrgSidebar = () => {
  const navigate = useNavigate();
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const orgs = useOrgStore((s) => s.orgs);
  const setCurrentOrg = useOrgStore((s) => s.setCurrentOrg);
  const createOrg = useOrgStore((s) => s.createOrg);
  const joinOrg = useOrgStore((s) => s.joinOrg);
  const fetchCurrentUser = useAuthStore((s) => s.fetchCurrentUser);

  const [mode, setMode] = useState(null); // null | 'create' | 'join'
  const [orgName, setOrgName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSwitch = (orgId) => {
    if (orgId === currentOrg?._id) return;
    setCurrentOrg(orgId);
    navigate('/dashboard');
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!orgName.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await createOrg(orgName.trim());
      await fetchCurrentUser();
      setOrgName('');
      setMode(null);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create organisation');
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoin = async (e) => {
    e.preventDefault();
    if (!inviteCode.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await joinOrg(inviteCode.trim());
      await fetchCurrentUser();
      setInviteCode('');
      setMode(null);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid invite code');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="hidden md:flex flex-col shrink-0"
      style={{
        width: 240,
        borderRight: '1px solid var(--color-border)',
        background: 'var(--color-bg-surface)',
        minHeight: '100%',
      }}
    >
      {/* Sidebar header */}
      <div
        className="px-4 py-3 shrink-0"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <span className="font-body font-semibold text-[11px] uppercase tracking-wide text-[color:var(--color-text-muted)]">
          Workspaces
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {!mode && (
          <>
            {/* Org list */}
            <div className="py-2">
              {orgs.map((org) => {
                const isActive = org._id === currentOrg?._id;
                const initial = org.name ? org.name.trim().charAt(0).toUpperCase() : '?';
                return (
                  <button
                    key={org._id}
                    type="button"
                    onClick={() => handleSwitch(org._id)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
                    style={isActive ? { background: 'var(--color-bg-subtle)' } : {}}
                  >
                    <div
                      className="flex items-center justify-center font-display font-bold text-white shrink-0"
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 'var(--radius-sm)',
                        background: isActive ? 'var(--color-accent)' : getAvatarColor(org.name || ''),
                        fontSize: 13,
                      }}
                      aria-hidden="true"
                    >
                      {initial}
                    </div>
                    <span className="flex-1 font-body text-[13px] text-[color:var(--color-text-primary)] truncate font-medium">
                      {org.name}
                    </span>
                    {isActive && (
                      <Check size={15} color="var(--color-accent)" aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Actions */}
            <div
              className="py-2"
              style={{ borderTop: '1px solid var(--color-border)' }}
            >
              <button
                type="button"
                onClick={() => { setMode('create'); setError(''); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
              >
                <div
                  className="flex items-center justify-center shrink-0"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 'var(--radius-sm)',
                    border: '1.5px dashed var(--color-accent)',
                  }}
                >
                  <Plus size={15} color="var(--color-accent)" aria-hidden="true" />
                </div>
                <span className="font-body text-[13px] font-medium text-[color:var(--color-accent)]">
                  Create Workspace
                </span>
              </button>
              <button
                type="button"
                onClick={() => { setMode('join'); setError(''); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
              >
                <div
                  className="flex items-center justify-center shrink-0"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 'var(--radius-sm)',
                    border: '1.5px dashed var(--color-border)',
                  }}
                >
                  <Users size={15} color="var(--color-text-secondary)" aria-hidden="true" />
                </div>
                <span className="font-body text-[13px] font-medium text-[color:var(--color-text-secondary)]">
                  Join Workspace
                </span>
              </button>
            </div>
          </>
        )}

        {/* Create form */}
        {mode === 'create' && (
          <div className="p-4">
            <button
              type="button"
              onClick={() => { setMode(null); setError(''); }}
              className="flex items-center gap-1 font-body text-[12px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] mb-4"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Back
            </button>
            <p className="font-display font-bold text-[14px] text-[color:var(--color-text-primary)] mb-4">
              Create Workspace
            </p>
            <form onSubmit={handleCreate}>
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Workspace name"
                autoFocus
                disabled={submitting}
                className="w-full h-9 px-3 font-body text-[13px] text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-input)] focus:outline-none"
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              />
              {error && (
                <p className="mt-2 font-body text-[11px] text-[color:var(--color-status-stuck)]">{error}</p>
              )}
              <button
                type="submit"
                disabled={submitting || !orgName.trim()}
                className="mt-3 w-full h-9 font-body font-semibold text-[13px] text-white bg-accent hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                style={{ borderRadius: 'var(--radius-md)' }}
              >
                {submitting ? 'Creating…' : 'Create'}
              </button>
            </form>
          </div>
        )}

        {/* Join form */}
        {mode === 'join' && (
          <div className="p-4">
            <button
              type="button"
              onClick={() => { setMode(null); setError(''); }}
              className="flex items-center gap-1 font-body text-[12px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] mb-4"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Back
            </button>
            <p className="font-display font-bold text-[14px] text-[color:var(--color-text-primary)] mb-4">
              Join Workspace
            </p>
            <form onSubmit={handleJoin}>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Paste invite code"
                autoFocus
                disabled={submitting}
                className="w-full h-9 px-3 font-body text-[13px] text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-input)] focus:outline-none"
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              />
              {error && (
                <p className="mt-2 font-body text-[11px] text-[color:var(--color-status-stuck)]">{error}</p>
              )}
              <button
                type="submit"
                disabled={submitting || !inviteCode.trim()}
                className="mt-3 w-full h-9 font-body font-semibold text-[13px] text-[color:var(--color-text-primary)] bg-white hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                style={{
                  border: '1.5px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                {submitting ? 'Joining…' : 'Join'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};

/* ----------------------------- PageWrapper ----------------------------- */

/**
 * PageWrapper — standard shell used by all authenticated in-app pages.
 * Renders the Navbar + a persistent org sidebar on the left + page content.
 *
 * Props:
 *   showNav (bool, default true) — render the Navbar + sidebar
 *   padded  (bool, default true) — apply page padding to the content area
 *   children
 */
const PageWrapper = ({
  showNav = true,
  padded = true,
  children,
  className = '',
  // Chat: on phones its own headers are the top chrome (per the mobile
  // design), so the global bar steps aside below `md`. Desktop unaffected.
  hideNavOnMobile = false,
  // Chat again: an app pane wants every pixel to the sidebar's edge — the
  // 1440px reading-width cap that suits document pages leaves a grey moat
  // around a full-height pane on wide monitors.
  fullWidth = false,
}) => {
  const { pathname } = useLocation();
  const contentHeight = showNav ? 'calc(100vh - 56px)' : '100vh';

  return (
    <div className="min-h-screen bg-base">
      {showNav && (
        <div className={hideNavOnMobile ? 'hidden md:block' : ''}>
          <Navbar />
        </div>
      )}

      <div
        className="flex"
        style={{
          minHeight: contentHeight,
          background: 'var(--color-bg-base)',
        }}
      >
        {showNav && <OrgSidebar />}

        {/* Below `md` the fixed TabBar covers the bottom 56px of the viewport
            (plus the iPhone home-bar inset), so the content column reserves
            that much space — otherwise the last row of every page hides
            behind the bar. Desktop keeps its zero. */}
        <div
          className={[
            'flex-1 min-w-0',
            showNav ? 'pb-[calc(64px_+_env(safe-area-inset-bottom))] md:pb-0' : '',
            className,
          ].join(' ')}
        >
          <div
            key={pathname}
            className={[
              'mx-auto w-full macan-page-enter',
              padded ? 'macan-page-padded px-4 py-6 md:px-10 md:py-8' : '',
            ].join(' ')}
            style={{ maxWidth: fullWidth ? 'none' : 1440 }}
          >
            {children}
          </div>
        </div>
      </div>

      {showNav && <TabBar />}
    </div>
  );
};

export default PageWrapper;

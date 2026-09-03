import { useCallback, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Plus,
  Users,
  Check,
  ArrowLeft,
  ChevronRight,
} from 'lucide-react';
import Navbar from './Navbar';
import TabBar from './TabBar';
import useOrgStore from '../../store/orgStore';
import useAuthStore from '../../store/authStore';

const AVATAR_COLORS = ['#2563EB', '#16A34A', '#EA580C', '#7C3AED', '#D97706', '#DC2626'];

/** Drawer width, and the handle's `left` offset once the drawer is open. */
const SIDEBAR_WIDTH = 240;
/** Navbar height — the drawer hangs below it rather than covering it. */
const NAV_HEIGHT = 56;
/** Remembers a COLLAPSE, so the default (absent value) is open. */
const COLLAPSE_KEY = 'macan:orgSidebarCollapsed';

const getAvatarColor = (seed = '') => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

/* ----------------------------- Org Sidebar ----------------------------- */

/**
 * The workspace list itself. Pure content — the drawer chrome (position,
 * slide, hover/pin state) belongs to OrgSidebarDrawer below, so this stays a
 * plain column that fills whatever box it is handed.
 */
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
    <div className="flex flex-col h-full min-h-0">
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

/* -------------------------- Org Sidebar Drawer -------------------------- */

/**
 * OrgSidebarColumn — the workspaces column, always on screen.
 *
 * It was briefly a hover-out overlay, which kept the content column centred on
 * the window but cost more than it bought: a switcher nobody can see is a
 * switcher nobody uses, and the workspace you are standing in — the thing that
 * scopes every board, task and number on the page — was named nowhere.
 *
 * So it is back in the page flow, `sticky` under the navbar, and the content
 * beside it is centred in the space that is left. That is what every app with
 * a sidebar does, and being able to READ which workspace you are in beats a
 * perfectly centred column.
 *
 * The collapse handle stays for the rare screen that needs the width back. It
 * defaults to OPEN and remembers a collapse across reloads.
 *
 * Desktop only (`md`+): below that the bottom TabBar is the navigation and the
 * More sheet carries the same workspace list.
 */
const OrgSidebarColumn = () => {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* private mode — it still collapses, it just won't be remembered */
      }
      return next;
    });
  }, []);

  return (
    <aside
      aria-label="Workspaces"
      className="hidden md:block shrink-0 relative"
      style={{
        width: collapsed ? 0 : SIDEBAR_WIDTH,
        transition: 'width 180ms ease',
      }}
    >
      <div
        id="org-sidebar"
        // Collapsed it has no width, so its buttons must leave the tab order
        // too — otherwise focus lands inside a panel nobody can see.
        inert={collapsed || undefined}
        className="sticky flex flex-col overflow-hidden"
        style={{
          top: NAV_HEIGHT,
          height: `calc(100vh - ${NAV_HEIGHT}px)`,
          width: SIDEBAR_WIDTH,
          background: 'var(--color-bg-surface)',
          borderRight: collapsed ? 'none' : '1px solid var(--color-border)',
          opacity: collapsed ? 0 : 1,
          pointerEvents: collapsed ? 'none' : 'auto',
          transition: 'opacity 150ms ease',
        }}
      >
        <OrgSidebar />
      </div>

      {/* Collapse handle, riding the column's outer edge. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls="org-sidebar"
        aria-label={collapsed ? 'Show workspaces' : 'Hide workspaces'}
        title={collapsed ? 'Show workspaces' : 'Hide workspaces'}
        className="fixed flex items-center justify-center hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          left: collapsed ? 0 : SIDEBAR_WIDTH,
          top: '50%',
          marginTop: NAV_HEIGHT / 2,
          transform: 'translateY(-50%)',
          width: 18,
          height: 52,
          zIndex: 36,
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderLeft: 'none',
          borderRadius: '0 var(--radius-md) var(--radius-md) 0',
          opacity: collapsed ? 0.7 : 1,
          transition: 'left 180ms ease, opacity 150ms ease',
        }}
      >
        <ChevronRight
          size={14}
          color="var(--color-text-secondary)"
          aria-hidden="true"
          style={{
            transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)',
            transition: 'transform 180ms ease',
          }}
        />
      </button>
    </aside>
  );
};

/* ----------------------------- PageWrapper ----------------------------- */

/**
 * PageWrapper — standard shell used by all authenticated in-app pages.
 * Renders the Navbar + the always-on workspace column + page content.
 *
 * Props:
 *   showNav (bool, default true) — render the Navbar + workspace column
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
        {showNav && <OrgSidebarColumn />}

        {/* Below `md` the fixed TabBar covers the bottom 56px of the viewport
            (plus the iPhone home-bar inset), so the content column reserves
            that much space — otherwise the last row of every page hides
            behind the bar. Desktop keeps its zero.

            The workspace column sits beside this one rather than over it, so
            the content is centred in the space that is left — the ordinary
            arrangement for a sidebar, and the price of being able to see
            which workspace you are in. */}
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

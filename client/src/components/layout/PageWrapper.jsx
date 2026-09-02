import { useCallback, useEffect, useState } from 'react';
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
/** Width of the invisible left-edge strip that opens the drawer on hover. */
const HOVER_ZONE = 12;
const PIN_KEY = 'macan:orgSidebarPinned';

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
 * OrgSidebarDrawer — the workspace bar as an OVERLAY that is closed by default.
 *
 * It used to be a 240px column in the page flow, which meant every page's
 * content was centred inside the *remaining* width and so sat visibly
 * off-centre in the window. It is now `fixed` and slides in over the page, so
 * the content column is centred in the viewport at all times, whether the
 * drawer is showing or not.
 *
 * Two ways in, because hover alone is undiscoverable:
 *   - park the pointer on the left edge (the invisible HOVER_ZONE strip) and it
 *     peeks open, closing again when the pointer leaves;
 *   - click the `>` handle to PIN it open, so it stays put while you switch
 *     workspaces or fill in the create/join form. The pin survives reloads.
 *
 * Desktop only (`md`+): below that the bottom TabBar is the navigation, and an
 * edge-hover gesture means nothing on touch.
 */
const OrgSidebarDrawer = () => {
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem(PIN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [peeking, setPeeking] = useState(false);

  const open = pinned || peeking;

  const writePin = (next) => {
    try {
      localStorage.setItem(PIN_KEY, next ? '1' : '0');
    } catch {
      /* private mode — the drawer still works, it just won't be remembered */
    }
  };

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      writePin(!prev);
      return !prev;
    });
  }, []);

  // Escape unpins. Without it a pinned drawer can only be dismissed by finding
  // the handle again, which is a long mouse trip on a wide monitor.
  useEffect(() => {
    if (!pinned) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setPinned(false);
        writePin(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  return (
    <div
      className="hidden md:block"
      onMouseEnter={() => setPeeking(true)}
      onMouseLeave={() => setPeeking(false)}
    >
      {/* Edge trigger — an invisible strip down the left of the content area.
          Kept separate from the drawer so there is something to hover *before*
          anything is on screen. */}
      <div
        aria-hidden="true"
        className="fixed left-0"
        style={{
          top: NAV_HEIGHT,
          bottom: 0,
          width: HOVER_ZONE,
          zIndex: 34,
        }}
      />

      {/* The drawer. z-35 clears sticky page chrome (z-20 at most) while
          staying under the z-40 Navbar, whose menus open at z-60. */}
      <aside
        id="org-sidebar"
        aria-label="Workspaces"
        // Closed it is merely translated off-screen, so without `inert` its
        // buttons stay in the tab order and a keyboard user lands inside a
        // panel they cannot see. React 19 passes this through natively.
        inert={!open}
        className="fixed left-0 flex flex-col"
        style={{
          top: NAV_HEIGHT,
          bottom: 0,
          width: SIDEBAR_WIDTH,
          zIndex: 35,
          background: 'var(--color-bg-surface)',
          borderRight: '1px solid var(--color-border)',
          transform: open ? 'translateX(0)' : `translateX(-${SIDEBAR_WIDTH}px)`,
          // Off-screen it must not swallow clicks meant for the page beneath.
          pointerEvents: open ? 'auto' : 'none',
          boxShadow: open ? '4px 0 16px rgba(0, 0, 0, 0.08)' : 'none',
          transition: 'transform 200ms ease, box-shadow 200ms ease',
          willChange: 'transform',
        }}
      >
        <OrgSidebar />
      </aside>

      {/* Click handle — rides the drawer's edge so it always reads as the thing
          that opens and closes it. */}
      <button
        type="button"
        onClick={togglePin}
        aria-expanded={open}
        aria-controls="org-sidebar"
        aria-label={pinned ? 'Hide workspaces' : 'Show workspaces'}
        title={pinned ? 'Hide workspaces (Esc)' : 'Show workspaces'}
        className="fixed flex items-center justify-center hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          left: open ? SIDEBAR_WIDTH : 0,
          // Centre it in the area BELOW the navbar, not in the viewport.
          top: '50%',
          marginTop: NAV_HEIGHT / 2,
          transform: 'translateY(-50%)',
          width: 20,
          height: 56,
          zIndex: 36,
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderLeft: 'none',
          borderRadius: '0 var(--radius-md) var(--radius-md) 0',
          boxShadow: '2px 0 8px rgba(0, 0, 0, 0.06)',
          // Dimmed while closed so it stays discoverable without competing
          // with the page it floats over on full-bleed layouts like Chat.
          opacity: open ? 1 : 0.65,
          transition: 'left 200ms ease, opacity 150ms ease, background-color 120ms ease',
        }}
      >
        <ChevronRight
          size={15}
          color="var(--color-text-secondary)"
          aria-hidden="true"
          style={{
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms ease',
          }}
        />
      </button>
    </div>
  );
};

/* ----------------------------- PageWrapper ----------------------------- */

/**
 * PageWrapper — standard shell used by all authenticated in-app pages.
 * Renders the Navbar + the hover/click workspace drawer + page content.
 *
 * The drawer is an overlay (see OrgSidebarDrawer), so the content column here
 * spans the full viewport width and its `mx-auto` cap is centred on the window
 * rather than on whatever was left over beside a sidebar.
 *
 * Props:
 *   showNav (bool, default true) — render the Navbar + workspace drawer
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

      {showNav && <OrgSidebarDrawer />}

      <div
        className="flex"
        style={{
          minHeight: contentHeight,
          background: 'var(--color-bg-base)',
        }}
      >
        {/* Below `md` the fixed TabBar covers the bottom 56px of the viewport
            (plus the iPhone home-bar inset), so the content column reserves
            that much space — otherwise the last row of every page hides
            behind the bar. Desktop keeps its zero.

            No left gutter is reserved for the drawer handle: padded pages
            already carry 40px of side padding, which clears the 20px tab, and
            adding one would push this column off the centre the drawer was
            made an overlay to protect. */}
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

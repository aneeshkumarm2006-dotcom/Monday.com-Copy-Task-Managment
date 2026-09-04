import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Home,
  LayoutGrid,
  CheckSquare,
  Bell,
  MessageCircle,
  MoreHorizontal,
  CalendarDays,
  BarChart3,
  Activity,
  Users,
  Settings,
  Check,
  ChevronRight,
} from 'lucide-react';
import { MonitorDown } from 'lucide-react';
import useOrgStore from '../../store/orgStore';
import useInstallApp from '../../hooks/useInstallApp';
import useNotificationStore from '../../store/notificationStore';
import useChatStore from '../../store/chatStore';
import usePermissions from '../../hooks/usePermissions';

/**
 * TabBar — the mobile app chrome: a bottom bar of five tabs, styled like a
 * native app's, rendered below the `md` breakpoint on every authenticated
 * page (PageWrapper mounts it, so board pages get it too).
 *
 * Four tabs are routes; the fifth ("More") opens a bottom sheet holding the
 * secondary destinations plus the workspace switcher — the two things the
 * retired hamburger drawer used to carry. More stays lit while the user is
 * ON one of its child pages, so the bar never shows "nowhere" as active.
 *
 * The Alerts badge reads the same store as the desktop bell, which the SSE
 * stream and poller keep fresh — no extra fetching here.
 */

const AVATAR_COLORS = ['#2563EB', '#16A34A', '#EA580C', '#7C3AED', '#D97706', '#DC2626'];

const getAvatarColor = (seed = '') => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

// Everything reachable from the More sheet. A tap on any of these routes
// lights the More tab, not nothing.
const MORE_ROUTES = ['/dashboard', '/calendar', '/analytics', '/productivity', '/members', '/settings'];

const TabButton = ({ label, icon: Icon, active, badge = 0, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={badge > 0 ? `${label}, ${badge} unread` : label}
    aria-current={active ? 'page' : undefined}
    className="relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
    style={{
      color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
      transition: 'color 150ms ease',
    }}
  >
    <span className="relative">
      <Icon size={22} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
      {badge > 0 && (
        <span
          aria-hidden="true"
          className="absolute flex items-center justify-center font-body font-bold text-white"
          style={{
            top: -4,
            right: -8,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            fontSize: 10,
            lineHeight: 1,
            borderRadius: 999,
            background: 'var(--color-status-stuck, #DC2626)',
            border: '2px solid var(--color-bg-surface)',
            boxSizing: 'content-box',
          }}
        >
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </span>
    <span
      className="font-body"
      style={{ fontSize: 10, fontWeight: active ? 700 : 500, letterSpacing: '0.01em' }}
    >
      {label}
    </span>
  </button>
);

const SheetRow = ({ icon: Icon, label, onClick, active }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline-none focus-visible:bg-[color:var(--color-bg-subtle)]"
    style={active ? { color: 'var(--color-accent)' } : { color: 'var(--color-text-primary)' }}
  >
    <span
      className="flex items-center justify-center shrink-0"
      style={{
        width: 34,
        height: 34,
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--color-accent-light)' : 'var(--color-bg-subtle)',
        color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
      }}
    >
      <Icon size={17} aria-hidden="true" />
    </span>
    <span className="flex-1 font-body text-[14px] font-medium truncate">{label}</span>
    <ChevronRight size={15} color="var(--color-text-muted)" aria-hidden="true" />
  </button>
);

/**
 * The More bottom sheet. Mounted only while open (or animating shut); the
 * close runs a 200ms slide-down before unmounting so it doesn't blink out.
 */
const MoreSheet = ({ onClose, closing }) => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { can } = usePermissions();
  const { canOffer: canOfferInstall, install } = useInstallApp();
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const orgs = useOrgStore((s) => s.orgs);
  const setCurrentOrg = useOrgStore((s) => s.setCurrentOrg);

  // Lock body scroll while the sheet is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = (to) => {
    onClose();
    navigate(to);
  };

  const rows = [
    // Home lives here since Chat took its slot on the bar — the design's
    // trade: the dashboard is a morning read, chat is an all-day one.
    { to: '/dashboard', label: 'Home', icon: Home },
    { to: '/calendar', label: 'Calendar', icon: CalendarDays },
    ...(can('analytics.view') ? [{ to: '/analytics', label: 'Analytics', icon: BarChart3 }] : []),
    ...(can('productivity.view_others')
      ? [{ to: '/productivity', label: 'Productivity', icon: Activity }]
      : []),
    ...(can('org.view_members') ? [{ to: '/members', label: 'Members', icon: Users }] : []),
    { to: '/settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="More">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 w-full h-full cursor-pointer"
        style={{
          background: 'rgba(17, 24, 39, 0.4)',
          animation: `macan-overlay-fade-in 200ms ease-out both${closing ? ' reverse' : ''}`,
        }}
      />

      {/* Sheet */}
      <div
        className={['absolute left-0 right-0 bottom-0 bg-surface flex flex-col', closing ? 'macan-sheet-down' : 'macan-sheet-up'].join(' ')}
        style={{
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -8px 30px rgba(0,0,0,0.18)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          maxHeight: '80vh',
        }}
      >
        {/* Grabber */}
        <div className="flex justify-center pt-2.5 pb-1 shrink-0" aria-hidden="true">
          <div style={{ width: 36, height: 4, borderRadius: 999, background: 'var(--color-border)' }} />
        </div>

        <div className="overflow-y-auto pb-2">
          {/* Navigation */}
          <div className="px-4 pt-2 pb-1">
            <span className="font-body font-semibold text-[11px] uppercase tracking-wide text-[color:var(--color-text-muted)]">
              Menu
            </span>
          </div>
          {rows.map((row) => (
            <SheetRow
              key={row.to}
              icon={row.icon}
              label={row.label}
              active={pathname.startsWith(row.to)}
              onClick={() => go(row.to)}
            />
          ))}
          {/* Hidden once the app IS the installed app — offering to install
              what you're standing in reads as broken. */}
          {canOfferInstall && (
            <SheetRow
              icon={MonitorDown}
              label="Install app"
              onClick={() => {
                onClose();
                install();
              }}
            />
          )}

          {/* Workspace switcher */}
          <div
            className="px-4 pt-3 pb-1 mt-2"
            style={{ borderTop: '1px solid var(--color-border)' }}
          >
            <span className="font-body font-semibold text-[11px] uppercase tracking-wide text-[color:var(--color-text-muted)]">
              Workspaces
            </span>
          </div>
          {orgs.map((org) => {
            const isActive = org._id === currentOrg?._id;
            const initial = org.name ? org.name.trim().charAt(0).toUpperCase() : '?';
            return (
              <button
                key={org._id}
                type="button"
                onClick={() => {
                  if (!isActive) {
                    setCurrentOrg(org._id);
                    go('/dashboard');
                  } else {
                    onClose();
                  }
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
              >
                <span
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
                </span>
                <span className="flex-1 font-body text-[13px] font-medium text-[color:var(--color-text-primary)] truncate">
                  {org.name}
                </span>
                {isActive && <Check size={15} color="var(--color-accent)" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const TabBar = () => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  // The Chat badge. This used to re-implement the sum inline, and that was a
  // bug waiting on a feature: a client board's rooms live only on that board's
  // Chat tab, so an inline sum counts unread messages this tab cannot reach and
  // the badge never clears. `chatStore.totalUnread()` applies the exclusion, and
  // is now the only place the number is worked out.
  //
  // Calling it inside the selector is safe because it returns a NUMBER — the
  // `Object.is` check zustand runs settles it. The loop this shape can cause
  // needs a selector that builds a fresh object or array each call; that is why
  // the filtered LIST is not what comes back here.
  const chatUnread = useChatStore((s) => s.totalUnread());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetClosing, setSheetClosing] = useState(false);
  const closeTimer = useRef(null);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const closeSheet = () => {
    if (!sheetOpen || sheetClosing) return;
    setSheetClosing(true);
    closeTimer.current = setTimeout(() => {
      setSheetOpen(false);
      setSheetClosing(false);
    }, 200);
  };

  const goTab = (to) => {
    if (sheetOpen) closeSheet();
    if (pathname === to) {
      // Re-tapping the tab you're on scrolls back to the top — the native-app
      // gesture people already have in their thumbs.
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      navigate(to);
    }
  };

  const onMoreRoute = MORE_ROUTES.some((r) => pathname.startsWith(r));

  const tabs = [
    { label: 'Boards', icon: LayoutGrid, to: '/boards' },
    { label: 'My Work', icon: CheckSquare, to: '/my-tasks' },
    { label: 'Chat', icon: MessageCircle, to: '/chat', badge: chatUnread },
    { label: 'Alerts', icon: Bell, to: '/notifications', badge: unreadCount },
  ];

  return (
    <>
      {(sheetOpen || sheetClosing) && <MoreSheet onClose={closeSheet} closing={sheetClosing} />}

      <nav
        aria-label="Primary"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface"
        style={{
          borderTop: '1px solid var(--color-border)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <div className="flex items-stretch" style={{ height: 56 }}>
          {tabs.map((tab) => (
            <TabButton
              key={tab.to}
              label={tab.label}
              icon={tab.icon}
              badge={tab.badge}
              // `/boards` must not light up while `/boards/:id` is open from a
              // dashboard link — but startsWith keeps it lit when the user
              // drilled in FROM the Boards tab, which is what they expect.
              active={!sheetOpen && !onMoreRoute && pathname.startsWith(tab.to)}
              onClick={() => goTab(tab.to)}
            />
          ))}
          <TabButton
            label="More"
            icon={MoreHorizontal}
            active={sheetOpen || onMoreRoute}
            onClick={() => (sheetOpen ? closeSheet() : setSheetOpen(true))}
          />
        </div>
      </nav>
    </>
  );
};

export default TabBar;

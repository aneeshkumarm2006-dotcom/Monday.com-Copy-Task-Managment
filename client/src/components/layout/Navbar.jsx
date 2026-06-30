import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Bell,
  Search,
  ChevronDown,
  User as UserIcon,
  LogOut,
  RefreshCw,
  Menu as MenuIcon,
  X as XIcon,
  ArrowLeft,
  Folder,
  CheckSquare,
} from 'lucide-react';
import useAuthStore from '../../store/authStore';
import useOrgStore from '../../store/orgStore';
import useNotificationStore from '../../store/notificationStore';
import api from '../../services/api';
import Chip from '../ui/Chip';
import Avatar from '../ui/Avatar';
import NotificationFeed from '../notifications/NotificationFeed';
import { resolveNotifLink } from '../notifications/notificationMeta';

/**
 * Top navigation bar. Sticky, 56px tall, white, with:
 *   logo · nav links · search · bell/help/settings icons · avatar dropdown.
 * See Macan_Design.md Section 6.1.
 */

const Logo = () => (
  <div className="flex items-center gap-2.5 shrink-0">
    <div
      className="flex items-center justify-center bg-accent"
      style={{
        width: 32,
        height: 32,
        borderRadius: 'var(--radius-sm)',
      }}
      aria-hidden="true"
    >
      <span className="font-display font-bold text-white text-[16px] leading-none">
        M
      </span>
    </div>
    <span className="font-display font-bold text-[18px] text-[color:var(--color-text-primary)] tracking-tight">
      Macan
    </span>
  </div>
);

const NavLinks = ({ isAdmin, onNavigate }) => {
  const links = [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/boards', label: 'My Boards' },
    { to: '/my-tasks', label: 'My Work' },
    { to: '/members', label: 'Members' },
    ...(isAdmin
      ? [
          { to: '/analytics', label: 'Analytics' },
          { to: '/productivity', label: 'Productivity' },
        ]
      : []),
  ];

  return (
    <div className="flex items-center gap-1">
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            [
              'relative font-body font-medium text-[14px] px-3 py-4 transition-colors duration-150',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]',
              isActive
                ? 'text-[color:var(--color-accent)] font-semibold'
                : 'text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]',
            ].join(' ')
          }
        >
          {({ isActive }) => (
            <>
              {link.label}
              {/* Active underline — 2px, flush with nav bottom border */}
              <span
                aria-hidden="true"
                className="absolute left-3 right-3 bottom-0"
                style={{
                  height: 2,
                  background: 'var(--color-accent)',
                  transition: 'transform 200ms ease-in-out, opacity 200ms ease-in-out',
                  transform: isActive ? 'scaleX(1)' : 'scaleX(0)',
                  transformOrigin: 'left center',
                  opacity: isActive ? 1 : 0,
                }}
              />
            </>
          )}
        </NavLink>
      ))}
    </div>
  );
};


/** Dropdown panel shared by desktop and mobile search. */
const SearchResultsDropdown = ({ results, loading, onBoardClick, onTaskClick }) => {
  const hasBoards = results?.boards?.length > 0;
  const hasTasks = results?.tasks?.length > 0;
  const noResults = results && !hasBoards && !hasTasks;

  return (
    <div
      role="listbox"
      aria-label="Search results"
      className="bg-white overflow-y-auto"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg)',
        maxHeight: 400,
      }}
    >
      {loading ? (
        <div className="px-4 py-6 text-center font-body text-[13px] text-[color:var(--color-text-muted)]">
          Searching…
        </div>
      ) : noResults ? (
        <div className="px-4 py-8 text-center">
          <p className="font-body font-medium text-[13px] text-[color:var(--color-text-primary)]">
            Nothing found
          </p>
          <p className="font-body text-[12px] text-[color:var(--color-text-muted)] mt-1">
            Try a different search term
          </p>
        </div>
      ) : (
        <>
          {hasBoards && (
            <section>
              <div
                className="px-4 py-2"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <span className="font-body text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                  Boards
                </span>
              </div>
              {results.boards.map((board) => (
                <button
                  key={board._id}
                  type="button"
                  onClick={() => onBoardClick(board._id)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus:bg-[color:var(--color-bg-subtle)]"
                >
                  <Folder size={14} color="var(--color-text-muted)" aria-hidden="true" />
                  <span className="flex-1 font-body text-[13px] text-[color:var(--color-text-primary)] truncate">
                    {board.name}
                  </span>
                  <span
                    className="font-body text-[11px] px-2 py-0.5 rounded-full shrink-0"
                    style={{
                      background:
                        board.visibility === 'public'
                          ? 'var(--color-accent-light)'
                          : 'var(--color-bg-subtle)',
                      color:
                        board.visibility === 'public'
                          ? 'var(--color-accent-text)'
                          : 'var(--color-text-muted)',
                    }}
                  >
                    {board.visibility}
                  </span>
                </button>
              ))}
            </section>
          )}
          {hasTasks && (
            <section>
              <div
                className="px-4 py-2"
                style={{
                  borderTop: hasBoards ? '1px solid var(--color-border)' : undefined,
                  borderBottom: '1px solid var(--color-border)',
                }}
              >
                <span className="font-body text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                  Tasks
                </span>
              </div>
              {results.tasks.map((task) => (
                <button
                  key={task._id}
                  type="button"
                  onClick={() => onTaskClick(task)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus:bg-[color:var(--color-bg-subtle)]"
                >
                  <CheckSquare size={14} color="var(--color-text-muted)" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <span className="block font-body text-[13px] text-[color:var(--color-text-primary)] truncate">
                      {task.name}
                    </span>
                    {task.board?.name && (
                      <span className="block font-body text-[11px] text-[color:var(--color-text-muted)] truncate">
                        {task.board.name}
                      </span>
                    )}
                  </div>
                  {task.status && (
                    <Chip
                      type="status"
                      value={task.status}
                      board={task.board}
                      className="shrink-0"
                    />
                  )}
                </button>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
};

/** Desktop search bar — max 380px, centered in the nav. */
const SearchBar = ({ className = '' }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const debounceRef = useRef(null);
  const navigate = useNavigate();
  const currentOrg = useOrgStore((s) => s.currentOrg);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setQuery('');
        setResults(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const runSearch = async (val, orgId) => {
    setLoading(true);
    try {
      const { data } = await api.get('/api/search', { params: { q: val, org: orgId } });
      setResults(data);
      setOpen(true);
    } catch {
      // silent — don't disrupt nav on search errors
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    if (!val.trim()) {
      setResults(null);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      if (currentOrg?._id) runSearch(val.trim(), currentOrg._id);
    }, 300);
  };

  const handleSelect = (path) => {
    navigate(path);
    setOpen(false);
    setQuery('');
    setResults(null);
  };

  return (
    <div
      ref={wrapperRef}
      className={['relative flex items-center', className].filter(Boolean).join(' ')}
      style={{ maxWidth: 380, width: '100%' }}
    >
      <Search
        size={16}
        color="var(--color-text-muted)"
        className="absolute left-3 pointer-events-none"
        aria-hidden="true"
      />
      <input
        type="search"
        value={query}
        onChange={handleChange}
        onFocus={() => { if (results) setOpen(true); }}
        placeholder="Search tasks and boards…"
        className="w-full font-body text-[13px] text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-input)] transition-[border-color,background-color] duration-150 focus:outline-none focus:border-[color:var(--color-accent)] focus:bg-white placeholder:text-[color:var(--color-text-muted)]"
        style={{
          height: 36,
          paddingLeft: 36,
          paddingRight: 14,
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-full)',
        }}
        aria-label="Search tasks and boards"
      />
      {(open || (loading && !results)) && (
        <div className="absolute top-full left-0 right-0 mt-2" style={{ zIndex: 60 }}>
          <SearchResultsDropdown
            results={results}
            loading={loading && !results}
            onBoardClick={(id) => handleSelect(`/boards/${id}`)}
            onTaskClick={(task) => handleSelect(`/boards/${task.board?._id || task.board}`)}
          />
        </div>
      )}
    </div>
  );
};

/**
 * Mobile search — full-width overlay that replaces the navbar content
 * when the search icon is tapped on mobile (<768px).
 */
const MobileSearchOverlay = ({ onClose }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const navigate = useNavigate();
  const currentOrg = useOrgStore((s) => s.currentOrg);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSearch = async (val, orgId) => {
    setLoading(true);
    try {
      const { data } = await api.get('/api/search', { params: { q: val, org: orgId } });
      setResults(data);
      setOpen(true);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    if (!val.trim()) {
      setResults(null);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      if (currentOrg?._id) runSearch(val.trim(), currentOrg._id);
    }, 300);
  };

  const handleSelect = (path) => {
    navigate(path);
    onClose();
  };

  return (
    <div className="h-full flex items-center gap-2">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close search"
        className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] shrink-0"
        style={{ width: 36, height: 36 }}
      >
        <ArrowLeft size={20} color="var(--color-text-secondary)" aria-hidden="true" />
      </button>
      <div className="relative flex-1">
        <Search
          size={16}
          color="var(--color-text-muted)"
          className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={handleChange}
          placeholder="Search tasks and boards…"
          className="w-full font-body text-[13px] text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-input)] transition-[border-color,background-color] duration-150 focus:outline-none focus:border-[color:var(--color-accent)] focus:bg-white placeholder:text-[color:var(--color-text-muted)]"
          style={{
            height: 36,
            paddingLeft: 36,
            paddingRight: 14,
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-full)',
          }}
          aria-label="Search tasks and boards"
        />
        {(open || (loading && !results)) && (
          <div className="absolute top-full left-0 right-0 mt-2" style={{ zIndex: 60 }}>
            <SearchResultsDropdown
              results={results}
              loading={loading && !results}
              onBoardClick={(id) => handleSelect(`/boards/${id}`)}
              onTaskClick={(task) => handleSelect(`/boards/${task.board?._id || task.board}`)}
            />
          </div>
        )}
      </div>
    </div>
  );
};

const IconButton = ({ icon: Icon, label, badge, onClick, active }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    aria-haspopup={onClick ? 'true' : undefined}
    aria-expanded={active || undefined}
    className="relative flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      width: 36,
      height: 36,
      background: active ? 'var(--color-bg-subtle)' : undefined,
    }}
  >
    <Icon
      size={20}
      color="var(--color-text-secondary)"
      aria-hidden="true"
    />
    {badge ? (
      <span
        aria-hidden="true"
        className="absolute macan-badge-pulse flex items-center justify-center font-display"
        style={{
          top: 4,
          right: 4,
          minWidth: 16,
          height: 16,
          padding: '0 4px',
          borderRadius: 9999,
          background: '#DC2626',
          border: '1.5px solid white',
          color: 'white',
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {typeof badge === 'number' ? (badge > 9 ? '9+' : badge) : null}
      </span>
    ) : null}
  </button>
);

const NotificationBell = () => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const navigate = useNavigate();
  const currentOrgId = useOrgStore((s) => s.currentOrg?._id);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const fetchNotifications = useNotificationStore((s) => s.fetchNotifications);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const clearRead = useNotificationStore((s) => s.clearRead);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    // Refresh on open so newly-triggered server-side notifications show up.
    // Passes no filter so the active tab is preserved.
    if (next) fetchNotifications(currentOrgId || undefined);
  };

  const handleActivate = (notif) => {
    if (!notif.isRead) markRead(notif._id);
    const link = resolveNotifLink(notif);
    setOpen(false);
    if (link) navigate(link);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <IconButton
        icon={Bell}
        label={
          unreadCount > 0
            ? `Notifications (${unreadCount} unread)`
            : 'Notifications'
        }
        badge={unreadCount}
        onClick={handleToggle}
        active={open}
      />
      {open && (
        <>
          {/* Backdrop — clicking it closes the drawer */}
          <div
            aria-hidden="true"
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.15)',
              zIndex: 99,
              animation: 'macan-notif-backdrop 200ms ease-out',
            }}
          />

          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            aria-live="polite"
            className="bg-white overflow-hidden flex flex-col"
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              bottom: 0,
              width: 'min(50vw, 720px)',
              minWidth: 380,
              maxWidth: '100vw',
              zIndex: 100,
              borderLeft: '1px solid var(--color-border)',
              boxShadow: 'var(--shadow-lg)',
              animation: 'macan-notif-slide 300ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 shrink-0"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <span
              className="font-display text-[color:var(--color-text-primary)]"
              style={{ fontWeight: 700, fontSize: 18 }}
            >
              Notifications
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => markAllRead(currentOrgId || undefined)}
                disabled={unreadCount === 0}
                className="font-body text-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded"
                style={{
                  color:
                    unreadCount === 0
                      ? 'var(--color-text-muted)'
                      : 'var(--color-accent)',
                  fontWeight: 500,
                  cursor: unreadCount === 0 ? 'default' : 'pointer',
                }}
              >
                Mark all read
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close notifications"
                className="inline-flex items-center justify-center rounded-md transition-colors hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{ width: 28, height: 28 }}
              >
                <XIcon size={18} className="text-[color:var(--color-text-muted)]" />
              </button>
            </div>
          </div>

          {/* Tabs + list */}
          <NotificationFeed
            orgId={currentOrgId || undefined}
            onActivate={handleActivate}
            variant="page"
          />

          {/* Footer */}
          <div
            className="flex items-center justify-between px-4 py-2 shrink-0"
            style={{ borderTop: '1px solid var(--color-border)' }}
          >
            <button
              type="button"
              onClick={() => clearRead(currentOrgId || undefined)}
              className="font-body text-[12px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded"
            >
              Clear read
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate('/notifications');
              }}
              className="font-body text-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded"
              style={{ color: 'var(--color-accent)', fontWeight: 500 }}
            >
              See all
            </button>
          </div>
          </aside>

          <style>{`
            @keyframes macan-notif-slide {
              from { transform: translateX(100%); }
              to   { transform: translateX(0); }
            }
            @keyframes macan-notif-backdrop {
              from { opacity: 0; }
              to   { opacity: 1; }
            }
          `}</style>
        </>
      )}
    </div>
  );
};

const AvatarDropdown = ({ user, onLogout }) => {
  const [open, setOpen] = useState(false);
  const [showOrgPicker, setShowOrgPicker] = useState(false);
  const wrapperRef = useRef(null);
  const navigate = useNavigate();
  const orgs = useOrgStore((s) => s.orgs);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const setCurrentOrg = useOrgStore((s) => s.setCurrentOrg);

  useEffect(() => {
    if (!open) return undefined;
    const handle = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
        setShowOrgPicker(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setShowOrgPicker(false);
      }
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handleProfile = () => {
    setOpen(false);
    navigate('/settings');
  };

  const handleLogout = async () => {
    setOpen(false);
    await onLogout?.();
    navigate('/login', { replace: true });
  };

  const handleSwitchOrg = (orgId) => {
    setCurrentOrg(orgId);
    setShowOrgPicker(false);
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="User menu"
        className="flex items-center gap-1 rounded-full transition-opacity duration-150 hover:opacity-85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
      >
        <Avatar user={user} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 bg-white overflow-hidden"
          style={{
            width: 240,
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            animation: 'macan-dropdown-enter 150ms ease-out',
          }}
        >
          {/* User summary */}
          <div
            className="px-4 py-3 flex items-center gap-3"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <Avatar user={user} size={36} />
            <div className="min-w-0 flex-1">
              <p className="font-body font-semibold text-[13px] text-[color:var(--color-text-primary)] truncate">
                {user?.name || 'User'}
              </p>
              <p className="font-body text-[12px] text-[color:var(--color-text-muted)] truncate">
                {currentOrg?.name || user?.email}
              </p>
            </div>
          </div>

          {!showOrgPicker ? (
            <div className="py-1">
              <MenuItem icon={UserIcon} label="Profile" onClick={handleProfile} />
              {orgs.length > 1 && (
                <MenuItem
                  icon={RefreshCw}
                  label="Switch Org"
                  rightIcon={ChevronDown}
                  onClick={() => setShowOrgPicker(true)}
                />
              )}
              <MenuItem icon={LogOut} label="Logout" onClick={handleLogout} danger />
            </div>
          ) : (
            <div className="py-1 max-h-64 overflow-y-auto">
              <button
                type="button"
                onClick={() => setShowOrgPicker(false)}
                className="w-full px-4 py-2 text-left font-body text-[12px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] transition-colors"
              >
                ← Back
              </button>
              {orgs.map((org) => {
                const isCurrent = org._id === currentOrg?._id;
                return (
                  <button
                    key={org._id}
                    type="button"
                    onClick={() => handleSwitchOrg(org._id)}
                    className="w-full px-4 py-2.5 flex items-center gap-2 text-left font-body text-[13px] transition-colors hover:bg-[color:var(--color-bg-subtle)]"
                    style={{
                      color: isCurrent
                        ? 'var(--color-accent-text)'
                        : 'var(--color-text-primary)',
                      fontWeight: isCurrent ? 600 : 400,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 9999,
                        background: isCurrent
                          ? 'var(--color-accent)'
                          : 'var(--color-border-strong)',
                      }}
                    />
                    <span className="truncate flex-1">{org.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes macan-dropdown-enter {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

const MenuItem = ({ icon: Icon, rightIcon: RightIcon, label, onClick, danger }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className="w-full flex items-center gap-3 px-4 py-2.5 text-left font-body text-[13px] transition-colors hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus:bg-[color:var(--color-bg-subtle)]"
    style={{
      color: danger
        ? 'var(--color-status-stuck)'
        : 'var(--color-text-primary)',
    }}
  >
    {Icon && <Icon size={16} aria-hidden="true" />}
    <span className="flex-1">{label}</span>
    {RightIcon && (
      <RightIcon
        size={14}
        color="var(--color-text-muted)"
        aria-hidden="true"
      />
    )}
  </button>
);

const Navbar = () => {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  // Is current user an admin of the currently-selected org?
  const adminId =
    typeof currentOrg?.admin === 'object' && currentOrg?.admin !== null
      ? currentOrg.admin._id || currentOrg.admin
      : currentOrg?.admin;
  const isMainAdmin =
    !!user && !!adminId && String(adminId) === String(user._id);
  const isExtraAdmin =
    !!user &&
    Array.isArray(currentOrg?.admins) &&
    currentOrg.admins.some((a) => {
      const id = typeof a === 'object' && a !== null ? a._id || a : a;
      return String(id) === String(user._id);
    });
  const isAdmin = isMainAdmin || isExtraAdmin;

  return (
    <nav
      className="sticky top-0 z-40 bg-surface w-full px-4 md:px-8"
      style={{
        height: 56,
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      {/* Mobile search overlay — replaces entire nav bar content */}
      {mobileSearchOpen ? (
        <MobileSearchOverlay onClose={() => setMobileSearchOpen(false)} />
      ) : (
        <div className="h-full flex items-center gap-4">
          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            className="md:hidden flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{ width: 36, height: 36 }}
          >
            {mobileOpen ? (
              <XIcon size={20} color="var(--color-text-secondary)" aria-hidden="true" />
            ) : (
              <MenuIcon size={20} color="var(--color-text-secondary)" aria-hidden="true" />
            )}
          </button>

          {/* Logo + nav links (links hidden on mobile) */}
          <div className="flex items-center gap-4">
            <Logo />
            <div className="hidden md:block h-full">
              <NavLinks isAdmin={isAdmin} />
            </div>
          </div>

          {/* Search — centered, hidden on mobile */}
          <div className="hidden md:flex flex-1 justify-center px-4">
            <SearchBar />
          </div>

          {/* Spacer for mobile */}
          <div className="flex-1 md:hidden" />

          {/* Right cluster */}
          <div className="flex items-center gap-1">
            {/* Mobile search icon — visible only on mobile, hidden on desktop */}
            <button
              type="button"
              onClick={() => setMobileSearchOpen(true)}
              aria-label="Search"
              className="md:hidden flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{ width: 36, height: 36 }}
            >
              <Search size={20} color="var(--color-text-secondary)" aria-hidden="true" />
            </button>
            <NotificationBell />
            <div className="ml-2">
              <AvatarDropdown user={user} onLogout={logout} />
            </div>
          </div>
        </div>
      )}

      {/* Mobile nav drawer (links only — search is accessed via the search icon) */}
      {!mobileSearchOpen && mobileOpen && (
        <div
          className="md:hidden absolute top-full left-0 right-0 bg-surface z-40"
          style={{
            borderBottom: '1px solid var(--color-border)',
            boxShadow: 'var(--shadow-md)',
            padding: '16px',
          }}
        >
          <div className="flex flex-col gap-1">
            <NavLinks
              isAdmin={isAdmin}
              onNavigate={() => setMobileOpen(false)}
            />
          </div>
        </div>
      )}
    </nav>
  );
};

export default Navbar;

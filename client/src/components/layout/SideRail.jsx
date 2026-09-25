import { useCallback, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Home,
  Folder,
  CheckSquare,
  MessageCircle,
  Users,
  BarChart3,
  Activity,
  Settings,
  ChevronDown,
  Plus,
  ArrowLeft,
} from 'lucide-react';
import useOrgStore from '../../store/orgStore';
import useAuthStore from '../../store/authStore';
import useChatStore from '../../store/chatStore';
import useExecutiveViewStore from '../../store/executiveViewStore';
import usePermissions from '../../hooks/usePermissions';
import { applyNavSwitches } from '../../utils/executiveNav';
import OptionMenu from '../ui/OptionMenu';
import EntityLogo from '../ui/EntityLogo';

/**
 * SIDE RAIL — the app's navigation, standing up.
 *
 * It used to be a row of links in the navbar, and that row had outgrown the
 * bar: seven links whose own container carried the comment "scrolls sideways
 * rather than widening the bar when the viewport is too narrow". Worse, three
 * of the seven are capability-gated, so the bar's WIDTH changed with who was
 * looking — an owner saw seven links where a viewer saw four, and no horizontal
 * layout survives that.
 *
 * Three blocks, separated by hairlines, because the links are three different
 * kinds of thing:
 *
 *   1. WHERE YOU ARE   the workspace, alone at the top. Switching it re-scopes
 *                      every page below, so it earns its own block.
 *   2. WHERE YOU GO     Dashboard, My Boards, My Work, Chat — the same four
 *                      destinations the navbar had, same routes, same pages.
 *   3. HOW YOU RUN IT   Members, Analytics, Productivity, Settings — pinned to
 *                      the bottom and smaller, because today Productivity sits
 *                      beside Chat at identical weight and that tells a new
 *                      hire they matter equally. They don't.
 *
 * WHAT IS DELIBERATELY NOT HERE: the boards. `My Boards` is a page, and it
 * opens in the content column exactly as it always has. A rail that also lists
 * boards is two doors to the same room, and it starts scrolling the moment an
 * agency passes a dozen boards.
 *
 * TWO FILTERS, IN THIS ORDER: a row must survive the CAPABILITY it asks for,
 * and then the Executive profile's switch for it (`utils/executiveNav.js`).
 * The order is the whole safety argument — the switches are applied to what the
 * gates left, so a profile can only ever subtract, and the Executive edits
 * their own profile. For everybody else there is no profile, the switch pass
 * hands back the very same array, and this rail is the one that shipped before
 * that feature existed. See `executiveNav.js` for why that is a filter and not
 * a list.
 *
 * Desktop only. Below `md` the bottom `TabBar` is the navigation and this
 * whole column is unmounted by `PageWrapper` — not one line of mobile changes.
 */

/** Open width. 12px wider than the drawer it replaces: "Rakotta Real Estate"
 *  is the longest string the rail must hold and it fits at 13.5px DM Sans. */
export const RAIL_WIDTH = 252;
/** Collapsed width. NOT zero: the rail is the navigation now, so collapsing it
 *  to nothing would leave the app with no way to move. Icons and tooltips. */
export const RAIL_WIDTH_SLIM = 56;

const AVATAR_COLORS = ['#2563EB', '#16A34A', '#EA580C', '#7C3AED', '#D97706', '#DC2626'];

/** Stable colour per workspace name — the same hash the drawer used, so a
 *  workspace does not change colour on the day we shipped this. */
const getAvatarColor = (seed = '') => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const initialOf = (name = '') => {
  const trimmed = String(name).trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
};

/* ------------------------------- one row ------------------------------- */

/**
 * A single navigation row.
 *
 * `size` is 'primary' (34px) or 'secondary' (31px). Two heights, descending by
 * importance — the eye reads size before it reads position, which is how the
 * footer stops competing with Chat without being hidden.
 *
 * Collapsed it becomes a 40x38 icon box with the label as its tooltip and,
 * where a badge would have been, a dot: a number under 12px is not a number.
 */
const RailRow = ({ to, label, icon: Icon, badge = 0, size = 'primary', collapsed }) => {
  const primary = size === 'primary';

  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className="relative flex items-center shrink-0 transition-colors duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
      style={{
        height: collapsed ? 38 : (primary ? 34 : 31),
        width: collapsed ? 40 : '100%',
        padding: collapsed ? 0 : '0 9px',
        gap: collapsed ? 0 : 10,
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderRadius: 8,
        textDecoration: 'none',
      }}
    >
      {({ isActive }) => (
        <>
          {/* The fill and the bar together. Fill alone is soft on a warm ground,
              a 2.5px bar alone is thin — both, and the active row is
              unmistakable at a glance across a wide screen.
              Painted as a sibling rather than a background on the link itself
              so the two can fade independently of the label colour. */}
          <span
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              borderRadius: 8,
              background: isActive ? 'var(--color-accent-light)' : 'transparent',
              transition: 'background 120ms ease',
              pointerEvents: 'none',
            }}
          />
          {!collapsed && (
            <span
              aria-hidden="true"
              className="absolute"
              style={{
                left: 3,
                top: 8,
                bottom: 8,
                width: 2.5,
                borderRadius: 2,
                background: 'var(--color-accent)',
                opacity: isActive ? 1 : 0,
                transition: 'opacity 120ms ease',
                pointerEvents: 'none',
              }}
            />
          )}

          <span className="relative flex items-center justify-center shrink-0" style={{ width: primary ? 16 : 15, height: primary ? 16 : 15 }}>
            <Icon
              size={primary ? 16 : 15}
              strokeWidth={1.7}
              aria-hidden="true"
              // Thin and grey by default. Icons at full weight turn a rail into
              // a toolbar and pull attention off the words, which are what
              // people actually read.
              color={isActive ? 'var(--color-accent)' : 'var(--color-text-muted)'}
              style={{ transition: 'color 120ms ease' }}
            />
            {collapsed && badge > 0 && (
              <span
                aria-hidden="true"
                className="absolute"
                style={{
                  top: -2,
                  right: -3,
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: 'var(--color-status-stuck)',
                  border: '1.5px solid var(--color-bg-surface)',
                }}
              />
            )}
          </span>

          {!collapsed && (
            <>
              <span
                className="relative flex-1 min-w-0 truncate font-body"
                style={{
                  fontSize: primary ? 13.5 : 12.5,
                  fontWeight: isActive ? 700 : 500,
                  color: isActive
                    ? 'var(--color-accent-text)'
                    : (primary ? 'var(--color-text-primary)' : 'var(--color-text-secondary)'),
                  transition: 'color 120ms ease',
                }}
              >
                {label}
              </span>
              {badge > 0 && (
                <span
                  className="relative shrink-0 font-body tabular-nums"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    lineHeight: '16px',
                    minWidth: 18,
                    textAlign: 'center',
                    padding: '0 5px',
                    borderRadius: 9,
                    background: 'var(--color-status-stuck)',
                    color: '#FFFFFF',
                  }}
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </>
          )}
        </>
      )}
    </NavLink>
  );
};

/* -------------------------- workspace switcher -------------------------- */

/**
 * The switcher button and its menu.
 *
 * Picking a workspace does exactly what the drawer's list did — `setCurrentOrg`
 * then `/dashboard` — because this change moves navigation, it does not change
 * what any of it does. Create and Join are the same two flows that lived in the
 * drawer, now the menu's two footer actions.
 */
const WorkspaceSwitcher = ({ collapsed, onExpand }) => {
  const navigate = useNavigate();
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const orgs = useOrgStore((s) => s.orgs);
  const setCurrentOrg = useOrgStore((s) => s.setCurrentOrg);
  const createOrg = useOrgStore((s) => s.createOrg);
  const joinOrg = useOrgStore((s) => s.joinOrg);
  const fetchCurrentUser = useAuthStore((s) => s.fetchCurrentUser);

  const btnRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState(null); // null | 'create' | 'join'
  const [orgName, setOrgName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // globals.css suppresses the focus ring on inputs because they are expected
  // to carry their own focus border — and an INLINE border beats any `focus:`
  // class, so without this the field had no visible focus state whatsoever.
  const [fieldFocused, setFieldFocused] = useState(false);

  const options = useMemo(
    () =>
      orgs.map((org) => ({
        value: org._id,
        label: org.name || 'Untitled workspace',
        tile: { text: initialOf(org.name), color: getAvatarColor(org.name || ''), image: org.logo || '' },
      })),
    [orgs]
  );

  const handleSelect = useCallback(
    (orgId) => {
      if (orgId === currentOrg?._id) return;
      setCurrentOrg(orgId);
      navigate('/dashboard');
    },
    [currentOrg, setCurrentOrg, navigate]
  );

  /**
   * A 240px form cannot be shown inside a 56px rail, so choosing Create or
   * Join while collapsed opens the rail first. The menu itself is portalled
   * and unclipped, which is why the ACTIONS can be offered there at all.
   */
  const openPanel = useCallback(
    (next) => {
      setMenuOpen(false);
      setError('');
      if (collapsed) onExpand?.();
      setMode(next);
    },
    [collapsed, onExpand]
  );

  const closePanel = useCallback(() => {
    setMode(null);
    setError('');
    setOrgName('');
    setInviteCode('');
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!orgName.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await createOrg(orgName.trim());
      await fetchCurrentUser();
      closePanel();
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create organisation');
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoin = async (e) => {
    e.preventDefault();
    if (!inviteCode.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await joinOrg(inviteCode.trim());
      await fetchCurrentUser();
      closePanel();
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid invite code');
    } finally {
      setSubmitting(false);
    }
  };

  const tileColor = getAvatarColor(currentOrg?.name || '');

  /* --- create / join panel. Sits in the rail's flow rather than floating, so
         the column's `overflow-hidden` can never clip it — but only while the
         rail is OPEN. Collapse the rail mid-form and 240px of form inside 56px
         of column would be clipped to a sliver, so the button comes back and
         the half-typed name waits in state until the rail is opened again. --- */
  if (mode && !collapsed) {
    const creating = mode === 'create';
    return (
      <div style={{ padding: '6px 2px 10px' }}>
        <button
          type="button"
          onClick={closePanel}
          className="flex items-center gap-1 font-body text-[12px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] mb-3"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </button>
        <p className="font-display font-bold text-[13.5px] text-[color:var(--color-text-primary)] mb-3">
          {creating ? 'Create workspace' : 'Join workspace'}
        </p>
        <form onSubmit={creating ? handleCreate : handleJoin}>
          <input
            type="text"
            value={creating ? orgName : inviteCode}
            onChange={(e) => (creating ? setOrgName(e.target.value) : setInviteCode(e.target.value))}
            placeholder={creating ? 'Workspace name' : 'Paste invite code'}
            autoFocus
            disabled={submitting}
            maxLength={80}
            onFocus={() => setFieldFocused(true)}
            onBlur={() => setFieldFocused(false)}
            className="w-full h-9 px-3 font-body text-[13px] text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-input)]"
            style={{
              border: `1px solid ${fieldFocused ? 'var(--color-accent)' : 'var(--color-border)'}`,
              boxShadow: fieldFocused ? '0 0 0 3px var(--color-accent-light)' : 'none',
              borderRadius: 'var(--radius-md)',
              transition: 'border-color 120ms ease, box-shadow 120ms ease',
            }}
          />
          {error && (
            <p role="alert" className="mt-2 font-body text-[11px] text-[color:var(--color-status-stuck)]">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting || !(creating ? orgName.trim() : inviteCode.trim())}
            className="mt-3 w-full h-9 font-body font-semibold text-[13px] text-white bg-accent hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            style={{ borderRadius: 'var(--radius-md)' }}
          >
            {submitting ? (creating ? 'Creating…' : 'Joining…') : (creating ? 'Create' : 'Join')}
          </button>
        </form>
      </div>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        title={collapsed ? (currentOrg?.name || 'Workspace') : undefined}
        className="flex items-center shrink-0 transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
        style={{
          width: collapsed ? 40 : '100%',
          height: collapsed ? 40 : 42,
          padding: collapsed ? 0 : '0 8px',
          gap: collapsed ? 0 : 9,
          justifyContent: collapsed ? 'center' : 'flex-start',
          borderRadius: 9,
          background: menuOpen ? 'var(--color-bg-subtle)' : 'transparent',
          border: 'none',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        {/* The one saturated object in the rail. With nothing else competing,
            the eye lands on which workspace you are in before anything else —
            which is the entire reason it sits at the top. */}
        {/* The workspace's own logo when it has one — the fastest possible
            answer to "which client's workspace am I in" — else the lettered
            tile in the name's colour, exactly as before. */}
        <EntityLogo
          src={currentOrg?.logo}
          name={currentOrg?.name}
          size={collapsed ? 30 : 26}
          radius={7}
          color={tileColor}
        />
        {!collapsed && (
          <>
            <span
              className="flex-1 min-w-0 truncate font-body font-bold"
              style={{ fontSize: 13.5, color: 'var(--color-text-primary)', letterSpacing: '-0.005em' }}
            >
              {currentOrg?.name || 'No workspace'}
            </span>
            <ChevronDown
              size={15}
              aria-hidden="true"
              color="var(--color-text-muted)"
              className="shrink-0"
              style={{
                transform: menuOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 150ms ease',
              }}
            />
          </>
        )}
      </button>

      {menuOpen && (
        <OptionMenu
          anchorEl={btnRef.current}
          options={options}
          value={currentOrg?._id || null}
          onSelect={handleSelect}
          onClose={() => setMenuOpen(false)}
          title="Workspaces"
          ariaLabel="Switch workspace"
          width={collapsed ? 236 : RAIL_WIDTH - 16}
          footer={[
            { label: 'New workspace', icon: Plus, onClick: () => openPanel('create') },
            { label: 'Join with a code', icon: Users, onClick: () => openPanel('join') },
          ]}
        />
      )}
    </>
  );
};

/* --------------------------------- rail --------------------------------- */

const SideRail = ({ collapsed = false, onExpand }) => {
  const { can } = usePermissions();

  // Same two numbers the mobile tab bar shows, read the same way: a direct
  // mention outranks a plain unread, and `totalUnread()` excludes channels the
  // Chat page cannot open so the badge always has somewhere to send you.
  const chatUnread = useChatStore((s) => s.totalUnread());
  const mentionCount = useChatStore((s) => s.mentionCount);
  const chatBadge = mentionCount > 0 ? mentionCount : chatUnread;

  /**
   * The Executive profile's rail switches, or null for everyone else.
   *
   * The narrowest subscription that answers the question: this component needs
   * `nav` and nothing else off the profile, and `nav` is a stable sub-object of
   * it, so the rail re-renders when the switches change and not when a board
   * label or a home section does.
   *
   * There is deliberately NO `isExecutive` branch below. `applyNavSwitches`
   * already reads a null `nav` as "not an Executive" and returns the array it
   * was given, unchanged and by identity — so the non-executive path is one
   * function call that provably cannot alter anything, rather than a second
   * rendering path that has to be kept in step with the first.
   */
  const nav = useExecutiveViewStore((s) => s.profile?.nav || null);

  // Every link asks for the capability its own page needs — copied verbatim
  // from the navbar row this replaces, so nobody gains or loses a door.
  //
  // The capability gates stay exactly where they were, INSIDE the literal, and
  // the profile's switches are applied to the result. That ordering is what
  // makes a switch unable to reveal anything: by the time `applyNavSwitches`
  // sees the list, a row the capability forbade is already not in it, and a
  // filter cannot put it back (spec invariant 6).
  const primaryLinks = applyNavSwitches(
    [
      { to: '/dashboard', label: 'Dashboard', icon: Home },
      { to: '/boards', label: 'My Boards', icon: Folder },
      { to: '/my-tasks', label: 'My Work', icon: CheckSquare },
      { to: '/chat', label: 'Chat', icon: MessageCircle, badge: chatBadge },
    ],
    nav
  );

  // Settings is in the always-visible list for the same reason Dashboard is:
  // the switches themselves are edited from Settings, and a rail that could
  // hide the way back to them would be a one-way door.
  const secondaryLinks = applyNavSwitches(
    [
      ...(can('org.view_members') ? [{ to: '/members', label: 'Members', icon: Users }] : []),
      ...(can('analytics.view') ? [{ to: '/analytics', label: 'Analytics', icon: BarChart3 }] : []),
      ...(can('productivity.view_others')
        ? [{ to: '/productivity', label: 'Productivity', icon: Activity }]
        : []),
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
    nav
  );

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ padding: '8px 8px 0', alignItems: collapsed ? 'center' : 'stretch' }}
    >
      <WorkspaceSwitcher collapsed={collapsed} onExpand={onExpand} />

      <div
        aria-hidden="true"
        className="shrink-0"
        style={{
          height: 1,
          // Full-bleed inside the padding box, with 8px of air either side. The
          // air matters more than the line: a rule with rows pressed against it
          // reads as a table.
          width: collapsed ? 30 : '100%',
          background: 'var(--color-border)',
          margin: '8px 0',
        }}
      />

      {/* Scrolls only if a very short window makes it, and never takes the
          footer with it — that is what `min-h-0` on a flex child buys. */}
      <nav
        aria-label="Main"
        className="flex flex-col flex-1 min-h-0 overflow-y-auto"
        style={{ gap: 1, width: collapsed ? 'auto' : '100%', alignItems: collapsed ? 'center' : 'stretch' }}
      >
        {primaryLinks.map((link) => (
          <RailRow key={link.to} {...link} collapsed={collapsed} />
        ))}
      </nav>

      <div
        className="shrink-0 flex flex-col"
        style={{
          gap: 1,
          width: collapsed ? 'auto' : '100%',
          alignItems: collapsed ? 'center' : 'stretch',
          borderTop: '1px solid var(--color-border)',
          paddingTop: 6,
          paddingBottom: 8,
          marginTop: 6,
        }}
      >
        {secondaryLinks.map((link) => (
          <RailRow key={link.to} {...link} size="secondary" collapsed={collapsed} />
        ))}
      </div>
    </div>
  );
};

export default SideRail;

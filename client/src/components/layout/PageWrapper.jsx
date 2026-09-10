import { useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import Navbar from './Navbar';
import TabBar from './TabBar';
import SideRail, { RAIL_WIDTH, RAIL_WIDTH_SLIM } from './SideRail';

/** Navbar height — the rail hangs below it rather than covering it. */
const NAV_HEIGHT = 56;
/** Remembers a COLLAPSE, so the default (absent value) is open. */
const COLLAPSE_KEY = 'macan:orgSidebarCollapsed';

/* ------------------------------ Rail Column ------------------------------ */

/**
 * RailColumn — the navigation column, always on screen.
 *
 * `sticky` under the navbar, in the page flow, with the content beside it
 * centred in the space that is left. That is what every app with a sidebar
 * does, and being able to READ which workspace you are in beats a perfectly
 * centred column.
 *
 * COLLAPSED IS 56px, NOT ZERO. It used to be zero, and that was correct while
 * this column held only a workspace list — the navigation was up in the bar.
 * Now the column IS the navigation, and collapsing it to nothing would leave
 * the app with no way to move. So it narrows to icons and tooltips, keeps its
 * buttons in the tab order, and never disappears.
 *
 * Desktop only (`md`+): below that the bottom TabBar is the navigation and the
 * More sheet carries the same workspace list.
 */
const RailColumn = () => {
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

  // Choosing "New workspace" from the switcher while collapsed needs the rail
  // open — a 240px form does not fit in 56px. The rail asks; the column, which
  // owns the state, obliges.
  const expand = useCallback(() => {
    setCollapsed(false);
    try {
      localStorage.setItem(COLLAPSE_KEY, '0');
    } catch {
      /* private mode — it still opens, it just won't be remembered */
    }
  }, []);

  const width = collapsed ? RAIL_WIDTH_SLIM : RAIL_WIDTH;

  return (
    <aside
      aria-label="Primary"
      className="hidden md:block shrink-0 relative"
      style={{
        width,
        transition: 'width 180ms ease',
      }}
    >
      <div
        id="side-rail"
        className="sticky flex flex-col overflow-hidden"
        style={{
          top: NAV_HEIGHT,
          height: `calc(100vh - ${NAV_HEIGHT}px)`,
          width,
          background: 'var(--color-bg-surface)',
          borderRight: '1px solid var(--color-border)',
          // Width is what moves; the contents stay opaque and focusable the
          // whole way, because they are still the only navigation on screen.
          transition: 'width 180ms ease',
        }}
      >
        <SideRail collapsed={collapsed} onExpand={expand} />
      </div>

      {/* Collapse handle, riding the column's outer edge. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls="side-rail"
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        className="fixed flex items-center justify-center hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          left: width,
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
          transition: 'left 180ms ease',
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
      {/* No wrapper element here: the bar is sticky, and a wrapper exactly its
          own height would cap how far it can travel — it would unstick the
          moment you scrolled. The responsive class goes on the <nav>. */}
      {showNav && <Navbar className={hideNavOnMobile ? 'hidden md:block' : ''} />}

      <div
        className="flex"
        style={{
          minHeight: contentHeight,
          background: 'var(--color-bg-base)',
        }}
      >
        {showNav && <RailColumn />}

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

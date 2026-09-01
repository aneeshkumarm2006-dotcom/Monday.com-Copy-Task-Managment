import { useMemo } from 'react';
import {
  Bell,
  CircleDot,
  FileBarChart,
  FileText,
  Gauge,
  Globe,
  Hourglass,
  KeyRound,
  Link2,
  MapPin,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Split,
  Stethoscope,
  Swords,
  TrendingUp,
  Wallet,
} from 'lucide-react';

import Button from '../../../ui/Button';
import Dropdown from '../../../ui/Dropdown';
import DateRangePicker from '../../../ui/DateRangePicker';
import { marketLabel, staleness } from '../../../../utils/connectorFormat';

/**
 * The chrome a connector dashboard sits in — a project bar, a grouped rail, a
 * heading. Shared by BOTH connector tabs, which is why it lives here and not in
 * either provider's directory and why nothing in it names one.
 *
 * ---- Why it is shared ------------------------------------------------------
 *
 * The two tabs arrive at their screen list differently — one is handed
 * `provider.screens` by the server, the other derives it from the kind catalog
 * (`utils/connectorScreens.js`) — but from here down they are the same page, and
 * they have to stay the same page. A user reading two clients' data in one
 * afternoon should not have to learn where the Refresh button is twice, and a
 * fix to the staleness stamp should not have to be made twice to be true.
 *
 * Everything below is driven by props: a list of screens, a list of headings, a
 * project and the pickers that narrow it. It does not know which provider
 * produced any of it.
 *
 * ---- What this replaced, and why -------------------------------------------
 *
 * Fourteen screens in one `SegmentedControl`, over three labelled dropdowns that
 * were shown whether or not there was anything to choose. Two rows of buttons
 * that wrapped differently at every width, no hierarchy between "Rank tracking"
 * and "Usage & spend", and no answer on screen to the first question a person
 * opening the tab has: WHICH SITE AM I LOOKING AT.
 *
 * So the layout is the one every SEO tool converged on, for the same reason:
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │  (o) example.com          [market] [history]   ⟳      │  ← project bar
 *   │      Last collected 2 hours ago · 2 in flight         │
 *   ├───────────────┬───────────────────────────────────────┤
 *   │  Overview     │  Rank tracking                        │
 *   │  RANKINGS     │  Every tracked keyword, sortable…     │  ← heading + blurb
 *   │   Rank track… │  ┌─────────────────────────────────┐  │
 *   │   AI visibil… │  │  the screen                     │  │
 *   │  RESEARCH     │  └─────────────────────────────────┘  │
 *   └───────────────┴───────────────────────────────────────┘
 *
 * ---- The rail is DATA, including its headings ------------------------------
 *
 * `screens` and `screenGroups` both come from the provider descriptor, so a
 * screen declared in a later phase appears in the rail, under the right heading,
 * with nothing here to edit. Two fallbacks keep that honest rather than tidy: a
 * screen with no `group` is a top-level entry above the first heading, and one
 * naming a heading the provider does not declare is filed under "More" instead
 * of vanishing. The icon is the one thing that cannot travel as data — a
 * component is not JSON — so an unmapped key gets a neutral dot and its label,
 * never a blank row.
 *
 * ---- A control only appears when there is a choice --------------------------
 *
 * The site picker is a heading when the board maps one site, and the market
 * picker is a line of text when the project has produced one market. Those two
 * rules are most of what makes this read as simpler than what it replaced: on
 * the ordinary board — one client, one market — the bar is a domain, a date
 * range and a Refresh button.
 */

/**
 * Screen key → nav icon. Deliberately a client-side map: the descriptor can
 * describe a screen but cannot ship a React component, which is the same reason
 * `SCREENS` in the tab is one. An unmapped key renders a dot and its label.
 */
const ICONS = {
  overview: Gauge,
  rank_tracking: TrendingUp,
  /**
   * The second provider's KIND keys, which are its screen keys too — see
   * `utils/connectorScreens.js`. Kept in the same map rather than in a second
   * one per provider: a key means the same thing on both sides (`site_audit` is
   * a crawl either way, `backlinks` a link profile) and two maps would be two
   * places for the same screen to end up with two different icons.
   */
  positions: TrendingUp,
  keyword_metrics: KeyRound,
  domain_overview: Globe,
  ai_visibility: Sparkles,
  cannibalization: Split,
  keyword_research: Search,
  competitors: Swords,
  top_pages: FileText,
  backlinks: Link2,
  toxic_backlinks: ShieldAlert,
  site_audit: Stethoscope,
  local: MapPin,
  client_report: FileBarChart,
  alerts: Bell,
  usage: Wallet,
};

/**
 * Screens, arranged for the rail.
 *
 * @param {{key: string, label: string, group?: string|null}[]} screens
 * @param {{key: string, label: string}[]} groups
 * @returns {{top: object[], sections: {key: string, label: string, items: object[]}[]}}
 */
const arrangeScreens = (screens = [], groups = []) => {
  const top = screens.filter((s) => !s.group);
  const known = new Set(groups.map((g) => g.key));

  const sections = groups
    .map((g) => ({
      key: g.key,
      label: g.label,
      items: screens.filter((s) => s.group === g.key),
    }))
    // A heading whose every screen this board switched off is not drawn.
    .filter((sec) => sec.items.length > 0);

  // Named rather than dropped — the same treatment an unknown screen key gets.
  const orphans = screens.filter((s) => s.group && !known.has(s.group));
  if (orphans.length) sections.push({ key: '__more', label: 'More', items: orphans });

  return { top, sections };
};

const NavItem = ({ screen, active, onChange }) => {
  const Icon = ICONS[screen.key] || CircleDot;
  const isActive = screen.key === active;
  return (
    <button
      type="button"
      onClick={() => onChange(screen.key)}
      aria-current={isActive ? 'page' : undefined}
      title={screen.blurb || screen.label}
      className="flex items-center gap-2.5 px-2.5 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
      style={{
        height: 34,
        width: '100%',
        borderRadius: 'var(--radius-md)',
        background: isActive ? 'var(--color-accent-light)' : 'transparent',
        color: isActive ? 'var(--color-accent-text)' : 'var(--color-text-secondary)',
        fontWeight: isActive ? 600 : 500,
        fontSize: 13,
        border: 'none',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'var(--color-bg-subtle)';
          e.currentTarget.style.color = 'var(--color-text-primary)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--color-text-secondary)';
        }
      }}
    >
      <Icon size={15} className="shrink-0" aria-hidden="true" />
      <span className="font-body truncate">{screen.label}</span>
    </button>
  );
};

const GroupLabel = ({ children }) => (
  <p
    className="font-body px-2.5 pt-4 pb-1"
    style={{
      fontSize: 10.5,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      color: 'var(--color-text-muted)',
    }}
  >
    {children}
  </p>
);

/** The left rail. Hidden below `lg`, where `ProviderNavBar` takes over. */
export const ProviderNav = ({ screens, groups, active, onChange }) => {
  const { top, sections } = useMemo(
    () => arrangeScreens(screens, groups),
    [screens, groups]
  );

  return (
    <aside
      className="hidden lg:block shrink-0"
      style={{
        width: 208,
        borderRight: '1px solid var(--color-border)',
        background: 'var(--color-bg-surface)',
      }}
    >
      <nav className="flex flex-col gap-0.5 px-2 py-3" aria-label="Screens">
        {top.map((s) => (
          <NavItem key={s.key} screen={s} active={active} onChange={onChange} />
        ))}
        {sections.map((sec) => (
          <div key={sec.key} className="flex flex-col gap-0.5">
            <GroupLabel>{sec.label}</GroupLabel>
            {sec.items.map((s) => (
              <NavItem key={s.key} screen={s} active={active} onChange={onChange} />
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
};

/**
 * The same nav below `lg`, as one scrolling row.
 *
 * Group headings are dropped rather than stacked: on a phone the nav's job is
 * reachability, and the chips already arrive grouped because the catalog is
 * ordered. Mirrors `SettingsTabBar`, which solved this exact problem for the
 * settings rail.
 */
export const ProviderNavBar = ({ screens, active, onChange }) => (
  <div
    className="lg:hidden flex items-center gap-1 overflow-x-auto"
    style={{ padding: 8, borderBottom: '1px solid var(--color-border)' }}
  >
    {screens.map((s) => {
      const Icon = ICONS[s.key] || CircleDot;
      const isActive = s.key === active;
      return (
        <button
          key={s.key}
          type="button"
          onClick={() => onChange(s.key)}
          aria-current={isActive ? 'page' : undefined}
          className="shrink-0 inline-flex items-center gap-1.5 transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            height: 34,
            padding: '0 12px',
            borderRadius: 'var(--radius-md)',
            background: isActive ? 'var(--color-accent-light)' : 'transparent',
            color: isActive ? 'var(--color-accent-text)' : 'var(--color-text-secondary)',
            fontWeight: isActive ? 600 : 500,
            fontSize: 13,
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <Icon size={14} aria-hidden="true" />
          <span className="font-body whitespace-nowrap">{s.label}</span>
        </button>
      );
    })}
  </div>
);

/**
 * The project bar — which site, which market, how far back, and how old.
 *
 * The staleness stamp is not decoration. Nothing on this tab is live; every
 * number came out of our own database at some earlier moment, and "collected 3
 * months ago" is the only outward sign that a connector quietly stopped
 * working. `SectionShell` makes that argument per card; this is the one place
 * it is made about the whole page.
 */
export const ProviderProjectBar = ({
  project,
  projectOptions,
  projectId,
  onProjectChange,
  variantOptions,
  variant,
  onVariantChange,
  range,
  onRangeChange,
  queued = 0,
  canManage,
  refreshing,
  /**
   * A reason Refresh cannot do anything, distinct from `refreshing`.
   *
   * A project that has been deleted at the provider can never be collected
   * again, and the button is disabled rather than hidden: a control that
   * vanishes reads as a permission problem, and this is not one.
   */
  refreshDisabled = false,
  onRefresh,
}) => {
  const title = project?.domain || project?.name || project?.externalId || 'This site';
  const manyProjects = projectOptions.length > 1;
  const manyVariants = variantOptions.length > 1;

  return (
    <header
      className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3"
      style={{ borderBottom: '1px solid var(--color-border)' }}
    >
      <div
        className="grid place-items-center shrink-0"
        style={{
          width: 36,
          height: 36,
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-accent-light)',
          color: 'var(--color-accent-text)',
        }}
      >
        <Globe size={18} aria-hidden="true" />
      </div>

      <div className="min-w-0" style={{ flex: '1 1 220px' }}>
        {manyProjects ? (
          // A switcher only when there is something to switch to. Its trigger
          // carries the name, so the heading is not printed twice.
          <div style={{ maxWidth: 300 }}>
            <Dropdown
              ariaLabel="Site"
              options={projectOptions}
              value={projectId}
              onChange={onProjectChange}
            />
          </div>
        ) : (
          <h2
            className="font-display font-semibold truncate"
            style={{ fontSize: 17, color: 'var(--color-text-primary)' }}
            title={title}
          >
            {title}
          </h2>
        )}

        <p
          className="font-body mt-1 flex flex-wrap items-center gap-x-2 gap-y-1"
          style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
        >
          <span>
            {project?.lastFetchedAt
              ? `Last collected ${staleness(project.lastFetchedAt)}`
              : 'Never collected'}
          </span>
          {/* The market, when there is only one and therefore no picker for it.
              A rank is a rank IN A MARKET, and a page that never says which one
              is a page whose numbers cannot be checked. */}
          {!manyVariants && variant && (
            <>
              <span aria-hidden="true">·</span>
              <span>{marketLabel(variant)}</span>
            </>
          )}
          {queued > 0 && (
            <span
              className="inline-flex items-center gap-1"
              style={{
                padding: '1px 7px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--color-status-working-bg)',
                color: 'var(--color-status-working)',
                fontWeight: 500,
              }}
            >
              <Hourglass size={11} aria-hidden="true" />
              {queued} in flight
            </span>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {manyVariants && (
          <div style={{ width: 190 }}>
            <Dropdown
              ariaLabel="Market"
              size="sm"
              options={variantOptions}
              value={variant}
              onChange={onVariantChange}
            />
          </div>
        )}

        <DateRangePicker
          label="History"
          preset={range.preset}
          value={range}
          onChange={onRangeChange}
        />

        {canManage && (
          <Button
            variant="secondary"
            icon={RefreshCw}
            onClick={onRefresh}
            disabled={refreshing || refreshDisabled}
          >
            {refreshing ? 'Working…' : 'Refresh'}
          </Button>
        )}
      </div>
    </header>
  );
};

/**
 * The screen's own name and one line about it.
 *
 * The blurb has been in the descriptor since the catalog was written and was
 * never rendered anywhere. It belongs here: half of these screens read a
 * database that is rebuilt weekly rather than a live SERP, and the sentence
 * saying so is the difference between a number somebody trusts correctly and
 * one they trust blindly.
 */
export const ScreenHeading = ({ screen }) => {
  if (!screen) return null;
  return (
    <div className="mb-4">
      <h3
        className="font-display font-semibold"
        style={{ fontSize: 16, color: 'var(--color-text-primary)' }}
      >
        {screen.label}
      </h3>
      {screen.blurb && (
        <p
          className="font-body mt-0.5"
          style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', maxWidth: 760 }}
        >
          {screen.blurb}
        </p>
      )}
    </div>
  );
};

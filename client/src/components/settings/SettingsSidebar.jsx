import {
  Building2,
  UserCircle2,
  Bell,
  FlaskConical,
  Plug,
  CalendarDays,
  LayoutDashboard,
} from 'lucide-react';

/**
 * SettingsSidebar — left-rail tab nav used exclusively by the Settings page.
 * See Macan_Design.md Section 6.14 and 7.8.
 *
 * Props:
 *   activeTab: 'organisation' | 'profile' | 'notifications' | 'features'
 *   onTabChange: (tab) => void
 *   showAdminTabs: boolean — hide Workspace tab for non-admins
 *   canExtraFeatures: boolean — hide Extra features unless the caller holds a
 *     capability for at least one opt-in tool. Kept as its own flag rather than
 *     folded into `showAdminTabs`, because the two answer different questions:
 *     one is "may you run the workspace", the other is "is there anything in
 *     here for you".
 *   canHolidays: boolean — `org.manage_holidays`. Its own flag for the same
 *     reason: the holiday calendar has its own row in the permissions matrix,
 *     so a role can hold it WITHOUT holding org.manage_settings, and folding it
 *     into `showAdminTabs` would hide the tab from exactly those people.
 *   canMyView: boolean — does this person have an executive view. A FOURTH flag,
 *     and emphatically not a role check done in here: "is an Executive" is
 *     `profile !== null` on `executiveViewStore`, which is a fetch with a
 *     loading state and an org it was resolved for. A sidebar that reached for
 *     that itself would render the tab, then unrender it, on every sign-in —
 *     and would answer the question a second time, in a component whose job is
 *     drawing buttons. The page owns the answer; this owns the row.
 */
const TABS = [
  { key: 'organisation', label: 'Workspace', icon: Building2, adminOnly: true },
  { key: 'profile', label: 'Profile', icon: UserCircle2, adminOnly: false },
  { key: 'notifications', label: 'Notifications', icon: Bell, adminOnly: false },
  // The executive's own view — their rail switches, board order and labels.
  // Gated on having a profile at all rather than on a capability: the tab edits
  // one document, and somebody with no document has nothing to edit.
  { key: 'myview', label: 'My view', icon: LayoutDashboard, executiveTab: true },
  // Connecting an external account is credential handling for the whole
  // workspace, so it sits with Workspace on `adminOnly` rather than being a
  // personal setting. Switching a connector on for one board is a separate,
  // board-level act and lives on that board's Add-ons tab.
  { key: 'connectors', label: 'Connectors', icon: Plug, adminOnly: true },
  // The workspace holiday calendar. Gated on its own capability rather than on
  // "is an admin": one person marking a day off changes what every board counts
  // as owed, but that is a job an ops lead can hold without also being able to
  // rename the org. Everyone still SEES holidays everywhere; only editing is gated.
  { key: 'holidays', label: 'Holidays', icon: CalendarDays, holidayTab: true },
  { key: 'features', label: 'Extra features', icon: FlaskConical, featureTab: true },
];

const visibleTabs = (showAdminTabs, canExtraFeatures, canHolidays, canMyView) =>
  TABS.filter(
    (t) =>
      (showAdminTabs || !t.adminOnly) &&
      (!t.featureTab || canExtraFeatures) &&
      (!t.holidayTab || canHolidays) &&
      (!t.executiveTab || canMyView)
  );

const SettingsSidebar = ({
  activeTab,
  onTabChange,
  showAdminTabs = true,
  canExtraFeatures = false,
  canHolidays = false,
  // Defaults to false, like the other three: a caller that has not been taught
  // about this flag shows the tab to nobody, which is the state Settings was in
  // before the tab existed.
  canMyView = false,
}) => {
  const tabs = visibleTabs(showAdminTabs, canExtraFeatures, canHolidays, canMyView);

  return (
    <aside
      className="shrink-0 bg-surface hidden md:block"
      style={{
        width: 220,
        borderRight: '1px solid var(--color-border)',
        padding: '24px 12px',
        borderTopLeftRadius: 'var(--radius-lg)',
        borderBottomLeftRadius: 'var(--radius-lg)',
      }}
    >
      <nav className="flex flex-col gap-1" aria-label="Settings sections">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onTabChange(tab.key)}
              aria-current={isActive ? 'page' : undefined}
              className="flex items-center gap-3 px-3 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                height: 40,
                borderRadius: 'var(--radius-md)',
                background: isActive ? 'var(--color-accent-light)' : 'transparent',
                color: isActive
                  ? 'var(--color-accent-text)'
                  : 'var(--color-text-secondary)',
                fontWeight: isActive ? 600 : 500,
                fontSize: 14,
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
              <Icon size={16} aria-hidden="true" />
              <span className="font-body">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
};

/**
 * Horizontal tab bar version for mobile (<768px).
 * Stacked above content instead of left rail.
 */
export const SettingsTabBar = ({
  activeTab,
  onTabChange,
  showAdminTabs = true,
  canExtraFeatures = false,
  canHolidays = false,
  canMyView = false,
}) => {
  const tabs = visibleTabs(showAdminTabs, canExtraFeatures, canHolidays, canMyView);
  return (
    <div
      className="md:hidden flex items-center gap-1 overflow-x-auto"
      style={{
        padding: '8px 8px',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-bg-surface)',
        borderTopLeftRadius: 'var(--radius-lg)',
        borderTopRightRadius: 'var(--radius-lg)',
      }}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onTabChange(tab.key)}
            aria-current={isActive ? 'page' : undefined}
            className="shrink-0 transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              height: 36,
              padding: '0 14px',
              borderRadius: 'var(--radius-md)',
              background: isActive ? 'var(--color-accent-light)' : 'transparent',
              color: isActive
                ? 'var(--color-accent-text)'
                : 'var(--color-text-secondary)',
              fontWeight: isActive ? 600 : 500,
              fontSize: 13,
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};

export default SettingsSidebar;

import { Building2, UserCircle2 } from 'lucide-react';

/**
 * SettingsSidebar — left-rail tab nav used exclusively by the Settings page.
 * See Macan_Design.md Section 6.14 and 7.8.
 *
 * Props:
 *   activeTab: 'organisation' | 'members' | 'profile'
 *   onTabChange: (tab) => void
 *   showAdminTabs: boolean — hide Organisation tab for non-admins
 */
const TABS = [
  { key: 'organisation', label: 'Organisation', icon: Building2, adminOnly: true },
  { key: 'profile', label: 'Profile', icon: UserCircle2, adminOnly: false },
];

const SettingsSidebar = ({ activeTab, onTabChange, showAdminTabs = true }) => {
  const tabs = TABS.filter((t) => showAdminTabs || !t.adminOnly);

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
export const SettingsTabBar = ({ activeTab, onTabChange, showAdminTabs = true }) => {
  const tabs = TABS.filter((t) => showAdminTabs || !t.adminOnly);
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

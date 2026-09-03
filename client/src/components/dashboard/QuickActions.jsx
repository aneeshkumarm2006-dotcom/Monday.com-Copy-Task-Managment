import { useNavigate } from 'react-router-dom';
import { Plus, UserPlus, Calendar, BarChart2, Zap } from 'lucide-react';
import usePermissions from '../../hooks/usePermissions';

/**
 * QuickActions — colored shortcut buttons stacked in the dashboard sidebar.
 * See Macan_Design.md Sections 6.10 and 7.3.
 *
 * Props:
 *   onCreateBoard — optional handler; falls back to navigating to /boards
 */

const ACTIONS = [
  {
    id: 'create-board',
    icon: Plus,
    title: 'Create Board',
    subtitle: 'Start a new project',
    color: 'var(--color-accent)',
    to: '/boards',
  },
  {
    id: 'invite-team',
    icon: UserPlus,
    title: 'Invite Team',
    subtitle: 'Share your invite link',
    color: '#16A34A',
    to: '/settings',
  },
  {
    id: 'calendar',
    icon: Calendar,
    title: 'Calendar',
    subtitle: 'See upcoming tasks',
    color: '#EA580C',
    to: '/calendar',
  },
  {
    id: 'analytics',
    icon: BarChart2,
    title: 'Analytics',
    subtitle: 'View workspace insights',
    color: '#7C3AED',
    to: '/analytics',
    // Analytics is capability-gated. Offering it to someone the router will
    // bounce is a dead end dressed as a shortcut.
    capability: 'analytics.view',
  },
];

const ActionButton = ({ icon: Icon, title, subtitle, color, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full flex items-center gap-3 text-left transition-transform duration-150 ease-in-out hover:-translate-y-px hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      height: 64,
      padding: '0 16px',
      borderRadius: 'var(--radius-lg)',
      background: color,
      color: '#FFFFFF',
    }}
  >
    <Icon size={24} color="#FFFFFF" aria-hidden="true" strokeWidth={2.2} />
    <div className="min-w-0 flex-1">
      <p
        className="font-body font-semibold leading-tight"
        style={{ fontSize: 14, color: '#FFFFFF' }}
      >
        {title}
      </p>
      <p
        className="font-body leading-tight mt-0.5"
        style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}
      >
        {subtitle}
      </p>
    </div>
  </button>
);

const QuickActions = ({ onCreateBoard }) => {
  const { can } = usePermissions();
  const navigate = useNavigate();

  const handleAction = (action) => {
    if (action.id === 'create-board' && typeof onCreateBoard === 'function') {
      onCreateBoard();
      return;
    }
    if (action.to) navigate(action.to);
  };

  return (
    <section
      className="bg-surface h-full"
      style={{
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        padding: 20,
      }}
    >
      <div className="flex items-center gap-2">
        <Zap size={18} color="#16A34A" aria-hidden="true" />
        <h2
          className="font-display font-bold"
          style={{
            fontSize: 15,
            color: 'var(--color-text-primary)',
          }}
        >
          Quick Actions
        </h2>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {ACTIONS.filter((a) => !a.capability || can(a.capability)).map((action) => (
          <ActionButton
            key={action.id}
            icon={action.icon}
            title={action.title}
            subtitle={action.subtitle}
            color={action.color}
            onClick={() => handleAction(action)}
          />
        ))}
      </div>
    </section>
  );
};

export default QuickActions;

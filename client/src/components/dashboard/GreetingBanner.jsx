import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import Button from '../ui/Button';

/**
 * GreetingBanner — full-width greeting card with CTA buttons at the top of
 * the dashboard. See Macan_Design.md Section 7.3.
 *
 * Props:
 *   name            — user's display name
 *   pendingCount    — number of pending tasks for the user
 */

const timeOfDayGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

const MacanIcon = () => (
  <div
    className="flex items-center justify-center bg-accent shrink-0"
    style={{
      width: 40,
      height: 40,
      borderRadius: 'var(--radius-md)',
    }}
    aria-hidden="true"
  >
    <span className="font-display font-bold text-white text-[20px] leading-none">
      M
    </span>
  </div>
);

const GreetingBanner = ({ name = 'there', pendingCount = 0 }) => {
  const navigate = useNavigate();
  const greeting = timeOfDayGreeting();
  const firstName = (name || '').split(' ')[0] || 'there';

  const tasksLabel =
    pendingCount === 1
      ? 'You have 1 task waiting.'
      : `You have ${pendingCount} tasks waiting.`;

  return (
    <div
      className="w-full bg-surface px-5 py-5 sm:px-8 sm:py-6"
      style={{
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <div className="flex items-start gap-4">
        <MacanIcon />
        <div className="min-w-0 flex-1">
          <h1
            className="font-display font-bold leading-tight text-[22px] md:text-[28px]"
            style={{
              color: 'var(--color-text-primary)',
              letterSpacing: 'var(--tracking-tight)',
            }}
          >
            {greeting}, {firstName}!
          </h1>
          <p
            className="font-body mt-1"
            style={{
              fontSize: 14,
              color: 'var(--color-text-secondary)',
            }}
          >
            {tasksLabel}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          icon={ArrowRight}
          iconPosition="right"
          onClick={() => navigate('/boards')}
        >
          View All Boards
        </Button>
        <Button variant="secondary" onClick={() => navigate('/analytics')}>
          View Analytics
        </Button>
      </div>
    </div>
  );
};

export default GreetingBanner;

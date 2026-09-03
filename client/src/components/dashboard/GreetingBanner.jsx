import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import Button from '../ui/Button';
import macanMark from '../../assets/macan-mark.svg';

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

/**
 * The brand mark, not an "M" tile. Home is the first screen of the day and
 * the one place the logo earns its keep — an initial in a blue square could
 * belong to any app.
 */
const MacanIcon = () => (
  <div
    className="flex items-center justify-center shrink-0"
    style={{
      width: 44,
      height: 44,
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-accent-light)',
    }}
    aria-hidden="true"
  >
    <img src={macanMark} alt="" width={22} height={22} />
  </div>
);

const GreetingBanner = ({ name = 'there', pendingCount = 0, overdueCount = 0 }) => {
  const navigate = useNavigate();
  const greeting = timeOfDayGreeting();
  const firstName = (name || '').split(' ')[0] || 'there';

  // "20 tasks waiting" is a shelf; "10 of them are overdue" is a reason to
  // start. When nothing is late the sentence stays as it was.
  const tasksLabel =
    pendingCount === 1
      ? 'You have 1 task waiting'
      : `You have ${pendingCount} tasks waiting`;
  const overdueLabel =
    overdueCount > 0
      ? overdueCount === 1
        ? '1 is overdue'
        : `${overdueCount} are overdue`
      : null;

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
            {overdueLabel ? (
              <>
                {' — '}
                <strong style={{ color: 'var(--color-status-stuck)', fontWeight: 700 }}>
                  {overdueLabel}
                </strong>
              </>
            ) : (
              '.'
            )}
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

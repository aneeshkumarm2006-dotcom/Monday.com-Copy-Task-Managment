import { Globe, Lock, CalendarRange, Users } from 'lucide-react';
import { boardTypeKey } from '../../utils/boardFilters';

/**
 * The little pill that says what KIND of board this is.
 *
 * Previously this was a two-state public/private ternary duplicated in
 * BoardCard and the board header. That was already lossy — a Client Portal
 * board rendered as "private", which is technically true and practically
 * useless — and a third board type made it worse. One component, both places.
 *
 * Board TYPE wins over visibility when there is one: "monthly" and "client"
 * tell you far more about a board than "private" does, and both types are
 * always private anyway.
 */
const STYLES = {
  monthly: {
    icon: CalendarRange,
    label: 'monthly',
    bg: 'var(--color-accent-light)',
    fg: 'var(--color-accent-text)',
  },
  client: {
    icon: Users,
    label: 'client',
    bg: 'var(--color-card-purple-bg, var(--color-bg-subtle))',
    fg: 'var(--color-text-secondary)',
  },
  public: {
    icon: Globe,
    label: 'public',
    bg: 'var(--color-status-done-bg)',
    fg: 'var(--color-status-done)',
  },
  private: {
    icon: Lock,
    label: 'private',
    bg: '#FFF0F0',
    fg: '#DC2626',
  },
};

const BoardTypePill = ({ board, size = 11 }) => {
  if (!board) return null;
  const spec = STYLES[boardTypeKey(board)];
  const Icon = spec.icon;

  return (
    <span
      className="inline-flex items-center gap-1 font-body shrink-0"
      style={{
        fontSize: size,
        fontWeight: 500,
        padding: size >= 11 ? '3px 10px' : '2px 8px',
        borderRadius: 'var(--radius-full)',
        background: spec.bg,
        color: spec.fg,
      }}
    >
      <Icon size={size} aria-hidden="true" />
      {spec.label}
    </span>
  );
};

export default BoardTypePill;

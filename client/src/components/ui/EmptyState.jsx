import Button from './Button';

/**
 * EmptyState — used everywhere the list/grid has nothing to show.
 * See Macan_Design.md Section 12.
 *
 * Props: icon (Lucide component), title, description, actionLabel, onAction
 */
const EmptyState = ({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  className = '',
}) => {
  return (
    <div
      className={[
        'flex flex-col items-center justify-center text-center px-6 py-8 sm:py-12',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {Icon && (
        <Icon
          size={48}
          strokeWidth={1.5}
          color="var(--color-text-muted)"
          aria-hidden="true"
        />
      )}
      {title && (
        <h3 className="mt-4 font-display font-semibold text-[16px] text-[color:var(--color-text-primary)]">
          {title}
        </h3>
      )}
      {description && (
        <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)] max-w-xs">
          {description}
        </p>
      )}
      {actionLabel && onAction && (
        <div className="mt-4">
          <Button variant="primary" onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
};

export default EmptyState;

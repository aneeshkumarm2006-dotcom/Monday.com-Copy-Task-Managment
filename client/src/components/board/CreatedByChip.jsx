import Avatar from '../ui/Avatar';
import { formatDate } from '../../utils/dateUtils';

/**
 * "Created by <person>" byline, drawn identically for a board (beside its name)
 * and for a group (under the Notes panel header).
 *
 * RENDERS NOTHING WITHOUT A HYDRATED USER. `createdBy` arrives populated from
 * the server on boards and on groups, but a group made before the field existed
 * carries none and never will — the information was not recorded, so there is
 * nothing to backfill and no fallback to invent. Drawing "Created by Unknown"
 * would be a claim; drawing nothing is the truth. The same branch also covers
 * the loading window, where `board` is still null.
 *
 * A bare id (not populated) is treated as absent for the same reason: the chip
 * shows a name, and resolving one from the org roster would silently miss anyone
 * who has since left, or who was never a member of the caller's workspace view.
 */
const CreatedByChip = ({ user, at, label = 'Created by', size = 18, className = '' }) => {
  const name = typeof user === 'object' ? (user?.name || user?.email || '') : '';
  if (!name) return null;

  const when = at ? formatDate(at) : '';

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-body ${className}`}
      style={{ minWidth: 0, maxWidth: '100%' }}
      title={when ? `${label} ${name} on ${when}` : `${label} ${name}`}
    >
      <Avatar user={user} size={size} />
      <span
        className="truncate"
        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
      >
        {label}{' '}
        <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>
          {name}
        </span>
      </span>
    </span>
  );
};

export default CreatedByChip;

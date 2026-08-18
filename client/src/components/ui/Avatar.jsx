import { useState } from 'react';
import { getInitial } from '../../utils/avatar';

/**
 * Shared user avatar: renders the user's profile picture, falling back to a
 * flat accent circle with their initial. Used by the navbar avatar menu, the
 * notification components (actor avatars), the tracker group-owner chip and the
 * People tab.
 *
 * The fallback circle is the SAME flat accent treatment the board's task-row
 * assignee avatars use, so a person looks identical everywhere they appear.
 */
const Avatar = ({ user, size = 32 }) => {
  const [imgError, setImgError] = useState(false);
  if (user?.profilePic && !imgError) {
    return (
      <img
        src={user.profilePic}
        alt={user.name || 'User avatar'}
        className="object-cover"
        style={{ width: size, height: size, borderRadius: 9999 }}
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center font-display font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: 'var(--color-accent-light)',
        color: 'var(--color-accent-text)',
        fontSize: size * 0.4,
      }}
      aria-hidden="true"
    >
      {getInitial(user?.name)}
    </div>
  );
};

export default Avatar;

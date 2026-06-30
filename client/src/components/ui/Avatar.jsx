import { useState } from 'react';
import { getAvatarColor, getInitial } from '../../utils/avatar';

/**
 * Shared user avatar: renders the user's profile picture, falling back to a
 * deterministic colored circle with their initial. Used by the navbar avatar
 * menu and the notification components (actor avatars).
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
  const seed = user?.email || user?.name || '';
  return (
    <div
      className="flex items-center justify-center font-display font-semibold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: getAvatarColor(seed),
        fontSize: size * 0.4,
      }}
      aria-hidden="true"
    >
      {getInitial(user?.name)}
    </div>
  );
};

export default Avatar;

/**
 * Deterministic avatar helpers shared by the Avatar component and anything that
 * needs the same initial/color logic.
 */

export const AVATAR_COLORS = [
  '#2563EB',
  '#16A34A',
  '#EA580C',
  '#7C3AED',
  '#D97706',
  '#DC2626',
];

export const getInitial = (name) => {
  if (!name) return '?';
  return name.trim().charAt(0).toUpperCase();
};

export const getAvatarColor = (seed = '') => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  const idx = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
};

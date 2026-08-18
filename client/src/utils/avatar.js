/**
 * Deterministic avatar helpers shared by the Avatar component and anything that
 * needs the same initial logic.
 *
 * There is deliberately NO per-person colour hash here any more. Avatars used to
 * pick a background out of a six-colour palette keyed on the user's email, which
 * meant the SAME screen showed two systems at once: a task row's assignees were
 * a flat accent circle while the group-owner chip a few pixels away was orange,
 * purple or green. One flat treatment is the whole point — the initial and the
 * profile picture carry the identity, not the colour.
 */

export const getInitial = (name) => {
  if (!name) return '?';
  return name.trim().charAt(0).toUpperCase();
};

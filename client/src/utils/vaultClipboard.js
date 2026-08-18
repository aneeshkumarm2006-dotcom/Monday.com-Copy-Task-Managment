/**
 * Copying a secret to the clipboard, and taking it back out again.
 *
 * The clipboard is a system-wide, plaintext buffer that every application on the
 * machine can read and that most operating systems now sync between devices. A
 * password copied at 09:00 is still sitting there at 17:00, one accidental
 * ⌘V into a chat window away from being pasted somewhere permanent.
 *
 * So a copy from the vault is temporary by construction: after
 * `CLEAR_AFTER_MS`, the clipboard is overwritten — but ONLY if it still holds
 * what we put there. Blindly wiping it would delete whatever the user copied in
 * the meantime, which is a far more annoying bug than the one being fixed.
 */

/** Long enough to switch windows and paste; short enough to matter. */
export const CLEAR_AFTER_MS = 45_000;

let pending = null;

/**
 * Copy `text`, then clear it later.
 *
 * @returns {Promise<boolean>} false when the browser refuses (an insecure origin,
 *          or a copy not tied to a user gesture) so the caller can offer the
 *          reveal-and-select fallback instead of claiming success.
 */
export const copySecret = async (text) => {
  const value = String(text ?? '');
  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
  } catch {
    return false;
  }

  if (pending) clearTimeout(pending);
  pending = setTimeout(async () => {
    pending = null;
    try {
      // Read-back before wiping. `readText` needs clipboard-read permission,
      // which Firefox does not grant to pages at all — so a failure here is
      // expected, not exceptional, and the right response is to leave the
      // clipboard alone rather than destroy something the user put there.
      const current = await navigator.clipboard.readText();
      if (current === value) await navigator.clipboard.writeText('');
    } catch {
      /* no read permission — leaving it is safer than clearing blind */
    }
  }, CLEAR_AFTER_MS);

  return true;
};

/**
 * Cancel a pending clear. Called when the vault locks: the timer is about to
 * become the only thing still referencing the secret, and a lock should not
 * silently reach into the clipboard some seconds later.
 */
export const cancelSecretClear = () => {
  if (pending) clearTimeout(pending);
  pending = null;
};

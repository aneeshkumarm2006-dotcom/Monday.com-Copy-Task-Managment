/**
 * PWA install — capturing the browser's one shot at it.
 *
 * Chrome/Edge/Android fire `beforeinstallprompt` ONCE, early, and only while
 * the app isn't installed. Nothing can re-request it, so the event has to be
 * caught at module scope (imported from main.jsx before React mounts) and
 * held for whenever the person actually clicks "Install app".
 *
 * iOS Safari never fires it — installing there is Share → Add to Home Screen
 * — so the UI asks `getInstallState()` and shows instructions instead of a
 * button that would do nothing.
 */

let deferredPrompt = null;
const listeners = new Set();

const notify = () => listeners.forEach((fn) => fn());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Stop Chrome's own mini-infobar; the app offers install in its menus.
    e.preventDefault();
    deferredPrompt = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}

export const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.navigator.standalone === true);

export const isIOS = () =>
  typeof navigator !== 'undefined' &&
  /iPad|iPhone|iPod/.test(navigator.userAgent) &&
  !window.MSStream;

/**
 * What the install UI should do right now:
 *   'installed' — already running as the app (offer nothing)
 *   'prompt'    — we hold the browser prompt (offer the real button)
 *   'ios'       — Safari on iPhone/iPad (offer Add-to-Home-Screen steps)
 *   'manual'    — everything else (offer the generic browser-menu hint)
 */
export const getInstallState = () => {
  if (isStandalone()) return 'installed';
  if (deferredPrompt) return 'prompt';
  if (isIOS()) return 'ios';
  return 'manual';
};

/** Fire the held browser prompt. Resolves true when the person accepted. */
export const promptInstall = async () => {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null; // single-use, per the spec
  notify();
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === 'accepted';
};

/** Re-render hook plumbing: call `fn` whenever the install state changes. */
export const onInstallStateChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

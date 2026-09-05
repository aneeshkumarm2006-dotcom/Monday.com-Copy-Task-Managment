/**
 * Getting a new deploy onto the screen.
 *
 * The service worker precaches index.html and every chunk (see vite.config.js).
 * That is what makes a returning visit boot from disk — and it is also why a
 * tab opened just after a deploy runs the PREVIOUS build from top to bottom.
 * The new worker installs quietly in the background, `skipWaiting` activates it
 * and `clientsClaim` hands it this page, but nothing tells the JavaScript
 * already running that it is now a version behind. It keeps going on the old
 * bundle until the person happens to reload.
 *
 * That gap is not academic. A crash fixed and deployed hours earlier still took
 * down the board page for anyone whose tab was still on the old build, and
 * "reload the page" was the only cure — which is exactly what it looked like
 * from the user's side: broken once, fine after a refresh, no way to tell why.
 * `registerType: 'autoUpdate'` promises that a deploy takes over on its own;
 * this is the missing half of that promise.
 *
 * `controllerchange` fires the moment the new worker takes this page over, so
 * that is the reload signal. Two guards keep it from firing when it shouldn't:
 *
 *  - The FIRST worker to control a page raises `controllerchange` too, on a tab
 *    that is already running the newest build. Reloading there would be a
 *    pointless flash on every first visit, so a page that booted with no
 *    controller ignores the event.
 *  - A timestamp in sessionStorage caps this at one automatic reload per ten
 *    seconds, so a worker that somehow kept swapping could not spin the tab.
 */

const RELOAD_AT_KEY = 'macan:sw-reload-at';
const MIN_GAP_MS = 10_000;

const supported =
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

/**
 * Was this page already under a worker when it booted? If not, the first
 * `controllerchange` is only that worker claiming it — not a newer build.
 */
const startedControlled = supported && !!navigator.serviceWorker.controller;

let reloading = false;

const reloadForNewBuild = () => {
  if (reloading) return;

  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_AT_KEY)) || 0;
  } catch {
    // Private browsing. Without the timestamp the in-memory flag below is the
    // only guard, and it is enough for a single page life.
  }
  if (last && Date.now() - last < MIN_GAP_MS) return;

  reloading = true;
  try {
    sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
  } catch {
    // See above.
  }
  window.location.reload();
};

if (supported) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!startedControlled) return;
    reloadForNewBuild();
  });
}

/**
 * Re-check /sw.js right now instead of waiting for the browser's own schedule.
 *
 * Called when something has gone wrong on screen: a page running a build that
 * has since been superseded is one ordinary explanation for a crash, and this
 * is how that gets tested. If there IS a newer worker it installs, activates
 * and claims the page, and the listener above reloads onto the new build. If
 * there isn't, nothing happens and the error on screen is the real story.
 *
 * Safe to call from anywhere: never throws, and never reloads by itself.
 */
export const checkForNewBuild = async () => {
  if (!supported) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return false;
    await registration.update();
    return !!(registration.installing || registration.waiting);
  } catch {
    // Offline, or the worker's own fetch failed. Either way there is nothing
    // newer to move to, and the caller has a real error to show.
    return false;
  }
};

import api from './api';

/**
 * Fetch the human title for a Google Drive/Docs URL via the server proxy
 * (the browser can't read cross-origin Google pages directly).
 *
 * Results are memoised per-url for the session so re-rendering the Updates feed
 * — or showing the same doc across several updates — hits the network once.
 * Returns a string title, or null when it can't be resolved (private doc, etc.).
 */
const cache = new Map(); // url -> Promise<string|null>

export const getLinkTitle = (url) => {
  if (!url) return Promise.resolve(null);

  // NOT SIGNED IN TO THE APP → don't ask. This is the Client Portal guard, and
  // it is load-bearing rather than an optimisation.
  //
  // `DriveLinkChip` calls this on mount, and it is reached from
  // `ReadOnlyRichBody` → `driveChipExtension` → `DriveLinkChip`. The portal
  // renders `ReadOnlyRichBody` — that is the whole reason that component was
  // extracted out of `UpdatesTab` — so a team member pasting a Drive link into
  // a client chat or mail message makes the CLIENT'S browser call an
  // app-authenticated endpoint through `services/api.js`. Its 401 handler
  // deletes `macan_token`, so a team member with a stale session in another tab
  // is signed out of Macan by opening a portal page.
  //
  // The proxy needs an app session and can never answer without one, so
  // returning null here loses nothing: the chip renders its filename fallback,
  // which is what it does for an unresolvable doc anyway.
  if (!localStorage.getItem('macan_token')) return Promise.resolve(null);

  if (cache.has(url)) return cache.get(url);

  const promise = api
    .get('/api/proxy/link-preview', {
      params: { url },
      suppressErrorToast: true,
    })
    .then((res) => res.data?.title || null)
    .catch(() => null);

  cache.set(url, promise);
  return promise;
};

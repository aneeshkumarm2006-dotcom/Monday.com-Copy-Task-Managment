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

const express = require('express');
const { URL } = require('url');
const authMiddleware = require('../middleware/auth');
const { cloudinary } = require('../config/cloudinary');

const router = express.Router();
router.use(authMiddleware);

const ALLOWED_HOST = 'res.cloudinary.com';

// Google hosts whose public pages we'll fetch a title from for the Updates
// link chip. Anything else is rejected so this endpoint can't be turned into
// an open SSRF proxy.
const DRIVE_HOSTS = new Set([
  'docs.google.com',
  'drive.google.com',
  'sheets.google.com',
  'slides.google.com',
  'forms.google.com',
]);

// Small in-process cache so repeated views of the same update don't re-fetch
// the title on every render. TTL is generous — a doc title rarely changes.
const titleCache = new Map(); // url -> { title, expires }
const TITLE_TTL_MS = 60 * 60 * 1000; // 1 hour

const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");

/**
 * Pull a human title out of a fetched Google page. Prefers og:title (the bare
 * document name, e.g. "June 2026 | Performance Report") and falls back to the
 * <title> tag with its " - Google Docs" suffix trimmed off.
 */
const extractTitle = (html) => {
  const og =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i
    );
  if (og && og[1]) return decodeEntities(og[1]).trim();

  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title && title[1]) {
    const cleaned = decodeEntities(title[1])
      .replace(/\s[-–]\s*Google\s+(Docs|Sheets|Slides|Forms|Drive).*$/i, '')
      .trim();
    // A bare "Google Docs" app title, or a sign-in / accounts page, means the
    // doc is private or we were redirected — no useful name to show. (A doc the
    // user genuinely named e.g. "Google Ads Report" is deliberately kept.)
    const isAppOrLogin =
      /^google (docs|sheets|slides|forms|drive)$/i.test(cleaned) ||
      /sign in|google accounts/i.test(cleaned);
    if (cleaned && !isAppOrLogin) return cleaned;
  }
  return null;
};

/**
 * GET /api/proxy/link-preview?url=<google-drive-url>
 *
 * Fetches a public Google Docs/Drive page server-side (CORS blocks the browser)
 * and returns its title so the Updates feed can render the link as an
 * icon + title chip. Returns { title: null } for private/unreachable docs — the
 * client then falls back to a type label. Only Google hosts are permitted.
 */
router.get('/link-preview', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (parsed.protocol !== 'https:' || !DRIVE_HOSTS.has(parsed.hostname)) {
    return res.status(403).json({ error: 'Only Google Drive URLs are allowed' });
  }

  const cached = titleCache.get(url);
  if (cached && cached.expires > Date.now()) {
    return res.json({ title: cached.title });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // A desktop UA gets the normal HTML page (with og:title) rather than a
        // stripped mobile/redirect shell.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html',
      },
    }).finally(() => clearTimeout(timer));

    let title = null;
    if (response.ok) {
      // Only read the head-ish portion — the title lives near the top and
      // Google pages are huge.
      const html = (await response.text()).slice(0, 200 * 1024);
      title = extractTitle(html);
    }

    titleCache.set(url, { title, expires: Date.now() + TITLE_TTL_MS });
    return res.json({ title });
  } catch (err) {
    console.error('[proxy] link-preview failed:', err.message);
    // Not fatal — the client falls back to a type label.
    return res.json({ title: null });
  }
});

/**
 * Parse a Cloudinary delivery URL into { resourceType, publicId, ext }.
 *
 * URL format:
 *   https://res.cloudinary.com/{cloud}/{resource_type}/upload/[v{ver}/]{public_id}.{ext}
 *
 * public_id includes folder separators (e.g. "macan/updates/filename").
 */
const parseCloudinaryUrl = (urlStr) => {
  const m = urlStr.match(
    /res\.cloudinary\.com\/([^/]+)\/(image|video|raw)\/upload\/(.+?)(?:\?.*)?$/
  );
  if (!m) return null;

  const resourceType = m[2];
  let path = m[3];

  // Strip optional version prefix "v<digits>/"
  path = path.replace(/^v\d+\//, '');

  // Extract extension from the filename portion only (not folder names)
  const lastSlash = path.lastIndexOf('/');
  const filename  = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const folder    = lastSlash >= 0 ? path.slice(0, lastSlash)  : '';
  const lastDot   = filename.lastIndexOf('.');

  let publicId, ext;
  if (lastDot > 0) {
    ext      = filename.slice(lastDot + 1);
    const base = filename.slice(0, lastDot);
    publicId = folder ? `${folder}/${base}` : base;
  } else {
    ext      = null;
    publicId = path;
  }

  return { resourceType, publicId, ext };
};

/**
 * GET /api/proxy/download?url=<cloudinary-url>&name=<filename>
 *
 * Uses Node's native fetch (Node 18+, auto-redirect, proper SSL) to
 * download a Cloudinary asset server-side and stream it to the browser
 * as Content-Disposition: attachment, regardless of resource_type.
 */
router.get('/download', async (req, res) => {
  const { url, name } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });

  // Express URL-decodes query params automatically
  const cleanUrl = url;

  try {
    const parsed = new URL(cleanUrl);
    if (parsed.hostname !== ALLOWED_HOST) {
      return res.status(403).json({ error: 'Only Cloudinary URLs are allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const safeFilename =
    (name || 'file').replace(/[^\w.\-() ]/g, '_').trim() || 'file';

  // Try to build a signed URL (bypasses Cloudinary access restrictions)
  const parts = parseCloudinaryUrl(cleanUrl);
  let primaryUrl = cleanUrl;

  console.log('[proxy] cleanUrl   :', cleanUrl);
  console.log('[proxy] parsed     :', parts);

  if (parts) {
    try {
      primaryUrl = cloudinary.url(parts.publicId, {
        resource_type: parts.resourceType,
        sign_url: true,
        secure: true,    // generate https:// — http:// gets redirected and breaks the signature
        type: 'upload',
        // Omit format so Cloudinary serves the stored file as-is
      });
      console.log('[proxy] signed URL :', primaryUrl);
    } catch (e) {
      console.error('[proxy] sign error :', e.message);
      primaryUrl = cleanUrl;
    }
  }

  // Attempt the download using native fetch (Node 18+).
  // fetch follows redirects automatically and handles TLS correctly.
  const tryFetch = async (fetchUrl) => {
    const response = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'Macan-Proxy/1.0' },
    });
    console.log('[proxy] fetch status:', response.status, fetchUrl.slice(0, 80));
    return response;
  };

  try {
    let response = await tryFetch(primaryUrl);

    // If signed URL fails, fall back to the original URL
    if (!response.ok && primaryUrl !== cleanUrl) {
      console.log('[proxy] signed URL failed, trying original');
      response = await tryFetch(cleanUrl);
    }

    if (!response.ok) {
      console.error('[proxy] all attempts failed, status:', response.status);
      return res
        .status(502)
        .json({ error: `Cloudinary returned HTTP ${response.status}` });
    }

    const contentType =
      response.headers.get('content-type') || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

    // Stream the response body to the client
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('[proxy] fetch threw:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to fetch file from storage' });
    }
  }
});

module.exports = router;

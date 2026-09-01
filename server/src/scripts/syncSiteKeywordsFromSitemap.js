/**
 * syncSiteKeywordsFromSitemap.js
 *
 * Fills a locally-authored DataForSEO Site's `trackedKeywords` from the target
 * site's OWN PAGES, rather than from a list somebody typed.
 *
 * WHY THIS EXISTS: a Site is authored here (see services/connectors/dataforseo/
 * sites.js — DataForSEO has no projects to mirror, so the row is the original),
 * and its keyword list is what every collection is bought from. Typing ninety
 * keywords into the form is slow, drifts the moment the site publishes a page,
 * and produces a list nobody can re-derive. The sitemap already declares every
 * page the site wants found, and each page's `<title>` already declares the
 * query it was written for. That is the list — read it, do not retype it.
 *
 * WHAT IT DERIVES, AND WHY THAT SHAPE:
 *   - Keywords come from the `<title>`, split on the pipe/dash separators that
 *     divide a title's keyword segments from its brand, falling back to the
 *     `<h1>`. A title's FIRST segment is the page's primary keyword and is
 *     always kept; a LATER segment is kept only when it shares a content word
 *     with the page's own URL, which is what separates a real secondary target
 *     ("SEO Montreal" on /services/seo) from brand furniture ("Custom Stores").
 *   - Sentence-shaped and conjunction-joined segments are dropped. Nobody
 *     searches "Built for your business" or "SEO, Ads & Growth Marketing".
 *
 * LANGUAGE, from the sitemap rather than from the path: `xhtml:link` alternates
 * carry the hreflang of every translation, so a page reachable only as the
 * alternate of a language the Site does not TARGET is skipped. A Site whose
 * targets are all `en` therefore never buys its own French pages' keywords —
 * which matters because keywords x targets is a cross product, and a second
 * language would otherwise have to be a second target that re-buys everything.
 *
 * MERGE, NOT REPLACE: keywords already on the Site are kept and come first. An
 * existing list is somebody's deliberate choice (head terms no page title
 * spells), and the derivation is an addition to it, not a verdict on it. The
 * write itself goes through the provider's own `readSiteForm`, so the search
 * operator refusal, the length limits and the 200-keyword cap are the SAME
 * rules the HTTP route enforces — this script cannot store a Site the form
 * would reject.
 *
 * Run from the server directory:
 *   node src/scripts/syncSiteKeywordsFromSitemap.js --domain acme.com \
 *     [--sitemap https://acme.com/sitemap.xml] [--exclude '/blog/'] \
 *     [--all-languages] [--concurrency 8] [--apply]
 *
 * Dry run by DEFAULT — it prints the derived list and writes nothing without
 * --apply. Idempotent: a second run with the same site derives the same list.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models'); // register all schemas

const ConnectorProject = require('../models/ConnectorProject');
const dataforseo = require('../services/connectors/dataforseo');
const {
  normaliseDomain,
  normaliseKeyword,
} = require('../services/connectors/dataforseo/sites');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const values = (name) =>
  argv.reduce((acc, a, i) => (a === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (compatible; MacanKeywordSync/1.0)';

const fetchText = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
};

/**
 * Every `<url>` in a sitemap, following a `<sitemapindex>` into its children.
 *
 * @param {string} url
 * @param {Set<string>} seen - guards a sitemap that indexes itself
 * @returns {Promise<Array<{loc: string, alternates: Array<{hreflang: string, href: string}>}>>}
 */
const readSitemap = async (url, seen = new Set()) => {
  if (seen.has(url)) return [];
  seen.add(url);
  const xml = await fetchText(url);

  if (/<sitemapindex/i.test(xml)) {
    const children = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(
      (m) => m[1]
    );
    const nested = [];
    for (const child of children) nested.push(...(await readSitemap(child, seen)));
    return nested;
  }

  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)]
    .map((block) => {
      const body = block[1];
      const loc = (body.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1] || null;
      const alternates = [...body.matchAll(/<xhtml:link[^>]*>/gi)].map((tag) => ({
        hreflang: ((tag[0].match(/hreflang=["']([^"']+)["']/i) || [])[1] || '').toLowerCase(),
        href: (tag[0].match(/href=["']([^"']+)["']/i) || [])[1] || '',
      }));
      return loc ? { loc, alternates } : null;
    })
    .filter(Boolean);
};

const decodeEntities = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "’")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();

const tagText = (html, re) => {
  const m = html.match(re);
  return m ? decodeEntities(m[1].replace(/<[^>]*>/g, ' ')) : null;
};

/** Title and h1 for one page. A page that will not load contributes nothing. */
const readPage = async (url) => {
  try {
    const html = await fetchText(url);
    return {
      url,
      ok: true,
      title: tagText(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
      h1: tagText(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i),
    };
  } catch (err) {
    return { url, ok: false, error: String(err.message || err) };
  }
};

/** Run `worker` over `items`, `limit` at a time — politeness to the site. */
const mapLimit = async (items, limit, worker) => {
  const queue = [...items];
  const results = [];
  await Promise.all(
    Array.from({ length: Math.max(1, limit) }, async () => {
      while (queue.length) results.push(await worker(queue.shift()));
    })
  );
  return results;
};

// ---------------------------------------------------------------------------
// Deriving
// ---------------------------------------------------------------------------

/**
 * Words that carry meaning, for asking whether two phrases are about the same
 * thing. Accented letters are kept — a stripped "referencement" is not a word.
 */
const STOP = new Set([
  'and', 'for', 'the', 'with', 'your', 'you', 'our', 'that', 'from',
  'des', 'les', 'une', 'pour', 'sur', 'aux', 'avec', 'votre',
]);
const contentWords = (text) =>
  new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9À-ſ]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
const shareAWord = (a, b) => {
  const words = contentWords(b);
  return [...contentWords(a)].some((w) => words.has(w));
};

/** A question, a colon-clause or a trailing full stop is a headline's tail. */
const trimTail = (s) => s.split(/[:?!]/)[0].replace(/\s*\.\s*$/, '').trim();

/** Opens like a sentence, so it is a headline rather than a query. */
const SENTENCE_OPENER =
  /^(how|why|what|when|where|who|can|should|are|is|do|does|the|your|our|we|let|built|turn|grow|win|reach|convert|learn|get|make|find|a|an)\b/i;

/**
 * The last path segment, read as the query the page was written for.
 *
 * The fallback when a title yields nothing, which happens more often than it
 * sounds: "Google Ads and PPC Pricing" and "ChatGPT and AI Search Ads Agency
 * Ottawa" are both conjunction-joined and both belong to a page that must be
 * tracked. Their slugs — `google-ads-pricing`, `chatgpt-ads-ottawa` — are the
 * query, and are what the page was named for in the first place.
 *
 * @param {string} url
 * @returns {string|null}
 */
const keywordFromSlug = (url) => {
  const slug = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/|\/$/g, '').split('/').pop() || '';
  const words = slug.split('-').filter(Boolean);
  if (words.length < 2 || words.length > 6) return null;
  return words.join(' ');
};

/**
 * The keywords one page offers.
 *
 * @param {{url: string, title: ?string, h1: ?string}} page
 * @param {RegExp} brandRe - matches the site's own name, which is not a keyword
 * @returns {string[]}
 */
const keywordsFromPage = (page, brandRe) => {
  const raw = page.title || page.h1 || '';
  if (!raw) return [keywordFromSlug(page.url)].filter(Boolean);
  const path = (page.url.replace(/^https?:\/\/[^/]+/, '') || '/').replace(/[/-]/g, ' ');

  const segments = raw
    .split(/\s*[|–—]\s*/)
    // A parenthetical is an aside, not part of the query.
    .map((s) => s.replace(/\([^)]*\)/g, ' '))
    .map(trimTail)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((s) => !brandRe.test(s))
    .filter((s) => !SENTENCE_OPENER.test(s))
    // A tagline joins two offers with a conjunction; nobody searches that way.
    .filter((s) => !/,| & | and | et /i.test(s))
    .filter((s) => {
      const words = s.split(/\s+/).length;
      return words >= 2 && words <= 6;
    });

  // A page whose whole title was refused is not a page with nothing to rank
  // for — it is a page whose title is a sentence or a pair of joined offers.
  // Its slug still carries the query.
  if (!segments.length) return [keywordFromSlug(page.url)].filter(Boolean);

  // The first surviving segment is the page's primary keyword. A later one is a
  // secondary target only when it is about the page it sits on.
  return segments.filter((s, i) => i === 0 || shareAWord(s, path));
};

/**
 * The base language of an hreflang value: `fr-CA` and `fr` are one language,
 * and `x-default` is not a language at all.
 */
const baseLanguage = (hreflang) => String(hreflang || '').split('-')[0].toLowerCase();

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const run = async () => {
  const domain = normaliseDomain(value('domain'));
  if (!domain) {
    console.error('Pass --domain <the site domain>, like --domain acme.com');
    process.exit(1);
  }

  const apply = flag('apply');
  const allLanguages = flag('all-languages');
  const concurrency = Number(value('concurrency', '8')) || 8;
  const excludes = values('exclude').map((p) => new RegExp(p, 'i'));

  await connectDB();

  const project = await ConnectorProject.findOne({ provider: 'dataforseo', domain });
  if (!project) {
    console.error(`No DataForSEO site for ${domain}. Create it on the board's Add-ons tab first.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  if (!project.locallyAuthored) {
    console.error(`${domain} is a mirrored project, so its keywords are edited at the provider.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  /** The languages this Site actually buys SERPs in. */
  const targetLanguages = new Set(
    (project.targets || []).map((t) => baseLanguage(t.languageCode)).filter(Boolean)
  );

  console.log(`\nSite: ${project.name} (${domain})`);
  console.log(
    `Targets: ${
      (project.targets || [])
        .map((t) => `${t.locationCode}/${t.languageCode}/${t.device}`)
        .join(', ') || 'none'
    }`
  );
  console.log(`Already tracking: ${(project.trackedKeywords || []).length} keyword(s)\n`);

  const sitemapUrl = value('sitemap', `https://${domain}/sitemap.xml`);
  console.log(`Reading ${sitemapUrl} ...`);
  const entries = await readSitemap(sitemapUrl);
  console.log(`  ${entries.length} URL(s) declared`);

  /**
   * URLs the sitemap ITSELF declares to be a translation into a language this
   * Site does not target. Built from every entry's alternates, so a page is
   * judged by what the sitemap says about it and not by its path shape.
   */
  const trim = (u) => String(u).replace(/\/$/, '');
  const foreign = new Set();
  if (!allLanguages && targetLanguages.size) {
    for (const entry of entries) {
      for (const alt of entry.alternates) {
        const lang = baseLanguage(alt.hreflang);
        if (!lang || lang === 'x' || !alt.href) continue;
        if (!targetLanguages.has(lang)) foreign.add(trim(alt.href));
      }
    }
    // A page also served in a targeted language is not foreign, whatever else
    // it is listed as.
    for (const entry of entries) {
      for (const alt of entry.alternates) {
        if (targetLanguages.has(baseLanguage(alt.hreflang))) foreign.delete(trim(alt.href));
      }
    }
  }

  const inLanguage = entries.filter((e) => !foreign.has(trim(e.loc)));
  const wanted = inLanguage.map((e) => e.loc).filter((loc) => !excludes.some((re) => re.test(loc)));

  console.log(
    `  ${entries.length - inLanguage.length} skipped as another language, ` +
      `${inLanguage.length - wanted.length} excluded by --exclude`
  );
  console.log(`  crawling ${wanted.length} page(s) ...`);

  const pages = await mapLimit(wanted, concurrency, readPage);
  const failed = pages.filter((p) => !p.ok);
  if (failed.length) {
    console.log(`  ${failed.length} page(s) would not load:`);
    failed.slice(0, 10).forEach((p) => console.log(`    ${p.url} - ${p.error}`));
  }

  /** The site's own name, so its brand never becomes a tracked keyword. */
  const brandRe = new RegExp(domain.replace(/^www\./, '').split('.')[0], 'i');

  const derived = new Map(); // keyword -> the page paths that produced it
  for (const page of pages) {
    if (!page.ok) continue;
    for (const kw of keywordsFromPage(page, brandRe)) {
      const key = normaliseKeyword(kw);
      if (!key || key.length < 5) continue;
      if (!derived.has(key)) derived.set(key, []);
      derived.get(key).push(page.url.replace(/^https?:\/\/[^/]+/, '') || '/');
    }
  }

  // Existing keywords first: they are somebody's deliberate choice, and a cap
  // that has to drop something must never drop those.
  const existing = (project.trackedKeywords || []).map(normaliseKeyword).filter(Boolean);
  const merged = [...new Set([...existing, ...derived.keys()])];

  console.log(`\nDerived ${derived.size} keyword(s) from the site; ${merged.length} after merging.\n`);
  merged.forEach((kw, i) => {
    const from = derived.get(kw);
    const note = !from
      ? '(already tracked)'
      : from.length > 1
        ? `(${from.length} pages)`
        : from[0];
    console.log(`${String(i + 1).padStart(3)}. ${kw}  ${note}`);
  });

  /**
   * Validated by the SAME reader the HTTP route uses, and as a FULL REPLACEMENT
   * of the authored fields — which is what the route does too. Everything the
   * form refuses (a search operator, an over-long keyword, the 200 cap) is
   * refused here, so this script cannot store a Site the UI would reject.
   */
  const form = dataforseo.projectAuthoring.readForm({
    name: project.name,
    domain: project.domain,
    businessName: project.businessName,
    trackedKeywords: merged,
    targets: (project.targets || []).map((t) => ({
      locationCode: t.locationCode,
      languageCode: t.languageCode,
      device: t.device,
      label: t.label,
    })),
    competitors: project.competitors || [],
  });

  if (!form.ok) {
    console.error(`\nRefused: ${form.error}${form.code ? ` [${form.code}]` : ''}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const calls = form.values.trackedKeywords.length * form.values.targets.length;
  console.log(
    `\n${apply ? 'Writing' : 'Would write'} ${form.values.trackedKeywords.length} keyword(s) ` +
      `across ${form.values.targets.length} target(s) - ${calls} SERP call(s) per collection.`
  );

  if (apply) {
    Object.assign(project, form.values);
    await project.save();
    console.log('Saved.');
  } else {
    console.log('Re-run with --apply to write.');
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

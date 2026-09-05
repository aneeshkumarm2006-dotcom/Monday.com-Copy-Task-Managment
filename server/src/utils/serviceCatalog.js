/**
 * SERVICES — the vocabulary an agency sells, normalised in one place.
 *
 * A SERVICE is a group on a client board: SEO, Meta Ads, Google Ads, Web
 * Development. The organisation keeps a reusable catalog of the names it has
 * used (`models/ServiceCatalogEntry.js`), and the invite table offers that
 * catalog in a dropdown you can also type a new name into — "catalog + free
 * text". Typing a name nobody has typed before mints a catalog row, so the
 * catalog grows by use and nobody has to curate it before the first invite.
 *
 * This file is the NORMALISATION half of that, and it is deliberately
 * DEPENDENCY-FREE — no models, no mongoose, no config. It is required by a
 * controller, a service, a migration and a plain `node --test` file, and the
 * rules below are exactly the kind of thing that has to be testable without a
 * database or it simply never gets tested. Same reasoning as `chatSurfaces.js`
 * and `clientBoard.js`.
 */

/**
 * The longest a service name may be.
 *
 * Deliberately identical to `groupController.MAX_GROUP_NAME`, because a service
 * name BECOMES a group name — a catalog entry that could not fit in the group it
 * creates would be a name the user typed, saw accepted, and then found silently
 * truncated somewhere else.
 */
const MAX_SERVICE_NAME = 60;

/**
 * The colours a service can be given when nobody picks one. Eight hues, taken
 * from the badge vocabulary already used elsewhere in the product, chosen to
 * stay distinguishable at the 3px width the portal's service table renders them.
 */
const SERVICE_PALETTE = [
  '#2563EB', // blue
  '#059669', // green
  '#7C3AED', // violet
  '#EA580C', // orange
  '#0891B2', // cyan
  '#DC2626', // red
  '#B45309', // amber
  '#DB2777', // pink
];

/**
 * The display form of a name: what the user typed, tidied.
 *
 * Trim, clamp, then TRIM AGAIN. The second trim is not redundant — slicing a
 * 62-character name at 60 can land in the middle of a gap and leave a trailing
 * space, which then reads as a different name from the same one typed shorter.
 */
const normaliseServiceName = (raw) => {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_SERVICE_NAME).trim();
};

/**
 * The catalog key for a name, or null when nothing survives.
 *
 * THIS IS THE ONLY THING ALLOWED TO PRODUCE A SLUG. One definition, or the day
 * someone writes `name.toLowerCase()` inline, "Meta Ads" and "meta ads" become
 * two catalog entries and the `(organisation, slug)` unique index that exists to
 * prevent exactly that stops meaning anything.
 *
 * Lowercase, collapse whitespace runs to a single dash, drop everything that is
 * not a letter, digit or dash, collapse dash runs, and trim dashes off the ends.
 * So "  META   ADS  ", "Meta Ads" and "meta-ads" all key as `meta-ads`, while a
 * name made only of punctuation keys as nothing at all and must be refused by
 * the caller rather than stored as an empty string.
 */
const serviceSlug = (raw) => {
  const name = normaliseServiceName(raw);
  if (!name) return null;
  const slug = name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
};

/**
 * A stable colour for a slug — the same service is the same colour in every
 * workspace that never opened a settings screen, and keeps that colour forever
 * because the input is the slug rather than a position in a list.
 *
 * A plain sum of char codes is enough here: the palette has eight entries and
 * the realistic input is three to six services, so what matters is determinism,
 * not avalanche. `>>> 0` keeps it non-negative for any input.
 */
const colorForSlug = (slug) => {
  const key = typeof slug === 'string' ? slug : '';
  if (!key) return SERVICE_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return SERVICE_PALETTE[hash % SERVICE_PALETTE.length];
};

module.exports = {
  MAX_SERVICE_NAME,
  SERVICE_PALETTE,
  normaliseServiceName,
  serviceSlug,
  colorForSlug,
};

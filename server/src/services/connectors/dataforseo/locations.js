const C = require('./constants');

/**
 * WHERE A KEYWORD IS SEARCHED FROM, as something a person can pick.
 *
 * ---- The problem this file exists to solve ---------------------------------
 *
 * DataForSEO addresses a market with an integer. 2840 is the United States,
 * 2826 the United Kingdom, 1023191 New York. Until now the Add-ons form asked
 * for that integer directly, with the two best-known values written into the
 * helper text, and every other market was a trip to the provider's docs and a
 * copy-paste back into a number field.
 *
 * That is not merely inconvenient. THE FIELD HAS NO WRONG-LOOKING VALUES. A
 * typo'd 2804 (Ukraine) where 2840 (United States) was meant is a valid code
 * for a real market, so nothing rejects it, nothing looks odd on the way in,
 * and the first sign of the mistake is a rank report for a client that has
 * been quietly measuring the wrong country — for as long as it took somebody to
 * notice, at full price the whole time.
 *
 * A picker is therefore not decoration. It is the only place a location code
 * can be checked at all.
 *
 * ---- Why countries are DERIVED and cities are FETCHED ----------------------
 *
 * Google's country geo-targets, which DataForSEO adopts wholesale, are
 * `2000 + the ISO 3166-1 numeric code`. That is a RULE, so the country half of
 * this catalog is generated from the ISO list below and is correct by
 * construction — there is no table of hand-copied integers to drift.
 *
 * Cities and regions have no such rule. `1023191` for New York is arbitrary,
 * and a hand-written table of them would be exactly the failure described
 * above with our name on it instead of the user's. So they are not hardcoded:
 * they come from the provider's own free locations endpoint, on demand, per
 * country. A city list nobody asked for is never fetched, and a wrong one is
 * impossible to ship.
 *
 * ---- Why the cache is in memory and not in Mongo ---------------------------
 *
 * The response is a static reference table — the set of places Google will sell
 * ads in does not move week to week — and it is FREE, so a cache miss costs
 * nothing but latency. A collection would buy durability we have no use for and
 * charge a migration, an index and a growth story for it. A process restart
 * re-fetches one free list; that is the whole downside.
 *
 * The bound matters more than the persistence: one country's locations is tens
 * of thousands of rows, so the cache holds a small number of countries and
 * evicts the least recently used. See `MAX_CACHED_COUNTRIES`.
 */

// ---------------------------------------------------------------------------
// Countries — derived, not copied
// ---------------------------------------------------------------------------

/**
 * ISO 3166-1: alpha-2, numeric, and the English name.
 *
 * The numeric code is the ONLY column that feeds a location code (`2000 + n`).
 * The alpha-2 is what the provider's per-country endpoint is addressed by. The
 * name is what a person searches for.
 *
 * Not every country on earth — the ones Google sells search ads in, which is
 * what DataForSEO can return a SERP for. A country absent here is still
 * reachable: the form takes a raw code, deliberately, for exactly this case.
 */
const ISO_COUNTRIES = [
  ['AE', 784, 'United Arab Emirates'],
  ['AF', 4, 'Afghanistan'],
  ['AL', 8, 'Albania'],
  ['AM', 51, 'Armenia'],
  ['AO', 24, 'Angola'],
  ['AR', 32, 'Argentina'],
  ['AT', 40, 'Austria'],
  ['AU', 36, 'Australia'],
  ['AZ', 31, 'Azerbaijan'],
  ['BA', 70, 'Bosnia and Herzegovina'],
  ['BD', 50, 'Bangladesh'],
  ['BE', 56, 'Belgium'],
  ['BG', 100, 'Bulgaria'],
  ['BH', 48, 'Bahrain'],
  ['BO', 68, 'Bolivia'],
  ['BR', 76, 'Brazil'],
  ['BY', 112, 'Belarus'],
  ['CA', 124, 'Canada'],
  ['CH', 756, 'Switzerland'],
  ['CI', 384, "Côte d'Ivoire"],
  ['CL', 152, 'Chile'],
  ['CM', 120, 'Cameroon'],
  ['CO', 170, 'Colombia'],
  ['CR', 188, 'Costa Rica'],
  ['CY', 196, 'Cyprus'],
  ['CZ', 203, 'Czechia'],
  ['DE', 276, 'Germany'],
  ['DK', 208, 'Denmark'],
  ['DO', 214, 'Dominican Republic'],
  ['DZ', 12, 'Algeria'],
  ['EC', 218, 'Ecuador'],
  ['EE', 233, 'Estonia'],
  ['EG', 818, 'Egypt'],
  ['ES', 724, 'Spain'],
  ['ET', 231, 'Ethiopia'],
  ['FI', 246, 'Finland'],
  ['FR', 250, 'France'],
  ['GB', 826, 'United Kingdom'],
  ['GE', 268, 'Georgia'],
  ['GH', 288, 'Ghana'],
  ['GR', 300, 'Greece'],
  ['GT', 320, 'Guatemala'],
  ['HK', 344, 'Hong Kong'],
  ['HN', 340, 'Honduras'],
  ['HR', 191, 'Croatia'],
  ['HU', 348, 'Hungary'],
  ['ID', 360, 'Indonesia'],
  ['IE', 372, 'Ireland'],
  ['IL', 376, 'Israel'],
  ['IN', 356, 'India'],
  ['IQ', 368, 'Iraq'],
  ['IS', 352, 'Iceland'],
  ['IT', 380, 'Italy'],
  ['JM', 388, 'Jamaica'],
  ['JO', 400, 'Jordan'],
  ['JP', 392, 'Japan'],
  ['KE', 404, 'Kenya'],
  ['KH', 116, 'Cambodia'],
  ['KR', 410, 'South Korea'],
  ['KW', 414, 'Kuwait'],
  ['KZ', 398, 'Kazakhstan'],
  ['LB', 422, 'Lebanon'],
  ['LK', 144, 'Sri Lanka'],
  ['LT', 440, 'Lithuania'],
  ['LU', 442, 'Luxembourg'],
  ['LV', 428, 'Latvia'],
  ['MA', 504, 'Morocco'],
  ['MD', 498, 'Moldova'],
  ['ME', 499, 'Montenegro'],
  ['MK', 807, 'North Macedonia'],
  ['MT', 470, 'Malta'],
  ['MU', 480, 'Mauritius'],
  ['MX', 484, 'Mexico'],
  ['MY', 458, 'Malaysia'],
  ['NG', 566, 'Nigeria'],
  ['NI', 558, 'Nicaragua'],
  ['NL', 528, 'Netherlands'],
  ['NO', 578, 'Norway'],
  ['NP', 524, 'Nepal'],
  ['NZ', 554, 'New Zealand'],
  ['OM', 512, 'Oman'],
  ['PA', 591, 'Panama'],
  ['PE', 604, 'Peru'],
  ['PH', 608, 'Philippines'],
  ['PK', 586, 'Pakistan'],
  ['PL', 616, 'Poland'],
  ['PR', 630, 'Puerto Rico'],
  ['PT', 620, 'Portugal'],
  ['PY', 600, 'Paraguay'],
  ['QA', 634, 'Qatar'],
  ['RO', 642, 'Romania'],
  ['RS', 688, 'Serbia'],
  ['RU', 643, 'Russia'],
  ['SA', 682, 'Saudi Arabia'],
  ['SE', 752, 'Sweden'],
  ['SG', 702, 'Singapore'],
  ['SI', 705, 'Slovenia'],
  ['SK', 703, 'Slovakia'],
  ['SN', 686, 'Senegal'],
  ['SV', 222, 'El Salvador'],
  ['TH', 764, 'Thailand'],
  ['TN', 788, 'Tunisia'],
  ['TR', 792, 'Türkiye'],
  ['TW', 158, 'Taiwan'],
  ['TZ', 834, 'Tanzania'],
  ['UA', 804, 'Ukraine'],
  ['UG', 800, 'Uganda'],
  ['US', 840, 'United States'],
  ['UY', 858, 'Uruguay'],
  ['UZ', 860, 'Uzbekistan'],
  ['VE', 862, 'Venezuela'],
  ['VN', 704, 'Vietnam'],
  ['ZA', 710, 'South Africa'],
  ['ZM', 894, 'Zambia'],
  ['ZW', 716, 'Zimbabwe'],
];

/**
 * The languages a market is plausibly searched in, per country.
 *
 * A DEFAULT AND NOTHING MORE. Picking the language is the user's job — an
 * agency tracking a Barcelona client may want `ca` and a Montreal one `fr` —
 * and the picker offers the full list either way. This only decides which one
 * is already filled in when a country is chosen, so the common case is one
 * click instead of two.
 *
 * The first entry is the default. A country absent from this table falls back
 * to English, which is the honest answer for "we do not know" and is never
 * silently wrong in a way that costs money: a language mismatch returns a real
 * SERP for a real market, just not the one intended, and it is visible on the
 * first screen anybody opens.
 */
const COUNTRY_LANGUAGES = {
  AE: ['ar', 'en'],
  AF: ['fa', 'ps'],
  AL: ['sq'],
  AM: ['hy', 'ru'],
  AO: ['pt'],
  AR: ['es'],
  AT: ['de'],
  AU: ['en'],
  AZ: ['az', 'ru'],
  BA: ['bs', 'hr', 'sr'],
  BD: ['bn', 'en'],
  BE: ['nl', 'fr', 'de'],
  BG: ['bg'],
  BH: ['ar', 'en'],
  BO: ['es'],
  BR: ['pt'],
  BY: ['ru', 'be'],
  CA: ['en', 'fr'],
  CH: ['de', 'fr', 'it'],
  CI: ['fr'],
  CL: ['es'],
  CM: ['fr', 'en'],
  CO: ['es'],
  CR: ['es'],
  CY: ['el', 'en'],
  CZ: ['cs'],
  DE: ['de'],
  DK: ['da'],
  DO: ['es'],
  DZ: ['ar', 'fr'],
  EC: ['es'],
  EE: ['et', 'ru'],
  EG: ['ar', 'en'],
  ES: ['es', 'ca'],
  ET: ['am', 'en'],
  FI: ['fi', 'sv'],
  FR: ['fr'],
  GB: ['en'],
  GE: ['ka', 'ru'],
  GH: ['en'],
  GR: ['el'],
  GT: ['es'],
  HK: ['zh-TW', 'en'],
  HN: ['es'],
  HR: ['hr'],
  HU: ['hu'],
  ID: ['id', 'en'],
  IE: ['en'],
  IL: ['he', 'ar', 'en'],
  IN: ['en', 'hi'],
  IQ: ['ar'],
  IS: ['is'],
  IT: ['it'],
  JM: ['en'],
  JO: ['ar', 'en'],
  JP: ['ja'],
  KE: ['en', 'sw'],
  KH: ['km'],
  KR: ['ko'],
  KW: ['ar', 'en'],
  KZ: ['ru', 'kk'],
  LB: ['ar', 'fr', 'en'],
  LK: ['en', 'si', 'ta'],
  LT: ['lt'],
  LU: ['fr', 'de'],
  LV: ['lv', 'ru'],
  MA: ['ar', 'fr'],
  MD: ['ro', 'ru'],
  ME: ['sr'],
  MK: ['mk'],
  MT: ['en', 'mt'],
  MU: ['en', 'fr'],
  MX: ['es'],
  MY: ['ms', 'en', 'zh-CN'],
  NG: ['en'],
  NI: ['es'],
  NL: ['nl'],
  NO: ['no'],
  NP: ['ne', 'en'],
  NZ: ['en'],
  OM: ['ar', 'en'],
  PA: ['es'],
  PE: ['es'],
  PH: ['en', 'tl'],
  PK: ['en', 'ur'],
  PL: ['pl'],
  PR: ['es', 'en'],
  PT: ['pt'],
  PY: ['es'],
  QA: ['ar', 'en'],
  RO: ['ro'],
  RS: ['sr'],
  RU: ['ru'],
  SA: ['ar', 'en'],
  SE: ['sv'],
  SG: ['en', 'zh-CN', 'ms'],
  SI: ['sl'],
  SK: ['sk'],
  SN: ['fr'],
  SV: ['es'],
  TH: ['th'],
  TN: ['ar', 'fr'],
  TR: ['tr'],
  TW: ['zh-TW'],
  TZ: ['sw', 'en'],
  UA: ['uk', 'ru'],
  UG: ['en'],
  US: ['en', 'es'],
  UY: ['es'],
  UZ: ['ru', 'uz'],
  VE: ['es'],
  VN: ['vi'],
  ZA: ['en', 'af'],
  ZM: ['en'],
  ZW: ['en'],
};

/**
 * Every language code the picker offers, with a name to search by.
 *
 * Spelled as DataForSEO spells them, which is mostly ISO 639-1 with a handful
 * of script/region tags. `LANGUAGE_RE` in `sites.js` is the authority on the
 * SHAPE of an acceptable code and it is deliberately looser than this list —
 * the picker is a convenience over the common cases, not a whitelist, and a
 * language nobody thought to list must still be typeable.
 */
const LANGUAGES = [
  ['af', 'Afrikaans'],
  ['am', 'Amharic'],
  ['ar', 'Arabic'],
  ['az', 'Azerbaijani'],
  ['be', 'Belarusian'],
  ['bg', 'Bulgarian'],
  ['bn', 'Bengali'],
  ['bs', 'Bosnian'],
  ['ca', 'Catalan'],
  ['cs', 'Czech'],
  ['da', 'Danish'],
  ['de', 'German'],
  ['el', 'Greek'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['et', 'Estonian'],
  ['fa', 'Persian'],
  ['fi', 'Finnish'],
  ['fr', 'French'],
  ['he', 'Hebrew'],
  ['hi', 'Hindi'],
  ['hr', 'Croatian'],
  ['hu', 'Hungarian'],
  ['hy', 'Armenian'],
  ['id', 'Indonesian'],
  ['is', 'Icelandic'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['ka', 'Georgian'],
  ['kk', 'Kazakh'],
  ['km', 'Khmer'],
  ['ko', 'Korean'],
  ['lt', 'Lithuanian'],
  ['lv', 'Latvian'],
  ['mk', 'Macedonian'],
  ['ms', 'Malay'],
  ['mt', 'Maltese'],
  ['ne', 'Nepali'],
  ['nl', 'Dutch'],
  ['no', 'Norwegian'],
  ['pl', 'Polish'],
  ['ps', 'Pashto'],
  ['pt', 'Portuguese'],
  ['ro', 'Romanian'],
  ['ru', 'Russian'],
  ['si', 'Sinhala'],
  ['sk', 'Slovak'],
  ['sl', 'Slovenian'],
  ['sq', 'Albanian'],
  ['sr', 'Serbian'],
  ['sv', 'Swedish'],
  ['sw', 'Swahili'],
  ['ta', 'Tamil'],
  ['th', 'Thai'],
  ['tl', 'Filipino'],
  ['tr', 'Turkish'],
  ['uk', 'Ukrainian'],
  ['ur', 'Urdu'],
  ['uz', 'Uzbek'],
  ['vi', 'Vietnamese'],
  ['zh-CN', 'Chinese (Simplified)'],
  ['zh-TW', 'Chinese (Traditional)'],
];

const LANGUAGE_NAMES = new Map(LANGUAGES.map(([code, name]) => [code, name]));

/** Every country as a pickable location. Built once; the rule does the work. */
const COUNTRIES = ISO_COUNTRIES.map(([iso, numeric, name]) => ({
  locationCode: 2000 + numeric,
  name,
  countryIso: iso,
  /** `country`, `region` or `city` — the provider's own `location_type`. */
  type: 'country',
  /** What a person sees. For a country that is just its name. */
  label: name,
  languages: COUNTRY_LANGUAGES[iso] || ['en'],
}));

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.locationCode, c]));
const COUNTRY_BY_ISO = new Map(COUNTRIES.map((c) => [c.countryIso, c]));

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/**
 * Fold a string to something worth comparing: lowercase, accents stripped.
 *
 * Accents are stripped on BOTH sides so "Turkiye" finds "Türkiye" and "cote"
 * finds "Côte d'Ivoire". Somebody typing into a search box has no reason to
 * reach for a diaeresis, and a picker that demands one is a picker that returns
 * nothing and sends them back to the raw-code field this whole file exists to
 * replace.
 */
const fold = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/**
 * Rank one candidate against a folded query. Higher is better; 0 is no match.
 *
 * Prefix beats contains, and a shorter name beats a longer one at the same
 * rank, so "ind" puts India above "British Indian Ocean Territory" and "united
 * s" puts the United States above the United States Minor Outlying Islands.
 */
const scoreMatch = (haystack, needle) => {
  const text = fold(haystack);
  if (!text) return 0;
  if (text === needle) return 1000;
  if (text.startsWith(needle)) return 500 - Math.min(text.length, 200);
  // A word boundary inside the string — "york" inside "New York".
  if (text.includes(` ${needle}`)) return 300 - Math.min(text.length, 200);
  if (text.includes(needle)) return 100 - Math.min(text.length, 90);
  return 0;
};

/**
 * The countries matching a query, best first.
 *
 * Pure, synchronous, and needs no account — which is what makes the picker work
 * on a workspace that has not connected DataForSEO yet, and what keeps a market
 * choice out of the provider's hands.
 *
 * @param {string} query
 * @param {number} [limit]
 * @returns {Array<Object>}
 */
const searchCountries = (query, limit = 20) => {
  const needle = fold(query);
  if (!needle) return COUNTRIES.slice(0, limit);

  /**
   * A bare number is a LOCATION CODE, not a name.
   *
   * The escape hatch that keeps every market reachable: somebody who already
   * has the code from the provider's docs pastes it and gets the country back
   * by name, which is also the only confirmation available that the code they
   * copied is the country they meant.
   */
  if (/^\d+$/.test(needle)) {
    const exact = COUNTRY_BY_CODE.get(Number(needle));
    return exact ? [exact] : [];
  }

  return COUNTRIES.map((country) => ({
    country,
    score: Math.max(scoreMatch(country.name, needle), scoreMatch(country.countryIso, needle)),
  }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.country.name.localeCompare(b.country.name))
    .slice(0, limit)
    .map((row) => row.country);
};

// ---------------------------------------------------------------------------
// Cities and regions — the provider's own list, cached
// ---------------------------------------------------------------------------

/**
 * How many countries' location lists to hold at once.
 *
 * One country is tens of thousands of rows and the cache holds them parsed, so
 * this is the only thing standing between a locations picker and a heap the
 * size of the provider's entire geography. Small on purpose: an agency works in
 * a handful of markets, and the miss it does take costs one free request.
 */
const MAX_CACHED_COUNTRIES = 4;

/** ISO -> {fetchedAt, rows}. Insertion order is the LRU order; see `remember`. */
const cityCache = new Map();

/**
 * How long a cached country list is trusted.
 *
 * Long, because this is a static reference table — Google does not add cities
 * on a weekly cadence — and because the cost of a stale entry is that a place
 * added last month is missing for a day, while the cost of a short TTL is a
 * multi-megabyte parse on a cadence nobody asked for.
 */
const CITY_TTL_MS = 24 * 60 * 60 * 1000;

const remember = (iso, rows) => {
  // Re-inserting moves the key to the end, which is what makes plain insertion
  // order an LRU: the oldest key is always the first one out.
  cityCache.delete(iso);
  cityCache.set(iso, { fetchedAt: Date.now(), rows });
  while (cityCache.size > MAX_CACHED_COUNTRIES) {
    const oldest = cityCache.keys().next().value;
    cityCache.delete(oldest);
  }
};

const cached = (iso) => {
  const entry = cityCache.get(iso);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CITY_TTL_MS) {
    cityCache.delete(iso);
    return null;
  }
  // Touch, so a country in active use is not the one evicted.
  remember(iso, entry.rows);
  return entry.rows;
};

/**
 * One row of the provider's locations payload, as this picker wants it.
 *
 * The payload nests: a city carries `location_name` ("New York,New York,United
 * States") alongside a `location_code_parent`. The comma-joined name is the one
 * worth showing — it is what disambiguates the eight Springfields — so it is
 * kept whole and only tidied for spacing.
 */
const normaliseProviderLocation = (row, iso) => {
  const code = Number(row?.location_code);
  if (!Number.isInteger(code) || code <= 0) return null;
  const name = String(row?.location_name || '').trim();
  if (!name) return null;

  const type = String(row?.location_type || '').toLowerCase();
  return {
    locationCode: code,
    name,
    label: name.replace(/\s*,\s*/g, ', '),
    countryIso: iso,
    // The provider spells these `Country`, `Region`, `City`, `County`,
    // `Municipality`, `Postal Code` and more. Anything that is not a country is
    // a place inside one as far as this picker is concerned, and the raw string
    // rides along for the label.
    type: type === 'country' ? 'country' : type || 'place',
    languages: COUNTRY_BY_ISO.get(iso)?.languages || ['en'],
  };
};

/**
 * Every location the provider knows inside one country.
 *
 * FREE, and that is load-bearing: the picker may call this whenever somebody
 * expands a country, without a budget reservation, without a rate-limit
 * conversation and without the caller having to know whether it is safe. If
 * DataForSEO ever starts billing this endpoint, this function is where that
 * changes and the caller list is one line long.
 *
 * @param {Object} client - a `createDfsClient` instance
 * @param {string} iso - a two-letter country code
 * @returns {Promise<Array<Object>>}
 */
const fetchCountryLocations = async (client, iso) => {
  const key = String(iso || '').toUpperCase();
  if (!COUNTRY_BY_ISO.has(key)) return [];

  const hit = cached(key);
  if (hit) return hit;

  const answer = await client.call(
    `${C.ENDPOINT_SERP_LOCATIONS}/${key.toLowerCase()}`,
    null,
    { method: 'GET' }
  );

  const result = answer?.tasks?.[0]?.result;
  const rows = (Array.isArray(result) ? result : [])
    .map((row) => normaliseProviderLocation(row, key))
    .filter(Boolean);

  remember(key, rows);
  return rows;
};

/**
 * Search inside one country's places.
 *
 * Separate from `searchCountries` because the two have entirely different
 * failure modes and the caller has to be able to tell them apart: this one
 * needs an account, can fail, and can be slow the first time. The country
 * search cannot fail at all.
 *
 * @param {Array<Object>} rows - from `fetchCountryLocations`
 * @param {string} query
 * @param {number} [limit]
 */
const searchWithin = (rows, query, limit = 25) => {
  const needle = fold(query);
  const list = Array.isArray(rows) ? rows : [];

  if (/^\d+$/.test(needle)) {
    const code = Number(needle);
    return list.filter((row) => row.locationCode === code).slice(0, limit);
  }

  if (!needle) {
    // No query: the biggest places first is a better opening list than
    // alphabetical, and `location_type` is the only size signal the payload
    // carries. Regions before cities, then by name.
    const rank = (row) => (row.type === 'country' ? 0 : row.type === 'region' ? 1 : 2);
    return [...list]
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  return list
    .map((row) => ({ row, score: scoreMatch(row.name, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
    .slice(0, limit)
    .map((entry) => entry.row);
};

/**
 * The human label for a stored target, for a row that has only the codes.
 *
 * The form stores `label` when it has one, but a Site authored before this file
 * existed — or through the API, or by the sitemap script — has a null label and
 * a bare 2840. This is what stops those rows rendering as an integer forever.
 *
 * @param {{locationCode: number, languageCode: string, device: string}} target
 * @returns {string}
 */
const describeTarget = (target) => {
  const country = COUNTRY_BY_CODE.get(Number(target?.locationCode));
  const place = country ? country.name : `Location ${target?.locationCode}`;
  const language =
    LANGUAGE_NAMES.get(String(target?.languageCode || '')) || target?.languageCode || '';
  const device = String(target?.device || 'desktop');
  return `${place}, ${language} (${device})`;
};

module.exports = {
  COUNTRIES,
  LANGUAGES,
  LANGUAGE_NAMES,
  COUNTRY_BY_CODE,
  COUNTRY_BY_ISO,
  searchCountries,
  fetchCountryLocations,
  searchWithin,
  describeTarget,
  // Exported for the tests, which assert on the rule rather than on the table.
  fold,
  scoreMatch,
};
